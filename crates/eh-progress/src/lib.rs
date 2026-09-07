//! Progress reporting: what the engine SAYS. Not what anything draws.
//!
//! ─── WHY THIS IS ITS OWN LEAF CRATE ─────────────────────────────────────
//! A loader is two separate things and conflating them is how a project ends
//! up with two of them:
//!
//!   * **reporting** — "I am 40 MB into a 300 MB download". Emitted from deep
//!     inside `eh-archive`, `eh-identity`, `eh-engine`. That is this crate.
//!   * **rendering** — bars, spinners, ANSI, log lines. That is `eh-cli`
//!     today and `eh-tauri` later, and neither belongs in the engine (NS-4).
//!
//! It is a LEAF because `eh-archive` and `eh-identity` do long work and must
//! report, and they cannot depend on `eh-engine` — that edge points the wrong
//! way. So everything depends on this, and this depends on nothing.
//!
//! ─── ITEM COUNTS LIE ON REAL COLLECTIONS ────────────────────────────────
//! Measured on a real 954-mod install: median per-mod time 4 ms, 99th
//! percentile 491 **seconds**. "Mod 34 of 954" as a progress bar is therefore
//! not a rough estimate, it is wrong — the bar crawls, then teleports. Weight
//! by BYTES wherever bytes are known ({@link Unit::Bytes}) and reserve item
//! counts for things that genuinely are uniform.
//!
//! ─── EVERY ENDING LEAVES A TRACE ────────────────────────────────────────
//! A {@link Task} dropped without an explicit outcome ends as
//! {@link Outcome::Abandoned}, not silently. A spinner that simply stops is
//! indistinguishable from one still running, and "which phase did it die in"
//! is the first question asked of any failed install.

#![forbid(unsafe_code)]

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

/// Identifies one task for the lifetime of a run. Not stable across runs.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub struct TaskId(pub u64);

/// What the numbers mean. Renderers format by this — bytes want human sizes
/// and a transfer rate; a step count wants neither.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Unit {
    Bytes,
    Files,
    Mods,
    Steps,
}

impl Unit {
    /// Singular/plural noun for a renderer that wants to write it out.
    pub fn noun(self, n: u64) -> &'static str {
        match (self, n) {
            (Unit::Bytes, _) => "bytes",
            (Unit::Files, 1) => "file",
            (Unit::Files, _) => "files",
            (Unit::Mods, 1) => "mod",
            (Unit::Mods, _) => "mods",
            (Unit::Steps, 1) => "step",
            (Unit::Steps, _) => "steps",
        }
    }
}

/// How a task ended. There is no "unknown" — see the crate docs.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Outcome {
    Done,
    /// Deliberately not done, with the reason. Skipping is a RESULT — a mod
    /// already present byte-for-byte is a success, not an omission.
    Skipped(String),
    Failed(String),
    /// Dropped without an outcome. Always a bug in the caller, and visible
    /// rather than silent.
    Abandoned,
}

/// Receives events. Implement this to render, log, or record.
///
/// Implementations must be cheap: these are called from hot loops (per
/// archive entry, per hashed block) and the engine must not pay for a
/// renderer nobody is watching.
pub trait ProgressSink: Send + Sync {
    fn begin(&self, id: TaskId, parent: Option<TaskId>, label: &str, total: Option<u64>, unit: Unit);
    fn advance(&self, id: TaskId, delta: u64);
    /// Totals are often learned late — an archive's entry count is not known
    /// until its directory is read. Late is normal, not exceptional.
    fn set_total(&self, id: TaskId, total: u64);
    fn message(&self, id: TaskId, msg: &str);
    fn end(&self, id: TaskId, outcome: Outcome);
}

/// Discards everything. The default for tests, CI and library use.
pub struct NoopSink;

impl ProgressSink for NoopSink {
    fn begin(&self, _: TaskId, _: Option<TaskId>, _: &str, _: Option<u64>, _: Unit) {}
    fn advance(&self, _: TaskId, _: u64) {}
    fn set_total(&self, _: TaskId, _: u64) {}
    fn message(&self, _: TaskId, _: &str) {}
    fn end(&self, _: TaskId, _: Outcome) {}
}

/// The handle threaded through the engine. Cheap to clone.
#[derive(Clone)]
pub struct Progress {
    sink: Arc<dyn ProgressSink>,
    next_id: Arc<AtomicU64>,
}

impl Progress {
    pub fn new(sink: Arc<dyn ProgressSink>) -> Self {
        Self { sink, next_id: Arc::new(AtomicU64::new(0)) }
    }

    /// A `Progress` that reports nowhere. Use in tests and when embedding.
    pub fn silent() -> Self {
        Self::new(Arc::new(NoopSink))
    }

    /// Start a top-level task. `total: None` means indeterminate — the
    /// renderer shows a spinner rather than inventing a percentage.
    pub fn task(&self, label: impl AsRef<str>, total: Option<u64>, unit: Unit) -> Task {
        self.spawn(None, label.as_ref(), total, unit)
    }

    fn spawn(&self, parent: Option<TaskId>, label: &str, total: Option<u64>, unit: Unit) -> Task {
        let id = TaskId(self.next_id.fetch_add(1, Ordering::Relaxed));
        self.sink.begin(id, parent, label, total, unit);
        Task { id, progress: self.clone(), ended: AtomicBool::new(false) }
    }
}

/// One unit of work. Ends when consumed by [`Task::done`] and friends, or as
/// [`Outcome::Abandoned`] when dropped.
pub struct Task {
    id: TaskId,
    progress: Progress,
    ended: AtomicBool,
}

