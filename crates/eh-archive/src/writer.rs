//! The shared write path. Every backend goes through this, so refusal and
//! collision behaviour is a property of the crate rather than of whichever
//! container the mod happened to be packed in.

use crate::format::Format;
use crate::safety::{safe_join, CaseCollision, CaseWatch, RefusalReason};
use crate::{Extraction, Refusal};
use std::path::{Path, PathBuf};

pub(crate) struct Writer {
    dest: PathBuf,
    via: Format,
    files: u64,
    directories: u64,
    bytes: u64,
    refused: Vec<Refusal>,
    collisions: Vec<CaseCollision>,
    watch: CaseWatch,
}

impl Writer {
    pub(crate) fn new(dest: &Path, via: Format) -> Self {
        Self {
            dest: dest.to_path_buf(),
            via,
            files: 0,
            directories: 0,
            bytes: 0,
            refused: Vec::new(),
            collisions: Vec::new(),
            watch: CaseWatch::new(),
        }
    }

    /// Resolve an entry path, recording a refusal instead of returning one.
    /// `None` means: skip this entry, it has already been accounted for.
    pub(crate) fn resolve(&mut self, raw: &str) -> Option<PathBuf> {
        if let Some(collision) = self.watch.observe(raw) {
            self.collisions.push(collision);
        }
        match safe_join(&self.dest, raw) {
            Ok(path) => Some(path),
            Err(why) => {
                self.refused.push(Refusal { raw: raw.to_owned(), why });
                None
            }
        }
    }

    pub(crate) fn make_dir(&mut self, path: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(path)?;
        self.directories += 1;
        Ok(())
    }

    /// Ensure an entry's parent exists. Archives do not reliably carry
    /// directory entries, so relying on them loses files.
    pub(crate) fn prepare_parent(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        Ok(())
    }

    pub(crate) fn wrote_file(&mut self, bytes: u64) {
        self.files += 1;
        self.bytes += bytes;
    }

    pub(crate) fn finish(self) -> Extraction {
        Extraction {
            via: self.via,
            files: self.files,
            directories: self.directories,
            bytes: self.bytes,
            refused: self.refused,
            case_collisions: self.collisions,
        }
    }
}

/// Refusals are data, so a caller can decide. Convenience for the common
/// "did anything look hostile?" question.
impl Extraction {
    pub fn refused_traversals(&self) -> usize {
        self.refused
            .iter()
            .filter(|r| matches!(r.why, RefusalReason::Traversal | RefusalReason::Absolute))
            .count()
    }
}
