//! Rendering lives HERE, never in the engine (NS-4).
//!
//! `eh-engine` and everything under it emit `eh_progress` events and have no
//! idea whether anything is drawing them. That is what lets a future
//! `eh-tauri` reuse the same engine by supplying its own sink instead of
//! reimplementing the install loop with progress bolted through it.

pub mod plain;
pub mod tty;

use eh_progress::Progress;
use std::io::IsTerminal;
use std::sync::Arc;

/// Pick a renderer from the environment.
///
/// Progress goes to **stderr** so that stdout stays a clean channel for
/// machine-readable output — a curator piping `eh verify` into a report must
/// not get spinner frames in their JSON.
pub fn for_environment() -> Progress {
    if std::io::stderr().is_terminal() {
        Progress::new(Arc::new(tty::TtySink::new()))
    } else {
        Progress::new(Arc::new(plain::PlainSink::new(std::io::stderr())))
    }
}
