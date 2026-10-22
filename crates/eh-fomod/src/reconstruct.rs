//! Rebuild a mod's staging folder from its recorded file list, by content.
//!
//! ─── WHY THIS INSTALLS A FOMOD WITHOUT RUNNING IT ───────────────────────
//! An XML FOMOD only ever COPIES archive entries to destinations; it never
//! changes a byte. So every file of a FOMOD install is an archive entry, at a
//! path the script chose. A `thorough` manifest records exactly that outcome
//! for the curator's install — every staged path with its SHA-256 — and the
//! archive supplies the bytes. Joining the two by hash reproduces the
//! curator's staging folder without evaluating a line of the script: no
//! conditional patterns, no flags, no group rules, and no guessing what an
//! empty `fomodSelections` meant (NS-8).
//!
//! ─── WHAT THIS DELIBERATELY REPRODUCES ──────────────────────────────────
//! The curator's staging, exactly — INCLUDING anything Vortex lost while
//! installing it on the curator's machine. That is the one thing a replay of
//! the script would catch and this cannot, and it is why the recorded
//! `fomodSelections` are kept: a later replay cross-checks this result and
//! WARNS. It never decides what gets installed.
//!
//! ─── PLAN, THEN WRITE ───────────────────────────────────────────────────
//! [`plan`] decides everything and writes nothing, so a mod that cannot be
//! reproduced is known before a byte lands. [`StagingPlan::apply`] refuses an
//! incomplete plan and refuses a destination that already holds anything: a
//! staging folder this did not create is not this code's to overwrite (NS-2).

use eh_identity::{sha256_file, HashingWriter};
use eh_progress::{Task, Unit};
use ehcoll::EhcollStagingFile;
use std::collections::HashMap;
use std::fmt;
use std::fs::{self, File};
use std::io::{self, BufReader, BufWriter};
use std::path::{Path, PathBuf};

/// Every file the install may draw bytes from, keyed by SHA-256.
///
/// Typically the extracted archive, plus — for a mirrored mod — the package's
/// `mirror/` files. File NAMES play no part: two entries with one hash are
/// the same bytes, and either will do.
#[derive(Debug, Default, Clone)]
pub struct ContentIndex {
    by_hash: HashMap<String, Source>,
    files: u64,
}

#[derive(Debug, Clone)]
struct Source {
    path: PathBuf,
    size: u64,
}

impl ContentIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// Hash every regular file under `root`. Symlinks are not followed: an
    /// extraction never writes one, so one here was not put there by us.
    pub fn add_tree(&mut self, root: &Path, task: &Task) -> io::Result<()> {
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let mut entries: Vec<_> = fs::read_dir(&dir)?.collect::<Result<_, _>>()?;
            // Deterministic order, so which of two identical files is used
            // does not depend on the filesystem's mood.
            entries.sort_by_key(|e| e.file_name());
            for entry in entries {
                let kind = entry.file_type()?;
                if kind.is_dir() {
                    stack.push(entry.path());
                } else if kind.is_file() {
                    self.add_file(&entry.path(), task)?;
                }
            }
        }
        Ok(())
    }

    /// Hash one file into the index and return its SHA-256.
    pub fn add_file(&mut self, path: &Path, task: &Task) -> io::Result<String> {
        let (hash, size) = sha256_file(path, Some(task))?;
        self.files += 1;
        self.by_hash
            .entry(hash.clone())
            .or_insert_with(|| Source { path: path.to_path_buf(), size });
        Ok(hash)
    }

    /// Files hashed so far, duplicates included.
    pub fn files(&self) -> u64 {
        self.files
    }

    fn get(&self, sha256: &str) -> Option<&Source> {
        self.by_hash.get(sha256)
    }
}

/// A staged file nothing in the index can supply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissingFile {
    pub path: String,
    pub sha256: String,
}

/// One file to write: these bytes, at this path.
#[derive(Debug, Clone)]
struct Copy {
    path: String,
    sha256: String,
    size: u64,
    source: PathBuf,
}

/// What reconstructing a mod's staging folder would do, before it does it.
#[derive(Debug, Clone)]
pub struct StagingPlan {
    copies: Vec<Copy>,
    /// Recorded with a hash nothing in the index has. Either the package
    /// should have carried it (a mirror/bundle problem) or the archive is not
    /// the one the curator installed.
    pub missing: Vec<MissingFile>,
    /// Recorded with no hash at all — a `fast` or `none` build. This method
    /// cannot place such a file, and will not guess which entry it was.
    pub unhashed: Vec<String>,
}

impl StagingPlan {
    /// True when every recorded file has a source.
    pub fn is_complete(&self) -> bool {
        self.missing.is_empty() && self.unhashed.is_empty()
    }

    /// Files the plan would write.
    pub fn len(&self) -> usize {
        self.copies.len()
    }

    pub fn is_empty(&self) -> bool {
        self.copies.is_empty()
    }

    /// Bytes the plan would write.
    pub fn bytes(&self) -> u64 {
        self.copies.iter().map(|c| c.size).sum()
    }

