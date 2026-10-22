//! Part 2 of deployment: will the plan work in THIS game folder?
//!
//! Reads the game folder and changes nothing in it, with one exception: the
//! hardlink test below creates one small file and removes it again.
//!
//! ─── WHY THE HARDLINK TEST IS A REAL LINK ───────────────────────────────
//! Comparing device numbers is not enough. `link(2)` refuses (`EXDEV`)
//! across two MOUNT POINTS of the same filesystem — which is exactly what a
//! Flatpak's bind mounts are — and some filesystems (exFAT, FAT32) cannot
//! hardlink at all. Only trying it answers the question. Decided 2026-10-22:
//! when it fails, deployment is refused, never silently turned into copies.
//!
//! ─── CASE, FOR A WINDOWS GAME ON LINUX ──────────────────────────────────
//! The game runs under Wine, which looks files up case-insensitively, on a
//! filesystem where `Textures/` and `textures/` are two folders. Wine sees
//! only one of them. So every planned path is resolved against what is ON
//! DISK — an existing `Textures/` is reused whatever a mod spells it — and a
//! folder that does not exist yet gets ONE spelling for every mod. Two
//! existing folders differing only in case are reported: deploying into
//! either could put files where the game does not look. The decision is made
//! at the link; a mod's staging folder is never renamed to suit a game.

use crate::plan::{DeployPlan, Target};
use ehcoll::SupportedGameId;
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

/// The executable that proves a folder is this game's installation.
pub fn game_executable(game: SupportedGameId) -> &'static str {
    match game {
        SupportedGameId::Skyrimse => "SkyrimSE.exe",
        SupportedGameId::Fallout3 => "Fallout3.exe",
        SupportedGameId::Falloutnv => "FalloutNV.exe",
        SupportedGameId::Fallout4 => "Fallout4.exe",
        SupportedGameId::Starfield => "Starfield.exe",
    }
}

/// Something that must be fixed before deploying.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Blocker {
    /// The folder is not this game's installation.
    NotTheGameFolder { looked_for: &'static str },
    /// A folder the plan deploys into does not exist.
    MissingTarget(PathBuf),
    /// Staging and the game are on different filesystems or mount points.
    DifferentMounts { staging: PathBuf, target: PathBuf },
    /// The game's drive cannot hold hardlinks at all.
    NoHardlinks { target: PathBuf, why: String },
    /// The folder cannot be written to.
    NotWritable { target: PathBuf, why: String },
    /// Vortex has files deployed here; two managers would fight over them.
    VortexDeployed { record: PathBuf, files: usize },
    /// A folder sits where a file must go, or a file where a folder must go.
    InTheWay(PathBuf),
    /// Two existing folders differ only in case; Wine sees one of them.
    CaseTwins(Vec<PathBuf>),
}

/// A file that is already where a mod's file goes, and is not ours. It is
/// backed up and put back on purge (decided 2026-10-22, Vortex's way).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToBackUp {
    pub path: PathBuf,
    pub size: u64,
    pub mod_key: String,
}

/// One planned file, resolved to where it lands on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Placed {
    /// Index into `DeployPlan::files`.
    pub file: usize,
    pub source: PathBuf,
    pub dest: PathBuf,
}

#[derive(Debug, Clone, Default)]
pub struct Preflight {
    pub placed: Vec<Placed>,
    pub to_back_up: Vec<ToBackUp>,
    pub blockers: Vec<Blocker>,
}

impl Preflight {
    pub fn is_clear(&self) -> bool {
        self.blockers.is_empty()
    }
}

/// What pre-flight needs to know about where things are.
pub struct Layout<'a> {
    pub game: SupportedGameId,
    pub game_dir: &'a Path,
    /// Where staging lives — the hardlink test starts here.
    pub staging_root: &'a Path,
    /// A mod's staging folder, by compare key.
    pub staging_of: &'a dyn Fn(&str) -> PathBuf,
    /// Files Event Horizon itself deployed before (from its deployment
    /// record), by absolute path. Those are replaced, not backed up.
    pub ours: &'a BTreeSet<PathBuf>,
}

