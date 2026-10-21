//! The library's invariants: instances kept apart, one game folder per
//! instance, downloads shared by hash, and instance.json read strictly.

use eh_library::*;
use ehcoll::SupportedGameId;
use std::fs;
use std::path::PathBuf;

struct World {
    _dir: tempfile::TempDir,
    lib: Library,
    fo4: PathBuf,
    skyrim: PathBuf,
}

fn world() -> World {
    let dir = tempfile::tempdir().unwrap();
    let fo4 = dir.path().join("games").join("Fallout 4");
    let skyrim = dir.path().join("games").join("Skyrim Special Edition");
    fs::create_dir_all(fo4.join("Data")).unwrap();
    fs::create_dir_all(skyrim.join("Data")).unwrap();
    let lib = Library::open(dir.path().join("eh")).unwrap();
    World { _dir: dir, lib, fo4, skyrim }
}

fn id(s: &str) -> InstanceId {
    InstanceId::new(s).unwrap()
}

#[test]
fn two_games_get_two_instances_with_separate_staging() {
    let w = world();
    let a = w.lib.create_instance(InstanceConfig::new(id("fo4-ivy"), SupportedGameId::Fallout4, w.fo4.clone())).unwrap();
    let b = w
        .lib
        .create_instance(InstanceConfig::new(id("skyrim-lorerim"), SupportedGameId::Skyrimse, w.skyrim.clone()))
        .unwrap();
    assert_ne!(a.staging_dir_for("nexus:1:2"), b.staging_dir_for("nexus:1:2"));
    let listed: Vec<_> = w.lib.instances().unwrap().iter().map(|i| i.id().to_string()).collect();
    assert_eq!(listed, ["fo4-ivy", "skyrim-lorerim"]);
}

#[test]
fn two_instances_cannot_share_a_game_folder() {
    let w = world();
    w.lib.create_instance(InstanceConfig::new(id("first"), SupportedGameId::Fallout4, w.fo4.clone())).unwrap();
    // The same folder spelled differently must still be caught.
    let spelled_differently = w.fo4.join("Data").join("..");
    let err = w
        .lib
        .create_instance(InstanceConfig::new(id("second"), SupportedGameId::Fallout4, spelled_differently))
        .unwrap_err();
    assert!(matches!(err, LibraryError::GameDirTaken { ref by, .. } if by.as_str() == "first"), "{err}");
    assert!(!w.lib.root().join("instances").join("second").exists(), "a refused instance leaves nothing");
}

#[test]
fn an_id_is_taken_once() {
    let w = world();
    w.lib.create_instance(InstanceConfig::new(id("main"), SupportedGameId::Fallout4, w.fo4.clone())).unwrap();
    let err = w
        .lib
        .create_instance(InstanceConfig::new(id("main"), SupportedGameId::Skyrimse, w.skyrim.clone()))
        .unwrap_err();
    assert!(matches!(err, LibraryError::IdTaken(_)), "{err}");
    assert_eq!(w.lib.instance(&id("main")).unwrap().config().game, SupportedGameId::Fallout4);
}

#[test]
fn a_game_folder_that_does_not_exist_is_refused() {
    let w = world();
    let err = w
        .lib
        .create_instance(InstanceConfig::new(id("x"), SupportedGameId::Fallout4, w.fo4.join("nope")))
        .unwrap_err();
    assert!(matches!(err, LibraryError::NoGameDir(_)), "{err}");
}

#[test]
fn instance_names_are_safe_folder_names() {
    for good in ["fo4", "fallout4-ivy-2", "0day"] {
        InstanceId::new(good).unwrap();
    }
    for bad in ["", "-x", "Fo4", "a b", "../x", "a/b", "a_b", &"x".repeat(65)] {
        assert!(InstanceId::new(bad).is_err(), "{bad:?}");
    }
}

#[test]
fn an_instance_round_trips_through_its_file_including_its_package() {
    let w = world();
    let mut i = w.lib.create_instance(InstanceConfig::new(id("fo4"), SupportedGameId::Fallout4, w.fo4.clone())).unwrap();
    i.set_package(PackageRef { id: "uuid-1".into(), name: "Ivy".into(), version: "1.2.0".into() }).unwrap();
    let back = w.lib.instance(&id("fo4")).unwrap();
    assert_eq!(back.config(), i.config());
    assert_eq!(back.config().game_dir, fs::canonicalize(&w.fo4).unwrap());
}

#[test]
fn an_instance_file_from_a_newer_version_is_refused_not_guessed() {
    let w = world();
    w.lib.create_instance(InstanceConfig::new(id("fo4"), SupportedGameId::Fallout4, w.fo4.clone())).unwrap();
    let file = w.lib.root().join("instances/fo4/instance.json");
    let raw = fs::read_to_string(&file).unwrap().replace("\"format\": 1", "\"format\": 2");
    fs::write(&file, raw).unwrap();
    assert!(matches!(w.lib.instance(&id("fo4")), Err(LibraryError::UnknownFormat(_, Some(2)))));
    // And a damaged instance is an error in the listing, not a gap in it.
    assert!(w.lib.instances().is_err());
}

#[test]
fn an_instance_file_moved_to_another_folder_is_refused() {
    let w = world();
    w.lib.create_instance(InstanceConfig::new(id("fo4"), SupportedGameId::Fallout4, w.fo4.clone())).unwrap();
    fs::rename(w.lib.root().join("instances/fo4"), w.lib.root().join("instances/copy")).unwrap();
    assert!(matches!(w.lib.instance(&id("copy")), Err(LibraryError::Corrupt(..))));
}

#[test]
fn downloads_are_one_shared_store_keyed_by_hash() {
    let w = world();
    let sha = "a".repeat(64);
    assert_eq!(w.lib.archive_path(&sha).unwrap(), w.lib.root().join("archives").join(&sha));
    assert!(w.lib.archive_path("../../etc/passwd").is_err());
    assert!(w.lib.archive_path(&sha.to_uppercase()).is_err());
}

#[test]
fn mod_folder_names_are_portable_and_never_collide() {
    let a = mod_dir_name("nexus:111:222");
    assert!(a.starts_with("nexus_111_222-"), "{a}");
    assert!(!a.contains([':', '/', '\\']));
    // Same readable part, different keys: the hash keeps them apart.
    assert_ne!(mod_dir_name("a:b"), mod_dir_name("a_b"));
    assert_ne!(mod_dir_name("nexus:1:23"), mod_dir_name("nexus:12:3"));
    // A hostile key cannot climb out of the staging folder.
    let hostile = mod_dir_name("../../etc");
    assert!(!hostile.contains('/') && !hostile.starts_with('.'), "{hostile}");
}

#[test]
fn a_collection_revision_has_one_place_and_a_hostile_name_has_none() {
    let w = world();
    assert_eq!(
        w.lib.package_path("skyrimspecialedition", "ecb76c", 15).unwrap(),
        w.lib.root().join("packages/skyrimspecialedition/ecb76c/r15.ehcoll")
    );
    assert_ne!(
        w.lib.package_path("skyrimspecialedition", "ecb76c", 14).unwrap(),
        w.lib.package_path("skyrimspecialedition", "ecb76c", 15).unwrap()
    );
    for (game, slug, rev) in [("..", "x", 1), ("sse", "../x", 1), ("sse", "a/b", 1), ("sse", "", 1), ("sse", "x", 0)] {
        assert!(w.lib.package_path(game, slug, rev).is_err(), "{game}/{slug}/{rev}");
    }
}
