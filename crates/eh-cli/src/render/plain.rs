//! The renderer for when nobody is watching live: CI, a pipe, a log file.
//!
//! Spinners are worse than useless here — they emit thousands of redraw
//! frames into a file somebody will later have to read. This renderer emits
//! one line per event that matters and periodic lines for long work, so a
//! failed 954-mod install leaves a log you can actually diagnose from.

use eh_progress::{Outcome, ProgressSink, TaskId, Unit};
use std::collections::HashMap;
use std::io::Write;
use std::sync::Mutex;

/// Emit a progress line each time a determinate task crosses this fraction.
const TICK_PERCENT: u64 = 25;

struct Row {
    depth: usize,
    label: String,
    total: Option<u64>,
    current: u64,
    last_bucket: u64,
    unit: Unit,
}

struct Inner<W: Write + Send> {
    out: W,
    rows: HashMap<TaskId, Row>,
}

pub struct PlainSink<W: Write + Send> {
    inner: Mutex<Inner<W>>,
}

impl<W: Write + Send> PlainSink<W> {
    pub fn new(out: W) -> Self {
        Self { inner: Mutex::new(Inner { out, rows: HashMap::new() }) }
    }

    fn with<F: FnOnce(&mut Inner<W>)>(&self, f: F) {
        if let Ok(mut inner) = self.inner.lock() {
            f(&mut inner);
        }
    }
}

impl<W: Write + Send> ProgressSink for PlainSink<W> {
    fn begin(&self, id: TaskId, parent: Option<TaskId>, label: &str, total: Option<u64>, unit: Unit) {
        self.with(|inner| {
            let depth = parent
                .and_then(|p| inner.rows.get(&p).map(|r| r.depth + 1))
                .unwrap_or(0);
            let scale = match total {
                Some(t) => format!(" (0/{})", amount(t, unit)),
                None => String::new(),
            };
            let _ = writeln!(inner.out, "{}> {label}{scale}", pad(depth));
            inner.rows.insert(
                id,
                Row { depth, label: label.to_owned(), total, current: 0, last_bucket: 0, unit },
            );
        });
    }

    fn advance(&self, id: TaskId, delta: u64) {
        self.with(|inner| {
            let Some(row) = inner.rows.get_mut(&id) else { return };
            row.current = row.current.saturating_add(delta);
            // Only determinate work can report a percentage honestly.
            let Some(total) = row.total.filter(|t| *t > 0) else { return };
            let bucket = (row.current.min(total) * 100 / total) / TICK_PERCENT;
            if bucket <= row.last_bucket {
                return;
            }
            row.last_bucket = bucket;
            let (depth, label) = (row.depth, row.label.clone());
            let line = format!(
                "{}  {label} {}% ({}/{})",
                pad(depth),
                bucket * TICK_PERCENT,
                amount(row.current, row.unit),
                amount(total, row.unit)
            );
            let _ = writeln!(inner.out, "{line}");
        });
    }

    fn set_total(&self, id: TaskId, total: u64) {
        self.with(|inner| {
            if let Some(row) = inner.rows.get_mut(&id) {
                row.total = Some(total);
            }
        });
    }

    fn message(&self, id: TaskId, msg: &str) {
        self.with(|inner| {
            let Some(row) = inner.rows.get(&id) else { return };
            let (depth, label) = (row.depth, row.label.clone());
            let _ = writeln!(inner.out, "{}  {label}: {msg}", pad(depth));
        });
    }

    fn end(&self, id: TaskId, outcome: Outcome) {
        self.with(|inner| {
            let Some(row) = inner.rows.remove(&id) else { return };
            let line = match &outcome {
                Outcome::Done => format!("{}ok   {}", pad(row.depth), row.label),
                Outcome::Skipped(why) => format!("{}skip {} - {why}", pad(row.depth), row.label),
                Outcome::Failed(why) => format!("{}FAIL {} - {why}", pad(row.depth), row.label),
                // Not cosmetic: this is the line that says which phase died.
                Outcome::Abandoned => {
                    format!("{}????  {} - abandoned without an outcome", pad(row.depth), row.label)
                }
            };
            let _ = writeln!(inner.out, "{line}");
        });
    }
}

