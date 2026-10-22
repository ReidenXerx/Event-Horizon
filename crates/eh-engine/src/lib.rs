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

mod install;
mod supply;

pub use install::{install_package, InstallReport, ModFailure, NeedsUser};
pub use supply::{feed, feed_folder, find_mod_by_query, instance_manifest, missing, Fed, FedFolder, Wanted};

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

/// The deployment planner and its types, re-exported for shells.
pub mod deploy {
    pub use eh_deploy::*;
}

/// A deployment plan, and what still stands between it and the game.
#[derive(Debug, Clone)]
pub struct DeployPreview {
    pub collection: String,
    pub game: ehcoll::SupportedGameId,
    pub game_dir: std::path::PathBuf,
    pub plan: eh_deploy::DeployPlan,
    /// Mods the plan deploys whose staging is not built from their current
    /// files yet — `eh install` first.
    pub unstaged: Vec<String>,
    /// compareKey → name, for showing people mods rather than keys.
    pub names: std::collections::HashMap<String, String>,
}

impl DeployPreview {
    /// A mod's name, or its key when the manifest has no such mod.
    pub fn name<'a>(&'a self, key: &'a str) -> &'a str {
        self.names.get(key).map(String::as_str).unwrap_or(key)
    }
}

/// Plan the deployment of the collection an instance has installed. Reads
/// nothing in the game folder and writes nothing anywhere.
pub fn deploy_preview(instance: &eh_library::Instance) -> Result<DeployPreview, EngineError> {
    let (manifest, _) = instance_manifest(instance)?;
    let plan = eh_deploy::plan(manifest.game.id, &manifest.mods, &manifest.rules).map_err(EngineError::Plan)?;
    let by_key: std::collections::HashMap<&str, &ehcoll::EhcollMod> =
        manifest.mods.iter().map(|m| (m.compare_key.as_str(), m)).collect();
    let unstaged = plan
        .order
        .iter()
        .filter(|k| {
            let fp = install::fingerprint(by_key[k.as_str()]);
            fp.is_none() || instance.staged_fingerprint(k) != fp || !instance.staging_dir_for(k).is_dir()
        })
        .cloned()
        .collect();
    Ok(DeployPreview {
        collection: manifest.package.name.clone(),
        game: manifest.game.id,
        game_dir: instance.config().game_dir.clone(),
        names: manifest.mods.iter().map(|m| (m.compare_key.clone(), m.name.clone())).collect(),
        plan,
        unstaged,
    })
}

/// Pre-flight: check the plan against the real game folder. Reads the game
/// folder; the only write is a hardlink test file, removed at once.
pub fn deploy_check(instance: &eh_library::Instance) -> Result<(DeployPreview, eh_deploy::Preflight), EngineError> {
    let preview = deploy_preview(instance)?;
    let staging_of = |k: &str| instance.staging_dir_for(k);
    // Files an earlier Event Horizon deployment placed — including one that
    // stopped halfway — are replaced, never mistaken for foreign files.
    let record = eh_deploy::Store::new(instance.dir()).load().map_err(EngineError::Apply)?;
    let ours = eh_deploy::ours(&record, &instance.config().game_dir);
    let check = eh_deploy::preflight(
        &preview.plan,
        &eh_deploy::Layout {
            game: preview.game,
            game_dir: &instance.config().game_dir,
            staging_root: &instance.staging_root(),
            staging_of: &staging_of,
            ours: &ours,
        },
    );
    Ok((preview, check))
}

/// What deploying did.
#[derive(Debug, Clone)]
pub struct Deployed {
    pub applied: eh_deploy::Applied,
    /// What an earlier deployment placed that this plan no longer has —
    /// taken out, its backups put back.
    pub pruned: eh_deploy::Purged,
    /// Whether this run finished one that had been interrupted.
    pub resumed: bool,
}

