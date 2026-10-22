//! Applying a deployment to a real (temporary) game folder: links, backups,
//! repeat runs, and a run that fails halfway and is finished by the next.

use eh_deploy::{apply, ours, plan, preflight, ApplyError, Layout, Store};
use eh_progress::{Progress, Unit};
use ehcoll::{parse_manifest, SupportedGameId};
use serde_json::{json, Value};
use std::fs;
use std::io::Write as _;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

const FIXTURE: &str = include_str!("../../../spec/fixtures/manifests/valid/roundtrip.json");
const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SSE: SupportedGameId = SupportedGameId::Skyrimse;

struct World {
    _dir: tempfile::TempDir,
    game: PathBuf,
    staging: PathBuf,
    instance: PathBuf,
}

impl World {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let game = dir.path().join("Skyrim Special Edition");
        fs::create_dir_all(game.join("Data")).unwrap();
        fs::write(game.join("SkyrimSE.exe"), b"exe").unwrap();
        let staging = dir.path().join("instance/staging");
        let instance = dir.path().join("instance");
        fs::create_dir_all(&staging).unwrap();
        Self { _dir: dir, game, staging, instance }
    }

    fn mod_dir(&self, key: &str) -> PathBuf {
        self.staging.join(key.replace(':', "_"))
    }

    /// Stage one mod's files (path, bytes), replacing any earlier staging.
    fn stage(&self, key: &str, files: &[(&str, &[u8])]) {
        let d = self.mod_dir(key);
        let _ = fs::remove_dir_all(&d);
        for (p, b) in files {
            let full = d.join(p);
            fs::create_dir_all(full.parent().unwrap()).unwrap();
            fs::write(full, b).unwrap();
        }
    }

    /// Plan the staged mods (in this order), pre-flight, apply.
    fn deploy(&self, mods: &[(&str, &[&str])]) -> Result<eh_deploy::Applied, ApplyError> {
        let p = plan_of(mods);
        let store = self.store();
        let mine = ours(&store.load()?, &self.game);
        let staging_of = |k: &str| self.mod_dir(k);
        let check = preflight(
            &p,
            &Layout { game: SSE, game_dir: &self.game, staging_root: &self.staging, staging_of: &staging_of, ours: &mine },
        );
        assert!(check.is_clear(), "{:?}", check.blockers);
        apply(&p, &check, &self.game, &self.backups(), &store, &Progress::silent().task("t", None, Unit::Files))
    }

    fn store(&self) -> Store {
        Store::new(&self.instance)
    }

    fn backups(&self) -> PathBuf {
        self.staging.join(".eh-backups")
    }

    fn ino(p: &Path) -> u64 {
        fs::metadata(p).unwrap().ino()
    }
}

/// The plan for these mods (in this order), each with these staged paths.
fn plan_of(mods: &[(&str, &[&str])]) -> eh_deploy::DeployPlan {
    {
        let mods: Vec<Value> = mods
            .iter()
            .enumerate()
            .map(|(i, (key, files))| {
                let id: u64 = key.rsplit(':').next().unwrap().parse().unwrap();
                json!({
                    "compareKey": key, "name": key, "version": "1",
                    "source": { "kind": "nexus", "gameDomain": "skyrimspecialedition", "modId": id, "fileId": id,
                                "archiveName": "x.7z", "sha256": SHA },
                    "install": { "fomodSelections": [] },
                    "state": { "enabled": true, "installOrder": i, "deploymentPriority": i,
                               "stagingFiles": files.iter().map(|p| json!({ "path": p, "size": 1, "sha256": SHA })).collect::<Vec<_>>() }
                })
            })
            .collect();
        let mut v: Value = serde_json::from_str(FIXTURE).unwrap();
        v["mods"] = json!(mods);
        v["rules"] = json!([]);
        v["loadOrder"] = json!([]);
        let man = parse_manifest(&v.to_string()).unwrap().manifest;
        plan(SSE, &man.mods, &man.rules).unwrap()
    }
}

