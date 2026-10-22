//! Part 3 of deployment: put the planned files into the game, as hardlinks.
//!
//! ─── THE RECORD MUST NEVER MISS A FILE ──────────────────────────────────
//! A file placed but not recorded is the worst outcome here: purge could not
//! remove it, and the next deployment would take our own file for a foreign
//! one and back it up. So every action is written to a JOURNAL before it is
//! done — "backing up X", "linking Y from mod Z", "creating folder W" — and a
//! run that dies halfway leaves a journal the next run reads and finishes
//! from. A finished run folds the journal into the deployment record.
//!
//! A link is made under a fixed temporary name and renamed into place, so a
//! crash never leaves a half-made file under the real name, and the next run
//! knows exactly which leftover to remove.
//!
//! ─── A FILE THAT IS NOT OURS IS BACKED UP, NEVER DESTROYED ──────────────
//! Decided 2026-10-22 (Vortex's way). The original is moved — a rename on the
//! same filesystem, which pre-flight proved — into the backup folder, with
//! its SHA-256 recorded so the restore can be checked byte for byte. A backup
//! already at that place is never overwritten: that file is refused (NS-2).

use crate::plan::DeployPlan;
use crate::preflight::Preflight;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

pub const RECORD_FORMAT: u32 = 1;

/// A file Event Horizon put in the game folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeployedFile {
    /// Relative to the game folder, spelled as on disk.
    pub path: String,
    pub mod_key: String,
    /// The link's identity: it is ours only while these still match.
    pub dev: u64,
    pub ino: u64,
    pub size: u64,
}

/// A file that was in the game folder before us, moved aside.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupEntry {
    /// Where it was, relative to the game folder.
    pub path: String,
    /// Where it is now, relative to the backup folder.
    pub stored: String,
    pub sha256: String,
    pub size: u64,
}

/// What a deployment put where. Kept in the instance.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Record {
    pub format: u32,
    pub files: Vec<DeployedFile>,
    pub backups: Vec<BackupEntry>,
    /// Folders we created, relative to the game folder, parents first.
    pub created_dirs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum Entry {
    Link(DeployedFile),
    Backup(BackupEntry),
    Mkdir { path: String },
}

/// The deployment record and its journal, in the instance folder.
pub struct Store {
    record: PathBuf,
    journal: PathBuf,
}

impl Store {
    pub fn new(instance_dir: &Path) -> Self {
        Self { record: instance_dir.join("deployment.json"), journal: instance_dir.join("deployment.journal") }
    }

    /// True when a run stopped before finishing.
    pub fn interrupted(&self) -> bool {
        self.journal.exists()
    }

    /// The record, with any unfinished run's journal replayed onto it.
    pub fn load(&self) -> Result<Record, ApplyError> {
        let mut record = match fs::read_to_string(&self.record) {
            Ok(text) => {
                let r: Record =
                    serde_json::from_str(&text).map_err(|e| ApplyError::Record(self.record.clone(), e.to_string()))?;
                if r.format != RECORD_FORMAT {
                    return Err(ApplyError::Record(
                        self.record.clone(),
                        format!("format {} is not one this version reads", r.format),
                    ));
                }
                r
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => Record { format: RECORD_FORMAT, ..Record::default() },
            Err(e) => return Err(ApplyError::Io(self.record.clone(), e)),
        };
        if let Ok(f) = File::open(&self.journal) {
            for line in BufReader::new(f).lines() {
                let line = line.map_err(|e| ApplyError::Io(self.journal.clone(), e))?;
                // A line cut off by the crash itself names nothing complete.
                let Ok(entry) = serde_json::from_str::<Entry>(&line) else { continue };
                fold(&mut record, entry);
            }
        }
        Ok(record)
    }

    fn append(&self, journal: &mut File, entry: &Entry) -> Result<(), ApplyError> {
        let mut line = serde_json::to_string(entry).expect("journal entries serialise");
        line.push('\n');
        journal.write_all(line.as_bytes()).map_err(|e| ApplyError::Io(self.journal.clone(), e))?;
        journal.flush().map_err(|e| ApplyError::Io(self.journal.clone(), e))
    }

    /// Replace the record with `record` — removing it when nothing is left
    /// deployed — and drop any journal it absorbed.
    pub(crate) fn replace(&self, record: &Record) -> Result<(), ApplyError> {
        if record.files.is_empty() && record.backups.is_empty() && record.created_dirs.is_empty() {
            match fs::remove_file(&self.record) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(ApplyError::Io(self.record.clone(), e)),
            }
            let _ = fs::remove_file(&self.journal);
            return Ok(());
        }
        self.finish(record)
    }