/// Deploy the instance's collection into its game folder, as hardlinks.
/// Refuses unless every mod is staged and pre-flight is clear.
pub fn deploy(instance: &eh_library::Instance, task: &Task) -> Result<Deployed, EngineError> {
    let _lock = instance.lock().map_err(EngineError::Library)?;
    let store = eh_deploy::Store::new(instance.dir());
    let resumed = store.interrupted();
    let (preview, check) = deploy_check(instance)?;
    if !preview.unstaged.is_empty() {
        return Err(EngineError::NotStaged(preview.unstaged.len()));
    }
    let game_dir = &instance.config().game_dir;
    let backups = backups_root(instance);
    let applied = eh_deploy::apply(&preview.plan, &check, game_dir, &backups, &store, task).map_err(EngineError::Apply)?;
    // Then what the plan no longer has: out, with its backups put back.
    let keep: std::collections::BTreeSet<String> = check
        .placed
        .iter()
        .map(|p| p.dest.strip_prefix(game_dir).unwrap_or(&p.dest).to_string_lossy().replace('\\', "/"))
        .collect();
    let pruned = eh_deploy::prune(&store, game_dir, &backups, &keep).map_err(EngineError::Purge)?;
    Ok(Deployed { applied, pruned, resumed })
}

fn backups_root(instance: &eh_library::Instance) -> std::path::PathBuf {
    instance.staging_root().join(".eh-backups")
}

/// Take the whole deployment out of the game folder and put every backed-up
/// file back. Checks every backup before changing anything.
pub fn purge(instance: &eh_library::Instance) -> Result<eh_deploy::Purged, EngineError> {
    let _lock = instance.lock().map_err(EngineError::Library)?;
    let store = eh_deploy::Store::new(instance.dir());
    if !store.has_deployment() {
        return Ok(eh_deploy::Purged::default());
    }
    eh_deploy::purge(&store, &instance.config().game_dir, &backups_root(instance)).map_err(EngineError::Purge)
}

/// What `eh verify` found.
#[derive(Debug, Clone)]
pub struct VerifyReport {
    pub verified: eh_deploy::Verified,
    /// Mods whose staged files are themselves wrong: they must be staged
    /// again from their archives (see [`forget_for_restage`]).
    pub restage: Vec<String>,
    /// compareKey → name.
    pub names: std::collections::HashMap<String, String>,
}

/// The integrity pass (NS-4): check every planned file against the
/// curator's record — in the game folder when deployed, else in staging.
/// Reads only; writes nothing anywhere.
pub fn verify(instance: &eh_library::Instance, quick: bool, task: &Task) -> Result<VerifyReport, EngineError> {
    let (manifest, _) = instance_manifest(instance)?;
    let preview = deploy_preview(instance)?;
    let mut expected_by: std::collections::HashMap<(&str, &str), eh_deploy::Expected> = std::collections::HashMap::new();
    for m in &manifest.mods {
        for f in m.state.staging_files.as_deref().unwrap_or_default() {
            expected_by.insert(
                (m.compare_key.as_str(), f.path.as_str()),
                eh_deploy::Expected { size: f.size, sha256: f.sha256.clone() },
            );
        }
    }
    let expected = |k: &str, p: &str| expected_by.get(&(k, p)).cloned();
    let staging_of = |k: &str| instance.staging_dir_for(k);
    let store = eh_deploy::Store::new(instance.dir());
    let verified = if store.has_deployment() {
        let record = store.load().map_err(EngineError::Apply)?;
        let nobody = std::collections::BTreeSet::new();
        let located = eh_deploy::locate(
            &preview.plan,
            &eh_deploy::Layout {
                game: preview.game,
                game_dir: &instance.config().game_dir,
                staging_root: &instance.staging_root(),
                staging_of: &staging_of,
                ours: &nobody,
            },
        );
        eh_deploy::verify_deployment(&preview.plan, &located, &record, &instance.config().game_dir, &expected, quick, task)
    } else {
        eh_deploy::verify_staging(&preview.plan, &staging_of, &expected, quick, task)
    };
    // Outside a deployment, any wrong or missing staged file means restage.
    let mut restage: Vec<String> = verified
        .findings
        .iter()
        .filter(|f| f.needs_restage() || !verified.deployment)
        .map(|f| f.mod_key.clone())
        .collect();
    restage.sort();
    restage.dedup();
    Ok(VerifyReport { verified, restage, names: preview.names })
}

/// Forget the staging receipts of `mods`, so the next `eh install` stages
/// them again from their archives instead of trusting what is there.
pub fn forget_for_restage(instance: &eh_library::Instance, mods: &[String]) -> Result<usize, EngineError> {
    for k in mods {
        instance.forget_staged(k).map_err(EngineError::Library)?;
    }
    Ok(mods.len())
}

/// The manifest types, re-exported so a shell needs only the engine.
pub mod manifest {
    pub use ehcoll::*;
}

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
// Collections
// ───────────────────────────────────────────────────────────────────────────

