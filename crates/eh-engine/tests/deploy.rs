//! Install, then deploy, through the engine — the path `eh deploy --yes` takes.

use eh_engine::library::{InstanceConfig, InstanceId, Library};
use eh_engine::{create_instance, deploy, install_package, EngineError};
use eh_progress::{Progress, Unit};
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

const FIXTURE: &str = include_str!("../../../spec/fixtures/manifests/valid/roundtrip.json");

fn sha(b: &[u8]) -> String {
    eh_identity::sha256_reader(b, None).unwrap().0
}

/// Two bundled mods: one ships a cleaned Dawnguard.esm, one a DLL for the root.
fn package(dir: &Path, with_second: bool) -> PathBuf {
    let mut m: Value = serde_json::from_str(FIXTURE).unwrap();
    m["game"]["id"] = json!("skyrimse");
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    let mut mods = Vec::new();
    let mut add = |key: &str, name: &str, order: i64, mod_type: &str, files: &[(&str, &[u8])]| {
        for (p, b) in files {
            entries.push((format!("bundled/{key}/{p}"), b.to_vec()));
        }
        mods.push(json!({
            "compareKey": format!("external:{key}"), "name": name, "version": "1",
            "source": { "kind": "external", "expectedFilename": "x.zip", "sha256": key, "bundled": true },
            "install": { "fomodSelections": [] },
            "state": { "enabled": true, "installOrder": order, "deploymentPriority": order, "modType": mod_type,
                       "stagingFiles": files.iter().map(|(p, b)| json!({ "path": p, "size": b.len(), "sha256": sha(b) })).collect::<Vec<_>>() }
        }));
    };
    add(&"a1".repeat(32), "Cleaned Masters", 0, "", &[("Dawnguard.esm", b"cleaned"), ("textures/x.dds", b"tex")]);
    if with_second {
        add(&"b2".repeat(32), "Engine Fix", 1, "dinput", &[("d3dx9_42.dll", b"dll")]);
    }
    m["mods"] = json!(mods);
    m["rules"] = json!([]);
    m["loadOrder"] = json!([]);
    let path = dir.join("pack.ehcoll");
    let mut z = zip::ZipWriter::new(fs::File::create(&path).unwrap());
    let o = zip::write::FileOptions::<()>::default();
    z.start_file("manifest.json", o).unwrap();
    z.write_all(m.to_string().as_bytes()).unwrap();
    z.start_file("collection.json", o).unwrap();
    z.write_all(b"{}").unwrap();
    for (name, body) in &entries {
        z.start_file(name.as_str(), o).unwrap();
        z.write_all(body).unwrap();
    }
    z.finish().unwrap();
    path
}

fn task() -> eh_progress::Task {
    Progress::silent().task("t", None, Unit::Files)
}

#[test]
fn an_installed_collection_deploys_as_hardlinks_with_the_original_backed_up() {
    let dir = tempfile::tempdir().unwrap();
    let game = dir.path().join("Skyrim Special Edition");
    fs::create_dir_all(game.join("Data")).unwrap();
    fs::write(game.join("SkyrimSE.exe"), b"exe").unwrap();
    fs::write(game.join("Data/Dawnguard.esm"), b"vanilla").unwrap();
    let lib = Library::open(dir.path().join("eh")).unwrap();
    let mut inst = create_instance(
        &lib,
        InstanceConfig::new(InstanceId::new("poc").unwrap(), ehcoll::SupportedGameId::Skyrimse, game.clone()),
    )
    .unwrap();
    let pkg = package(dir.path(), true);

    install_package(None, &lib, &mut inst, &pkg, &task()).unwrap();
    let d = deploy(&inst, &task()).unwrap();
    assert_eq!((d.applied.linked, d.applied.backed_up, d.pruned.removed), (3, 1, 0));

    let key = format!("external:{}", "a1".repeat(32));
    let staged = inst.staging_dir_for(&key).join("Dawnguard.esm");
    assert_eq!(fs::metadata(game.join("Data/Dawnguard.esm")).unwrap().ino(), fs::metadata(&staged).unwrap().ino());
    assert_eq!(fs::read(game.join("d3dx9_42.dll")).unwrap(), b"dll", "a dinput mod lands in the game folder");
    assert_eq!(fs::read(inst.staging_root().join(".eh-backups/Data/Dawnguard.esm")).unwrap(), b"vanilla");

    let again = deploy(&inst, &task()).unwrap();
    assert_eq!((again.applied.linked, again.applied.already_in_place, again.applied.backed_up), (0, 3, 0));

    // A later revision drops the second mod: its file is taken out again,
    // and nothing else moves.
    let smaller = dir.path().join("smaller");
    fs::create_dir_all(&smaller).unwrap();
    let pkg2 = package(&smaller, false);
    install_package(None, &lib, &mut inst, &pkg2, &task()).unwrap();
    let d = deploy(&inst, &task()).unwrap();
    assert_eq!((d.applied.linked, d.pruned.removed, d.pruned.restored), (0, 1, 0));
    assert!(!game.join("d3dx9_42.dll").exists());
    assert_eq!(fs::read(game.join("Data/Dawnguard.esm")).unwrap(), b"cleaned", "still deployed");

    // Purge: everything out, the vanilla master back, our folders gone.
    let p = eh_engine::purge(&inst).unwrap();
    assert_eq!((p.removed, p.restored), (2, 1));
    assert_eq!(fs::read(game.join("Data/Dawnguard.esm")).unwrap(), b"vanilla");
    assert!(!game.join("Data/textures").exists());
    let left: Vec<_> = fs::read_dir(&game).unwrap().flatten().map(|e| e.file_name()).collect();
    assert_eq!(left.len(), 2, "SkyrimSE.exe and Data, as before: {left:?}");
}