fn no_temp_files(dir: &Path) -> bool {
    walk(dir).iter().all(|p| !p.to_string_lossy().ends_with(".eh-tmp"))
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for e in fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(walk(&p));
        }
        out.push(p);
    }
    out
}

#[test]
fn files_become_hardlinks_to_staging_and_everything_is_recorded() {
    let w = World::new();
    w.stage("nexus:1:1", &[("textures/armor/iron.dds", b"iron"), ("a.esp", b"plugin")]);
    let r = w.deploy(&[("nexus:1:1", &["textures/armor/iron.dds", "a.esp"])]).unwrap();
    assert_eq!((r.linked, r.backed_up, r.created_dirs), (2, 0, 2));

    let dest = w.game.join("Data/textures/armor/iron.dds");
    assert_eq!(World::ino(&dest), World::ino(&w.mod_dir("nexus:1:1").join("textures/armor/iron.dds")), "a hardlink, not a copy");
    let rec = w.store().load().unwrap();
    assert_eq!(rec.files.len(), 2);
    assert_eq!(rec.created_dirs, ["Data/textures", "Data/textures/armor"], "parents first");
    assert!(!w.store().interrupted(), "the journal is folded into the record");
    assert!(no_temp_files(&w.game));
}

#[test]
fn a_file_already_there_is_moved_aside_with_its_hash_then_replaced() {
    let w = World::new();
    fs::write(w.game.join("Data/Dawnguard.esm"), b"the game's own").unwrap();
    w.stage("nexus:1:1", &[("Dawnguard.esm", b"cleaned")]);
    let r = w.deploy(&[("nexus:1:1", &["Dawnguard.esm"])]).unwrap();
    assert_eq!(r.backed_up, 1);
    assert_eq!(fs::read(w.game.join("Data/Dawnguard.esm")).unwrap(), b"cleaned");
    assert_eq!(fs::read(w.backups().join("Data/Dawnguard.esm")).unwrap(), b"the game's own");
    let b = &w.store().load().unwrap().backups[0];
    assert_eq!(b.sha256, eh_identity::sha256_reader(&b"the game's own"[..], None).unwrap().0);
    assert_eq!(b.path, "Data/Dawnguard.esm");
}

#[test]
fn deploying_twice_changes_nothing_the_second_time() {
    let w = World::new();
    fs::write(w.game.join("Data/Dawnguard.esm"), b"vanilla").unwrap();
    w.stage("nexus:1:1", &[("Dawnguard.esm", b"cleaned"), ("b.esp", b"b")]);
    let mods = [("nexus:1:1", &["Dawnguard.esm", "b.esp"][..])];
    w.deploy(&mods).unwrap();
    let record = w.store().load().unwrap();
    let r = w.deploy(&mods).unwrap();
    assert_eq!((r.linked, r.already_in_place, r.backed_up), (0, 2, 0), "our own link is not backed up");
    assert_eq!(w.store().load().unwrap(), record);
}

#[test]
fn an_outdated_file_of_ours_is_replaced_not_backed_up() {
    let w = World::new();
    w.stage("nexus:1:1", &[("a.esp", b"v1")]);
    w.deploy(&[("nexus:1:1", &["a.esp"])]).unwrap();
    w.stage("nexus:1:1", &[("a.esp", b"v2")]); // restaged: a new file, a new inode
    let r = w.deploy(&[("nexus:1:1", &["a.esp"])]).unwrap();
    assert_eq!((r.linked, r.backed_up), (1, 0));
    assert_eq!(fs::read(w.game.join("Data/a.esp")).unwrap(), b"v2");
    assert!(!w.backups().exists());
}

