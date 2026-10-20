//! Rebuilding staging by content, against archive trees shaped like real
//! FOMOD layouts: numbered option folders, the SAME destination path offered
//! by several options with different bytes, and a curator who picked one.

use eh_fomod::{plan, plan_from_trees, ContentIndex, ReconstructError};
use eh_progress::{Progress, Unit};
use ehcoll::EhcollStagingFile;
use std::fs;
use std::path::{Path, PathBuf};

fn sha(bytes: &[u8]) -> String {
    eh_identity::sha256_reader(bytes, None).unwrap().0
}

fn write(root: &Path, rel: &str, bytes: &[u8]) {
    let p = root.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, bytes).unwrap();
}

fn staged(path: &str, bytes: &[u8]) -> EhcollStagingFile {
    EhcollStagingFile { path: path.into(), size: bytes.len() as u64, sha256: Some(sha(bytes)) }
}

struct Case {
    _dir: tempfile::TempDir,
    archive: PathBuf,
    mirror: PathBuf,
    dest: PathBuf,
}

impl Case {
    /// An extracted FOMOD archive: one required core, and two options that
    /// both install `textures/body.dds` with different bytes.
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("extracted");
        write(&archive, "fomod/ModuleConfig.xml", b"<config/>");
        write(&archive, "00 Core/Mod.esp", b"core plugin");
        write(&archive, "10 Option A/textures/body.dds", b"option A texture");
        write(&archive, "11 Option B/textures/body.dds", b"option B texture");
        let mirror = dir.path().join("package-mirror");
        fs::create_dir_all(&mirror).unwrap();
        let dest = dir.path().join("staging").join("TheMod");
        Self { _dir: dir, archive, mirror, dest }
    }
}

fn task() -> eh_progress::Task {
    Progress::silent().task("test", None, Unit::Bytes)
}

#[test]
fn the_curators_choice_is_reproduced_from_the_recorded_hashes_alone() {
    let c = Case::new();
    // The curator picked option B. Nothing here says so except the hash.
    let files = [staged("Mod.esp", b"core plugin"), staged("textures/body.dds", b"option B texture")];
    let p = plan_from_trees(&files, &[&c.archive], &task()).unwrap();
    assert!(p.is_complete(), "{p:#?}");
    let applied = p.apply(&c.dest, &task()).unwrap();
    assert_eq!(applied.files, 2);
    assert_eq!(fs::read(c.dest.join("Mod.esp")).unwrap(), b"core plugin");
    assert_eq!(fs::read(c.dest.join("textures/body.dds")).unwrap(), b"option B texture");
    // Only what the curator staged: no script, no options, no leftovers.
    assert!(!c.dest.join("fomod").exists());
    let names: Vec<_> = fs::read_dir(&c.dest).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(names.len(), 2, "{names:?}");
}

#[test]
fn the_same_bytes_at_two_staged_paths_are_written_twice() {
    let c = Case::new();
    let files = [staged("a/Mod.esp", b"core plugin"), staged("b/Mod.esp", b"core plugin")];
    plan_from_trees(&files, &[&c.archive], &task()).unwrap().apply(&c.dest, &task()).unwrap();
    assert!(c.dest.join("a/Mod.esp").is_file() && c.dest.join("b/Mod.esp").is_file());
}

#[test]
fn a_file_no_source_has_refuses_the_whole_mod_and_writes_nothing() {
    let c = Case::new();
    let files = [staged("Mod.esp", b"core plugin"), staged("Generated.esp", b"made by a tool")];
    let p = plan_from_trees(&files, &[&c.archive], &task()).unwrap();
    assert!(!p.is_complete());
    assert_eq!(p.missing.len(), 1);
    assert_eq!(p.missing[0].path, "Generated.esp");
    match p.apply(&c.dest, &task()) {
        Err(ReconstructError::Incomplete { missing: 1, unhashed: 0 }) => {}
        other => panic!("expected Incomplete, got {other:?}"),
    }
    assert!(!c.dest.exists(), "an incomplete plan must not create anything");
}

#[test]
fn a_second_source_tree_supplies_what_the_archive_cannot() {
    // A mirrored mod: the package carries the tool-made file at mirror/<sha>.
    let c = Case::new();
    let made = b"made by a tool";
    write(&c.mirror, &sha(made), made);
    let files = [staged("Mod.esp", b"core plugin"), staged("Generated.esp", made)];
    let p = plan_from_trees(&files, &[&c.archive, &c.mirror], &task()).unwrap();
    assert!(p.is_complete(), "{p:#?}");
    p.apply(&c.dest, &task()).unwrap();
    assert_eq!(fs::read(c.dest.join("Generated.esp")).unwrap(), made);
}

#[test]
fn a_record_without_a_hash_is_refused_not_guessed() {
    let c = Case::new();
    let files = [EhcollStagingFile { path: "Mod.esp".into(), size: 11, sha256: None }];
    let p = plan_from_trees(&files, &[&c.archive], &task()).unwrap();
    assert_eq!(p.unhashed, vec!["Mod.esp".to_owned()]);
    assert!(matches!(p.apply(&c.dest, &task()), Err(ReconstructError::Incomplete { unhashed: 1, .. })));
}

#[test]
fn a_hash_match_with_the_wrong_size_is_not_a_source() {
    let c = Case::new();
    let mut f = staged("Mod.esp", b"core plugin");
    f.size += 1;
    let p = plan_from_trees(&[f], &[&c.archive], &task()).unwrap();
    assert_eq!(p.missing.len(), 1);
}

#[test]
fn a_destination_with_anything_in_it_is_left_alone() {
    let c = Case::new();
    write(&c.dest, "users-own-notes.txt", b"mine");
    let files = [staged("Mod.esp", b"core plugin")];
    let p = plan_from_trees(&files, &[&c.archive], &task()).unwrap();
    assert!(matches!(p.apply(&c.dest, &task()), Err(ReconstructError::DestinationNotEmpty(_))));
    assert_eq!(fs::read(c.dest.join("users-own-notes.txt")).unwrap(), b"mine");
    assert!(!c.dest.join("Mod.esp").exists());
}

#[test]
fn a_source_that_changed_after_indexing_is_caught_and_not_left_behind() {
    let c = Case::new();
    let files = [staged("Mod.esp", b"core plugin")];
    let p = plan_from_trees(&files, &[&c.archive], &task()).unwrap();
    // Same length, different bytes - only the hash can tell.
    fs::write(c.archive.join("00 Core/Mod.esp"), b"CORE PLUGIN").unwrap();
    assert!(matches!(p.apply(&c.dest, &task()), Err(ReconstructError::SourceChanged { .. })));
    assert!(!c.dest.join("Mod.esp").exists());
    assert!(!c.dest.join("Mod.esp.eh-part").exists());
}

#[test]
fn a_path_that_escapes_the_destination_is_refused_even_past_the_parser() {
    // The manifest parser rejects this first; this proves the writer does not
    // depend on that.
    let c = Case::new();
    let mut index = ContentIndex::new();
    index.add_tree(&c.archive, &task()).unwrap();
    // A safe file FIRST: it must not be written either, or a refused mod
    // leaves a half-built staging folder behind.
    let files = [staged("Mod.esp", b"core plugin"), staged("../../escaped.esp", b"core plugin")];
    let err = plan(&files, &index).apply(&c.dest, &task()).unwrap_err();
    assert!(matches!(err, ReconstructError::UnsafePath { .. }), "{err:?}");
    assert!(!c.dest.parent().unwrap().parent().unwrap().join("escaped.esp").exists());
    assert!(!c.dest.exists(), "nothing may be written when any path is refused");
}
