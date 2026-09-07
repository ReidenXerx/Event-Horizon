//! The interactive renderer: live bars, one per task, nested by indent.
//!
//! Finished child bars are CLEARED rather than left on screen — a 954-mod
//! install would otherwise scroll a thousand completed bars past anything you
//! wanted to read. Anything that did not simply succeed is instead printed as
//! a permanent line above the bars, so failures and skips survive the run and
//! successes do not bury them.

use eh_progress::{Outcome, ProgressSink, TaskId, Unit};
use indicatif::{MultiProgress, ProgressBar, ProgressStyle};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

pub struct TtySink {
    multi: MultiProgress,
    bars: Mutex<HashMap<TaskId, (ProgressBar, usize)>>,
}

impl TtySink {
    pub fn new() -> Self {
        Self { multi: MultiProgress::new(), bars: Mutex::new(HashMap::new()) }
    }
}

impl Default for TtySink {
    fn default() -> Self {
        Self::new()
    }
}

impl ProgressSink for TtySink {
    fn begin(&self, id: TaskId, parent: Option<TaskId>, label: &str, total: Option<u64>, unit: Unit) {
        let Ok(mut bars) = self.bars.lock() else { return };
        let depth = parent.and_then(|p| bars.get(&p).map(|(_, d)| d + 1)).unwrap_or(0);

        let bar = match total {
            Some(t) => ProgressBar::new(t),
            None => ProgressBar::new_spinner(),
        };
        bar.set_style(style_for(unit, total.is_some()));
        bar.set_prefix(format!("{}{label}", "  ".repeat(depth)));
        let bar = self.multi.add(bar);
        if total.is_none() {
            // Without a steady tick an indeterminate bar looks frozen during
            // a long blocking read, which reads as a hang.
            bar.enable_steady_tick(Duration::from_millis(120));
        }
        bars.insert(id, (bar, depth));
    }

    fn advance(&self, id: TaskId, delta: u64) {
        if let Ok(bars) = self.bars.lock() {
            if let Some((bar, _)) = bars.get(&id) {
                bar.inc(delta);
            }
        }
    }

    fn set_total(&self, id: TaskId, total: u64) {
        if let Ok(bars) = self.bars.lock() {
            if let Some((bar, _)) = bars.get(&id) {
                bar.set_length(total);
                // It was a spinner until the total arrived; give it a bar.
                bar.set_style(style_for(Unit::Files, true));
            }
        }
    }

    fn message(&self, id: TaskId, msg: &str) {
        if let Ok(bars) = self.bars.lock() {
            if let Some((bar, _)) = bars.get(&id) {
                bar.set_message(msg.to_owned());
            }
        }
    }

    fn end(&self, id: TaskId, outcome: Outcome) {
        let Ok(mut bars) = self.bars.lock() else { return };
        let Some((bar, depth)) = bars.remove(&id) else { return };
        let label = bar.prefix();

        // Plain success at depth disappears. Everything else leaves a mark.
        let note = match &outcome {
            Outcome::Done if depth > 0 => None,
            Outcome::Done => Some(format!("ok   {label}")),
            Outcome::Skipped(why) => Some(format!("skip {label} - {why}")),
            Outcome::Failed(why) => Some(format!("FAIL {label} - {why}")),
            Outcome::Abandoned => Some(format!("????  {label} - abandoned without an outcome")),
        };
        bar.finish_and_clear();
        if let Some(note) = note {
            let _ = self.multi.println(note);
        }
    }
}

fn style_for(unit: Unit, determinate: bool) -> ProgressStyle {
    let template = match (determinate, unit) {
        (false, _) => "{prefix:.bold} {spinner} {msg}",
        (true, Unit::Bytes) => {
            "{prefix:.bold} [{bar:24.cyan/blue}] {bytes}/{total_bytes} ({bytes_per_sec}, eta {eta})"
        }
        (true, _) => "{prefix:.bold} [{bar:24.cyan/blue}] {pos}/{len} {msg}",
    };
    ProgressStyle::with_template(template)
        .unwrap_or_else(|_| ProgressStyle::default_bar())
        .progress_chars("=> ")
}