#[test]
fn an_existing_backup_is_never_overwritten() {
    let w = World::new();
    fs::write(w.game.join("Data/Dawnguard.esm"), b"vanilla").unwrap();
    fs::create_dir_all(w.backups().join("Data")).unwrap();
    fs::write(w.backups().join("Data/Dawnguard.esm"), b"an older backup").unwrap();
    w.stage("nexus:1:1", &[("Dawnguard.esm", b"cleaned")]);
    let err = w.deploy(&[("nexus:1:1", &["Dawnguard.esm"])]).unwrap_err();
    assert!(matches!(err, ApplyError::BackupExists { .. }), "{err}");
    assert_eq!(fs::read(w.game.join("Data/Dawnguard.esm")).unwrap(), b"vanilla");
    assert_eq!(fs::read(w.backups().join("Data/Dawnguard.esm")).unwrap(), b"an older backup");
}

#[test]
fn a_missing_staged_file_stops_before_anything_changes() {
    let w = World::new();
    w.stage("nexus:1:1", &[("a.esp", b"a")]);
    let err = w.deploy(&[("nexus:1:1", &["a.esp", "b.esp"])]).unwrap_err();
    assert!(matches!(err, ApplyError::MissingSource(_)), "{err}");
    assert!(!w.game.join("Data/a.esp").exists(), "not even the files that were there");
    assert!(!w.store().interrupted());
}

#[test]
fn a_run_that_fails_halfway_is_finished_by_the_next() {
    let w = World::new();
    fs::create_dir_all(w.game.join("Data/locked")).unwrap();
    let mut perms = fs::metadata(w.game.join("Data/locked")).unwrap().permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o555);
    fs::set_permissions(w.game.join("Data/locked"), perms).unwrap();
    if fs::write(w.game.join("Data/locked/probe"), b"x").is_ok() {
        eprintln!("skipped: running with rights that ignore folder permissions");
        return;
    }
    w.stage("nexus:1:1", &[("a.esp", b"a"), ("c.esp", b"c"), ("locked/b.esp", b"b")]);
    let mods = [("nexus:1:1", &["a.esp", "c.esp", "locked/b.esp"][..])];

    // Planned order is a.esp, c.esp, locked/b.esp: two land, the third fails.
    let err = w.deploy(&mods).unwrap_err();
    assert!(matches!(err, ApplyError::Io(..)), "{err}");
    assert!(w.store().interrupted(), "the journal stays for the next run");
    let replayed = w.store().load().unwrap();
    assert_eq!(replayed.files.len(), 3, "two placed + the one being placed when it failed");
    // As if the crash had also left a temporary link behind.
    fs::write(w.game.join("Data/.a.esp.eh-tmp"), b"leftover").unwrap();

    let mut perms = fs::metadata(w.game.join("Data/locked")).unwrap().permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o755);
    fs::set_permissions(w.game.join("Data/locked"), perms).unwrap();
    let r = w.deploy(&mods).unwrap();
    assert_eq!((r.linked, r.already_in_place, r.backed_up), (1, 2, 0), "the first two are recognised as ours");
    assert!(!w.store().interrupted());
    assert_eq!(w.store().load().unwrap().files.len(), 3);
    assert!(no_temp_files(&w.game));
}

// ── purge and prune ────────────────────────────────────────────────────────

use eh_deploy::{prune, purge, PurgeError};
use std::collections::{BTreeMap, BTreeSet};

/// Every path under the game folder with its bytes (folders as None).
fn snapshot(root: &Path) -> BTreeMap<PathBuf, Option<Vec<u8>>> {
    walk(root)
        .into_iter()
        .map(|p| {
            let bytes = if p.is_dir() { None } else { Some(fs::read(&p).unwrap()) };
            (p.strip_prefix(root).unwrap().to_path_buf(), bytes)
        })
        .collect()
}

/// A deployment with a backed-up vanilla master and a new folder.
fn deployed() -> World {
    let w = World::new();
    fs::write(w.game.join("Data/Dawnguard.esm"), b"vanilla").unwrap();
    w.stage("nexus:1:1", &[("Dawnguard.esm", b"cleaned"), ("textures/armor/iron.dds", b"iron"), ("a.esp", b"a")]);
    w.deploy(&[("nexus:1:1", &["Dawnguard.esm", "textures/armor/iron.dds", "a.esp"])]).unwrap();
    w
}