impl Task {
    pub fn id(&self) -> TaskId {
        self.id
    }

    /// A nested task — "extracting" under "installing Foo" under "install".
    pub fn child(&self, label: impl AsRef<str>, total: Option<u64>, unit: Unit) -> Task {
        self.progress.spawn(Some(self.id), label.as_ref(), total, unit)
    }

    pub fn advance(&self, delta: u64) {
        self.progress.sink.advance(self.id, delta);
    }

    /// Set the total once it becomes known. See [`ProgressSink::set_total`].
    pub fn set_total(&self, total: u64) {
        self.progress.sink.set_total(self.id, total);
    }

    pub fn message(&self, msg: impl AsRef<str>) {
        self.progress.sink.message(self.id, msg.as_ref());
    }

    pub fn done(self) {
        self.settle(Outcome::Done);
    }

    pub fn skipped(self, why: impl Into<String>) {
        self.settle(Outcome::Skipped(why.into()));
    }

    pub fn failed(self, why: impl Into<String>) {
        self.settle(Outcome::Failed(why.into()));
    }

    fn settle(&self, outcome: Outcome) {
        if !self.ended.swap(true, Ordering::SeqCst) {
            self.progress.sink.end(self.id, outcome);
        }
    }
}

impl Drop for Task {
    fn drop(&mut self) {
        self.settle(Outcome::Abandoned);
    }
}

/// Captures every event for assertions. Progress is behaviour, so it is
/// testable behaviour.
pub mod recording {
    use super::*;
    use std::sync::Mutex;

    #[derive(Clone, PartialEq, Eq, Debug)]
    pub enum Event {
        Begin { id: TaskId, parent: Option<TaskId>, label: String, total: Option<u64>, unit: Unit },
        Advance { id: TaskId, delta: u64 },
        SetTotal { id: TaskId, total: u64 },
        Message { id: TaskId, msg: String },
        End { id: TaskId, outcome: Outcome },
    }

    #[derive(Default)]
    pub struct RecordingSink {
        events: Mutex<Vec<Event>>,
    }

    impl RecordingSink {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn events(&self) -> Vec<Event> {
            self.events.lock().expect("progress recorder poisoned").clone()
        }

        fn push(&self, e: Event) {
            self.events.lock().expect("progress recorder poisoned").push(e);
        }
    }

    impl ProgressSink for RecordingSink {
        fn begin(&self, id: TaskId, parent: Option<TaskId>, label: &str, total: Option<u64>, unit: Unit) {
            self.push(Event::Begin { id, parent, label: label.to_owned(), total, unit });
        }
        fn advance(&self, id: TaskId, delta: u64) {
            self.push(Event::Advance { id, delta });
        }
        fn set_total(&self, id: TaskId, total: u64) {
            self.push(Event::SetTotal { id, total });
        }
        fn message(&self, id: TaskId, msg: &str) {
            self.push(Event::Message { id, msg: msg.to_owned() });
        }
        fn end(&self, id: TaskId, outcome: Outcome) {
            self.push(Event::End { id, outcome });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::recording::{Event, RecordingSink};
    use super::*;

    fn harness() -> (Progress, Arc<RecordingSink>) {
        let sink = Arc::new(RecordingSink::new());
        (Progress::new(sink.clone()), sink)
    }

    #[test]
    fn an_explicit_outcome_is_recorded_once() {
        let (p, sink) = harness();
        p.task("verify", Some(3), Unit::Mods).done();
        let ends: Vec<_> = sink
            .events()
            .into_iter()
            .filter(|e| matches!(e, Event::End { .. }))
            .collect();
        assert_eq!(ends, vec![Event::End { id: TaskId(0), outcome: Outcome::Done }]);
    }

    #[test]
    fn dropping_without_an_outcome_is_abandoned_not_silence() {
        let (p, sink) = harness();
        drop(p.task("download", None, Unit::Bytes));
        assert!(sink
            .events()
            .iter()
            .any(|e| matches!(e, Event::End { outcome: Outcome::Abandoned, .. })));
    }

    #[test]
    fn a_child_carries_its_parent() {
        let (p, sink) = harness();
        let parent = p.task("install", Some(2), Unit::Mods);
        parent.child("extract", None, Unit::Files).done();
        let begins: Vec<_> = sink
            .events()
            .into_iter()
            .filter_map(|e| match e {
                Event::Begin { id, parent, .. } => Some((id, parent)),
                _ => None,
            })
            .collect();
        assert_eq!(begins, vec![(TaskId(0), None), (TaskId(1), Some(TaskId(0)))]);
        parent.done();
    }

    #[test]
    fn a_total_learned_late_is_reported() {
        let (p, sink) = harness();
        let t = p.task("extract", None, Unit::Files);
        t.set_total(42);
        t.advance(7);
        t.done();
        let evs = sink.events();
        assert!(evs.contains(&Event::SetTotal { id: TaskId(0), total: 42 }));
        assert!(evs.contains(&Event::Advance { id: TaskId(0), delta: 7 }));
    }

    #[test]
    fn skipping_carries_its_reason() {
        let (p, sink) = harness();
        p.task("Foo.7z", Some(1), Unit::Mods).skipped("already present, bytes match");
        assert!(sink.events().iter().any(|e| matches!(
            e,
            Event::End { outcome: Outcome::Skipped(why), .. } if why == "already present, bytes match"
        )));
    }

    #[test]
    fn silent_progress_does_not_panic_and_still_nests() {
        let p = Progress::silent();
        let t = p.task("install", Some(1), Unit::Mods);
        t.child("hash", Some(1024), Unit::Bytes).done();
        t.done();
    }
}