/// Check `plan` against the real game folder.
pub fn preflight(plan: &DeployPlan, layout: &Layout) -> Preflight {
    run(plan, layout, true)
}

/// Where each planned file lands, resolved exactly as [`preflight`] does —
/// and nothing else: no hardlink test, no Vortex check, NOTHING WRITTEN.
/// For verification, which must not touch what it is checking.
pub fn locate(plan: &DeployPlan, layout: &Layout) -> Preflight {
    run(plan, layout, false)
}

fn run(plan: &DeployPlan, layout: &Layout, probe: bool) -> Preflight {
    let mut out = Preflight::default();
    let exe = game_executable(layout.game);
    if !has_entry_ignoring_case(layout.game_dir, exe) {
        out.blockers.push(Blocker::NotTheGameFolder { looked_for: exe });
        return out;
    }

    // The folders the plan deploys into, and whether each can take links.
    let mut targets: Vec<Target> = plan.files.iter().map(|f| f.target).collect();
    targets.sort();
    targets.dedup();
    let mut resolver = CaseResolver::default();
    let mut target_dirs: HashMap<Target, PathBuf> = HashMap::new();
    for t in targets {
        let rel = t.relative_dir(layout.game);
        let dir = if rel == "." {
            layout.game_dir.to_path_buf()
        } else {
            match resolver.resolve(layout.game_dir, rel, true) {
                Ok(p) => p,
                Err(b) => {
                    out.blockers.push(b);
                    continue;
                }
            }
        };
        if !dir.is_dir() {
            out.blockers.push(Blocker::MissingTarget(dir));
            continue;
        }
        if probe {
            if let Some(b) = probe_hardlink(layout.staging_root, &dir) {
                out.blockers.push(b);
            }
            if let Some(b) = vortex_deployment(&dir) {
                out.blockers.push(b);
            }
        }
        target_dirs.insert(t, dir);
    }

    // Each blocking path once, however many files sit beneath it.
    let mut twins_reported: BTreeSet<Vec<PathBuf>> = BTreeSet::new();
    let mut in_the_way: BTreeSet<PathBuf> = BTreeSet::new();
    for (i, f) in plan.files.iter().enumerate() {
        let Some(base) = target_dirs.get(&f.target) else { continue };
        let dest = match resolver.resolve(base, &f.path, false) {
            Ok(p) => p,
            Err(Blocker::CaseTwins(t)) => {
                if twins_reported.insert(t.clone()) {
                    out.blockers.push(Blocker::CaseTwins(t));
                }
                continue;
            }
            Err(Blocker::InTheWay(p)) => {
                if in_the_way.insert(p.clone()) {
                    out.blockers.push(Blocker::InTheWay(p));
                }
                continue;
            }
            Err(b) => {
                out.blockers.push(b);
                continue;
            }
        };
        match fs::symlink_metadata(&dest) {
            Ok(meta) if meta.is_dir() => {
                if in_the_way.insert(dest.clone()) {
                    out.blockers.push(Blocker::InTheWay(dest.clone()));
                }
            }
            Ok(meta) if !layout.ours.contains(&dest) => {
                out.to_back_up.push(ToBackUp { path: dest.clone(), size: meta.len(), mod_key: f.mod_key.clone() })
            }
            _ => {}
        }
        out.placed.push(Placed { file: i, source: (layout.staging_of)(&f.mod_key).join(&f.staged_path), dest });
    }
    out
}

fn has_entry_ignoring_case(dir: &Path, name: &str) -> bool {
    fs::read_dir(dir)
        .map(|it| it.flatten().any(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(name)))
        .unwrap_or(false)
}