fn purge_it(w: &World) -> Result<eh_deploy::Purged, PurgeError> {
    purge(&w.store(), &w.game, &w.backups())
}

#[test]
fn purge_puts_the_game_folder_back_exactly_as_it_was() {
    let w = World::new();
    fs::write(w.game.join("Data/Dawnguard.esm"), b"vanilla").unwrap();
    let before = snapshot(&w.game);
    w.stage("nexus:1:1", &[("Dawnguard.esm", b"cleaned"), ("textures/armor/iron.dds", b"iron")]);
    w.deploy(&[("nexus:1:1", &["Dawnguard.esm", "textures/armor/iron.dds"])]).unwrap();
    assert_ne!(snapshot(&w.game), before);

    let p = purge_it(&w).unwrap();
    assert_eq!((p.removed, p.restored, p.folders_removed), (2, 1, 2));
    assert_eq!(snapshot(&w.game), before, "byte for byte, folder for folder");
    assert!(!w.store().has_deployment(), "the record is gone");
    assert!(!w.backups().exists(), "and so is the emptied backup folder");
    assert!(w.mod_dir("nexus:1:1").join("Dawnguard.esm").exists(), "staging is untouched");
}

#[test]
fn a_missing_backup_refuses_the_purge_with_nothing_changed() {
    let w = deployed();
    fs::remove_file(w.backups().join("Data/Dawnguard.esm")).unwrap();
    let before = snapshot(&w.game);
    assert!(matches!(purge_it(&w), Err(PurgeError::BackupMissing { .. })));
    assert_eq!(snapshot(&w.game), before);
    assert!(w.store().has_deployment());
}

#[test]
fn a_damaged_backup_refuses_the_purge_with_nothing_changed() {
    let w = deployed();
    fs::write(w.backups().join("Data/Dawnguard.esm"), b"vanillA").unwrap();
    let before = snapshot(&w.game);
    assert!(matches!(purge_it(&w), Err(PurgeError::BackupDamaged { .. })));
    assert_eq!(snapshot(&w.game), before);
}

#[test]
fn a_new_file_where_a_backup_goes_back_refuses_the_purge() {
    let w = deployed();
    // The user replaced our cleaned master with yet another one.
    fs::remove_file(w.game.join("Data/Dawnguard.esm")).unwrap();
    fs::write(w.game.join("Data/Dawnguard.esm"), b"the user's own").unwrap();
    assert!(matches!(purge_it(&w), Err(PurgeError::RestoreBlocked { .. })));
    assert_eq!(fs::read(w.game.join("Data/Dawnguard.esm")).unwrap(), b"the user's own");
    assert_eq!(fs::read(w.backups().join("Data/Dawnguard.esm")).unwrap(), b"vanilla");
}

#[test]
fn a_file_someone_replaced_is_left_alone_and_named() {
    let w = deployed();
    fs::remove_file(w.game.join("Data/a.esp")).unwrap();
    fs::write(w.game.join("Data/a.esp"), b"edited by the user").unwrap();
    let p = purge_it(&w).unwrap();
    assert_eq!(p.left_alone, [w.game.join("Data/a.esp")]);
    assert_eq!(fs::read(w.game.join("Data/a.esp")).unwrap(), b"edited by the user");
    assert_eq!(fs::read(w.game.join("Data/Dawnguard.esm")).unwrap(), b"vanilla");
}

#[test]
fn a_folder_we_made_that_now_holds_the_users_files_is_kept() {
    let w = deployed();
    fs::write(w.game.join("Data/textures/armor/mine.dds"), b"user").unwrap();
    purge_it(&w).unwrap();
    assert_eq!(fs::read(w.game.join("Data/textures/armor/mine.dds")).unwrap(), b"user");
    assert!(!w.game.join("Data/textures/armor/iron.dds").exists());
}