/// The game a Nexus domain names, among the games manifests support. The
/// Nexus domain is not the game id: `skyrimse` is `skyrimspecialedition`.
pub fn game_of_nexus_domain(domain: &str) -> Option<ehcoll::SupportedGameId> {
    use ehcoll::SupportedGameId::*;
    match domain.to_ascii_lowercase().as_str() {
        "skyrimspecialedition" => Some(Skyrimse),
        "fallout3" => Some(Fallout3),
        "newvegas" => Some(Falloutnv),
        "fallout4" => Some(Fallout4),
        "starfield" => Some(Starfield),
        _ => None,
    }
}

/// What a collection link names, without downloading anything.
pub fn collection_info(
    client: &eh_nexus::Client,
    link: &str,
) -> Result<eh_nexus::CollectionRevision, EngineError> {
    let link = eh_nexus::parse_collection_link(link).map_err(EngineError::Link)?;
    client.collection_revision(&link).map_err(EngineError::Nexus)
}

/// A collection's package, downloaded and read.
#[derive(Debug, Clone)]
pub struct FetchedCollection {
    pub revision: eh_nexus::CollectionRevision,
    pub path: std::path::PathBuf,
    /// Where it came from, or `None` when the stored copy was reused.
    pub via: Option<String>,
    pub bytes: u64,
    pub package: eh_package::PackageRead,
}

/// Download the package a collection link names into the library, and read
/// it. Works with a free account: only mod files need Premium.
///
/// The file counts as downloaded only once it reads as an Event Horizon
/// package — so a stored one is never half a file — and only a package for
/// the game the collection is listed under is returned.
pub fn fetch_collection(
    client: &eh_nexus::Client,
    library: &eh_library::Library,
    link: &str,
    task: &Task,
) -> Result<FetchedCollection, EngineError> {
    let revision = collection_info(client, link)?;
    let game = game_of_nexus_domain(&revision.game_domain)
        .ok_or_else(|| EngineError::UnsupportedGame(revision.game_domain.clone()))?;
    let dest = library
        .package_path(&revision.game_domain, &revision.slug, revision.revision_number)
        .map_err(EngineError::Library)?;
    let fetched = client
        .fetch_collection(&revision, &dest, task, &|p| {
            eh_package::read_package(p).map(|_| ()).map_err(|e| e.to_string())
        })
        .map_err(EngineError::Nexus)?;
    let package = read_package(&fetched.path)?;
    if package.manifest.game.id != game {
        return Err(EngineError::Unexpected(format!(
            "collection {} is listed for {}, but its package is for {}",
            revision.slug,
            game.as_str(),
            package.manifest.game.id.as_str()
        )));
    }
    Ok(FetchedCollection { revision, path: fetched.path, via: fetched.via, bytes: fetched.bytes, package })
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
            .set_package(eh_library::PackageRef::named(
                manifest.package.id.clone(),
                manifest.package.name.clone(),
                manifest.package.version.clone(),
            ))
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
    stage_with(m, Some(archive), &eh_fomod::ContentIndex::new(), extra_sources, work, dest, task)
}

