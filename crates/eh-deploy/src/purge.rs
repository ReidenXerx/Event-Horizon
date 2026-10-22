//! Part 4 of deployment: take files back out — all of them (purge), or the
//! ones a new plan no longer has (redeploy).
//!
//! ─── CHECK EVERYTHING, THEN CHANGE ──────────────────────────────────────
//! Every backup that would be put back is checked FIRST: it must exist, its
//! bytes must hash to what was recorded when it was taken, and the place it
//! goes back to must be free or hold our own link. Anything else — a backup
//! missing or damaged, a new file the user put there since — refuses the
//! purge with nothing changed (decided 2026-10-22; NS-2).
//!
//! Then: our links are removed (only while they are still OUR link — same
//! inode; a file the user replaced is left alone and reported), backups are
//! moved back, and the folders we created are removed if empty, deepest
//! first.
//!
//! ─── NO JOURNAL NEEDED ──────────────────────────────────────────────────
//! Every step is safe to repeat: a link already removed is skipped, a backup
//! already moved back is recognised by its hash, an emptied folder is gone.
//! The record is rewritten only at the end, so a purge that stops halfway is
//! finished by running it again.

use crate::apply::{identity, temp_name, BackupEntry, Record, Store};
use std::collections::BTreeSet;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

/// What taking files out did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Purged {
    pub removed: usize,
    pub restored: usize,
    pub folders_removed: usize,
    /// Files we placed that someone has since replaced: not ours any more,
    /// so not removed.
    pub left_alone: Vec<PathBuf>,
}

#[derive(Debug)]
pub enum PurgeError {
    Apply(crate::apply::ApplyError),
    Io(PathBuf, std::io::Error),
    /// Nothing was changed.
    BackupMissing { original: PathBuf, backup: PathBuf },
    /// Nothing was changed.
    BackupDamaged { backup: PathBuf, expected: String, got: String },
    /// A file that is not ours now sits where a backup goes back. Nothing
    /// was changed.
    RestoreBlocked { original: PathBuf, backup: PathBuf },
}

impl fmt::Display for PurgeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Apply(e) => write!(f, "{e}"),
            Self::Io(p, e) => write!(f, "{}: {e}", p.display()),
            Self::BackupMissing { original, backup } => write!(
                f,
                "the backup of {} should be at {} and is not. Nothing was changed: putting the game \
                 back without it would lose that file for good.",
                original.display(),
                backup.display()
            ),
            Self::BackupDamaged { backup, expected, got } => write!(
                f,
                "the backup {} has changed since it was taken (sha256 {got}, recorded {expected}). \
                 Nothing was changed.",
                backup.display()
            ),
            Self::RestoreBlocked { original, backup } => write!(
                f,
                "{} now holds a file Event Horizon did not put there, so its backup ({}) cannot go \
                 back. Move that file away and run this again. Nothing was changed.",
                original.display(),
                backup.display()
            ),
        }
    }
}

impl std::error::Error for PurgeError {}

impl From<crate::apply::ApplyError> for PurgeError {
    fn from(e: crate::apply::ApplyError) -> Self {
        Self::Apply(e)
    }
}

/// Take out every file the record holds, and put every backup back.
pub fn purge(store: &Store, game_dir: &Path, backups_root: &Path) -> Result<Purged, PurgeError> {
    let out = take_out(store, game_dir, backups_root, &BTreeSet::new())?;
    let _ = fs::remove_dir(backups_root);
    Ok(out)
}

/// Take out only what `keep` (paths relative to the game folder, as the new
/// plan places them) no longer has — the second half of a redeploy.
pub fn prune(store: &Store, game_dir: &Path, backups_root: &Path, keep: &BTreeSet<String>) -> Result<Purged, PurgeError> {
    take_out(store, game_dir, backups_root, keep)
}

