//! Staging one mod end to end: a real ZIP shaped like a FOMOD archive,
//! extracted, hashed, and rebuilt into the curator's staging folder.

use eh_engine::{find_mod, stage_mod, EngineError};
use eh_progress::{Progress, Unit};
use ehcoll::{parse_manifest, EhcollMod, EhcollStagingFile};
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipWriter};

const FIXTURE: &str = include_str!("../../../spec/fixtures/manifests/valid/roundtrip.json");

fn sha(b: &[u8]) -> String {
    eh_identity::sha256_reader(b, None).unwrap().0
}

fn staged(path: &str, b: &[u8]) -> EhcollStagingFile {
    EhcollStagingFile { path: path.into(), size: b.len() as u64, sha256: Some(sha(b)) }
}

fn fomod_zip(path: &Path) {
    let mut z = ZipWriter::new(File::create(path).unwrap());
    let o = FileOptions::<()>::default().compression_method(CompressionMethod::Deflated);
    for (name, body) in [
        ("fomod/ModuleConfig.xml", &b"<config/>"[..]),
        ("00 Core/Mod.esp", b"core plugin"),
        ("10 Light/textures/body.dds", b"light texture"),
        ("11 Dark/textures/body.dds", b"dark texture"),
    ] {
        z.start_file(name, o).unwrap();
        z.write_all(body).unwrap();
    }
    z.finish().unwrap();
}

/// A real mod from the TypeScript-emitted fixture, with its file list replaced.
fn a_mod(files: Vec<EhcollStagingFile>) -> EhcollMod {
    let manifest = parse_manifest(FIXTURE).unwrap().manifest;
    let mut m = find_mod(&manifest, "nexus:111:222").expect("fixture mod").clone();
    m.state.staging_files = Some(files);
    m
}

fn task() -> eh_progress::Task {
    Progress::silent().task("t", None, Unit::Bytes)
}

#[test]
fn a_fomod_mod_is_staged_as_the_curator_chose_without_running_the_script() {
    let dir = tempfile::tempdir().unwrap();
    let archive = dir.path().join("TheMod-1.0.zip");
    fomod_zip(&archive);
    let m = a_mod(vec![staged("Mod.esp", b"core plugin"), staged("textures/body.dds", b"dark texture")]);
    let (work, dest) = (dir.path().join("work"), dir.path().join("staging").join("TheMod"));

    let staged = stage_mod(&m, &archive, &[], &work, &dest, &task()).unwrap();
    assert_eq!(staged.files, 2);
    assert_eq!(fs::read(dest.join("textures/body.dds")).unwrap(), b"dark texture");
    assert!(!dest.join("fomod").exists());
    assert_eq!(fs::read_dir(&work).unwrap().count(), 0, "the unpacked copy is cleaned up");
}

#[test]
fn a_mod_the_archive_cannot_reproduce_writes_nothing_and_says_what_is_missing() {
    let dir = tempfile::tempdir().unwrap();
    let archive = dir.path().join("TheMod-1.0.zip");
    fomod_zip(&archive);
    let m = a_mod(vec![staged("Mod.esp", b"core plugin"), staged("Cleaned.esp", b"cleaned by xEdit")]);
    let (work, dest) = (dir.path().join("work"), dir.path().join("staging").join("TheMod"));

    let err = stage_mod(&m, &archive, &[], &work, &dest, &task()).unwrap_err();
    let EngineError::Incomplete { missing, .. } = &err else { panic!("{err}") };
    assert_eq!(missing[0].path, "Cleaned.esp");
    assert!(err.to_string().contains("Cleaned.esp"), "{err}");
    assert!(!dest.exists());
    assert_eq!(fs::read_dir(&work).unwrap().count(), 0, "cleaned up on failure too");
}

#[test]
fn a_mod_with_no_file_list_is_refused_up_front() {
    let dir = tempfile::tempdir().unwrap();
    let mut m = a_mod(vec![]);
    m.state.staging_files = None;
    let err = stage_mod(&m, &dir.path().join("absent.zip"), &[], dir.path(), &dir.path().join("d"), &task())
        .unwrap_err();
    assert!(matches!(err, EngineError::NoStagingRecord(_)), "{err}");
}