    /// True when anything is deployed (or a deployment was interrupted).
    pub fn has_deployment(&self) -> bool {
        self.record.exists() || self.journal.exists()
    }

    /// Write the record whole, then drop the journal it absorbed.
    fn finish(&self, record: &Record) -> Result<(), ApplyError> {
        let tmp = self.record.with_extension("json.eh-part");
        let text = serde_json::to_string_pretty(record).expect("record serialises") + "\n";
        fs::write(&tmp, text).map_err(|e| ApplyError::Io(tmp.clone(), e))?;
        File::open(&tmp).and_then(|f| f.sync_all()).map_err(|e| ApplyError::Io(tmp.clone(), e))?;
        fs::rename(&tmp, &self.record).map_err(|e| ApplyError::Io(self.record.clone(), e))?;
        let _ = fs::remove_file(&self.journal);
        Ok(())
    }
}

fn fold(record: &mut Record, entry: Entry) {
    match entry {
        Entry::Link(f) => {
            record.files.retain(|x| !x.path.eq_ignore_ascii_case(&f.path));
            record.files.push(f);
        }
        Entry::Backup(b) => {
            if !record.backups.iter().any(|x| x.path.eq_ignore_ascii_case(&b.path)) {
                record.backups.push(b);
            }
        }
        Entry::Mkdir { path } => {
            if !record.created_dirs.contains(&path) {
                record.created_dirs.push(path);
            }
        }
    }
}

/// What a run did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Applied {
    pub linked: usize,
    pub already_in_place: usize,
    pub backed_up: usize,
    pub created_dirs: usize,
}

#[derive(Debug)]
pub enum ApplyError {
    Io(PathBuf, io::Error),
    /// The deployment record cannot be read.
    Record(PathBuf, String),
    /// A staged file the plan needs is not there; nothing was changed.
    MissingSource(PathBuf),
    /// Pre-flight did not pass; nothing was changed.
    NotClear,
    /// A backup already sits where this one would go. Neither file was
    /// touched; the deployment stopped here and can be continued.
    BackupExists { original: PathBuf, backup: PathBuf },
}

impl fmt::Display for ApplyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(p, e) => write!(f, "{}: {e}", p.display()),
            Self::Record(p, why) => write!(f, "the deployment record {} cannot be read: {why}", p.display()),
            Self::MissingSource(p) => {
                write!(f, "{} is missing from staging; run `eh install` again. Nothing was changed.", p.display())
            }
            Self::NotClear => {
                write!(f, "pre-flight found problems; run `eh deploy --dry-run` to see them. Nothing was changed.")
            }
            Self::BackupExists { original, backup } => write!(
                f,
                "{} would be backed up to {}, but a backup is already there. Neither was touched; \
                 move the old backup somewhere safe and run `eh deploy --yes` again to continue.",
                original.display(),
                backup.display()
            ),
        }
    }
}

impl std::error::Error for ApplyError {}

/// Where a link waits before taking its final name. Fixed, so a run after
/// a crash knows exactly what to clear away.
pub(crate) fn temp_name(dest: &Path) -> PathBuf {
    let name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    dest.with_file_name(format!(".{name}.eh-tmp"))
}

#[cfg(unix)]
pub(crate) fn identity(meta: &fs::Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (meta.dev(), meta.ino())
}

#[cfg(not(unix))]
pub(crate) fn identity(_meta: &fs::Metadata) -> (u64, u64) {
    (0, 0)
}

fn rel(game_dir: &Path, p: &Path) -> String {
    p.strip_prefix(game_dir).unwrap_or(p).to_string_lossy().replace('\\', "/")
}

/// Files in `record` that are still ours: same path, same link identity.
pub fn ours(record: &Record, game_dir: &Path) -> BTreeSet<PathBuf> {
    record
        .files
        .iter()
        .filter_map(|f| {
            let p = game_dir.join(&f.path);
            let meta = fs::symlink_metadata(&p).ok()?;
            (identity(&meta) == (f.dev, f.ino)).then_some(p)
        })
        .collect()
}

