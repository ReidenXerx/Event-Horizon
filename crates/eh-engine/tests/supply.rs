//! Mods the user downloads by hand: listing them, finding them by name, and
//! taking the file in — the right one, a repack of it, or the wrong version.

use eh_engine::library::{InstanceConfig, InstanceId, Library};
use eh_engine::{
    create_instance, feed, feed_folder, find_mod_by_query, install_package, instance_manifest, missing, EngineError, Fed,
};
use eh_progress::{Progress, Unit};
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};

const FIXTURE: &str = include_str!("../../../spec/fixtures/manifests/valid/roundtrip.json");
const BUNDLE: &str = "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1";

fn sha(b: &[u8]) -> String {
    eh_identity::sha256_reader(b, None).unwrap().0
}

fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut buf = std::io::Cursor::new(Vec::new());
    let mut z = zip::ZipWriter::new(&mut buf);
    for (name, body) in entries {
        z.start_file(*name, zip::write::FileOptions::<()>::default()).unwrap();
        z.write_all(body).unwrap();
    }
    z.finish().unwrap();
    buf.into_inner()
}

/// The archive the curator had for "Lovers Animations".
fn anim() -> Vec<u8> {
    zip_bytes(&[("Data/anim.esp", b"animations"), ("Data/meshes/a.nif", b"mesh")])
}
/// The same files, packed differently — a mirror's repack.
fn anim_repack() -> Vec<u8> {
    zip_bytes(&[("readme.txt", b"mirrored by someone"), ("Mod/Data/meshes/a.nif", b"mesh"), ("Mod/Data/anim.esp", b"animations")])
}
/// The author's newer upload: one file changed.
fn anim_newer() -> Vec<u8> {
    zip_bytes(&[("Data/anim.esp", b"animations v2"), ("Data/meshes/a.nif", b"mesh")])
}
fn armor(kind: &str) -> Vec<u8> {
    zip_bytes(&[(&format!("Data/armor-{kind}.esp"), kind.as_bytes())])
}

fn file(path: &str, bytes: &[u8]) -> Value {
    json!({ "path": path, "size": bytes.len(), "sha256": sha(bytes) })
}

fn external(name: &str, archive: &[u8], order: i64, files: Vec<Value>) -> Value {
    json!({
        "compareKey": format!("external:{}", sha(archive)), "name": name, "version": "1",
        "source": { "kind": "external", "expectedFilename": format!("{name}.zip"), "sha256": sha(archive),
                    "url": format!("https://example.com/{order}"), "instructions": "Log in, then download", "bundled": false },
        "install": { "fomodSelections": [] },
        "state": { "enabled": true, "installOrder": order, "deploymentPriority": order, "stagingFiles": files }
    })
}

fn package(dir: &Path) -> PathBuf {
    let mut m: Value = serde_json::from_str(FIXTURE).unwrap();
    m["mods"] = json!([
        {
            "compareKey": format!("external:{BUNDLE}"), "name": "Bundled Fix", "version": "1",
            "source": { "kind": "external", "expectedFilename": "fix.zip", "sha256": BUNDLE, "bundled": true },
            "install": { "fomodSelections": [] },
            "state": { "enabled": true, "installOrder": 0, "deploymentPriority": 0,
                       "stagingFiles": [file("Data/fix.esp", b"bundled fix")] }
        },
        external("Lovers Animations", &anim(), 1, vec![file("Data/anim.esp", b"animations"), file("Data/meshes/a.nif", b"mesh")]),
        external("Armor Light", &armor("light"), 2, vec![file("Data/armor-light.esp", b"light")]),
        external("Armor Heavy", &armor("heavy"), 3, vec![file("Data/armor-heavy.esp", b"heavy")]),
    ]);
    m["rules"] = json!([]);
    m["loadOrder"] = json!([]);
    let path = dir.join("pack.ehcoll");
    let bundled = format!("bundled/{BUNDLE}/Data/fix.esp");
    let manifest = m.to_string();
    std::fs::write(&path, zip_bytes(&[("manifest.json", manifest.as_bytes()), ("collection.json", b"{}"), (&bundled, b"bundled fix")]))
        .unwrap();
    path
}

struct World {
    dir: tempfile::TempDir,
    lib: Library,
    inst: eh_engine::library::Instance,
    pkg: PathBuf,
}

