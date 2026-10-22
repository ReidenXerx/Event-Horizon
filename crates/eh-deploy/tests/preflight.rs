//! Pre-flight against real folders: a fake game installation in a temp dir,
//! and — for the mount test — a staging folder on a different mount.

use eh_deploy::{plan, preflight, Blocker, DeployPlan, Layout};
use ehcoll::{parse_manifest, SupportedGameId};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

const FIXTURE: &str = include_str!("../../../spec/fixtures/manifests/valid/roundtrip.json");
const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn m(id: u64, mod_type: &str, files: &[&str]) -> Value {
    json!({
        "compareKey": format!("nexus:{id}:{id}"), "name": format!("Mod {id}"), "version": "1",
        "source": { "kind": "nexus", "gameDomain": "skyrimspecialedition", "modId": id, "fileId": id,
                    "archiveName": "x.7z", "sha256": SHA },
        "install": { "fomodSelections": [] },
        "state": { "enabled": true, "installOrder": id, "deploymentPriority": id, "modType": mod_type,
                   "stagingFiles": files.iter().map(|p| json!({ "path": p, "size": 1, "sha256": SHA })).collect::<Vec<_>>() }
    })
}

fn the_plan(game: SupportedGameId, mods: Vec<Value>) -> DeployPlan {
    let mut v: Value = serde_json::from_str(FIXTURE).unwrap();
    v["mods"] = json!(mods);
    v["rules"] = json!([]);
    v["loadOrder"] = json!([]);
    let man = parse_manifest(&v.to_string()).unwrap().manifest;
    plan(game, &man.mods, &man.rules).unwrap()
}

struct Game {
    _dir: tempfile::TempDir,
    root: PathBuf,
    staging: PathBuf,
}

/// A Skyrim SE install: SkyrimSE.exe and Data/, staging beside it.
fn skyrim() -> Game {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("Skyrim Special Edition");
    fs::create_dir_all(root.join("Data")).unwrap();
    fs::write(root.join("SkyrimSE.exe"), b"exe").unwrap();
    let staging = dir.path().join("staging");
    fs::create_dir_all(&staging).unwrap();
    Game { _dir: dir, root, staging }
}

fn check_with(game: SupportedGameId, root: &Path, staging: &Path, p: &DeployPlan, ours: &BTreeSet<PathBuf>) -> eh_deploy::Preflight {
    let staging_of = |k: &str| staging.join(k.replace(':', "_"));
    preflight(p, &Layout { game, game_dir: root, staging_root: staging, staging_of: &staging_of, ours })
}

fn check(g: &Game, p: &DeployPlan) -> eh_deploy::Preflight {
    check_with(SupportedGameId::Skyrimse, &g.root, &g.staging, p, &BTreeSet::new())
}

const SSE: SupportedGameId = SupportedGameId::Skyrimse;

#[test]
fn a_clean_game_folder_is_clear_and_every_file_lands_in_data() {
    let g = skyrim();
    let p = the_plan(SSE, vec![m(1, "", &["textures/a.dds"]), m(2, "dinput", &["dinput8.dll"])]);
    let r = check(&g, &p);
    assert!(r.is_clear(), "{:?}", r.blockers);
    let dests: BTreeSet<PathBuf> = r.placed.iter().map(|x| x.dest.clone()).collect();
    assert!(dests.contains(&g.root.join("Data/textures/a.dds")));
    assert!(dests.contains(&g.root.join("dinput8.dll")));
    let leftovers: Vec<_> = fs::read_dir(g.root.join("Data")).unwrap().flatten().collect();
    assert!(leftovers.is_empty(), "the link test leaves nothing behind: {leftovers:?}");
    assert!(fs::read_dir(&g.staging).unwrap().next().is_none());
}

#[test]
fn a_folder_without_the_games_executable_is_refused() {
    let g = skyrim();
    fs::remove_file(g.root.join("SkyrimSE.exe")).unwrap();
    fs::write(g.root.join("Fallout4.exe"), b"exe").unwrap();
    let r = check(&g, &the_plan(SSE, vec![m(1, "", &["a.esp"])]));
    assert_eq!(r.blockers, [Blocker::NotTheGameFolder { looked_for: "SkyrimSE.exe" }]);
}

#[test]
fn the_executable_and_data_are_found_whatever_their_case() {
    let g = skyrim();
    fs::rename(g.root.join("SkyrimSE.exe"), g.root.join("skyrimse.EXE")).unwrap();
    fs::rename(g.root.join("Data"), g.root.join("data")).unwrap();
    let r = check(&g, &the_plan(SSE, vec![m(1, "", &["a.esp"])]));
    assert!(r.is_clear(), "{:?}", r.blockers);
    assert_eq!(r.placed[0].dest, g.root.join("data/a.esp"));
}

#[test]
fn a_missing_data_folder_is_named() {
    let g = skyrim();
    fs::remove_dir(g.root.join("Data")).unwrap();
    let r = check(&g, &the_plan(SSE, vec![m(1, "", &["a.esp"])]));
    assert_eq!(r.blockers, [Blocker::MissingTarget(g.root.join("Data"))]);
}

