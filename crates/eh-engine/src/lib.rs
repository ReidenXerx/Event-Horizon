//! Orchestration. The only thing a user interface may depend on.
//!
//! ─── SCOPE ──────────────────────────────────────────────────────────────
//! Drives verify → resolve → download/extract → FOMOD replay → deploy →
//! load order → receipt, and owns resume-after-crash. Every shell — the CLI
//! today, Tauri later, a Vortex sidecar if the extension ever switches — is
//! a thin adapter over this.
//!
//! ─── NS-4: SHELLS HOLD NO LOGIC ─────────────────────────────────────────
//! `eh-cli` and any future `eh-tauri` must contain nothing that is not
//! reachable from here. The moment a GUI grows its own install path,
//! "unification" becomes a rewrite and the project has two installers that
//! disagree. This is how most mod managers acquire their second, worse one.
//!
//! ─── SEQUENTIAL, NOT CONCURRENT ─────────────────────────────────────────
//! Installing one mod at a time is a correctness property, not a performance
//! oversight. Parallel installs lose files.
//!
//! ─── EVERY ENDING LEAVES A TRACE ────────────────────────────────────────
//! Success writes a receipt; a crash leaves a marker; a cancelled or failed
//! run records which phase it stopped in and how far it got. A run that
//! stopped at 963 of 967 mods must not present as a machine with nothing
//! installed.
//!
//! STATUS: skeleton. No behaviour yet.

#![forbid(unsafe_code)]

use eh_progress::Task;
use std::path::Path;

/// Unpack one archive into a directory.
///
/// A passthrough today, and it exists so the CLI does not reach past the
/// engine into `eh-archive` (NS-4). When extraction grows the things a real
/// install needs — retry on a partial read, quarantining a mod whose archive
/// refused entries — it grows HERE, and every shell gets it for free.
pub fn unpack(
    archive: &Path,
    dest: &Path,
    task: &Task,
) -> Result<eh_archive::Extraction, eh_archive::ArchiveError> {
    eh_archive::extract(archive, dest, task)
}
