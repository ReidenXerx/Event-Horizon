//! The install loop against a fake Nexus and a REAL v2 package.
//!
//! The package holds the four kinds of mod a collection has:
//!   A  Nexus, a FOMOD archive — the curator's option is chosen by hash
//!   B  bundled — its files ride in the package under bundled/<sha>/
//!   C  Nexus, mirrored — one file exists only in the package's mirror/
//!   D  external, not bundled — the user has to supply the archive

use eh_engine::library::{InstanceConfig, InstanceId, Library};
use eh_engine::nexus::{ApiKey, Client};
use eh_engine::{create_instance, install_package, EngineError};
use eh_progress::{Progress, Unit};
use ehcoll::SupportedGameId;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const FIXTURE: &str = include_str!("../../../spec/fixtures/manifests/valid/roundtrip.json");

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

// ── the mods ───────────────────────────────────────────────────────────────

fn archive_a() -> Vec<u8> {
    zip_bytes(&[
        ("fomod/ModuleConfig.xml", b"<config/>"),
        ("00 Core/Data/a.esp", b"core of A"),
        ("10 Option One/textures/x.dds", b"option one"),
        ("11 Option Two/textures/x.dds", b"option two"),
    ])
}
fn archive_c() -> Vec<u8> {
    zip_bytes(&[("Data/c.esp", b"plugin of C")])
}
fn archive_d() -> Vec<u8> {
    zip_bytes(&[("Data/d.esp", b"plugin of D")])
}
const BUNDLE_B: &str = "b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0";
const CLEANED: &[u8] = b"cleaned by the curator";

fn file(path: &str, bytes: &[u8]) -> Value {
    json!({ "path": path, "size": bytes.len(), "sha256": sha(bytes) })
}

fn nexus_mod(key: &str, name: &str, mod_id: u64, file_id: u64, archive: &[u8], order: i64, files: Vec<Value>) -> Value {
    json!({
        "compareKey": key, "name": name, "version": "1.0",
        "source": { "kind": "nexus", "gameDomain": "fallout4", "modId": mod_id, "fileId": file_id,
                    "archiveName": format!("{name}.zip"), "sha256": sha(archive) },
        "install": { "fomodSelections": [] },
        "state": { "enabled": true, "installOrder": order, "deploymentPriority": order, "stagingFiles": files }
    })
}

/// The manifest, with `texture` deciding which FOMOD option A was staged with.
fn manifest(texture: &[u8], strict: bool) -> Value {
    let mut m: Value = serde_json::from_str(FIXTURE).unwrap();
    let mut c = nexus_mod("nexus:30:40", "C Mirrored", 30, 40, &archive_c(), 2,
        vec![file("Data/c.esp", b"plugin of C"), file("Data/cleaned.esp", CLEANED)]);
    c["state"]["mirrored"] = json!(true);
    m["mods"] = json!([
        nexus_mod("nexus:10:20", "A Fomod", 10, 20, &archive_a(), 0,
            vec![file("Data/a.esp", b"core of A"), file("textures/x.dds", texture)]),
        {
            "compareKey": format!("external:{BUNDLE_B}"), "name": "B Bundled", "version": "1.0",
            "source": { "kind": "external", "expectedFilename": "B.zip", "sha256": BUNDLE_B, "bundled": true },
            "install": { "fomodSelections": [] },
            "state": { "enabled": true, "installOrder": 1, "deploymentPriority": 1,
                       "stagingFiles": [file("Data/fix.esp", b"bundled fix")] }
        },
        c,
        {
            "compareKey": format!("external:{}", sha(&archive_d())), "name": "D Elsewhere", "version": "1.0",
            "source": { "kind": "external", "expectedFilename": "D-1.0.zip", "sha256": sha(&archive_d()),
                        "instructions": "Get it from the author's site", "url": "https://example.com/d",
                        "bundled": false },
            "install": { "fomodSelections": [] },
            "state": { "enabled": true, "installOrder": 3, "deploymentPriority": 3,
                       "stagingFiles": [file("Data/d.esp", b"plugin of D")] }
        }
    ]);
    m["rules"] = json!([]);
    m["loadOrder"] = json!([]);
    m["package"]["strictMissingMods"] = json!(strict);
    m
}

