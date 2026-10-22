//! Mods the user supplies by hand: finding them, opening their page, and
//! taking the file in.
//!
//! An external mod that the collection does not bundle and Nexus does not
//! host — a LoversLab file, a Google Drive link — is downloaded by the user.
//! `eh download <mod>` opens its page; `eh feed <mod> <file>` takes the file
//! into the library; `eh install` then stages it.
//!
//! ─── IDENTITY IS THE HASH, NOT THE NAME ─────────────────────────────────
//! The file the user points at is hashed. If it is the collection's archive
//! (same SHA-256), it is stored under that hash and the mod is done.
//!
//! If it is NOT — a mirror, a repack, the author's newer upload — the
//! TypeScript installer installs it anyway with a warning. This one cannot:
//! it rebuilds the curator's exact files, so the question it can answer is
//! sharper — does this archive hold every file the curator staged, byte for
//! byte? If yes, it is accepted (the staged result is identical, and every
//! file is checked again when staged). If no, it is refused, naming what is
//! missing; installing part of a mod would be worse than reporting it.

use crate::install::{fingerprint, part_dir, supplied_archive};
use crate::EngineError;
use eh_library::{Instance, Library};
use eh_progress::{Task, Unit};
use ehcoll::{EhcollManifest, EhcollMod, ModSource};
use std::fs;
use std::path::{Path, PathBuf};

/// The manifest of the package an instance installs, read from its unpacked
/// folder — no zip reopened, no package file needed.
pub fn instance_manifest(instance: &Instance) -> Result<(EhcollManifest, PathBuf), EngineError> {
    let sha = instance
        .config()
        .package
        .as_ref()
        .and_then(|p| p.sha256.clone())
        .ok_or_else(|| EngineError::NoPackageYet(instance.id().to_string()))?;
    let dir = instance.package_dir().join(sha);
    let parsed = crate::load_manifest(&dir.join("manifest.json"))?;
    Ok((parsed.manifest, dir))
}

/// A mod the user has to download themselves.
#[derive(Debug, Clone)]
pub struct Wanted {
    pub name: String,
    pub compare_key: String,
    pub expected_filename: String,
    pub sha256: Option<String>,
    pub url: Option<String>,
    pub instructions: Option<String>,
}

/// External mods still waiting for their archive, in install order: not
/// bundled, not staged from their current files, and not in the library.
pub fn missing(library: &Library, instance: &Instance) -> Result<Vec<Wanted>, EngineError> {
    let (manifest, _) = instance_manifest(instance)?;
    let mut mods: Vec<&EhcollMod> = manifest.mods.iter().collect();
    mods.sort_by_key(|m| m.state.install_order);
    Ok(mods.into_iter().filter_map(|m| wanted(library, instance, m)).collect())
}

fn wanted(library: &Library, instance: &Instance, m: &EhcollMod) -> Option<Wanted> {
    let ModSource::External(src) = &m.source else { return None };
    if src.bundled {
        return None;
    }
    let staged = fingerprint(m)
        .is_some_and(|fp| instance.staged_fingerprint(&m.compare_key).as_deref() == Some(fp.as_str()));
    let have = src.sha256.as_deref().and_then(|s| supplied_archive(library, s)).is_some()
        || instance.supplied_sha(&m.compare_key).and_then(|s| supplied_archive(library, &s)).is_some();
    if staged || have {
        return None;
    }
    Some(Wanted {
        name: m.name.clone(),
        compare_key: m.compare_key.clone(),
        expected_filename: src.expected_filename.clone(),
        sha256: src.sha256.clone(),
        url: src.url.clone(),
        instructions: src.instructions.clone(),
    })
}

/// The mod a user means. Tried in order, first unique answer wins:
/// a number from `eh missing`, the exact compare key, the exact name
/// (ignoring case), then a piece of the name (ignoring case).
pub fn find_mod_by_query<'m>(
    manifest: &'m EhcollManifest,
    missing_list: &[Wanted],
    query: &str,
) -> Result<&'m EhcollMod, EngineError> {
    let q = query.trim();
    let by_key = |k: &str| manifest.mods.iter().find(|m| m.compare_key == k);
    if let Ok(n) = q.parse::<usize>() {
        return missing_list
            .get(n.wrapping_sub(1))
            .and_then(|w| by_key(&w.compare_key))
            .ok_or_else(|| EngineError::NoSuchMod(format!("#{n} (the list from `eh missing` has {})", missing_list.len())));
    }
    if let Some(m) = by_key(q) {
        return Ok(m);
    }
    let lower = q.to_lowercase();
    let exact: Vec<&EhcollMod> = manifest.mods.iter().filter(|m| m.name.to_lowercase() == lower).collect();
    let hits = if exact.is_empty() {
        manifest.mods.iter().filter(|m| m.name.to_lowercase().contains(&lower)).collect()
    } else {
        exact
    };
    match hits.as_slice() {
        [one] => Ok(one),
        [] => Err(EngineError::NoSuchMod(q.to_owned())),
        many => Err(EngineError::AmbiguousMod {
            query: q.to_owned(),
            candidates: many.iter().map(|m| (m.name.clone(), m.compare_key.clone())).collect(),
        }),
    }
}

/// What feeding a file did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fed {
    /// The collection's own archive.
    Matches,
    /// A different archive that holds every staged file; accepted.
    Equivalent { sha256: String, files: usize },
}

