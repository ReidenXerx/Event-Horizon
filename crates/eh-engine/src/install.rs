//! The install loop: one collection package into one instance, mod by mod.
//!
//! ─── WHAT A RUN DOES ────────────────────────────────────────────────────
//!  1. Hold the instance (one run at a time), read the package, check it is
//!     for the instance's game and modpack.
//!  2. Refuse up front if Nexus downloads are needed and the account is not
//!     Premium — before mod 1, not at mod 900. (Premium-only for now:
//!     decided 2026-10-21.)
//!  3. Unpack the package into the instance, once per package file.
//!  4. For each mod, in the curator's install order: get its bytes (Nexus
//!     download, the package's `bundled/`, or an archive the user put in the
//!     library), then rebuild its staging folder by content.
//!
//! ─── SEQUENTIAL, AND RESUMABLE ──────────────────────────────────────────
//! One mod at a time — parallel installs lose files. A mod's staging folder
//! is built under a temporary name and renamed into place, and only then is
//! its receipt written; a run that stops anywhere leaves either a finished
//! mod or nothing, and the next run continues from the first unfinished one.
//!
//! The receipt holds a fingerprint of what the mod's folder was built from.
//! A new revision of the collection can keep a mod but change its files (a
//! different FOMOD choice, say); then the fingerprint differs and the mod is
//! rebuilt rather than skipped.
//!
//! ─── WHAT STOPS A RUN, AND WHAT DOES NOT ────────────────────────────────
//! A problem with ONE mod — removed from Nexus, different bytes, an archive
//! the user has not supplied — is recorded and the run moves on, unless the
//! curator set `strictMissingMods`, in which case it stops with the report
//! so far. A problem with the ACCOUNT — rejected key, rate limit, Nexus
//! unreachable — stops the run either way: every later mod would fail the
//! same way.
//!
//! This stages mods; it does not deploy them. Deployment is a separate step.

use crate::{read_package, stage_with, EngineError};
use eh_library::{Instance, Library, PackageRef};
use eh_nexus::{Client, NexusError};
use eh_progress::{Task, Unit};
use ehcoll::{EhcollMod, ModSource};
use std::fs;
use std::path::{Path, PathBuf};

/// What a run did, mod by mod.
#[derive(Debug, Clone, Default)]
pub struct InstallReport {
    /// Staged by this run.
    pub staged: Vec<String>,
    /// Already staged from the same files by an earlier run.
    pub already_staged: Vec<String>,
    pub failed: Vec<ModFailure>,
    /// External mods whose archive the user has to supply.
    pub needs_user: Vec<NeedsUser>,
    /// Why the run stopped before the last mod, when it did.
    pub stopped: Option<String>,
}

impl InstallReport {
    /// Every mod is staged.
    pub fn is_complete(&self) -> bool {
        self.failed.is_empty() && self.needs_user.is_empty() && self.stopped.is_none()
    }
}

#[derive(Debug, Clone)]
pub struct ModFailure {
    pub name: String,
    pub compare_key: String,
    pub why: String,
}

/// An external mod the collection does not carry and Nexus does not host.
#[derive(Debug, Clone)]
pub struct NeedsUser {
    pub name: String,
    pub compare_key: String,
    /// What the curator's file was called — a hint, never identity.
    pub expected_filename: String,
    /// The identity: the archive must hash to this. `None` when the mod is
    /// identified by its files alone and cannot be located by archive.
    pub sha256: Option<String>,
    pub instructions: Option<String>,
    pub url: Option<String>,
}