/// An instance that has installed the package once: the bundled mod staged,
/// three mods waiting for the user.
fn world() -> World {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path().join("eh")).unwrap();
    std::fs::create_dir_all(dir.path().join("game")).unwrap();
    let mut inst = create_instance(
        &lib,
        InstanceConfig::new(InstanceId::new("poc").unwrap(), ehcoll::SupportedGameId::Fallout4, dir.path().join("game")),
    )
    .unwrap();
    let pkg = package(dir.path());
    install_package(None, &lib, &mut inst, &pkg, &task()).unwrap();
    World { dir, lib, inst, pkg }
}

impl World {
    fn user_file(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let p = self.dir.path().join("Downloads").join(name);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, bytes).unwrap();
        p
    }
    fn feed(&self, query: &str, file: &Path) -> Result<Fed, EngineError> {
        let (manifest, package_dir) = instance_manifest(&self.inst).unwrap();
        let list = missing(&self.lib, &self.inst).unwrap();
        let m = find_mod_by_query(&manifest, &list, query)?;
        feed(&self.lib, &self.inst, &package_dir, m, file, &task())
    }
    fn missing_names(&self) -> Vec<String> {
        missing(&self.lib, &self.inst).unwrap().into_iter().map(|w| w.name).collect()
    }
    fn reinstall(&mut self) -> eh_engine::InstallReport {
        install_package(None, &self.lib, &mut self.inst, &self.pkg, &task()).unwrap()
    }
}

fn task() -> eh_progress::Task {
    Progress::silent().task("t", None, Unit::Steps)
}

#[test]
fn missing_lists_what_the_user_must_download_in_install_order() {
    let w = world();
    let list = missing(&w.lib, &w.inst).unwrap();
    let names: Vec<&str> = list.iter().map(|x| x.name.as_str()).collect();
    assert_eq!(names, ["Lovers Animations", "Armor Light", "Armor Heavy"], "the bundled mod is not the user's job");
    assert_eq!(list[0].url.as_deref(), Some("https://example.com/1"));
    assert_eq!(list[0].expected_filename, "Lovers Animations.zip");
}

#[test]
fn a_mod_is_found_by_number_name_piece_or_key_and_ambiguity_is_named() {
    let w = world();
    let (manifest, _) = instance_manifest(&w.inst).unwrap();
    let list = missing(&w.lib, &w.inst).unwrap();
    let find = |q: &str| find_mod_by_query(&manifest, &list, q).map(|m| m.name.clone());
    assert_eq!(find("2").unwrap(), "Armor Light", "numbers come from `eh missing`");
    assert_eq!(find("lovers animations").unwrap(), "Lovers Animations");
    assert_eq!(find("lovers").unwrap(), "Lovers Animations");
    assert_eq!(find(&format!("external:{}", sha(&armor("heavy")))).unwrap(), "Armor Heavy");
    match find("armor") {
        Err(EngineError::AmbiguousMod { candidates, .. }) => assert_eq!(candidates.len(), 2),
        other => panic!("{other:?}"),
    }
    assert!(matches!(find("nothing like this"), Err(EngineError::NoSuchMod(_))));
    assert!(matches!(find("9"), Err(EngineError::NoSuchMod(_))));
}

#[test]
fn the_right_file_is_taken_without_touching_the_users_copy_and_then_stages() {
    let mut w = world();
    let mine = w.user_file("Lovers Animations (1).zip", &anim());
    assert_eq!(w.feed("lovers", &mine).unwrap(), Fed::Matches);
    assert_eq!(std::fs::read(&mine).unwrap(), anim(), "the user's file is left as it was");
    assert!(w.lib.archive_path(&sha(&anim())).unwrap().is_file());
    assert_eq!(w.missing_names(), ["Armor Light", "Armor Heavy"]);

    let r = w.reinstall();
    assert_eq!(r.staged, ["Lovers Animations"]);
}