fn write_package(dir: &Path, name: &str, manifest: &Value) -> PathBuf {
    let path = dir.join(name);
    let m = manifest.to_string();
    let bundled = format!("bundled/{BUNDLE_B}/Data/fix.esp");
    let mirror = format!("mirror/{}", sha(CLEANED));
    std::fs::write(
        &path,
        zip_bytes(&[
            ("manifest.json", m.as_bytes()),
            ("collection.json", b"{}"),
            (&bundled, b"bundled fix"),
            (&mirror, CLEANED),
        ]),
    )
    .unwrap();
    path
}

// ── a fake Nexus ───────────────────────────────────────────────────────────

struct Nexus {
    base: String,
    seen: Arc<Mutex<Vec<String>>>,
}

impl Nexus {
    fn start(premium: bool, c_archive: Vec<u8>, link_status: u16) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (me, log) = (base.clone(), seen.clone());
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut r = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                let _ = r.read_line(&mut line);
                let path = line.split_whitespace().nth(1).unwrap_or("").to_owned();
                let mut len = 0;
                loop {
                    let mut h = String::new();
                    if r.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" {
                        break;
                    }
                    if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap_or(0);
                    }
                }
                let _ = r.read_exact(&mut vec![0; len]);
                log.lock().unwrap().push(path.clone());
                let links = |cdn: &str| format!(r#"[{{"name":"Nexus CDN","short_name":"Nexus CDN","URI":"{me}/cdn/{cdn}"}}]"#).into_bytes();
                let (status, body): (u16, Vec<u8>) = match path.as_str() {
                    "/v1/users/validate.json" => {
                        (200, format!(r#"{{"user_id":1,"name":"Bluuuk","is_premium":{premium},"is_supporter":false}}"#).into_bytes())
                    }
                    "/v1/games/fallout4/mods/10/files/20/download_link.json" => (link_status, links("a.zip")),
                    "/v1/games/fallout4/mods/30/files/40/download_link.json" => (link_status, links("c.zip")),
                    "/cdn/a.zip" => (200, archive_a()),
                    "/cdn/c.zip" => (200, c_archive.clone()),
                    _ => (404, vec![]),
                };
                let _ = write!(stream, "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                let _ = stream.write_all(&body);
            }
        });
        Self { base, seen }
    }

    fn client(&self) -> Client {
        Client::with_base(ApiKey::new("k").unwrap(), &self.base)
    }

    fn requests(&self) -> Vec<String> {
        self.seen.lock().unwrap().clone()
    }
}

// ── a world ────────────────────────────────────────────────────────────────

struct World {
    dir: tempfile::TempDir,
    lib: Library,
}

fn world() -> World {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path().join("eh")).unwrap();
    World { dir, lib }
}

impl World {
    fn instance(&self, game: SupportedGameId) -> eh_engine::library::Instance {
        let game_dir = self.dir.path().join("game");
        std::fs::create_dir_all(&game_dir).unwrap();
        create_instance(&self.lib, InstanceConfig::new(InstanceId::new("poc").unwrap(), game, game_dir)).unwrap()
    }

    fn staged(&self, inst: &eh_engine::library::Instance, key: &str, rel: &str) -> Vec<u8> {
        std::fs::read(inst.staging_dir_for(key).join(rel)).unwrap()
    }
}

fn task() -> eh_progress::Task {
    Progress::silent().task("t", None, Unit::Steps)
}

fn key_d() -> String {
    format!("external:{}", sha(&archive_d()))
}

// ── tests ──────────────────────────────────────────────────────────────────

#[test]
fn a_whole_collection_is_staged_and_the_missing_one_is_named() {
    let w = world();
    let nexus = Nexus::start(true, archive_c(), 200);
    let mut inst = w.instance(SupportedGameId::Fallout4);
    let pkg = write_package(w.dir.path(), "p.ehcoll", &manifest(b"option two", false));

    let r = install_package(Some(&nexus.client()), &w.lib, &mut inst, &pkg, &task()).unwrap();
    assert_eq!(r.staged, ["A Fomod", "B Bundled", "C Mirrored"]);
    assert_eq!(r.needs_user.len(), 1);
    assert_eq!(r.needs_user[0].expected_filename, "D-1.0.zip");
    assert!(!r.is_complete());

    assert_eq!(w.staged(&inst, "nexus:10:20", "textures/x.dds"), b"option two", "the curator's option");
    assert_eq!(w.staged(&inst, &format!("external:{BUNDLE_B}"), "Data/fix.esp"), b"bundled fix");
    assert_eq!(w.staged(&inst, "nexus:30:40", "Data/cleaned.esp"), CLEANED, "from the package's mirror/");
    assert!(w.lib.archive_path(&sha(&archive_a())).unwrap().is_file(), "downloads kept by hash");
    assert!(!inst.staging_dir_for(&key_d()).exists());
}