#[test]
fn a_purge_that_stopped_halfway_is_finished_by_running_it_again() {
    let w = deployed();
    // As if a purge had removed our master and put the backup back, then died
    // before rewriting the record.
    fs::remove_file(w.game.join("Data/Dawnguard.esm")).unwrap();
    fs::rename(w.backups().join("Data/Dawnguard.esm"), w.game.join("Data/Dawnguard.esm")).unwrap();
    let p = purge_it(&w).unwrap();
    assert_eq!(fs::read(w.game.join("Data/Dawnguard.esm")).unwrap(), b"vanilla", "recognised by its hash");
    assert_eq!(p.removed, 2);
    assert!(!w.store().has_deployment());
}

#[test]
fn prune_takes_out_only_what_the_new_plan_dropped() {
    let w = deployed();
    let keep: BTreeSet<String> = ["Data/a.esp".to_owned()].into();
    let p = prune(&w.store(), &w.game, &w.backups(), &keep).unwrap();
    assert_eq!((p.removed, p.restored), (2, 1));
    assert_eq!(fs::read(w.game.join("Data/a.esp")).unwrap(), b"a", "kept");
    assert_eq!(fs::read(w.game.join("Data/Dawnguard.esm")).unwrap(), b"vanilla", "dropped, so the original is back");
    assert!(!w.game.join("Data/textures").exists());
    let rec = w.store().load().unwrap();
    assert_eq!(rec.files.len(), 1);
    assert!(rec.backups.is_empty());
}


// ── verify ─────────────────────────────────────────────────────────────────

use eh_deploy::{locate, verify_deployment, verify_staging, Expected, FindingKind, Verified};

/// The curator's record: each staged path's real size and hash.
fn curator(files: &[(&str, &[u8])]) -> BTreeMap<String, Expected> {
    files
        .iter()
        .map(|(p, b)| {
            let sha = eh_identity::sha256_reader(*b, None).unwrap().0;
            (p.to_string(), Expected { size: b.len() as u64, sha256: Some(sha) })
        })
        .collect()
}

const FILES: [(&str, &[u8]); 2] = [("a.esp", b"plugin"), ("textures/x.dds", b"texture")];
const PATHS: [&str; 2] = ["a.esp", "textures/x.dds"];

fn deployed_for_verify() -> World {
    let w = World::new();
    w.stage("nexus:1:1", &FILES);
    w.deploy(&[("nexus:1:1", &PATHS)]).unwrap();
    w
}

fn verify_it(w: &World, paths: &[&str], quick: bool) -> Verified {
    let p = plan_of(&[("nexus:1:1", paths)]);
    let record = w.store().load().unwrap();
    let staging_of = |k: &str| w.mod_dir(k);
    let nobody = BTreeSet::new();
    let located = locate(&p, &Layout { game: SSE, game_dir: &w.game, staging_root: &w.staging, staging_of: &staging_of, ours: &nobody });
    let rec = curator(&FILES);
    let expected = |_: &str, path: &str| rec.get(path).cloned();
    verify_deployment(&p, &located, &record, &w.game, &expected, quick, &Progress::silent().task("t", None, Unit::Files))
}

fn kinds(v: &Verified) -> Vec<(String, FindingKind)> {
    v.findings.iter().map(|f| (f.path.file_name().unwrap().to_string_lossy().into_owned(), f.kind.clone())).collect()
}

#[test]
fn a_fresh_deployment_verifies_clean_and_verifying_writes_nothing() {
    let w = deployed_for_verify();
    let before = snapshot(&w.game);
    let mtime = |p: &Path| fs::metadata(p).unwrap().modified().unwrap();
    let (data, staging) = (mtime(&w.game.join("Data")), mtime(&w.staging));
    std::thread::sleep(std::time::Duration::from_millis(20));
    let v = verify_it(&w, &PATHS, false);
    assert!(v.is_clean(), "{:?}", v.findings);
    assert_eq!((v.checked, v.ok), (2, 2));
    assert_eq!(snapshot(&w.game), before);
    // A file made and removed again leaves no name behind, but it does move
    // the folder's modification time: not even a test link was made.
    assert_eq!((mtime(&w.game.join("Data")), mtime(&w.staging)), (data, staging));
}