#[test]
fn a_repack_with_every_curator_file_is_taken_and_stages_identically() {
    let mut w = world();
    let mirror = w.user_file("anim-mirror.zip", &anim_repack());
    match w.feed("lovers", &mirror).unwrap() {
        Fed::Equivalent { sha256, files } => {
            assert_eq!(sha256, sha(&anim_repack()));
            assert_eq!(files, 2);
        }
        other => panic!("{other:?}"),
    }
    assert!(!w.missing_names().contains(&"Lovers Animations".to_owned()));
    let r = w.reinstall();
    assert_eq!(r.staged, ["Lovers Animations"]);
    let key = format!("external:{}", sha(&anim()));
    assert_eq!(std::fs::read(w.inst.staging_dir_for(&key).join("Data/anim.esp")).unwrap(), b"animations");
    assert!(!w.inst.staging_dir_for(&key).join("readme.txt").exists(), "only the curator's files");
}

#[test]
fn a_different_version_is_refused_naming_what_it_lacks() {
    let w = world();
    let newer = w.user_file("anim-v2.zip", &anim_newer());
    match w.feed("lovers", &newer) {
        Err(EngineError::SuppliedDiffers { missing, total, .. }) => {
            assert_eq!(missing, ["Data/anim.esp"]);
            assert_eq!(total, 2);
        }
        other => panic!("{other:?}"),
    }
    assert!(!w.lib.archive_path(&sha(&anim_newer())).unwrap().exists(), "nothing stored");
    assert!(w.missing_names().contains(&"Lovers Animations".to_owned()));
    assert!(!w.inst.work_dir().exists(), "the probe is cleaned up");
}

#[test]
fn an_unreadable_download_is_called_damaged() {
    let w = world();
    let half = w.user_file("anim.zip", &anim()[..20]);
    assert!(matches!(w.feed("lovers", &half), Err(EngineError::Damaged(..))));
}

#[test]
fn only_user_supplied_mods_can_be_fed() {
    let w = world();
    let any = w.user_file("x.zip", b"x");
    assert!(matches!(w.feed("bundled fix", &any), Err(EngineError::NotUserSupplied(..))));
}

#[test]
fn a_downloads_folder_is_matched_by_hash_and_only_exact_archives_are_taken() {
    let mut w = world();
    w.user_file("armor light.zip", &armor("light"));
    w.user_file("Armor_Heavy-v1.zip", &armor("heavy"));
    w.user_file("anim-mirror.zip", &anim_repack()); // different bytes: needs naming
    w.user_file("unrelated.pdf", b"%PDF");
    let r = feed_folder(&w.lib, &w.inst, &w.dir.path().join("Downloads"), &task()).unwrap();
    assert_eq!(r.files_hashed, 4);
    let mut got = r.matched.clone();
    got.sort();
    assert_eq!(got, ["Armor Heavy", "Armor Light"]);
    assert_eq!(w.missing_names(), ["Lovers Animations"]);
    let rep = w.reinstall();
    assert_eq!(rep.staged.len(), 2);
}

#[test]
fn an_instance_without_a_package_says_to_install_first() {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path().join("eh")).unwrap();
    std::fs::create_dir_all(dir.path().join("game")).unwrap();
    let inst = create_instance(
        &lib,
        InstanceConfig::new(InstanceId::new("poc").unwrap(), ehcoll::SupportedGameId::Fallout4, dir.path().join("game")),
    )
    .unwrap();
    assert!(matches!(instance_manifest(&inst), Err(EngineError::NoPackageYet(_))));
}

#[test]
fn a_bundled_mod_is_never_the_users_to_download_even_when_not_yet_staged() {
    let w = world();
    // As if its staging had failed: no receipt.
    w.inst.forget_staged(&format!("external:{BUNDLE}")).unwrap();
    assert!(!w.missing_names().contains(&"Bundled Fix".to_owned()));
}

#[test]
fn the_deploy_preview_names_mods_that_are_not_staged_yet() {
    let mut w = world();
    let p = eh_engine::deploy_preview(&w.inst).unwrap();
    assert_eq!(p.plan.order.len(), 4);
    assert_eq!(p.unstaged.len(), 3, "only the bundled mod is staged: {:?}", p.unstaged);
    for (name, bytes) in [("a.zip", anim()), ("b.zip", armor("light")), ("c.zip", armor("heavy"))] {
        w.user_file(name, &bytes);
    }
    feed_folder(&w.lib, &w.inst, &w.dir.path().join("Downloads"), &task()).unwrap();
    w.reinstall();
    assert!(eh_engine::deploy_preview(&w.inst).unwrap().unstaged.is_empty());
}
