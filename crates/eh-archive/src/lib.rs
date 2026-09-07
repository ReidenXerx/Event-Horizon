//! Extraction, behind one trait.
//!
//! ─── SCOPE ──────────────────────────────────────────────────────────────
//! List and extract ZIP / 7z / RAR. Format is decided by CONTENT, path safety
//! and case-collision reporting are shared across every backend, and progress
//! is reported through `eh-progress` rather than printed.
//!
//! ─── UNREADABLE IS A RESULT, NOT AN ERROR ───────────────────────────────
//! Callers use this while explaining some other failure, so it reports why it
//! could not read rather than panicking into the middle of a diagnosis. Which
//! backend answered is kept in [`Extraction::via`], because on a broken
//! Wine prefix "which reader worked" is itself the diagnosis.
//!
//! ─── RAR IS OPT-IN, AND THE LICENCE GATE DOES NOT COVER IT ──────────────
//! LoversLab ships a lot of `.rar`, so RAR matters for this domain. But the
//! `unrar` crate declares `MIT OR Apache-2.0` while `unrar_sys` **vendors
//! ~21,000 lines of UnRAR C++** under the UnRAR licence
//! (`unrar_sys-0.5.8/vendor/unrar/license.txt`), which forbids using the
//! source to recreate the RAR compression algorithm and makes the result
//! non-free by Debian's standards.
//!
//! `cargo deny check licenses` reads crate METADATA and passes this happily.
//! The gate is green and wrong — which is exactly why RAR is behind the
//! `rar` feature, off by default, so the exposure is an explicit decision
//! rather than something inherited by anyone who types `cargo build`.
//!
//! It is not copyleft, so it will not relicense us. It does mean a distro
//! package is off the table and Flatpak/AppImage is the delivery story.

#![forbid(unsafe_code)]

mod backends;
pub mod format;
pub mod safety;
mod writer;

pub use format::{detect, sniff, Format};
pub use safety::{safe_join, CaseCollision, RefusalReason};

use eh_progress::Task;
use std::fmt;
use std::path::Path;

/// An entry that was not written, and why. Never silent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    /// The path exactly as the archive spelled it, for a human to read.
    pub raw: String,
    pub why: RefusalReason,
}

/// What an extraction actually did.
#[derive(Debug, Clone)]
pub struct Extraction {
    /// Which backend answered. Diagnostic in its own right.
    pub via: Format,
    pub files: u64,
    pub directories: u64,
    pub bytes: u64,
    /// Entries declined for safety. An empty vec is the normal case; a
    /// non-empty one is worth showing a human.
    pub refused: Vec<Refusal>,
    /// Entries differing only by case. Harmless on Windows, two files on
    /// Linux, and a game under Proton will find only one of them.
    pub case_collisions: Vec<CaseCollision>,
}

#[derive(Debug)]
pub enum ArchiveError {
    Io(std::io::Error),
    /// No backend recognised the leading bytes. A file no reader can open is
    /// a damaged or truncated download, which is a different problem from a
    /// mod that installed wrongly — and only one of them is fixed by
    /// downloading it again.
    Unrecognised { head: Vec<u8> },
    /// Recognised, but this build cannot read it. Distinct from corruption:
    /// the user needs a different binary, not a different file.
    Unsupported { format: Format, why: String },
    /// Recognised and readable, but the backend failed partway.
    Backend { format: Format, why: String },
}

impl fmt::Display for ArchiveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ArchiveError::Io(e) => write!(f, "{e}"),
            ArchiveError::Unrecognised { head } => {
                write!(f, "no reader recognised this file (starts with {head:02x?})")
            }
            ArchiveError::Unsupported { format, why } => {
                write!(f, "{} archives are not supported by this build: {why}", format.as_str())
            }
            ArchiveError::Backend { format, why } => {
                write!(f, "{} reader failed: {why}", format.as_str())
            }
        }
    }
}

impl std::error::Error for ArchiveError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            ArchiveError::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl From<std::io::Error> for ArchiveError {
    fn from(e: std::io::Error) -> Self {
        ArchiveError::Io(e)
    }
}

/// Unpack `archive` into `dest`, reporting progress into `task`.
///
/// `dest` is created if absent. The entry count is not known until the
/// container's directory has been read, so `task` starts indeterminate and
/// gains a total partway through — see [`eh_progress::Task::set_total`].
pub fn extract(archive: &Path, dest: &Path, task: &Task) -> Result<Extraction, ArchiveError> {
    let (format, head) = format::detect(archive)?;
    let Some(format) = format else {
        return Err(ArchiveError::Unrecognised { head });
    };
    std::fs::create_dir_all(dest)?;
    task.message(format!("reading {} archive", format.as_str()));

    match format {
        Format::Zip => backends::zip::extract(archive, dest, task),
        Format::SevenZip => backends::sevenz::extract(archive, dest, task),
        Format::Rar => backends::rar::extract(archive, dest, task),
    }
}