/// Install `package_path` into `instance`. `client` is needed only when a
/// mod must be downloaded from Nexus.
pub fn install_package(
    client: Option<&Client>,
    library: &Library,
    instance: &mut Instance,
    package_path: &Path,
    task: &Task,
) -> Result<InstallReport, EngineError> {
    let _lock = instance.lock().map_err(EngineError::Library)?;

    let package = read_package(package_path)?;
    let manifest = &package.manifest;
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

    let mut mods: Vec<&EhcollMod> = manifest.mods.iter().collect();
    mods.sort_by_key(|m| m.state.install_order);

    require_premium_if_needed(client, library, instance, &mods)?;

    let (package_dir, package_sha) = unpack_package(instance, package_path, task)?;
    // Bound to this package — a newer revision of the same collection keeps
    // the binding current — with the file and its unpacked folder recorded,
    // so `eh install <instance>` and `eh feed` work without being handed it.
    instance
        .set_package(PackageRef {
            id: manifest.package.id.clone(),
            name: manifest.package.name.clone(),
            version: manifest.package.version.clone(),
            file: Some(fs::canonicalize(package_path).unwrap_or_else(|_| package_path.to_path_buf())),
            sha256: Some(package_sha),
        })
        .map_err(EngineError::Library)?;
    let mirror = package_dir.join("mirror");
    let mut mirror_index = eh_fomod::ContentIndex::new();
    if mirror.is_dir() {
        let hashing = task.child("hash package mirror files", None, Unit::Bytes);
        mirror_index.add_tree(&mirror, &hashing).map_err(|e| EngineError::Io(mirror.clone(), e))?;
        hashing.done();
    }

    let strict = manifest.package.strict_missing_mods;
    let run = task.child(format!("install {}", manifest.package.name), Some(mods.len() as u64), Unit::Mods);
    let mut report = InstallReport::default();
    for m in mods {
        let step = run.child(&m.name, None, Unit::Steps);
        match install_one(client, library, instance, &package_dir, &mirror_index, m, &step) {
            Ok(Outcome::Staged) => {
                step.done();
                report.staged.push(m.name.clone());
            }
            Ok(Outcome::Already) => {
                step.skipped("already staged");
                report.already_staged.push(m.name.clone());
            }
            Ok(Outcome::NeedsUser(n)) => {
                step.skipped("needs the archive from you");
                report.needs_user.push(n);
                if strict {
                    report.stopped = Some(format!(
                        "{} is not available and the collection requires every mod (strictMissingMods)",
                        m.name
                    ));
                    break;
                }
            }
            Err(Failure::Mod(why)) => {
                step.failed(why.clone());
                report.failed.push(ModFailure { name: m.name.clone(), compare_key: m.compare_key.clone(), why });
                if strict {
                    report.stopped =
                        Some(format!("{} failed and the collection requires every mod (strictMissingMods)", m.name));
                    break;
                }
            }
            Err(Failure::Run(e)) => {
                step.failed(e.to_string());
                report.stopped = Some(format!("stopped at {}: {e}", m.name));
                break;
            }
        }
        run.advance(1);
    }
    let _ = fs::remove_dir(instance.work_dir());
    if report.is_complete() {
        run.done();
    } else {
        run.failed("not every mod is staged");
    }
    Ok(report)
}

enum Outcome {
    Staged,
    Already,
    NeedsUser(NeedsUser),
}

enum Failure {
    /// This mod failed; the run can go on.
    Mod(String),
    /// Every later mod would fail the same way.
    Run(EngineError),
}

fn install_one(
    client: Option<&Client>,
    library: &Library,
    instance: &Instance,
    package_dir: &Path,
    mirror_index: &eh_fomod::ContentIndex,
    m: &EhcollMod,
    step: &Task,
) -> Result<Outcome, Failure> {
    let Some(fingerprint) = fingerprint(m) else {
        return Err(Failure::Mod(EngineError::NoStagingRecord(m.compare_key.clone()).to_string()));
    };
    let dest = instance.staging_dir_for(&m.compare_key);
    if instance.staged_fingerprint(&m.compare_key).as_deref() == Some(fingerprint.as_str()) && dest.is_dir() {
        return Ok(Outcome::Already);
    }

    let mut archive: Option<PathBuf> = None;
    let mut extra: Vec<PathBuf> = Vec::new();
    match &m.source {
        ModSource::Nexus(src) => {
            let client = client.ok_or(Failure::Run(EngineError::NoNexusClient))?;
            let fetching = step.child("download", None, Unit::Bytes);
            match crate::fetch_nexus_mod(client, library, src, &fetching) {
                Ok(f) => {
                    fetching.done();
                    archive = Some(f.path);
                }
                Err(EngineError::Nexus(e)) => {
                    fetching.failed(e.to_string());
                    return Err(match e {
                        NexusError::InvalidKey(_)
                        | NexusError::NotPremium(_)
                        | NexusError::RateLimited(_)
                        | NexusError::Transport(_) => Failure::Run(EngineError::Nexus(e)),
                        other => Failure::Mod(other.to_string()),
                    });
                }
                Err(e) => return Err(Failure::Mod(e.to_string())),
            }
        }
        ModSource::External(src) if src.bundled => {
            let sha = src.sha256.as_deref().unwrap_or_default();
            extra.push(package_dir.join("bundled").join(sha));
        }
        ModSource::External(src) => {
            // The collection's own archive, by its hash; else one the user
            // supplied that `eh feed` proved holds every staged file.
            let supplied = src
                .sha256
                .as_deref()
                .and_then(|sha| supplied_archive(library, sha))
                .or_else(|| instance.supplied_sha(&m.compare_key).and_then(|sha| supplied_archive(library, &sha)));
            match supplied {
                Some(path) => archive = Some(path),
                None => {
                    return Ok(Outcome::NeedsUser(NeedsUser {
                        name: m.name.clone(),
                        compare_key: m.compare_key.clone(),
                        expected_filename: src.expected_filename.clone(),
                        sha256: src.sha256.clone(),
                        instructions: src.instructions.clone(),
                        url: src.url.clone(),
                    }))
                }
            }
        }
    }

    // Rebuild under a temporary name; the old folder (if any) and its receipt
    // go first, so a crash leaves no receipt naming a folder it does not
    // describe. Both live inside this instance's staging: ours to replace.
    instance.forget_staged(&m.compare_key).map_err(|e| Failure::Mod(e.to_string()))?;
    let part = part_dir(&dest);
    for stale in [&part, &dest] {
        if stale.exists() {
            fs::remove_dir_all(stale).map_err(|e| Failure::Mod(format!("{}: {e}", stale.display())))?;
        }
    }
    let extra_refs: Vec<&Path> = extra.iter().map(PathBuf::as_path).collect();
    stage_with(m, archive.as_deref(), mirror_index, &extra_refs, &instance.work_dir(), &part, step).map_err(|e| {
        let _ = fs::remove_dir_all(&part);
        Failure::Mod(e.to_string())
    })?;
    fs::rename(&part, &dest).map_err(|e| Failure::Mod(format!("{}: {e}", dest.display())))?;
    instance.record_staged(&m.compare_key, &fingerprint).map_err(|e| Failure::Mod(e.to_string()))?;
    Ok(Outcome::Staged)
}