#[test]
fn deploying_before_everything_is_staged_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let game = dir.path().join("Skyrim Special Edition");
    fs::create_dir_all(game.join("Data")).unwrap();
    fs::write(game.join("SkyrimSE.exe"), b"exe").unwrap();
    let lib = Library::open(dir.path().join("eh")).unwrap();
    let mut inst = create_instance(
        &lib,
        InstanceConfig::new(InstanceId::new("poc").unwrap(), ehcoll::SupportedGameId::Skyrimse, game.clone()),
    )
    .unwrap();
    install_package(None, &lib, &mut inst, &package(dir.path(), true), &task()).unwrap();
    let key = format!("external:{}", "b2".repeat(32));
    inst.forget_staged(&key).unwrap();
    let err = deploy(&inst, &task()).unwrap_err();
    assert!(matches!(err, EngineError::NotStaged(1)), "{err}");
    assert!(!game.join("Data/Dawnguard.esm").exists(), "nothing written");
}

#[test]
fn verify_finds_an_in_place_edit_and_fix_install_deploy_repairs_it() {
    let dir = tempfile::tempdir().unwrap();
    let game = dir.path().join("Skyrim Special Edition");
    fs::create_dir_all(game.join("Data")).unwrap();
    fs::write(game.join("SkyrimSE.exe"), b"exe").unwrap();
    let lib = Library::open(dir.path().join("eh")).unwrap();
    let mut inst = create_instance(
        &lib,
        InstanceConfig::new(InstanceId::new("poc").unwrap(), ehcoll::SupportedGameId::Skyrimse, game.clone()),
    )
    .unwrap();
    let pkg = package(dir.path(), true);
    install_package(None, &lib, &mut inst, &pkg, &task()).unwrap();

    // Before deploying, staging is what gets checked.
    let r = eh_engine::verify(&inst, false, &task()).unwrap();
    assert!(!r.verified.deployment && r.verified.is_clean());

    deploy(&inst, &task()).unwrap();
    let r = eh_engine::verify(&inst, false, &task()).unwrap();
    assert!(r.verified.deployment && r.verified.is_clean(), "{:?}", r.verified.findings);

    // A tool saves over the deployed master in place.
    fs::OpenOptions::new().write(true).open(game.join("Data/Dawnguard.esm")).unwrap().write_all(b"CLEANED").unwrap();
    let r = eh_engine::verify(&inst, false, &task()).unwrap();
    let key = format!("external:{}", "a1".repeat(32));
    assert_eq!(r.restage, std::slice::from_ref(&key));

    // --fix, then install and deploy, as the CLI tells the user.
    eh_engine::forget_for_restage(&inst, &r.restage).unwrap();
    let report = install_package(None, &lib, &mut inst, &pkg, &task()).unwrap();
    assert_eq!(report.staged, ["Cleaned Masters"]);
    deploy(&inst, &task()).unwrap();
    assert_eq!(fs::read(game.join("Data/Dawnguard.esm")).unwrap(), b"cleaned");
    assert!(eh_engine::verify(&inst, false, &task()).unwrap().verified.is_clean());
}