fn pad(depth: usize) -> String {
    "  ".repeat(depth)
}

/// Bytes get human units; everything else is a plain count with its noun.
fn amount(n: u64, unit: Unit) -> String {
    match unit {
        Unit::Bytes => bytes(n),
        other => format!("{n} {}", other.noun(n)),
    }
}

fn bytes(n: u64) -> String {
    const KIB: f64 = 1024.0;
    let n = n as f64;
    if n < KIB {
        return format!("{n:.0} B");
    }
    for (i, suffix) in ["KiB", "MiB", "GiB", "TiB"].iter().enumerate() {
        let scaled = n / KIB.powi(i as i32 + 1);
        if scaled < KIB {
            return format!("{scaled:.1} {suffix}");
        }
    }
    format!("{:.1} PiB", n / KIB.powi(5))
}

#[cfg(test)]
mod tests {
    use super::*;
    use eh_progress::Progress;
    use std::sync::Arc;

    /// A sink that writes into a shared buffer we can read back.
    #[derive(Clone, Default)]
    struct Buf(Arc<Mutex<Vec<u8>>>);

    impl Write for Buf {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Buf {
        fn text(&self) -> String {
            String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
        }
    }

    fn harness() -> (Progress, Buf) {
        let buf = Buf::default();
        (Progress::new(Arc::new(PlainSink::new(buf.clone()))), buf)
    }

    #[test]
    fn a_nested_task_is_indented_under_its_parent() {
        let (p, buf) = harness();
        let parent = p.task("install Foo", Some(1), Unit::Mods);
        parent.child("extract", Some(2), Unit::Files).done();
        parent.done();
        let text = buf.text();
        assert!(text.contains("> install Foo"), "{text}");
        assert!(text.contains("  > extract"), "{text}");
        assert!(text.contains("  ok   extract"), "{text}");
    }

    #[test]
    fn an_abandoned_task_names_itself_rather_than_going_quiet() {
        let (p, buf) = harness();
        drop(p.task("download Bar.7z", Some(100), Unit::Bytes));
        assert!(buf.text().contains("abandoned without an outcome"), "{}", buf.text());
    }

    #[test]
    fn a_determinate_task_reports_at_quarters_and_not_per_byte() {
        let (p, buf) = harness();
        let t = p.task("download", Some(100), Unit::Bytes);
        for _ in 0..100 {
            t.advance(1);
        }
        t.done();
        let text = buf.text();
        for pct in ["25%", "50%", "75%", "100%"] {
            assert!(text.contains(pct), "missing {pct} in:\n{text}");
        }
        // 100 single-byte advances must not produce 100 lines.
        assert!(text.lines().count() < 10, "too chatty:\n{text}");
    }

    #[test]
    fn an_indeterminate_task_never_invents_a_percentage() {
        let (p, buf) = harness();
        let t = p.task("scanning", None, Unit::Files);
        t.advance(9);
        t.done();
        assert!(!buf.text().contains('%'), "{}", buf.text());
    }

    #[test]
    fn a_total_learned_late_starts_reporting_percentages() {
        let (p, buf) = harness();
        let t = p.task("extract", None, Unit::Files);
        t.advance(5); // no total yet - silent
        t.set_total(10);
        t.advance(5); // now 10/10
        t.done();
        assert!(buf.text().contains("100%"), "{}", buf.text());
    }

    #[test]
    fn skipping_prints_the_reason_because_a_skip_is_a_result() {
        let (p, buf) = harness();
        p.task("Foo.7z", Some(1), Unit::Mods).skipped("bytes already match");
        assert!(buf.text().contains("skip Foo.7z - bytes already match"), "{}", buf.text());
    }

    #[test]
    fn bytes_render_human_scaled_not_raw() {
        assert_eq!(bytes(512), "512 B");
        assert_eq!(bytes(1024), "1.0 KiB");
        assert_eq!(bytes(1536), "1.5 KiB");
        assert_eq!(bytes(1024 * 1024 * 3), "3.0 MiB");
    }
}
