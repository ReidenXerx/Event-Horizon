//! Reading packages built in the test itself — shaped like real ones, and
//! broken in the ways real ones arrive broken.
//!
//! The messages asserted here were checked against the TypeScript reader
//! (`readEhcoll.ts`) on the same packages: 18 of 19 cases byte-identical,
//! the 19th differing only in the JSON parser's own wording.

use eh_package::{has_package_manifest, read_package, LINK_FILE_NAME};
use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipWriter};

const FIXTURE: &str = include_str!("../../../spec/fixtures/manifests/valid/roundtrip.json");
const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/// The TypeScript-emitted manifest, with its external mod bundled or not.
fn manifest(bundled: bool) -> String {
    let mut v: Value = serde_json::from_str(FIXTURE).unwrap();
    for m in v["mods"].as_array_mut().unwrap() {
        if m["source"]["kind"] == "external" {
            m["source"]["bundled"] = Value::Bool(bundled);
            m["source"]["sha256"] = Value::String(B.into());
        }
    }
    v.to_string()
}

struct Pkg {
    _dir: tempfile::TempDir,
    path: PathBuf,
}

fn zip_of(entries: &[(&str, &[u8])], method: CompressionMethod) -> Pkg {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("Collection.ehcoll");
    let mut z = ZipWriter::new(std::fs::File::create(&path).unwrap());
    let o = FileOptions::<()>::default().compression_method(method);
    for (name, body) in entries {
        if name.ends_with('/') {
            z.add_directory(*name, o).unwrap();
        } else {
            z.start_file(*name, o).unwrap();
            z.write_all(body).unwrap();
        }
    }
    z.finish().unwrap();
    Pkg { _dir: dir, path }
}

fn pkg(entries: &[(&str, &[u8])]) -> Pkg {
    zip_of(entries, CompressionMethod::Deflated)
}

fn errors(p: &Path) -> Vec<String> {
    read_package(p).err().map(|e| e.errors).unwrap_or_default()
}

fn assert_error(p: &Path, needle: &str) {
    let e = errors(p);
    assert!(e.iter().any(|m| m.contains(needle)), "expected {needle:?} in {e:#?}");
}

fn bundled_file(rel: &str) -> String {
    format!("bundled/{B}/{rel}")
}

#[test]
fn a_whole_package_reads_with_every_part_accounted_for() {
    let m = manifest(true);
    let (a, c) = (bundled_file("Data/b.esp"), bundled_file("Data/sub/c.esp"));
    let mirror = format!("mirror/{}", "c".repeat(64));
    let p = pkg(&[
        ("manifest.json", m.as_bytes()),
        ("collection.json", b"{}"),
        ("README.md", b"r"),
        ("CHANGELOG.md", b"c"),
        ("bundled/", b""),
        (&a, b"b"),
        (&c, b"cc"),
        (&mirror, b"m"),
        ("presentation/header.png", b"p"),
        ("ini-tweaks/x.ini", b"i"),
        ("from-a-later-build.txt", b"tolerated"),
    ]);
    let r = read_package(&p.path).unwrap();
    assert_eq!(r.bundled.len(), 1);
    assert_eq!((r.bundled[0].files, r.bundled[0].size), (2, 3));
    assert_eq!(r.bundled[0].bundle_folder, format!("bundled/{B}/"));
    assert!(r.has_readme && r.has_changelog);
    assert_eq!(r.ini_tweak_files, ["ini-tweaks/x.ini"]);
    assert_eq!(r.mirror_files, [mirror]);
    assert_eq!(r.manifest.mods.len(), 2);
}

#[test]
fn a_bundled_mod_without_its_folder_is_an_incomplete_package() {
    let m = manifest(true);
    let p = pkg(&[("manifest.json", m.as_bytes())]);
    assert_error(&p.path, &format!("has no folder bundled/{B}/ holding its files"));
    assert_error(&p.path, &format!("\"external:{B}\""));
}

#[test]
fn a_folder_no_mod_claims_is_stray() {
    let m = manifest(false);
    let stray = format!("bundled/{}/x.esp", "d".repeat(64));
    let p = pkg(&[("manifest.json", m.as_bytes()), (&stray, b"x")]);
    assert_error(&p.path, "The package contains stray files.");
}

#[test]
fn a_schema_1_archive_under_bundled_refuses_the_package() {
    let m = manifest(true);
    let (f, z) = (bundled_file("Data/b.esp"), format!("bundled/{B}.zip"));
    let p = pkg(&[("manifest.json", m.as_bytes()), (&f, b"b"), (&z, b"z")]);
    assert_error(&p.path, "1 entry that is not a file inside a bundled mod's folder");
}

#[test]
fn more_strays_than_are_worth_listing_are_counted() {
    let m = manifest(true);
    let f = bundled_file("a");
    let junk: Vec<String> = (0..7).map(|i| format!("bundled/junk{i}.7z")).collect();
    let mut entries: Vec<(&str, &[u8])> = vec![("manifest.json", m.as_bytes()), (&f, b"b")];
    entries.extend(junk.iter().map(|j| (j.as_str(), &b"z"[..])));
    let p = pkg(&entries);
    assert_error(&p.path, "7 entries that are not");
    assert_error(&p.path, "and 2 more");
}