#[test]
fn a_second_run_finishes_what_the_first_could_not_and_downloads_nothing_again() {
    let w = world();
    let nexus = Nexus::start(true, archive_c(), 200);
    let mut inst = w.instance(SupportedGameId::Fallout4);
    let pkg = write_package(w.dir.path(), "p.ehcoll", &manifest(b"option two", false));
    install_package(Some(&nexus.client()), &w.lib, &mut inst, &pkg, &task()).unwrap();
    let before = nexus.requests().len();

    // The user supplies D, named by its hash.
    std::fs::write(w.lib.archive_path(&sha(&archive_d())).unwrap(), archive_d()).unwrap();
    let r = install_package(Some(&nexus.client()), &w.lib, &mut inst, &pkg, &task()).unwrap();
    assert_eq!(r.staged, ["D Elsewhere"]);
    assert_eq!(r.already_staged.len(), 3);
    assert!(r.is_complete());
    assert_eq!(nexus.requests().len(), before, "not even the account check");
}

#[test]
fn a_free_account_is_refused_before_anything_is_downloaded() {
    let w = world();
    let nexus = Nexus::start(false, archive_c(), 200);
    let mut inst = w.instance(SupportedGameId::Fallout4);
    let pkg = write_package(w.dir.path(), "p.ehcoll", &manifest(b"option two", false));
    let err = install_package(Some(&nexus.client()), &w.lib, &mut inst, &pkg, &task()).unwrap_err();
    assert!(matches!(err, EngineError::PremiumRequired(ref n) if n == "Bluuuk"), "{err}");
    assert_eq!(nexus.requests(), ["/v1/users/validate.json"]);
    assert!(!inst.staging_root().exists());
}

#[test]
fn nexus_mods_without_a_key_are_refused_up_front() {
    let w = world();
    let mut inst = w.instance(SupportedGameId::Fallout4);
    let pkg = write_package(w.dir.path(), "p.ehcoll", &manifest(b"option two", false));
    let err = install_package(None, &w.lib, &mut inst, &pkg, &task()).unwrap_err();
    assert!(matches!(err, EngineError::NoNexusClient), "{err}");
}

#[test]
fn a_new_revision_that_changes_a_mods_files_restages_only_that_mod() {
    let w = world();
    let nexus = Nexus::start(true, archive_c(), 200);
    let mut inst = w.instance(SupportedGameId::Fallout4);
    let r1 = write_package(w.dir.path(), "r1.ehcoll", &manifest(b"option two", false));
    install_package(Some(&nexus.client()), &w.lib, &mut inst, &r1, &task()).unwrap();

    // Revision 2: the curator switched A to option one.
    let r2 = write_package(w.dir.path(), "r2.ehcoll", &manifest(b"option one", false));
    let r = install_package(Some(&nexus.client()), &w.lib, &mut inst, &r2, &task()).unwrap();
    assert_eq!(r.staged, ["A Fomod"]);
    assert_eq!(r.already_staged, ["B Bundled", "C Mirrored"]);
    assert_eq!(w.staged(&inst, "nexus:10:20", "textures/x.dds"), b"option one");
}

#[test]
fn a_mod_nexus_serves_differently_fails_alone_unless_the_collection_is_strict() {
    let w = world();
    let nexus = Nexus::start(true, zip_bytes(&[("Data/c.esp", b"re-uploaded")]), 200);
    let mut inst = w.instance(SupportedGameId::Fallout4);
    let pkg = write_package(w.dir.path(), "p.ehcoll", &manifest(b"option two", false));
    let r = install_package(Some(&nexus.client()), &w.lib, &mut inst, &pkg, &task()).unwrap();
    assert_eq!(r.failed.len(), 1);
    assert_eq!(r.failed[0].name, "C Mirrored");
    assert!(r.failed[0].why.contains("different bytes"), "{}", r.failed[0].why);
    assert_eq!(r.staged, ["A Fomod", "B Bundled"]);
    assert_eq!(r.needs_user.len(), 1, "the run went on past C");
    assert!(!inst.staging_dir_for("nexus:30:40").exists());

    let w = world();
    let nexus = Nexus::start(true, zip_bytes(&[("Data/c.esp", b"re-uploaded")]), 200);
    let mut inst = w.instance(SupportedGameId::Fallout4);
    let pkg = write_package(w.dir.path(), "p.ehcoll", &manifest(b"option two", true));
    let r = install_package(Some(&nexus.client()), &w.lib, &mut inst, &pkg, &task()).unwrap();
    assert!(r.stopped.as_deref().unwrap_or("").contains("strictMissingMods"), "{r:?}");
    assert!(r.needs_user.is_empty(), "D was never reached");
}