/// Put every planned file in place. `check` must be the pre-flight of this
/// plan, run with [`ours`] of this store's record.
pub fn apply(
    plan: &DeployPlan,
    check: &Preflight,
    game_dir: &Path,
    backups_root: &Path,
    store: &Store,
    task: &eh_progress::Task,
) -> Result<Applied, ApplyError> {
    if !check.is_clear() || !plan.is_deployable() {
        return Err(ApplyError::NotClear);
    }
    // Every source first: a missing one stops the run before anything moves.
    let mut sources = BTreeMap::new();
    for p in &check.placed {
        let meta = fs::metadata(&p.source).map_err(|_| ApplyError::MissingSource(p.source.clone()))?;
        if !meta.is_file() {
            return Err(ApplyError::MissingSource(p.source.clone()));
        }
        sources.insert(p.file, meta);
    }

    let mut record = store.load()?;
    let mine = ours(&record, game_dir);
    let mut journal = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&store.journal)
        .map_err(|e| ApplyError::Io(store.journal.clone(), e))?;
    // Leftovers of an interrupted run: temporary links it never renamed.
    for f in &record.files {
        let _ = fs::remove_file(temp_name(&game_dir.join(&f.path)));
    }

    task.set_total(check.placed.len() as u64);
    let mut done = Applied::default();
    for p in &check.placed {
        let source = &sources[&p.file];
        let (dev, ino) = identity(source);
        let dest = &p.dest;
        let mod_key = plan.files[p.file].mod_key.clone();
        let link = DeployedFile { path: rel(game_dir, dest), mod_key, dev, ino, size: source.len() };

        match fs::symlink_metadata(dest) {
            // Already this exact link: nothing to do but make sure it is recorded.
            Ok(meta) if identity(&meta) == (dev, ino) => {
                if !record.files.iter().any(|f| f == &link) {
                    store.append(&mut journal, &Entry::Link(link.clone()))?;
                    fold(&mut record, Entry::Link(link));
                }
                done.already_in_place += 1;
                task.advance(1);
                continue;
            }
            // Ours from an earlier deployment: replaced below, not backed up.
            Ok(_) if mine.contains(dest) => {}
            // Not ours: moved aside, checked, recorded first.
            Ok(meta) => {
                let stored_rel = rel(game_dir, dest);
                let stored = backups_root.join(&stored_rel);
                if fs::symlink_metadata(&stored).is_ok() {
                    return Err(ApplyError::BackupExists { original: dest.clone(), backup: stored });
                }
                let (sha, _) = eh_identity::sha256_file(dest, None).map_err(|e| ApplyError::Io(dest.clone(), e))?;
                let entry = BackupEntry { path: stored_rel.clone(), stored: stored_rel, sha256: sha, size: meta.len() };
                store.append(&mut journal, &Entry::Backup(entry.clone()))?;
                if let Some(parent) = stored.parent() {
                    fs::create_dir_all(parent).map_err(|e| ApplyError::Io(parent.to_path_buf(), e))?;
                }
                fs::rename(dest, &stored).map_err(|e| ApplyError::Io(dest.clone(), e))?;
                fold(&mut record, Entry::Backup(entry));
                done.backed_up += 1;
            }
            Err(_) => {}
        }

        // Folders the link needs that do not exist yet: recorded, then made.
        let mut missing: Vec<&Path> = Vec::new();
        let mut at = dest.parent();
        while let Some(dir) = at {
            if dir == game_dir || fs::symlink_metadata(dir).is_ok() {
                break;
            }
            missing.push(dir);
            at = dir.parent();
        }
        for dir in missing.into_iter().rev() {
            let entry = Entry::Mkdir { path: rel(game_dir, dir) };
            store.append(&mut journal, &entry)?;
            fs::create_dir(dir).map_err(|e| ApplyError::Io(dir.to_path_buf(), e))?;
            fold(&mut record, entry);
            done.created_dirs += 1;
        }

        store.append(&mut journal, &Entry::Link(link.clone()))?;
        let tmp = temp_name(dest);
        let _ = fs::remove_file(&tmp);
        fs::hard_link(&p.source, &tmp).map_err(|e| ApplyError::Io(tmp.clone(), e))?;
        fs::rename(&tmp, dest).map_err(|e| ApplyError::Io(dest.clone(), e))?;
        fold(&mut record, Entry::Link(link));
        done.linked += 1;
        task.advance(1);
    }
    journal.sync_all().map_err(|e| ApplyError::Io(store.journal.clone(), e))?;
    drop(journal);
    record.format = RECORD_FORMAT;
    store.finish(&record)?;
    Ok(done)
}
