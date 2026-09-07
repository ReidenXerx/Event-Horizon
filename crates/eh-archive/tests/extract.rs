//! End-to-end extraction against archives built in the test itself.
//!
//! Fixtures are constructed here rather than committed, for two reasons: a
//! hostile archive is exactly the thing you want written deliberately rather
//! than trusted from a blob in git, and real mod archives are large, licensed
//! and often adult content — none of which belongs in this history.

use eh_archive::{extract, ArchiveError, Format, RefusalReason};
use eh_progress::{Progress, Unit};
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipWriter};

/// Build a ZIP with exactly the entry names given - including names a
/// well-behaved packer would never emit.
fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
    let mut zip = ZipWriter::new(File::create(path).unwrap());
    let options = FileOptions::<()>::default().compression_method(CompressionMethod::Stored);
    for (name, body) in entries {
        zip.start_file(*name, options).unwrap();
        zip.write_all(body).unwrap();
    }
    zip.finish().unwrap();
}

fn write_7z(path: &Path, entries: &[(&str, &[u8])]) {
    let mut writer = sevenz_rust2::ArchiveWriter::create(path).unwrap();
    for (name, body) in entries {
        writer
            .push_archive_entry(
                sevenz_rust2::ArchiveEntry::new_file(name),
                Some(std::io::Cursor::new(body.to_vec())),
            )
            .unwrap();
    }
    writer.finish().unwrap();
}

struct Case {
    _dir: tempfile::TempDir,
    root: PathBuf,
}

impl Case {
    /// The working root is nested two levels inside the temp directory on
    /// purpose. If the traversal guard ever regresses, `../..` then lands
    /// inside the tempdir and is cleaned up with it - a test that proves an
    /// escape by writing into the real `/tmp` leaves the evidence behind and
    /// poisons its own next run.
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("a").join("b");
        std::fs::create_dir_all(&root).unwrap();
        Self { _dir: dir, root }
    }
    fn archive(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }
    fn dest(&self) -> PathBuf {
        self.root.join("out")
    }
}

fn silent() -> Progress {
    Progress::silent()
}

#[test]
fn a_zip_round_trips_with_nested_directories() {
    let case = Case::new();
    let archive = case.archive("mod.zip");
    write_zip(
        &archive,
        &[
            ("Data/Textures/armour.dds", b"texture-bytes"),
            ("Data/Scripts/thing.pex", b"script"),
            ("readme.txt", b"hi"),
        ],
    );

    let p = silent();
    let task = p.task("extract", None, Unit::Files);
    let result = extract(&archive, &case.dest(), &task).unwrap();
    task.done();

    assert_eq!(result.via, Format::Zip);
    assert_eq!(result.files, 3);
    assert!(result.refused.is_empty());
    assert_eq!(
        std::fs::read(case.dest().join("Data/Textures/armour.dds")).unwrap(),
        b"texture-bytes"
    );
    assert_eq!(result.bytes, 13 + 6 + 2);
}

#[test]
fn an_entry_that_escapes_the_destination_is_refused_and_never_written() {
    let case = Case::new();
    let archive = case.archive("hostile.zip");
    write_zip(
        &archive,
        &[
            ("Data/fine.esp", b"ok"),
            ("../escaped.txt", b"PWNED"),
            ("../../also-escaped.txt", b"PWNED"),
        ],
    );

    let p = silent();
    let task = p.task("extract", None, Unit::Files);
    let result = extract(&archive, &case.dest(), &task).unwrap();
    task.done();

    // The safe entry still lands - one hostile entry does not abort the mod.
    assert_eq!(result.files, 1);
    assert_eq!(result.refused.len(), 2);
    assert!(result.refused.iter().all(|r| r.why == RefusalReason::Traversal));
    assert_eq!(result.refused_traversals(), 2);

    // The part that actually matters: nothing outside dest was created.
    assert!(!case.root.join("escaped.txt").exists(), "one level up");
    assert!(
        !case.root.parent().unwrap().join("also-escaped.txt").exists(),
        "two levels up"
    );
    assert!(case.dest().join("Data/fine.esp").exists());
}

#[test]
fn an_absolute_entry_is_refused() {
    let case = Case::new();
    let archive = case.archive("abs.zip");
    write_zip(&archive, &[("/etc/passwd", b"nope"), ("C:\\Windows\\x.dll", b"nope")]);

    let p = silent();
    let task = p.task("extract", None, Unit::Files);
    let result = extract(&archive, &case.dest(), &task).unwrap();
    task.done();

    assert_eq!(result.files, 0);
    assert_eq!(result.refused.len(), 2);
    assert!(result.refused.iter().all(|r| r.why == RefusalReason::Absolute));
}

