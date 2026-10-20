//! One instance is one modpack on one game, within this build's limit.

use eh_engine::library::{InstanceConfig, InstanceId, Library};
use eh_engine::{create_instance, find_mod, stage_into_instance, EngineError, MAX_INSTANCES};
use eh_progress::{Progress, Unit};
use ehcoll::{parse_manifest, EhcollManifest, EhcollStagingFile, SupportedGameId};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

const FIXTURE: &str = include_str!("../../../spec/fixtures/manifests/valid/roundtrip.json");
const KEY: &str = "nexus:111:222";

struct World {
    dir: tempfile::TempDir,
    lib: Library,
    archive: PathBuf,
}

fn world() -> World {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path().join("eh")).unwrap();
    let archive = dir.path().join("mod.zip");
    let mut z = zip::ZipWriter::new(File::create(&archive).unwrap());
    z.start_file("Option/Mod.esp", zip::write::FileOptions::<()>::default()).unwrap();
    z.write_all(b"core plugin").unwrap();
    z.finish().unwrap();
    World { dir, lib, archive }
}

fn game_dir(w: &World, name: &str) -> PathBuf {
    let p = w.dir.path().join("games").join(name);
    fs::create_dir_all(&p).unwrap();
    p
}

/// The TypeScript-emitted fixture (Fallout 4), its first mod staging one file.
fn manifest() -> EhcollManifest {
    let mut m = parse_manifest(FIXTURE).unwrap().manifest;
    let (sha, _) = eh_identity::sha256_reader(&b"core plugin"[..], None).unwrap();
    m.mods.iter_mut().find(|x| x.compare_key == KEY).unwrap().state.staging_files =
        Some(vec![EhcollStagingFile { path: "Mod.esp".into(), size: 11, sha256: Some(sha) }]);
    m
}

fn task() -> eh_progress::Task {
    Progress::silent().task("t", None, Unit::Bytes)
}

fn id(s: &str) -> InstanceId {
    InstanceId::new(s).unwrap()
}

fn stage(w: &World, inst: &mut eh_engine::library::Instance, m: &EhcollManifest) -> Result<(), EngineError> {
    let md = find_mod(m, KEY).unwrap();
    stage_into_instance(inst, m, md, &w.archive, &[] as &[&Path], &task()).map(|_| ())
}

#[test]
fn the_proof_of_concept_holds_one_instance() {
    assert_eq!(MAX_INSTANCES, 1, "raising the limit is a deliberate change: update this test with it");
    let w = world();
    create_instance(&w.lib, InstanceConfig::new(id("fo4"), SupportedGameId::Fallout4, game_dir(&w, "Fallout 4"))).unwrap();
    let err = create_instance(
        &w.lib,
        InstanceConfig::new(id("skyrim"), SupportedGameId::Skyrimse, game_dir(&w, "Skyrim")),
    )
    .unwrap_err();
    assert!(matches!(err, EngineError::InstanceLimit(ref ids) if ids[0].as_str() == "fo4"), "{err}");
}

#[test]
fn a_mod_is_staged_inside_its_instance_and_binds_the_modpack() {
    let w = world();
    let mut inst =
        create_instance(&w.lib, InstanceConfig::new(id("fo4"), SupportedGameId::Fallout4, game_dir(&w, "Fallout 4"))).unwrap();
    let m = manifest();
    stage(&w, &mut inst, &m).unwrap();
    assert_eq!(fs::read(inst.staging_dir_for(KEY).join("Mod.esp")).unwrap(), b"core plugin");
    assert!(inst.staging_dir_for(KEY).starts_with(inst.dir()));
    let bound = w.lib.instance(&id("fo4")).unwrap().config().package.clone().unwrap();
    assert_eq!(bound.id, m.package.id, "the first modpack staged is the instance's modpack, on disk");
}

#[test]
fn a_collection_for_another_game_is_refused_before_anything_is_written() {
    let w = world();
    let mut inst =
        create_instance(&w.lib, InstanceConfig::new(id("sky"), SupportedGameId::Skyrimse, game_dir(&w, "Skyrim"))).unwrap();
    let err = stage(&w, &mut inst, &manifest()).unwrap_err();
    assert!(matches!(err, EngineError::WrongGame { .. }), "{err}");
    assert!(!inst.staging_root().exists());
    assert!(w.lib.instance(&id("sky")).unwrap().config().package.is_none(), "not bound by a refused stage");
}

#[test]
fn a_second_modpack_needs_its_own_instance() {
    let w = world();
    let mut inst =
        create_instance(&w.lib, InstanceConfig::new(id("fo4"), SupportedGameId::Fallout4, game_dir(&w, "Fallout 4"))).unwrap();
    stage(&w, &mut inst, &manifest()).unwrap();
    let mut other = manifest();
    other.package.id = "11111111-1111-4111-8111-111111111111".into();
    other.package.name = "Another Pack".into();
    let err = stage(&w, &mut inst, &other).unwrap_err();
    assert!(matches!(err, EngineError::WrongPackage { .. }), "{err}");
    assert!(err.to_string().contains("Another Pack"), "{err}");
}
