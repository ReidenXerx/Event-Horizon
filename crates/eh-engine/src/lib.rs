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
//! STATUS: unpack, manifest loading, Nexus download, and staging by content.
//! The install loop that strings them together is next.

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

// ───────────────────────────────────────────────────────────────────────────
// Manifest
// ───────────────────────────────────────────────────────────────────────────

/// Read and validate a `manifest.json` from disk.
pub fn load_manifest(path: &Path) -> Result<ehcoll::ParseOutcome, EngineError> {
    let raw = std::fs::read_to_string(path).map_err(|e| EngineError::Io(path.to_path_buf(), e))?;
    ehcoll::parse_manifest(&raw).map_err(EngineError::Manifest)
}

/// The mod a manifest knows by `compare_key`.
pub fn find_mod<'m>(manifest: &'m ehcoll::EhcollManifest, compare_key: &str) -> Option<&'m ehcoll::EhcollMod> {
    manifest.mods.iter().find(|m| m.compare_key == compare_key)
}

// ───────────────────────────────────────────────────────────────────────────
// Packages
// ───────────────────────────────────────────────────────────────────────────

/// The package reader and its types, re-exported for shells.
pub mod package {
    pub use eh_package::*;
}

/// Read and validate a `.ehcoll` package.
pub fn read_package(path: &Path) -> Result<eh_package::PackageRead, EngineError> {
    eh_package::read_package(path).map_err(EngineError::Package)
}