/// [`stage_mod`], generalised for the install loop: the archive is optional
/// (a bundled mod's files come from the package), and `base` is an index the
/// caller built once — the package's `mirror/` — instead of rehashing it for
/// every mod.
pub(crate) fn stage_with(
    m: &ehcoll::EhcollMod,
    archive: Option<&Path>,
    base: &eh_fomod::ContentIndex,
    extra_sources: &[&Path],
    work: &Path,
    dest: &Path,
    task: &Task,
) -> Result<Staged, EngineError> {
    let Some(files) = &m.state.staging_files else {
        return Err(EngineError::NoStagingRecord(m.compare_key.clone()));
    };
    let mut index = base.clone();
    let hashing = task.child("hash sources", None, eh_progress::Unit::Bytes);
    let mut refused = 0;
    // Held until staging is written: the extracted copy is a source.
    let mut _unpacked = None;
    if let Some(archive) = archive {
        std::fs::create_dir_all(work).map_err(|e| EngineError::Io(work.to_path_buf(), e))?;
        let unpacked = Unpacked::new(work).map_err(|e| EngineError::Io(work.to_path_buf(), e))?;
        let extracting = task.child("extract", None, eh_progress::Unit::Files);
        let extraction = eh_archive::extract(archive, &unpacked.0, &extracting).map_err(EngineError::Archive)?;
        extracting.done();
        refused = extraction.refused.len();
        index.add_tree(&unpacked.0, &hashing).map_err(|e| EngineError::Io(unpacked.0.clone(), e))?;
        _unpacked = Some(unpacked);
    }
    for tree in extra_sources {
        index.add_tree(tree, &hashing).map_err(|e| EngineError::Io(tree.to_path_buf(), e))?;
    }
    hashing.done();
    let plan = eh_fomod::plan(files, &index);
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
    Ok(Staged { files: applied.files, bytes: applied.bytes, refused_entries: refused })
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
    Plan(eh_deploy::PlanError),
    Apply(eh_deploy::ApplyError),
    Purge(eh_deploy::PurgeError),
    /// Mods the plan deploys are not staged yet.
    NotStaged(usize),
    Link(eh_nexus::LinkError),
    /// The instance has not installed a package yet, so it has no mods.
    NoPackageYet(String),
    NoSuchMod(String),
    AmbiguousMod { query: String, candidates: Vec<(String, String)> },
    /// The mod is not one the user supplies; the reason says where it comes from.
    NotUserSupplied(String, &'static str),
    /// The file cannot be opened as an archive.
    Damaged(std::path::PathBuf, String),
    /// A supplied archive that is not the collection's and lacks some of the
    /// curator's files.
    SuppliedDiffers { name: String, expected: Option<String>, actual: String, missing: Vec<String>, total: usize },
    /// Nexus downloads are needed and there is no client (no key).
    NoNexusClient,
    /// Nexus downloads are needed and the account is not Premium.
    PremiumRequired(String),
    /// A Nexus game this build has no manifest support for.
    UnsupportedGame(String),
    Unexpected(String),
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
            Self::Plan(e) => write!(f, "{e}"),
            Self::Apply(e) => write!(f, "{e}"),
            Self::Purge(e) => write!(f, "{e}"),
            Self::NotStaged(n) => write!(f, "{n} mods are not staged yet; run `eh install` first. Nothing was changed."),
            Self::Link(e) => write!(f, "{e}"),
            Self::NoPackageYet(i) => write!(
                f,
                "instance {i} has no collection installed yet; run `eh install {i} <package or link>` first"
            ),
            Self::NoSuchMod(q) => write!(f, "no mod in the collection matches {q:?}; `eh missing` lists the ones you can supply"),
            Self::AmbiguousMod { query, candidates } => {
                write!(f, "{query:?} matches {} mods — name one exactly, or use its number from `eh missing`:", candidates.len())?;
                for (name, key) in candidates.iter().take(10) {
                    write!(f, "\n  - {name}  ({key})")?;
                }
                if candidates.len() > 10 {
                    write!(f, "\n  … and {} more", candidates.len() - 10)?;
                }
                Ok(())
            }
            Self::NotUserSupplied(name, why) => write!(f, "{name} is not one you supply: {why}"),
            Self::Damaged(p, why) => write!(
                f,
                "{} cannot be opened as an archive ({why}); it is probably an incomplete download — download it again",
                p.display()
            ),
            Self::SuppliedDiffers { name, expected, actual, missing, total } => {
                write!(
                    f,
                    "this is not the archive the collection was built from for {name} (it has sha256 {actual}{}), \
                     and it lacks {} of the {total} files the curator installed, so it was not taken. \
                     It is probably a different version — look for the one the collection names.",
                    expected.as_deref().map(|e| format!(", the collection names {e}")).unwrap_or_default(),
                    missing.len()
                )?;
                for p in missing.iter().take(10) {
                    write!(f, "\n  - missing {p}")?;
                }
                if missing.len() > 10 {
                    write!(f, "\n  … and {} more", missing.len() - 10)?;
                }
                Ok(())
            }
            Self::NoNexusClient => write!(
                f,
                "this collection downloads mods from Nexus, and no Nexus API key is set (see `eh nexus whoami`)"
            ),
            Self::PremiumRequired(name) => write!(
                f,
                "this collection downloads mods from Nexus, and {name}'s account is not Premium. Nexus gives \
                 mod managers direct download links for Premium accounts only, and Event Horizon \
                 requires Premium for now."
            ),
            Self::UnsupportedGame(d) => write!(f, "Event Horizon does not support the Nexus game {d:?}"),
            Self::Unexpected(m) => write!(f, "{m}"),
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