/// Try the real thing: a file in staging, linked into `target`, both removed.
fn probe_hardlink(staging_root: &Path, target: &Path) -> Option<Blocker> {
    let tag = format!(".eh-link-test-{}", std::process::id());
    if let Err(e) = fs::create_dir_all(staging_root) {
        return Some(Blocker::NotWritable { target: staging_root.to_path_buf(), why: e.to_string() });
    }
    let source = staging_root.join(&tag);
    if let Err(e) = fs::write(&source, b"event horizon link test") {
        return Some(Blocker::NotWritable { target: staging_root.to_path_buf(), why: e.to_string() });
    }
    let link = target.join(&tag);
    let result = fs::hard_link(&source, &link);
    let _ = fs::remove_file(&link);
    let _ = fs::remove_file(&source);
    let e = result.err()?;
    // Linux errno values; elsewhere every failure reads as "cannot hardlink".
    Some(match e.raw_os_error() {
        Some(18) => Blocker::DifferentMounts { staging: staging_root.to_path_buf(), target: target.to_path_buf() },
        Some(13) | Some(30) => Blocker::NotWritable { target: target.to_path_buf(), why: e.to_string() },
        _ => Blocker::NoHardlinks { target: target.to_path_buf(), why: e.to_string() },
    })
}

/// Vortex keeps one record per mod type in the folder it deployed into:
/// `vortex.deployment.json`, `vortex.deployment.<type>.json`. One that still
/// lists files means Vortex owns files here.
fn vortex_deployment(dir: &Path) -> Option<Blocker> {
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if !(name.starts_with("vortex.deployment") && name.ends_with(".json")) {
            continue;
        }
        let files = fs::read_to_string(entry.path())
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .and_then(|v| v.get("files").and_then(|f| f.as_array()).map(Vec::len))
            // A record we cannot read is treated as live: refusing costs the
            // user a purge in Vortex; assuming wrong costs their files.
            .unwrap_or(1);
        if files > 0 {
            return Some(Blocker::VortexDeployed { record: entry.path(), files });
        }
    }
    None
}

/// Resolves relative paths against what is on disk, case-insensitively, and
/// gives folders that do not exist yet one spelling for every mod.
#[derive(Default)]
struct CaseResolver {
    /// Directory listings, read once each.
    listings: HashMap<PathBuf, Option<Vec<String>>>,
    /// Folders the deployment will create: (parent, lowercased name) → name.
    planned: HashMap<(PathBuf, String), String>,
}

impl CaseResolver {
    fn listing(&mut self, dir: &Path) -> Option<&Vec<String>> {
        self.listings
            .entry(dir.to_path_buf())
            .or_insert_with(|| {
                fs::read_dir(dir).ok().map(|it| it.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
            })
            .as_ref()
    }

    /// `rel` under `base`, each part spelled as it exists on disk.
    /// `last_is_dir` says whether the final part is a folder.
    fn resolve(&mut self, base: &Path, rel: &str, last_is_dir: bool) -> Result<PathBuf, Blocker> {
        let parts: Vec<&str> = rel.split(['/', '\\']).filter(|p| !p.is_empty() && *p != ".").collect();
        let mut at = base.to_path_buf();
        for (i, part) in parts.iter().enumerate() {
            let is_dir = i + 1 < parts.len() || last_is_dir;
            let lower = part.to_lowercase();
            let existing: Vec<String> = self
                .listing(&at)
                .map(|names| names.iter().filter(|n| n.to_lowercase() == lower).cloned().collect())
                .unwrap_or_default();
            let name = match existing.as_slice() {
                [one] => one.clone(),
                [] => {
                    if is_dir {
                        self.planned.entry((at.clone(), lower)).or_insert_with(|| (*part).to_owned()).clone()
                    } else {
                        (*part).to_owned()
                    }
                }
                many => {
                    let mut twins: Vec<PathBuf> = many.iter().map(|n| at.join(n)).collect();
                    twins.sort();
                    return Err(Blocker::CaseTwins(twins));
                }
            };
            at = at.join(name);
            if is_dir {
                if let Ok(meta) = fs::symlink_metadata(&at) {
                    if !meta.is_dir() {
                        return Err(Blocker::InTheWay(at));
                    }
                }
            }
        }
        Ok(at)
    }
}