#[test]
fn an_account_problem_stops_the_run_instead_of_failing_every_mod() {
    let w = world();
    let nexus = Nexus::start(true, archive_c(), 429);
    let mut inst = w.instance(SupportedGameId::Fallout4);
    let pkg = write_package(w.dir.path(), "p.ehcoll", &manifest(b"option two", false));
    let r = install_package(Some(&nexus.client()), &w.lib, &mut inst, &pkg, &task()).unwrap();
    assert!(r.stopped.as_deref().unwrap_or("").contains("rate limit"), "{r:?}");
    assert!(r.failed.is_empty() && r.staged.is_empty());
}

#[test]
fn a_collection_for_another_game_is_refused() {
    let w = world();
    let mut inst = w.instance(SupportedGameId::Skyrimse);
    let pkg = write_package(w.dir.path(), "p.ehcoll", &manifest(b"option two", false));
    assert!(matches!(
        install_package(None, &w.lib, &mut inst, &pkg, &task()),
        Err(EngineError::WrongGame { .. })
    ));
}

#[test]
fn a_crash_leftover_is_cleared_and_an_unreceipted_folder_is_rebuilt() {
    let w = world();
    let nexus = Nexus::start(true, archive_c(), 200);
    let mut inst = w.instance(SupportedGameId::Fallout4);
    let dest = inst.staging_dir_for("nexus:10:20");
    // A half-written temporary folder, and a "finished" folder with no
    // receipt — what a crash between the rename and the receipt leaves.
    let part = dest.with_file_name(format!(".eh-part-{}", dest.file_name().unwrap().to_string_lossy()));
    std::fs::create_dir_all(&part).unwrap();
    std::fs::write(part.join("junk"), b"x").unwrap();
    std::fs::create_dir_all(&dest).unwrap();
    std::fs::write(dest.join("stale.esp"), b"x").unwrap();

    let pkg = write_package(w.dir.path(), "p.ehcoll", &manifest(b"option two", false));
    let r = install_package(Some(&nexus.client()), &w.lib, &mut inst, &pkg, &task()).unwrap();
    assert!(r.staged.contains(&"A Fomod".to_owned()));
    assert!(!part.exists());
    assert!(!dest.join("stale.esp").exists());
    assert_eq!(w.staged(&inst, "nexus:10:20", "textures/x.dds"), b"option two");
}

#[test]
fn a_run_cannot_start_while_another_holds_the_instance() {
    let w = world();
    let mut inst = w.instance(SupportedGameId::Fallout4);
    std::fs::write(inst.dir().join(".lock"), "1").unwrap(); // pid 1 is always alive
    let pkg = write_package(w.dir.path(), "p.ehcoll", &manifest(b"option two", false));
    let err = install_package(None, &w.lib, &mut inst, &pkg, &task()).unwrap_err();
    assert!(err.to_string().contains("in use by another"), "{err}");
}

#[test]
fn a_wrong_file_under_the_right_name_is_still_needed_not_used() {
    let w = world();
    let nexus = Nexus::start(true, archive_c(), 200);
    let mut inst = w.instance(SupportedGameId::Fallout4);
    // The user saved some other archive under D's hash name.
    std::fs::write(w.lib.archive_path(&sha(&archive_d())).unwrap(), b"not D at all").unwrap();
    let pkg = write_package(w.dir.path(), "p.ehcoll", &manifest(b"option two", false));
    let r = install_package(Some(&nexus.client()), &w.lib, &mut inst, &pkg, &task()).unwrap();
    assert_eq!(r.needs_user.len(), 1, "identity is the hash, not the name: {r:?}");
    assert!(r.failed.is_empty(), "{r:?}");
}