/// What a package holds, and how much of it this engine can install today.
#[derive(Debug, Clone)]
pub struct PackageSummary {
    pub name: String,
    pub version: String,
    pub author: String,
    pub game: ehcoll::SupportedGameId,
    pub verification_level: &'static str,
    pub mods: usize,
    /// Downloaded from Nexus.
    pub nexus: usize,
    /// Carried inside the package, loose under `bundled/`.
    pub bundled: usize,
    /// External and not bundled: the user supplies the archive.
    pub user_supplied: usize,
    /// Installed from the original archive, then corrected from `mirror/`.
    pub mirrored: usize,
    /// Mods whose every recorded file has a SHA-256: staging can be rebuilt
    /// from the archive by content, without running any installer.
    pub rebuildable: usize,
    /// Names of mods that cannot be rebuilt that way, and why.
    pub not_rebuildable: Vec<(String, &'static str)>,
    pub warnings: Vec<String>,
}

/// Summarise a package that read cleanly.
pub fn summarize_package(read: &eh_package::PackageRead) -> PackageSummary {
    let m = &read.manifest;
    let (mut nexus, mut bundled, mut user_supplied, mut mirrored, mut rebuildable) = (0, 0, 0, 0, 0);
    let mut not_rebuildable = Vec::new();
    for md in &m.mods {
        match &md.source {
            ehcoll::ModSource::Nexus(_) => nexus += 1,
            ehcoll::ModSource::External(e) if e.bundled => bundled += 1,
            ehcoll::ModSource::External(_) => user_supplied += 1,
        }
        if md.state.mirrored == Some(true) {
            mirrored += 1;
        }
        match &md.state.staging_files {
            None => not_rebuildable.push((md.name.clone(), "no file list recorded")),
            Some(files) if files.iter().any(|f| f.sha256.is_none()) => {
                not_rebuildable.push((md.name.clone(), "files recorded without hashes"))
            }
            Some(_) => rebuildable += 1,
        }
    }
    PackageSummary {
        name: m.package.name.clone(),
        version: m.package.version.clone(),
        author: m.package.author.clone(),
        game: m.game.id,
        verification_level: match m.package.verification_level {
            Some(ehcoll::VerificationLevel::Thorough) => "thorough",
            Some(ehcoll::VerificationLevel::Fast) => "fast",
            Some(ehcoll::VerificationLevel::None) | None => "none",
        },
        mods: m.mods.len(),
        nexus,
        bundled,
        user_supplied,
        mirrored,
        rebuildable,
        not_rebuildable,
        warnings: read.warnings.clone(),
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Nexus
// ───────────────────────────────────────────────────────────────────────────

/// The Nexus client and its types, re-exported so a shell needs only the
/// engine (NS-4 in this crate's sense: shells hold no logic).
pub mod nexus {
    pub use eh_nexus::*;
}

/// Download a Nexus-sourced mod's archive into the library's shared store,
/// verified against the manifest's SHA-256. The store names files by that
/// hash, so a copy another instance — or another game — already fetched is
/// reused, and the manifest's `archiveName` (a stranger's string) never
/// becomes a path.
pub fn fetch_nexus_mod(
    client: &eh_nexus::Client,
    library: &eh_library::Library,
    source: &ehcoll::NexusModSource,
    task: &Task,
) -> Result<eh_nexus::Fetched, EngineError> {
    let file = eh_nexus::NexusFile {
        game_domain: source.game_domain.clone(),
        mod_id: source.mod_id,
        file_id: source.file_id,
    };
    let dest = library.archive_path(&source.sha256).map_err(EngineError::Library)?;
    client.fetch(&file, &source.sha256, &dest, task).map_err(EngineError::Nexus)
}

// ───────────────────────────────────────────────────────────────────────────
// Library and instances
// ───────────────────────────────────────────────────────────────────────────

/// The library and instance types, re-exported for shells.
pub mod library {
    pub use eh_library::*;
}

/// How many instances this build supports. The proof of concept is one game
/// with one modpack; the library itself has no limit, so raising this is the
/// whole change.
pub const MAX_INSTANCES: usize = 1;

/// Every game a manifest can name.
pub const GAMES: [ehcoll::SupportedGameId; 5] = [
    ehcoll::SupportedGameId::Skyrimse,
    ehcoll::SupportedGameId::Fallout3,
    ehcoll::SupportedGameId::Falloutnv,
    ehcoll::SupportedGameId::Fallout4,
    ehcoll::SupportedGameId::Starfield,
];

/// A game by the id manifests use (`fallout4`, `skyrimse`, …).
pub fn parse_game(s: &str) -> Option<ehcoll::SupportedGameId> {
    GAMES.into_iter().find(|g| g.as_str() == s)
}

/// The library at its default place.
pub fn open_library() -> Result<eh_library::Library, EngineError> {
    let root = eh_library::Library::default_root().map_err(EngineError::Library)?;
    eh_library::Library::open(root).map_err(EngineError::Library)
}

/// Create an instance, within this build's instance limit.
pub fn create_instance(
    library: &eh_library::Library,
    config: eh_library::InstanceConfig,
) -> Result<eh_library::Instance, EngineError> {
    let existing = library.instances().map_err(EngineError::Library)?;
    if existing.len() >= MAX_INSTANCES {
        return Err(EngineError::InstanceLimit(existing.into_iter().map(|i| i.id().clone()).collect()));
    }
    library.create_instance(config).map_err(EngineError::Library)
}

/// Stage one mod of `manifest` into `instance`.
///
/// One instance is one modpack on one game: a manifest for another game is
/// refused, and so is one for another collection than the instance already
/// installs. The first manifest staged binds the instance to its collection.
pub fn stage_into_instance(
    instance: &mut eh_library::Instance,
    manifest: &ehcoll::EhcollManifest,
    m: &ehcoll::EhcollMod,
    archive: &Path,
    extra_sources: &[&Path],
    task: &Task,
) -> Result<Staged, EngineError> {
    if manifest.game.id != instance.config().game {
        return Err(EngineError::WrongGame {
            instance: instance.id().clone(),
            instance_game: instance.config().game,
            manifest_game: manifest.game.id,
        });
    }
    if let Some(p) = &instance.config().package {
        if p.id != manifest.package.id {
            return Err(EngineError::WrongPackage {
                instance: instance.id().clone(),
                installs: p.name.clone(),
                offered: manifest.package.name.clone(),
            });
        }
    }
    let dest = instance.staging_dir_for(&m.compare_key);
    let staged = stage_mod(m, archive, extra_sources, &instance.work_dir(), &dest, task)?;
    // Bound only once something of the modpack is actually staged: a mod
    // that failed must not tie the instance to a pack it holds nothing of.
    if instance.config().package.is_none() {
        instance
            .set_package(eh_library::PackageRef {
                id: manifest.package.id.clone(),
                name: manifest.package.name.clone(),
                version: manifest.package.version.clone(),
            })
            .map_err(EngineError::Library)?;
    }
    Ok(staged)
}

// ───────────────────────────────────────────────────────────────────────────
// Staging, by content (eh-fomod "option A")
// ───────────────────────────────────────────────────────────────────────────

/// What staging one mod did.
#[derive(Debug, Clone)]
pub struct Staged {
    pub files: u64,
    pub bytes: u64,
    /// What the archive extraction refused for safety. Those entries are not
    /// sources; a mod that needed one ends up `Incomplete` instead.
    pub refused_entries: usize,
}

/// Rebuild one mod's staging folder in `dest` from its archive, by content.
///
/// `extra_sources` are other trees that may supply bytes — the package's
/// `mirror/` folder for a mirrored mod, a bundled mod's folder. The archive
/// is unpacked under `work`, and that copy is removed afterwards whatever
/// happens. Nothing is written to `dest` unless every recorded file has a
/// source.
pub fn stage_mod(
    m: &ehcoll::EhcollMod,
    archive: &Path,
    extra_sources: &[&Path],
    work: &Path,
    dest: &Path,
    task: &Task,
) -> Result<Staged, EngineError> {
    let Some(files) = &m.state.staging_files else {
        return Err(EngineError::NoStagingRecord(m.compare_key.clone()));
    };
    std::fs::create_dir_all(work).map_err(|e| EngineError::Io(work.to_path_buf(), e))?;
    let unpacked = Unpacked::new(work).map_err(|e| EngineError::Io(work.to_path_buf(), e))?;

    let extracting = task.child("extract", None, eh_progress::Unit::Files);
    let extraction = eh_archive::extract(archive, &unpacked.0, &extracting).map_err(EngineError::Archive)?;
    extracting.done();

    let mut trees: Vec<&Path> = vec![&unpacked.0];
    trees.extend_from_slice(extra_sources);
    let plan = eh_fomod::plan_from_trees(files, &trees, task)
        .map_err(|e| EngineError::Io(unpacked.0.clone(), e))?;
    if !plan.is_complete() {
        return Err(EngineError::Incomplete {
            compare_key: m.compare_key.clone(),
            missing: plan.missing.clone(),
            unhashed: plan.unhashed.clone(),
        });
    }
    let writing = task.child("write staging", Some(plan.bytes()), eh_progress::Unit::Bytes);
    let applied = plan.apply(dest, &writing).map_err(EngineError::Reconstruct)?;
    writing.done();
    Ok(Staged { files: applied.files, bytes: applied.bytes, refused_entries: extraction.refused.len() })
}

/// A scratch directory removed on drop, success or not.
struct Unpacked(std::path::PathBuf);

impl Unpacked {
    fn new(work: &Path) -> std::io::Result<Self> {
        for n in 0u32.. {
            let dir = work.join(format!("unpack-{}-{n}", std::process::id()));
            match std::fs::create_dir(&dir) {
                Ok(()) => return Ok(Self(dir)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
        unreachable!("u32 exhausted")
    }
}

impl Drop for Unpacked {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Debug)]
pub enum EngineError {
    Io(std::path::PathBuf, std::io::Error),
    Manifest(ehcoll::ParseError),
    Archive(eh_archive::ArchiveError),
    Reconstruct(eh_fomod::ReconstructError),
    /// The manifest records no file list for this mod (a `none` build), so
    /// there is nothing to rebuild its staging from.
    NoStagingRecord(String),
    /// Some recorded files have no source. Nothing was written.
    Incomplete { compare_key: String, missing: Vec<eh_fomod::MissingFile>, unhashed: Vec<String> },
    Library(eh_library::LibraryError),
    Nexus(eh_nexus::NexusError),
    Package(eh_package::PackageError),
    /// This build supports [`MAX_INSTANCES`], and they exist.
    InstanceLimit(Vec<eh_library::InstanceId>),
    WrongGame {
        instance: eh_library::InstanceId,
        instance_game: ehcoll::SupportedGameId,
        manifest_game: ehcoll::SupportedGameId,
    },
    WrongPackage { instance: eh_library::InstanceId, installs: String, offered: String },
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(p, e) => write!(f, "{}: {e}", p.display()),
            Self::Manifest(e) => write!(f, "{e}"),
            Self::Archive(e) => write!(f, "{e}"),
            Self::Reconstruct(e) => write!(f, "{e}"),
            Self::NoStagingRecord(k) => write!(
                f,
                "{k}: the manifest records no file list for this mod, so its staging cannot be rebuilt"
            ),
            Self::Library(e) => write!(f, "{e}"),
            Self::Nexus(e) => write!(f, "{e}"),
            Self::Package(e) => write!(f, "{e}"),
            Self::InstanceLimit(ids) => write!(
                f,
                "this version supports {MAX_INSTANCES} instance(s), and {} exist: {}",
                ids.len(),
                ids.iter().map(|i| i.as_str()).collect::<Vec<_>>().join(", ")
            ),
            Self::WrongGame { instance, instance_game, manifest_game } => write!(
                f,
                "instance {instance} is for {}, but this collection is for {}",
                instance_game.as_str(),
                manifest_game.as_str()
            ),
            Self::WrongPackage { instance, installs, offered } => write!(
                f,
                "instance {instance} installs {installs:?}; {offered:?} is a different collection \
                 and needs its own instance"
            ),
            Self::Incomplete { compare_key, missing, unhashed } => {
                write!(
                    f,
                    "{compare_key}: cannot reproduce the curator's staging — {} file(s) have no source, \
                     {} have no recorded hash. Nothing was written.",
                    missing.len(),
                    unhashed.len()
                )?;
                for m in missing.iter().take(10) {
                    write!(f, "\n  - no source for {} (sha256 {})", m.path, m.sha256)?;
                }
                if missing.len() > 10 {
                    write!(f, "\n  … and {} more", missing.len() - 10)?;
                }
                Ok(())
            }
        }
    }
}

impl std::error::Error for EngineError {}

