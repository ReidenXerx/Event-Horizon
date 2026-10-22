//! Part 5 of deployment: did the right bytes land? (NS-4: identity and
//! integrity are separate passes — this is the integrity one.)
//!
//! Read-only. Every file the plan deploys is checked against the curator's
//! record of it (`stagingFiles`: size and SHA-256), on disk, where the game
//! will read it — not against what Event Horizon believes it wrote.
//!
//! ─── A HARDLINK IS ONE FILE IN TWO PLACES ───────────────────────────────
//! A tool that edits a deployed file in place — xEdit saving a plugin —
//! edits the staged file too: they are the same file. Verification sees it
//! as wrong bytes, and the mod has to be staged again from its archive; a
//! redeploy alone would only link the same edited file back.

use crate::apply::{identity, Record};
use crate::plan::DeployPlan;
use crate::preflight::{Blocker, Preflight};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

/// What the curator recorded for one staged file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Expected {
    pub size: u64,
    /// Absent for packages built without per-file hashes.
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FindingKind {
    /// Not there at all.
    Missing,
    /// Something is there, but not the file Event Horizon deployed — the
    /// user or another tool put it there since.
    NotOurs,
    /// Our link, but to an older staging of the mod: staged again since, not
    /// deployed again since.
    Outdated,
    WrongSize { expected: u64, got: u64 },
    WrongBytes { expected: String, got: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub path: PathBuf,
    pub mod_key: String,
    pub kind: FindingKind,
}

impl Finding {
    /// The mod's staged files are themselves wrong: it must be staged again
    /// from its archive before a redeploy can help.
    pub fn needs_restage(&self) -> bool {
        matches!(self.kind, FindingKind::WrongSize { .. } | FindingKind::WrongBytes { .. })
    }
}

#[derive(Debug, Clone, Default)]
pub struct Verified {
    /// Whether the game folder was checked (a deployment exists) or only
    /// staging.
    pub deployment: bool,
    pub checked: usize,
    pub ok: usize,
    /// Files checked by size only, because the curator recorded no hash.
    pub size_only: usize,
    pub findings: Vec<Finding>,
    /// Files a deployment placed that the plan no longer has.
    pub stale: Vec<PathBuf>,
    /// The game folder could not even be read as planned.
    pub blockers: Vec<Blocker>,
}

impl Verified {
    pub fn is_clean(&self) -> bool {
        self.findings.is_empty() && self.stale.is_empty() && self.blockers.is_empty()
    }
}

/// Check the deployed game folder. `located` comes from
/// [`crate::preflight::locate`]; `expected` looks up the curator's record of
/// a mod's staged file. `quick` skips hashing.
pub fn verify_deployment(
    plan: &DeployPlan,
    located: &Preflight,
    record: &Record,
    game_dir: &Path,
    expected: &dyn Fn(&str, &str) -> Option<Expected>,
    quick: bool,
    task: &eh_progress::Task,
) -> Verified {
    let mut out = Verified { deployment: true, blockers: located.blockers.clone(), ..Verified::default() };
    task.set_total(located.placed.len() as u64);
    let mut planned: BTreeSet<&Path> = BTreeSet::new();
    for p in &located.placed {
        planned.insert(&p.dest);
        let f = &plan.files[p.file];
        let rel = p.dest.strip_prefix(game_dir).unwrap_or(&p.dest).to_string_lossy().replace('\\', "/");
        let recorded = record.files.iter().find(|r| r.path == rel);
        let kind = match fs::symlink_metadata(&p.dest) {
            Err(_) => Some(FindingKind::Missing),
            Ok(meta) => {
                let here = identity(&meta);
                if recorded.map(|r| (r.dev, r.ino)) != Some(here) {
                    Some(FindingKind::NotOurs)
                } else if fs::metadata(&p.source).map(|s| identity(&s)).ok() != Some(here) {
                    Some(FindingKind::Outdated)
                } else {
                    check_bytes(&p.dest, meta.len(), expected(&f.mod_key, &f.staged_path), quick, &mut out.size_only)
                }
            }
        };
        tally(&mut out, kind, &p.dest, &f.mod_key);
        task.advance(1);
    }
    out.stale = record
        .files
        .iter()
        .map(|r| game_dir.join(&r.path))
        .filter(|p| !planned.contains(p.as_path()))
        .filter(|p| {
            let rel = p.strip_prefix(game_dir).unwrap_or(p).to_string_lossy().replace('\\', "/");
            let still_ours = fs::symlink_metadata(p)
                .map(|m| record.files.iter().any(|r| r.path == rel && (r.dev, r.ino) == identity(&m)))
                .unwrap_or(false);
            still_ours
        })
        .collect();
    out
}

/// Check staging alone — for an instance that has not deployed yet.
pub fn verify_staging(
    plan: &DeployPlan,
    staging_of: &dyn Fn(&str) -> PathBuf,
    expected: &dyn Fn(&str, &str) -> Option<Expected>,
    quick: bool,
    task: &eh_progress::Task,
) -> Verified {
    let mut out = Verified::default();
    task.set_total(plan.files.len() as u64);
    for f in &plan.files {
        let path = staging_of(&f.mod_key).join(&f.staged_path);
        let kind = match fs::metadata(&path) {
            Err(_) => Some(FindingKind::Missing),
            Ok(meta) => check_bytes(&path, meta.len(), expected(&f.mod_key, &f.staged_path), quick, &mut out.size_only),
        };
        tally(&mut out, kind, &path, &f.mod_key);
        task.advance(1);
    }
    out
}

fn check_bytes(path: &Path, size: u64, expected: Option<Expected>, quick: bool, size_only: &mut usize) -> Option<FindingKind> {
    let e = expected?;
    if size != e.size {
        return Some(FindingKind::WrongSize { expected: e.size, got: size });
    }
    match (&e.sha256, quick) {
        (Some(sha), false) => match eh_identity::sha256_file(path, None) {
            Ok((got, _)) if &got == sha => None,
            Ok((got, _)) => Some(FindingKind::WrongBytes { expected: sha.clone(), got }),
            Err(_) => Some(FindingKind::Missing),
        },
        (None, _) => {
            *size_only += 1;
            None
        }
        (Some(_), true) => None,
    }
}

fn tally(out: &mut Verified, kind: Option<FindingKind>, path: &Path, mod_key: &str) {
    out.checked += 1;
    match kind {
        None => out.ok += 1,
        Some(kind) => out.findings.push(Finding { path: path.to_path_buf(), mod_key: mod_key.to_owned(), kind }),
    }
}