#[test]
fn case_colliding_entries_are_extracted_and_reported() {
    let case = Case::new();
    let archive = case.archive("collide.zip");
    write_zip(&archive, &[("Textures/A.dds", b"one"), ("textures/a.DDS", b"two")]);

    let p = silent();
    let task = p.task("extract", None, Unit::Files);
    let result = extract(&archive, &case.dest(), &task).unwrap();
    task.done();

    assert_eq!(result.files, 2, "both are written; Linux keeps them apart");
    assert_eq!(result.case_collisions.len(), 1, "and the caller is told");
}

#[test]
fn a_7z_round_trips() {
    let case = Case::new();
    let archive = case.archive("mod.7z");
    write_7z(&archive, &[("Data/thing.esp", b"plugin-bytes"), ("readme.md", b"x")]);

    let p = silent();
    let task = p.task("extract", None, Unit::Files);
    let result = extract(&archive, &case.dest(), &task).unwrap();
    task.done();

    assert_eq!(result.via, Format::SevenZip);
    assert_eq!(result.files, 2);
    assert_eq!(std::fs::read(case.dest().join("Data/thing.esp")).unwrap(), b"plugin-bytes");
}

#[test]
fn a_7z_entry_that_escapes_is_refused_exactly_as_in_a_zip() {
    // The whole point of one shared write path: the rule cannot differ by
    // container. A traversal tolerated in 7z would be the same bug relocated.
    let case = Case::new();
    let archive = case.archive("hostile.7z");
    write_7z(&archive, &[("ok.esp", b"fine"), ("../escaped.txt", b"PWNED")]);

    let p = silent();
    let task = p.task("extract", None, Unit::Files);
    let result = extract(&archive, &case.dest(), &task).unwrap();
    task.done();

    assert_eq!(result.files, 1);
    assert_eq!(result.refused.len(), 1);
    assert_eq!(result.refused[0].why, RefusalReason::Traversal);
    assert!(!case.root.join("escaped.txt").exists());
}

#[test]
fn the_extension_never_decides_the_format() {
    let case = Case::new();
    // A ZIP that somebody renamed to .rar - common after a re-upload.
    let archive = case.archive("actually-a-zip.rar");
    write_zip(&archive, &[("x.esp", b"content")]);

    let p = silent();
    let task = p.task("extract", None, Unit::Files);
    let result = extract(&archive, &case.dest(), &task).unwrap();
    task.done();

    assert_eq!(result.via, Format::Zip, "content wins over the filename");
    assert_eq!(result.files, 1);
}

#[test]
fn a_file_no_reader_recognises_is_unrecognised_rather_than_a_backend_failure() {
    let case = Case::new();
    let archive = case.archive("truncated.7z");
    std::fs::write(&archive, b"this is not an archive at all").unwrap();

    let p = silent();
    let task = p.task("extract", None, Unit::Files);
    let err = extract(&archive, &case.dest(), &task).unwrap_err();
    task.done();

    // The distinction is load-bearing: only a damaged download is fixed by
    // downloading again.
    assert!(matches!(err, ArchiveError::Unrecognised { .. }), "got {err:?}");
}

#[test]
#[cfg(not(feature = "rar"))]
fn a_rar_without_the_feature_says_unsupported_not_damaged() {
    let case = Case::new();
    let archive = case.archive("mod.rar");
    // Real RAR5 signature; enough for detection to route it correctly.
    std::fs::write(&archive, b"Rar!\x1a\x07\x01\x00rest-of-a-rar").unwrap();

    let p = silent();
    let task = p.task("extract", None, Unit::Files);
    let err = extract(&archive, &case.dest(), &task).unwrap_err();
    task.done();

    match err {
        ArchiveError::Unsupported { format: Format::Rar, .. } => {}
        other => panic!("a recognised RAR must not read as damaged: {other:?}"),
    }
}

#[test]
fn progress_learns_the_total_late_and_advances_once_per_entry() {
    use eh_progress::recording::{Event, RecordingSink};
    use std::sync::Arc;

    let case = Case::new();
    let archive = case.archive("mod.zip");
    write_zip(&archive, &[("a", b"1"), ("b", b"2"), ("c", b"3")]);

    let sink = Arc::new(RecordingSink::new());
    let p = Progress::new(sink.clone());
    // Starts indeterminate: the entry count is not knowable before opening.
    let task = p.task("extract", None, Unit::Files);
    extract(&archive, &case.dest(), &task).unwrap();
    task.done();

    let events = sink.events();
    assert!(
        events.iter().any(|e| matches!(e, Event::SetTotal { total: 3, .. })),
        "the total must arrive once the directory is read: {events:?}"
    );
    let advances = events.iter().filter(|e| matches!(e, Event::Advance { .. })).count();
    assert_eq!(advances, 3, "one per entry, including refused ones");
}