#[test]
fn a_file_edited_in_place_is_wrong_in_staging_too() {
    let w = deployed_for_verify();
    // Same inode — what a tool saving over the file does.
    fs::OpenOptions::new().write(true).open(w.game.join("Data/a.esp")).unwrap().write_all(b"PLUGIN").unwrap();
    let v = verify_it(&w, &PATHS, false);
    assert!(matches!(kinds(&v).as_slice(), [(n, FindingKind::WrongBytes { .. })] if n == "a.esp"), "{:?}", v.findings);
    assert!(v.findings[0].needs_restage());
    assert_eq!(fs::read(w.mod_dir("nexus:1:1").join("a.esp")).unwrap(), b"PLUGIN", "one file in two places");
    assert!(verify_it(&w, &PATHS, true).is_clean(), "--quick checks sizes, and the size did not change");
}

#[test]
fn a_replaced_file_a_missing_file_and_a_resized_one_are_each_named() {
    let w = deployed_for_verify();
    fs::remove_file(w.game.join("Data/a.esp")).unwrap();
    fs::write(w.game.join("Data/a.esp"), b"plugin").unwrap(); // same bytes, not our file
    fs::remove_file(w.game.join("Data/textures/x.dds")).unwrap();
    let v = verify_it(&w, &PATHS, false);
    assert_eq!(kinds(&v), [("a.esp".to_owned(), FindingKind::NotOurs), ("x.dds".to_owned(), FindingKind::Missing)]);
    assert!(v.findings.iter().all(|f| !f.needs_restage()), "a redeploy fixes these");

    let w = deployed_for_verify();
    fs::OpenOptions::new().append(true).open(w.game.join("Data/a.esp")).unwrap().write_all(b"!").unwrap();
    let v = verify_it(&w, &PATHS, true);
    assert_eq!(kinds(&v), [("a.esp".to_owned(), FindingKind::WrongSize { expected: 6, got: 7 })], "even --quick sees size");
}

#[test]
fn staged_again_but_not_deployed_again_is_outdated() {
    let w = deployed_for_verify();
    w.stage("nexus:1:1", &FILES); // same bytes, new files, new inodes
    let v = verify_it(&w, &PATHS, false);
    assert_eq!(v.findings.len(), 2);
    assert!(v.findings.iter().all(|f| f.kind == FindingKind::Outdated));
}

#[test]
fn a_file_still_deployed_but_no_longer_planned_is_stale() {
    let w = deployed_for_verify();
    let v = verify_it(&w, &["a.esp"], false);
    assert_eq!(v.stale, [w.game.join("Data/textures/x.dds")]);
    assert!(!v.is_clean());
}

#[test]
fn before_deploying_staging_itself_is_checked() {
    let w = World::new();
    w.stage("nexus:1:1", &FILES);
    fs::write(w.mod_dir("nexus:1:1").join("a.esp"), b"PLUGIN").unwrap();
    fs::remove_file(w.mod_dir("nexus:1:1").join("textures/x.dds")).unwrap();
    let p = plan_of(&[("nexus:1:1", &PATHS)]);
    let staging_of = |k: &str| w.mod_dir(k);
    let rec = curator(&FILES);
    let expected = |_: &str, path: &str| rec.get(path).cloned();
    let v = verify_staging(&p, &staging_of, &expected, false, &Progress::silent().task("t", None, Unit::Files));
    assert!(!v.deployment);
    assert!(matches!(kinds(&v).as_slice(), [(_, FindingKind::WrongBytes { .. }), (_, FindingKind::Missing)]), "{:?}", v.findings);

    // A package without per-file hashes: size is all that can be checked.
    let sizes_only = |_: &str, path: &str| rec.get(path).map(|e| Expected { size: e.size, sha256: None });
    w.stage("nexus:1:1", &FILES);
    let v = verify_staging(&p, &staging_of, &sizes_only, false, &Progress::silent().task("t", None, Unit::Files));
    assert_eq!((v.ok, v.size_only), (2, 2));
}
