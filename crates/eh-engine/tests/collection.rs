//! From a collection link to a stored, readable package — against a fake
//! Nexus serving a REAL v2 package built from the TypeScript-emitted fixture.

use eh_engine::library::Library;
use eh_engine::nexus::{ApiKey, Client};
use eh_engine::{fetch_collection, EngineError};
use eh_progress::{Progress, Unit};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

const FIXTURE: &str = include_str!("../../../spec/fixtures/manifests/valid/roundtrip.json");

/// A minimal HTTP server: `route(base, path)` -> (status, body).
fn serve(route: impl Fn(&str, &str) -> (u16, Vec<u8>) + Send + 'static) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (me, log) = (base.clone(), seen.clone());
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut stream = stream;
            let mut r = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            let _ = r.read_line(&mut line);
            let path = line.split_whitespace().nth(1).unwrap_or("").to_owned();
            let mut len = 0usize;
            loop {
                let mut h = String::new();
                if r.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" {
                    break;
                }
                if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap_or(0);
                }
            }
            let mut body = vec![0; len];
            let _ = r.read_exact(&mut body);
            log.lock().unwrap().push(path.clone());
            let (status, out) = route(&me, &path);
            let _ = write!(stream, "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", out.len());
            let _ = stream.write_all(&out);
        }
    });
    (base, seen)
}

fn package_bytes() -> Vec<u8> {
    let mut buf = std::io::Cursor::new(Vec::new());
    let mut z = zip::ZipWriter::new(&mut buf);
    let o = zip::write::FileOptions::<()>::default();
    z.start_file("manifest.json", o).unwrap();
    z.write_all(FIXTURE.as_bytes()).unwrap();
    z.start_file("collection.json", o).unwrap();
    z.write_all(b"{}").unwrap();
    z.finish().unwrap();
    buf.into_inner()
}

fn revision_json(domain: &str) -> Vec<u8> {
    format!(
        r#"{{"data":{{"collectionRevision":{{"id":9,"revisionNumber":3,"downloadLink":"/v2/collections/1/revisions/9/download_link",
        "adultContent":false,"modCount":2,"totalSize":"100","collection":{{"id":1,"name":"RT","game":{{"domainName":"{domain}"}}}}}}}}}}"#
    )
    .into_bytes()
}

fn nexus(domain: &'static str, package: Vec<u8>) -> (String, Arc<Mutex<Vec<String>>>) {
    serve(move |base, path| match path {
        "/v2/graphql" => (200, revision_json(domain)),
        "/v2/collections/1/revisions/9/download_link" => (
            200,
            format!(r#"{{"download_links":[{{"name":"Nexus CDN","short_name":"Nexus CDN","URI":"{base}/cdn/p.zip"}}]}}"#).into_bytes(),
        ),
        "/cdn/p.zip" => (200, package.clone()),
        _ => (404, vec![]),
    })
}

fn task() -> eh_progress::Task {
    Progress::silent().task("t", None, Unit::Bytes)
}

fn client(base: &str) -> Client {
    Client::with_base(ApiKey::new("k").unwrap(), base)
}

#[test]
fn a_link_becomes_a_stored_package_that_reads() {
    let (base, _) = nexus("fallout4", package_bytes());
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path()).unwrap();
    let f = fetch_collection(&client(&base), &lib, "https://www.nexusmods.com/games/fallout4/collections/abc123", &task()).unwrap();
    assert_eq!(f.path, lib.package_path("fallout4", "abc123", 3).unwrap());
    assert_eq!(f.package.manifest.mods.len(), 2);
    assert_eq!(f.via.as_deref(), Some("Nexus CDN"));
}

#[test]
fn something_that_is_not_a_package_is_never_stored() {
    let (base, _) = nexus("fallout4", b"<!DOCTYPE html><html>Error</html>".to_vec());
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path()).unwrap();
    let err = fetch_collection(&client(&base), &lib, "abc123", &task()).unwrap_err();
    assert!(err.to_string().contains("HTML page"), "{err}");
    assert!(!lib.package_path("fallout4", "abc123", 3).unwrap().exists());
}

#[test]
fn a_game_we_do_not_support_is_refused_before_downloading() {
    let (base, seen) = nexus("cyberpunk2077", package_bytes());
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path()).unwrap();
    let err = fetch_collection(&client(&base), &lib, "abc123", &task()).unwrap_err();
    assert!(matches!(err, EngineError::UnsupportedGame(ref d) if d == "cyberpunk2077"), "{err}");
    assert_eq!(*seen.lock().unwrap(), ["/v2/graphql"], "nothing but the lookup");
}

#[test]
fn a_package_for_another_game_than_its_listing_is_refused() {
    let (base, _) = nexus("skyrimspecialedition", package_bytes()); // the package says fallout4
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path()).unwrap();
    let err = fetch_collection(&client(&base), &lib, "abc123", &task()).unwrap_err();
    assert!(err.to_string().contains("listed for skyrimse, but its package is for fallout4"), "{err}");
}