#[test]
fn a_bundled_name_with_no_declared_encoding_is_refused() {
    let m = manifest(true);
    let (f, placeholder) = (bundled_file("Data/b.esp"), bundled_file("aX.esp"));
    let p = zip_of(&[("manifest.json", m.as_bytes()), (&f, b"b"), (&placeholder, b"n")], CompressionMethod::Stored);
    // Swap an ASCII byte for a raw 0xE9 in both name copies: no UTF-8 flag,
    // not ASCII — what a re-packing tool on a Windows code page produces.
    let mut bytes = std::fs::read(&p.path).unwrap();
    let mut hits = 0;
    for i in 0..bytes.len() - 6 {
        if &bytes[i..i + 6] == b"/aX.es" {
            bytes[i + 2] = 0xE9;
            hits += 1;
        }
    }
    assert_eq!(hits, 2, "local header and central directory");
    std::fs::write(&p.path, bytes).unwrap();
    assert_error(&p.path, "1 file whose name does not say how it is encoded");
}

#[test]
fn backslash_separated_names_are_read_as_paths() {
    let m = manifest(true);
    let f = format!("bundled\\{B}\\Data\\b.esp");
    let p = pkg(&[("manifest.json", m.as_bytes()), (&f, b"b")]);
    assert_eq!(read_package(&p.path).unwrap().bundled[0].files, 1);
}

#[test]
fn a_link_file_is_named_for_what_it_is() {
    let link = format!("Some/{LINK_FILE_NAME}");
    let p = pkg(&[(&link, b"{}")]);
    assert_error(&p.path, "is a collection's link file, not its package");
    assert!(!has_package_manifest(&p.path).unwrap());
}

#[test]
fn a_zip_without_a_manifest_is_not_a_package() {
    let p = pkg(&[("readme.txt", b"x")]);
    assert_error(&p.path, "does not contain manifest.json at its root");
}

#[test]
fn manifest_errors_come_through_as_the_parser_wrote_them() {
    let mut v: Value = serde_json::from_str(&manifest(false)).unwrap();
    v["schemaVersion"] = Value::from(1);
    let raw = v.to_string();
    let p = pkg(&[("manifest.json", raw.as_bytes())]);
    assert_error(&p.path, "built by an older Event Horizon");
}

#[test]
fn a_manifest_whose_bytes_changed_inside_the_zip_is_caught_by_its_crc() {
    let m = manifest(false);
    assert!(m.contains("\"name\":\"RT\""));
    let p = zip_of(&[("manifest.json", m.as_bytes())], CompressionMethod::Stored);
    // Still valid JSON, still a valid manifest — only the CRC can tell.
    let bytes = std::fs::read(&p.path).unwrap();
    let at = bytes.windows(11).position(|w| w == b"\"name\":\"RT\"").unwrap();
    let mut bytes = bytes;
    bytes[at + 9] = b'X';
    std::fs::write(&p.path, bytes).unwrap();
    assert_error(&p.path, "Could not read manifest.json");
}

#[test]
fn files_that_are_not_packages_say_what_they_are() {
    let dir = tempfile::tempdir().unwrap();
    let cases: [(&str, &[u8], &str); 5] = [
        ("html", b"<!DOCTYPE html><html>Error 503</html>", "an HTML page"),
        ("rar", b"Rar!\x1a\x07\x01\x00rest", "a RAR archive (not a ZIP)"),
        ("json", b"{\"a\":1}", "a JSON file"),
        ("empty", b"", "is 0 bytes"),
        ("noise", b"\x00\x01\x02\x03\x04\x05\x06\x07\x08", "something that is not a ZIP"),
    ];
    for (name, bytes, needle) in cases {
        let p = dir.path().join(format!("{name}.ehcoll"));
        std::fs::write(&p, bytes).unwrap();
        assert_error(&p, needle);
    }
}

#[test]
fn a_cut_short_download_is_called_incomplete_not_corrupt() {
    let m = manifest(false);
    let p = pkg(&[("manifest.json", m.as_bytes()), ("README.md", &[b'x'; 4096])]);
    let bytes = std::fs::read(&p.path).unwrap();
    std::fs::write(&p.path, &bytes[..bytes.len() / 2]).unwrap();
    assert_error(&p.path, "is an INCOMPLETE copy");
}

#[test]
fn a_missing_file_says_so() {
    assert_error(Path::new("/nonexistent/x.ehcoll"), "No file at");
}

#[test]
fn an_ordinary_vortex_collection_is_named_as_one() {
    let p = pkg(&[("collection.json", br#"{"info":{},"mods":[{"name":"x"}]}"#), ("bundled/x.7z", b"z")]);
    assert_error(&p.path, "is an ordinary Vortex collection, not an Event Horizon one");
}