/// Before anything is downloaded: does this run need Nexus, and can it?
fn require_premium_if_needed(
    client: Option<&Client>,
    library: &Library,
    instance: &Instance,
    mods: &[&EhcollMod],
) -> Result<(), EngineError> {
    let needs_download = mods.iter().any(|m| {
        let ModSource::Nexus(src) = &m.source else { return false };
        let staged = fingerprint(m).is_some_and(|fp| {
            instance.staged_fingerprint(&m.compare_key).as_deref() == Some(fp.as_str())
        });
        let stored = library.archive_path(&src.sha256).map(|p| p.is_file()).unwrap_or(false);
        !staged && !stored
    });
    if !needs_download {
        return Ok(());
    }
    let client = client.ok_or(EngineError::NoNexusClient)?;
    let account = client.validate().map_err(EngineError::Nexus)?;
    if !account.is_premium {
        return Err(EngineError::PremiumRequired(account.name));
    }
    Ok(())
}

/// The archive for an external mod, if the user has put it in the library's
/// downloads under its hash and its bytes match.
pub(crate) fn supplied_archive(library: &Library, sha256: &str) -> Option<PathBuf> {
    let path = library.archive_path(sha256).ok()?;
    let (got, _) = eh_identity::sha256_file(&path, None).ok()?;
    (got == sha256).then_some(path)
}

/// Unpack the package into the instance, once per package FILE: the folder
/// is named by the file's SHA-256, built under a temporary name and renamed
/// into place, so an existing folder is always a complete unpacking.
fn unpack_package(instance: &Instance, package_path: &Path, task: &Task) -> Result<(PathBuf, String), EngineError> {
    let hashing = task.child("check package", None, Unit::Bytes);
    let (sha, _) = eh_identity::sha256_file(package_path, Some(&hashing))
        .map_err(|e| EngineError::Io(package_path.to_path_buf(), e))?;
    hashing.done();
    let root = instance.package_dir();
    let dir = root.join(&sha);
    if dir.is_dir() {
        return Ok((dir, sha));
    }
    let part = part_dir(&dir);
    if part.exists() {
        fs::remove_dir_all(&part).map_err(|e| EngineError::Io(part.clone(), e))?;
    }
    let unpacking = task.child("unpack package", None, Unit::Files);
    let extraction = eh_archive::extract(package_path, &part, &unpacking).map_err(EngineError::Archive)?;
    if !extraction.refused.is_empty() {
        let _ = fs::remove_dir_all(&part);
        return Err(EngineError::Unexpected(format!(
            "the package has {} entries that would write outside its folder; it was changed after it \
             was built. Download it again.",
            extraction.refused.len()
        )));
    }
    unpacking.done();
    fs::rename(&part, &dir).map_err(|e| EngineError::Io(dir.clone(), e))?;
    Ok((dir, sha))
}

pub(crate) fn part_dir(dir: &Path) -> PathBuf {
    let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    dir.with_file_name(format!(".eh-part-{name}"))
}

/// What a mod's staging folder is built from: its source identity and its
/// recorded files. Same fingerprint, same folder.
pub(crate) fn fingerprint(m: &EhcollMod) -> Option<String> {
    let files = m.state.staging_files.as_ref()?;
    let mut lines: Vec<String> = files
        .iter()
        .map(|f| format!("{}\t{}\t{}", f.path, f.size, f.sha256.as_deref().unwrap_or("-")))
        .collect();
    lines.sort();
    let source = match &m.source {
        ModSource::Nexus(s) => format!("nexus\t{}", s.sha256),
        ModSource::External(s) => format!("external\t{}\t{}", s.sha256.as_deref().unwrap_or("-"), s.bundled),
    };
    let text = format!("{}\n{source}\n{}", m.compare_key, lines.join("\n"));
    eh_identity::sha256_reader(text.as_bytes(), None).ok().map(|(h, _)| h)
}