#[test]
fn staging_on_another_mount_is_refused_as_such() {
    let g = skyrim();
    let shm = Path::new("/dev/shm");
    let other_mount = shm.is_dir()
        && std::os::unix::fs::MetadataExt::dev(&fs::metadata(shm).unwrap())
            != std::os::unix::fs::MetadataExt::dev(&fs::metadata(&g.root).unwrap());
    if !other_mount {
        eprintln!("skipped: /dev/shm is not a separate mount here");
        return;
    }
    let staging = tempfile::tempdir_in(shm).unwrap();
    let r = check_with(SSE, &g.root, staging.path(), &the_plan(SSE, vec![m(1, "", &["a.esp"])]), &BTreeSet::new());
    assert!(matches!(r.blockers.as_slice(), [Blocker::DifferentMounts { .. }]), "{:?}", r.blockers);
}

#[test]
fn a_live_vortex_deployment_is_refused_and_an_emptied_one_is_not() {
    let g = skyrim();
    let record = g.root.join("Data/vortex.deployment.json");
    fs::write(&record, r#"{"version":1,"files":[{"relPath":"a.esp","source":"x"}]}"#).unwrap();
    let p = the_plan(SSE, vec![m(1, "", &["b.esp"])]);
    assert_eq!(check(&g, &p).blockers, [Blocker::VortexDeployed { record: record.clone(), files: 1 }]);
    fs::write(&record, r#"{"version":1,"files":[]}"#).unwrap();
    assert!(check(&g, &p).is_clear(), "after a purge in Vortex");
    fs::write(g.root.join("vortex.deployment.dinput.json"), "not json").unwrap();
    let p = the_plan(SSE, vec![m(1, "dinput", &["x.dll"])]);
    assert!(matches!(check(&g, &p).blockers.as_slice(), [Blocker::VortexDeployed { .. }]), "unreadable = assume live");
}

#[test]
fn a_file_already_there_is_listed_for_backup_unless_it_is_ours() {
    let g = skyrim();
    fs::write(g.root.join("Data/Dawnguard.esm"), b"the game's own master").unwrap();
    let p = the_plan(SSE, vec![m(1, "", &["Dawnguard.esm", "new.esp"])]);
    let r = check(&g, &p);
    assert!(r.is_clear());
    assert_eq!(r.to_back_up.len(), 1);
    assert_eq!(r.to_back_up[0].path, g.root.join("Data/Dawnguard.esm"));
    assert_eq!(r.to_back_up[0].size, 21);

    let ours: BTreeSet<PathBuf> = [g.root.join("Data/Dawnguard.esm")].into();
    assert!(check_with(SSE, &g.root, &g.staging, &p, &ours).to_back_up.is_empty(), "our own earlier deployment");
}

#[test]
fn something_in_the_way_is_a_blocker_named_once() {
    let g = skyrim();
    fs::create_dir_all(g.root.join("Data/a.esp")).unwrap(); // a folder where a file goes
    fs::write(g.root.join("Data/meshes"), b"file").unwrap(); // a file where a folder goes
    let p = the_plan(SSE, vec![m(1, "", &["a.esp", "meshes/x.nif", "meshes/y.nif", "meshes/sub/z.nif"])]);
    let r = check(&g, &p);
    assert_eq!(
        r.blockers,
        [Blocker::InTheWay(g.root.join("Data/a.esp")), Blocker::InTheWay(g.root.join("Data/meshes"))]
    );
}

#[test]
fn existing_folders_are_reused_in_their_case_and_new_ones_get_one_spelling() {
    let g = skyrim();
    fs::create_dir_all(g.root.join("Data/Textures")).unwrap();
    let p = the_plan(SSE, vec![m(1, "", &["textures/a.dds", "Meshes/x.nif"]), m(2, "", &["TEXTURES/b.dds", "meshes/y.nif"])]);
    let r = check(&g, &p);
    assert!(r.is_clear(), "{:?}", r.blockers);
    let dests: BTreeSet<PathBuf> = r.placed.iter().map(|x| x.dest.clone()).collect();
    assert!(dests.contains(&g.root.join("Data/Textures/a.dds")));
    assert!(dests.contains(&g.root.join("Data/Textures/b.dds")));
    // `Meshes` does not exist: the first mod's spelling is used for both.
    let meshes: BTreeSet<&Path> = r.placed.iter().filter(|x| x.dest.to_string_lossy().contains("eshes")).map(|x| x.dest.parent().unwrap()).collect();
    assert_eq!(meshes.len(), 1, "one folder, not Meshes/ and meshes/: {meshes:?}");
}

#[test]
fn two_existing_folders_differing_only_in_case_are_a_blocker() {
    let g = skyrim();
    fs::create_dir_all(g.root.join("Data/Textures")).unwrap();
    fs::create_dir_all(g.root.join("Data/textures")).unwrap();
    let r = check(&g, &the_plan(SSE, vec![m(1, "", &["textures/a.dds", "Textures/b.dds"])]));
    assert_eq!(
        r.blockers,
        [Blocker::CaseTwins(vec![g.root.join("Data/Textures"), g.root.join("Data/textures")])],
        "reported once"
    );
}

#[test]
fn starfield_deploys_its_default_mods_into_the_game_folder() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("Starfield");
    fs::create_dir_all(root.join("Data")).unwrap();
    fs::write(root.join("Starfield.exe"), b"exe").unwrap();
    let p = the_plan(SupportedGameId::Starfield, vec![m(1, "", &["Data/x.esm"])]);
    let r = check_with(SupportedGameId::Starfield, &root, &dir.path().join("staging"), &p, &BTreeSet::new());
    assert!(r.is_clear(), "{:?}", r.blockers);
    assert_eq!(r.placed[0].dest, root.join("Data/x.esm"));
}