fn take_out(store: &Store, game_dir: &Path, backups_root: &Path, keep: &BTreeSet<String>) -> Result<Purged, PurgeError> {
    let record = store.load()?;
    let kept = |path: &str| keep.iter().any(|k| k.eq_ignore_ascii_case(path));
    let is_ours = |path: &Path| {
        let rel = path.strip_prefix(game_dir).unwrap_or(path).to_string_lossy().replace('\\', "/");
        let Ok(meta) = fs::symlink_metadata(path) else { return false };
        record.files.iter().any(|f| f.path == rel && identity(&meta) == (f.dev, f.ino))
    };

    // 1. Check every backup that would go back, before touching anything.
    let mut to_restore: Vec<&BackupEntry> = Vec::new();
    for b in record.backups.iter().filter(|b| !kept(&b.path)) {
        let original = game_dir.join(&b.path);
        let backup = backups_root.join(&b.stored);
        match fs::symlink_metadata(&backup) {
            Ok(_) => {
                let (got, _) = eh_identity::sha256_file(&backup, None).map_err(|e| PurgeError::Io(backup.clone(), e))?;
                if got != b.sha256 {
                    return Err(PurgeError::BackupDamaged { backup, expected: b.sha256.clone(), got });
                }
                if fs::symlink_metadata(&original).is_ok() && !is_ours(&original) {
                    return Err(PurgeError::RestoreBlocked { original, backup });
                }
                to_restore.push(b);
            }
            Err(_) => {
                // Already moved back by an earlier, interrupted purge?
                let back = fs::symlink_metadata(&original).is_ok()
                    && !is_ours(&original)
                    && eh_identity::sha256_file(&original, None).map(|(h, _)| h == b.sha256).unwrap_or(false);
                if !back {
                    return Err(PurgeError::BackupMissing { original, backup });
                }
            }
        }
    }

    // 2. Our links out — only while they are still ours.
    let mut out = Purged::default();
    let mut remaining = Record { format: record.format, ..Record::default() };
    for f in &record.files {
        let path = game_dir.join(&f.path);
        let _ = fs::remove_file(temp_name(&path));
        if kept(&f.path) {
            remaining.files.push(f.clone());
            continue;
        }
        match fs::symlink_metadata(&path) {
            Ok(meta) if identity(&meta) == (f.dev, f.ino) => {
                fs::remove_file(&path).map_err(|e| PurgeError::Io(path.clone(), e))?;
                out.removed += 1;
            }
            Ok(_) => out.left_alone.push(path),
            Err(_) => {}
        }
    }

    // 3. Backups back where they were.
    for b in &to_restore {
        let original = game_dir.join(&b.path);
        let backup = backups_root.join(&b.stored);
        if let Some(parent) = original.parent() {
            fs::create_dir_all(parent).map_err(|e| PurgeError::Io(parent.to_path_buf(), e))?;
        }
        fs::rename(&backup, &original).map_err(|e| PurgeError::Io(backup.clone(), e))?;
        remove_empty_parents(&backup, backups_root);
        out.restored += 1;
    }
    remaining.backups = record.backups.iter().filter(|b| kept(&b.path)).cloned().collect();

    // 4. Folders we made, deepest first, if nothing else lives in them now.
    let still_needed: Vec<String> = remaining.files.iter().map(|f| f.path.to_lowercase()).collect();
    for dir in record.created_dirs.iter().rev() {
        let lower = dir.to_lowercase();
        if still_needed.iter().any(|p| p.starts_with(&format!("{lower}/"))) {
            remaining.created_dirs.insert(0, dir.clone());
            continue;
        }
        if fs::remove_dir(game_dir.join(dir)).is_ok() {
            out.folders_removed += 1;
        }
    }

    store.replace(&remaining)?;
    Ok(out)
}

/// Remove `from`'s parent folders up to (not including) `root` while empty.
fn remove_empty_parents(from: &Path, root: &Path) {
    let mut at = from.parent();
    while let Some(dir) = at {
        if dir == root || !dir.starts_with(root) || fs::remove_dir(dir).is_err() {
            break;
        }
        at = dir.parent();
    }
}