/// Take a file the user downloaded for `m` into the library.
///
/// The user's file is never moved or changed: it is hard-linked into the
/// library when it is on the same disk (no space used), copied otherwise.
pub fn feed(
    library: &Library,
    instance: &Instance,
    package_dir: &Path,
    m: &EhcollMod,
    file: &Path,
    task: &Task,
) -> Result<Fed, EngineError> {
    let ModSource::External(src) = &m.source else {
        return Err(EngineError::NotUserSupplied(m.name.clone(), "it is downloaded from Nexus"));
    };
    if src.bundled {
        return Err(EngineError::NotUserSupplied(m.name.clone(), "the collection carries its files"));
    }
    if !file.is_file() {
        return Err(EngineError::Io(file.to_path_buf(), std::io::Error::other("not a file")));
    }
    let hashing = task.child("hash", None, Unit::Bytes);
    let (sha, _) = eh_identity::sha256_file(file, Some(&hashing)).map_err(|e| EngineError::Io(file.to_path_buf(), e))?;
    hashing.done();

    if src.sha256.as_deref() == Some(sha.as_str()) {
        store(library, file, &sha)?;
        return Ok(Fed::Matches);
    }

    // Not the collection's archive. Does it hold every file the curator staged?
    let Some(files) = &m.state.staging_files else {
        return Err(EngineError::NoStagingRecord(m.compare_key.clone()));
    };
    let work = instance.work_dir();
    fs::create_dir_all(&work).map_err(|e| EngineError::Io(work.clone(), e))?;
    let probe = part_dir(&work.join(format!("feed-{}", std::process::id())));
    let _ = fs::remove_dir_all(&probe);
    let result = (|| {
        let extracting = task.child("open", None, Unit::Files);
        eh_archive::extract(file, &probe, &extracting).map_err(|e| EngineError::Damaged(file.to_path_buf(), e.to_string()))?;
        extracting.done();
        let mut index = eh_fomod::ContentIndex::new();
        let hashing = task.child("compare", None, Unit::Bytes);
        index.add_tree(&probe, &hashing).map_err(|e| EngineError::Io(probe.clone(), e))?;
        let mirror = package_dir.join("mirror");
        if mirror.is_dir() {
            index.add_tree(&mirror, &hashing).map_err(|e| EngineError::Io(mirror.clone(), e))?;
        }
        hashing.done();
        Ok(eh_fomod::plan(files, &index))
    })();
    let _ = fs::remove_dir_all(&probe);
    let _ = fs::remove_dir(&work);
    let plan = result?;
    if !plan.is_complete() {
        return Err(EngineError::SuppliedDiffers {
            name: m.name.clone(),
            expected: src.sha256.clone(),
            actual: sha,
            missing: plan.missing.iter().map(|f| f.path.clone()).collect(),
            total: files.len(),
        });
    }
    store(library, file, &sha)?;
    instance.record_supplied(&m.compare_key, &sha).map_err(EngineError::Library)?;
    Ok(Fed::Equivalent { sha256: sha, files: plan.len() })
}

/// What feeding a whole folder did.
#[derive(Debug, Clone, Default)]
pub struct FedFolder {
    /// Mods whose exact archive was found in the folder.
    pub matched: Vec<String>,
    /// Files looked at.
    pub files_hashed: usize,
}

/// Hash every file directly in `dir` and take in each one that is exactly
/// the archive a waiting mod names. Only exact matches: a different archive
/// needs the mod named, so the check above can say what it lacks.
pub fn feed_folder(library: &Library, instance: &Instance, dir: &Path, task: &Task) -> Result<FedFolder, EngineError> {
    let wanted: Vec<Wanted> = missing(library, instance)?;
    let mut by_sha = std::collections::HashMap::new();
    for w in &wanted {
        if let Some(s) = &w.sha256 {
            by_sha.insert(s.clone(), w.name.clone());
        }
    }
    let mut out = FedFolder::default();
    if by_sha.is_empty() {
        return Ok(out);
    }
    let mut entries: Vec<PathBuf> = fs::read_dir(dir)
        .map_err(|e| EngineError::Io(dir.to_path_buf(), e))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_file())
        .collect();
    entries.sort();
    let hashing = task.child("hash files", None, Unit::Bytes);
    for path in entries {
        let Ok((sha, _)) = eh_identity::sha256_file(&path, Some(&hashing)) else { continue };
        out.files_hashed += 1;
        if let Some(name) = by_sha.remove(&sha) {
            store(library, &path, &sha)?;
            out.matched.push(name);
        }
    }
    hashing.done();
    Ok(out)
}

/// Put `file` (already hashed to `sha`) into the library's downloads, under
/// its hash: a hard link when possible, else a copy. Written under a
/// temporary name and verified before it takes the final one.
fn store(library: &Library, file: &Path, sha: &str) -> Result<PathBuf, EngineError> {
    let dest = library.archive_path(sha).map_err(EngineError::Library)?;
    if supplied_archive(library, sha).is_some() {
        return Ok(dest);
    }
    let tmp = dest.with_extension("eh-part");
    let _ = fs::remove_file(&tmp);
    if fs::hard_link(file, &tmp).is_err() {
        fs::copy(file, &tmp).map_err(|e| EngineError::Io(tmp.clone(), e))?;
    }
    let (got, _) = eh_identity::sha256_file(&tmp, None).map_err(|e| EngineError::Io(tmp.clone(), e))?;
    if got != sha {
        let _ = fs::remove_file(&tmp);
        return Err(EngineError::Unexpected(format!("{} changed while it was being taken in", file.display())));
    }
    fs::rename(&tmp, &dest).map_err(|e| EngineError::Io(dest.clone(), e))?;
    Ok(dest)
}