    /// Write every file into `dest`, which must not exist or be empty.
    ///
    /// Each file's bytes are hashed AS they are written, so what this reports
    /// as written is what is on disk — not what was on disk when the index
    /// was built.
    pub fn apply(&self, dest: &Path, task: &Task) -> Result<Applied, ReconstructError> {
        if !self.is_complete() {
            return Err(ReconstructError::Incomplete {
                missing: self.missing.len(),
                unhashed: self.unhashed.len(),
            });
        }
        // Every path is checked before anything is written, so a bad entry
        // late in the list cannot leave a half-built staging folder behind.
        // Paths were validated by the manifest parser; this is the second
        // lock on the same door, because this is the code that writes.
        let targets = self
            .copies
            .iter()
            .map(|c| {
                eh_archive::safe_join(dest, &c.path)
                    .map_err(|why| ReconstructError::UnsafePath { path: c.path.clone(), why: why.as_str() })
            })
            .collect::<Result<Vec<_>, _>>()?;
        match fs::read_dir(dest) {
            Ok(mut it) => {
                if it.next().is_some() {
                    return Err(ReconstructError::DestinationNotEmpty(dest.to_path_buf()));
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => fs::create_dir_all(dest)?,
            Err(e) => return Err(e.into()),
        }

        task.set_total(self.bytes());
        let mut bytes = 0u64;
        for (copy, target) in self.copies.iter().zip(&targets) {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            let (got, n) = copy_hashed(&copy.source, target)?;
            if got != copy.sha256 || n != copy.size {
                let _ = fs::remove_file(target);
                return Err(ReconstructError::SourceChanged {
                    path: copy.path.clone(),
                    source: copy.source.clone(),
                    expected: copy.sha256.clone(),
                    got,
                });
            }
            bytes += n;
            task.advance(n);
        }
        Ok(Applied { files: self.copies.len() as u64, bytes })
    }
}

/// Copy `from` to `to`, returning the SHA-256 and length of what was written.
/// The file is written under a temporary name and renamed into place, so an
/// interrupted copy never leaves a plausible-looking half file.
fn copy_hashed(from: &Path, to: &Path) -> io::Result<(String, u64)> {
    let part = to.with_file_name(format!(
        "{}.eh-part",
        to.file_name().map(|n| n.to_string_lossy()).unwrap_or_default()
    ));
    let mut reader = BufReader::new(File::open(from)?);
    let mut writer = HashingWriter::new(BufWriter::new(File::create(&part)?));
    io::copy(&mut reader, &mut writer)?;
    let (inner, hash, n) = writer.finish()?;
    inner.into_inner().map_err(|e| e.into_error())?.sync_all()?;
    fs::rename(&part, to)?;
    Ok((hash, n))
}

/// What [`StagingPlan::apply`] wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Applied {
    pub files: u64,
    pub bytes: u64,
}

/// Match every recorded staging file to a source in `index`. Writes nothing.
pub fn plan(files: &[EhcollStagingFile], index: &ContentIndex) -> StagingPlan {
    let mut copies = Vec::with_capacity(files.len());
    let mut missing = Vec::new();
    let mut unhashed = Vec::new();
    for f in files {
        let Some(sha) = &f.sha256 else {
            unhashed.push(f.path.clone());
            continue;
        };
        match index.get(sha) {
            // A hash match whose SIZE disagrees with the record means the
            // record is inconsistent with itself; treat it as missing rather
            // than write bytes the manifest describes two different ways.
            Some(src) if src.size == f.size => copies.push(Copy {
                path: f.path.clone(),
                sha256: sha.clone(),
                size: f.size,
                source: src.path.clone(),
            }),
            _ => missing.push(MissingFile { path: f.path.clone(), sha256: sha.clone() }),
        }
    }
    StagingPlan { copies, missing, unhashed }
}

/// Convenience for the common shape: index these trees, plan, and report.
pub fn plan_from_trees(
    files: &[EhcollStagingFile],
    trees: &[&Path],
    task: &Task,
) -> io::Result<StagingPlan> {
    let hashing = task.child("hash sources", None, Unit::Bytes);
    let mut index = ContentIndex::new();
    for tree in trees {
        index.add_tree(tree, &hashing)?;
    }
    hashing.done();
    Ok(plan(files, &index))
}

#[derive(Debug)]
pub enum ReconstructError {
    Io(io::Error),
    /// The plan has files it cannot place. Nothing was written.
    Incomplete { missing: usize, unhashed: usize },
    /// The destination already holds something. Nothing was written.
    DestinationNotEmpty(PathBuf),
    UnsafePath { path: String, why: &'static str },
    /// A source file's bytes differ from when it was indexed.
    SourceChanged { path: String, source: PathBuf, expected: String, got: String },
}

impl fmt::Display for ReconstructError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(e) => write!(f, "{e}"),
            Self::Incomplete { missing, unhashed } => write!(
                f,
                "cannot reproduce this mod's staging: {missing} recorded file(s) have no source \
                 and {unhashed} have no recorded hash; nothing was written"
            ),
            Self::DestinationNotEmpty(p) => {
                write!(f, "{} already has files in it; refusing to write over them", p.display())
            }
            Self::UnsafePath { path, why } => write!(f, "refused to write {path:?}: {why}"),
            Self::SourceChanged { path, source, expected, got } => write!(
                f,
                "{path}: source {} changed after it was indexed (expected sha256 {expected}, wrote {got})",
                source.display()
            ),
        }
    }
}

impl std::error::Error for ReconstructError {}

impl From<io::Error> for ReconstructError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}
