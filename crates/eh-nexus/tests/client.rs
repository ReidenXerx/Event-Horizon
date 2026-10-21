//! The client against a local fake of the Nexus API and its CDNs.
//!
//! Every behaviour here is one a real install depends on and the real API
//! would make expensive or impossible to provoke on demand: a mirror that
//! dies mid-transfer, a file whose bytes changed, a redirect that would carry
//! the key somewhere else.

use eh_nexus::{ApiKey, Client, NexusError, NexusFile};
use eh_progress::{Progress, Unit};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

const KEY: &str = "test-key-not-real";

#[derive(Clone, Debug)]
struct Seen {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: String,
}

struct Reply {
    status: u16,
    headers: Vec<(&'static str, String)>,
    body: Vec<u8>,
    /// Declare this Content-Length instead of the body's, then hang up.
    claim_len: Option<usize>,
}

fn reply(status: u16, body: impl Into<Vec<u8>>) -> Reply {
    Reply { status, headers: vec![], body: body.into(), claim_len: None }
}

/// A one-thread HTTP/1.1 server answering every request with `route(path)`.
struct Fake {
    base: String,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Fake {
    fn start(route: impl Fn(&str, &str) -> Reply + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (log, me) = (seen.clone(), base.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() {
                    continue;
                }
                let method = line.split_whitespace().next().unwrap_or("").to_owned();
                let path = line.split_whitespace().nth(1).unwrap_or("").to_owned();
                let mut headers = HashMap::new();
                loop {
                    let mut h = String::new();
                    if reader.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" {
                        break;
                    }
                    if let Some((k, v)) = h.trim_end().split_once(':') {
                        headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_owned());
                    }
                }
                let len: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
                let mut body = vec![0u8; len];
                let _ = reader.read_exact(&mut body);
                let body = String::from_utf8_lossy(&body).into_owned();
                log.lock().unwrap().push(Seen { method, path: path.clone(), headers, body });
                let r = route(&me, &path);
                let mut head = format!(
                    "HTTP/1.1 {} X\r\nContent-Length: {}\r\nConnection: close\r\n",
                    r.status,
                    r.claim_len.unwrap_or(r.body.len())
                );
                for (k, v) in &r.headers {
                    head.push_str(&format!("{k}: {v}\r\n"));
                }
                head.push_str("\r\n");
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&r.body);
                let _ = stream.flush();
            }
        });
        Self { base, seen }
    }

    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }
}

fn client(fake: &Fake) -> Client {
    Client::with_base(ApiKey::new(KEY).unwrap(), &fake.base)
}

fn file() -> NexusFile {
    NexusFile { game_domain: "fallout4".into(), mod_id: 22431, file_id: 305057 }
}

fn sha(b: &[u8]) -> String {
    eh_identity::sha256_reader(b, None).unwrap().0
}

fn task() -> eh_progress::Task {
    Progress::silent().task("t", None, Unit::Bytes)
}

const LINKS_PATH: &str = "/v1/games/fallout4/mods/22431/files/305057/download_link.json";
const ARCHIVE: &[u8] = b"the real archive bytes";

/// Two mirrors, listed regional-first so the preference order is tested.
fn links_json(base: &str) -> String {
    format!(
        r#"[{{"name":"Amsterdam","short_name":"Amsterdam","URI":"{base}/cdn/ams/file.7z?md5=s&expires=1"}},
            {{"name":"Nexus Global Content Delivery Network","short_name":"Nexus CDN","URI":"{base}/cdn/global/file.7z?md5=s&expires=1"}}]"#
    )
}

// ── validate ───────────────────────────────────────────────────────────────

#[test]
fn validate_names_the_account_and_sends_the_key_only_as_documented() {
    let fake = Fake::start(|_, path| {
        assert_eq!(path, "/v1/users/validate.json");
        let mut r = reply(
            200,
            r#"{"user_id":7,"key":"echoed","name":"Bluuuk","is_premium":true,"is_supporter":false,"email":"x"}"#,
        );
        r.headers = vec![("X-RL-Daily-Remaining", "19999".into()), ("X-RL-Hourly-Remaining", "499".into())];
        r
    });
    let c = client(&fake);
    let acct = c.validate().unwrap();
    assert_eq!((acct.name.as_str(), acct.user_id, acct.is_premium), ("Bluuuk", 7, true));
    let limits = c.rate_limits().unwrap();
    assert_eq!((limits.daily_remaining, limits.hourly_remaining), (Some(19999), Some(499)));
    let seen = fake.seen();
    assert_eq!(seen[0].headers.get("apikey").map(String::as_str), Some(KEY));
    assert_eq!(seen[0].headers.get("application-name").map(String::as_str), Some("Event Horizon"));
}

#[test]
fn a_rejected_key_says_so_with_nexuss_message() {
    let fake = Fake::start(|_, _| reply(401, r#"{"message":"Please provide a valid API Key"}"#));
    match client(&fake).validate() {
        Err(NexusError::InvalidKey(m)) => assert!(m.contains("valid API Key"), "{m}"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_redirect_from_the_api_is_not_followed_so_the_key_goes_nowhere_else() {
    let elsewhere = Fake::start(|_, _| reply(200, "{}"));
    let target = format!("{}/steal", elsewhere.base);
    let fake = Fake::start(move |_, _| {
        let mut r = reply(302, "");
        r.headers = vec![("Location", target.clone())];
        r
    });
    assert!(matches!(client(&fake).validate(), Err(NexusError::Unexpected(_))));
    assert!(elsewhere.seen().is_empty(), "the key must not reach another host");
}

#[test]
fn a_rate_limit_is_reported_with_its_reset() {
    let fake = Fake::start(|_, _| {
        let mut r = reply(429, "{}");
        r.headers = vec![("X-RL-Hourly-Remaining", "0".into()), ("X-RL-Hourly-Reset", "2026-10-21T02:00:00Z".into())];
        r
    });
    match client(&fake).validate() {
        Err(NexusError::RateLimited(l)) => {
            assert_eq!(l.hourly_remaining, Some(0));
            assert_eq!(l.hourly_reset.as_deref(), Some("2026-10-21T02:00:00Z"));
        }
        other => panic!("{other:?}"),
    }
}

// ── download ───────────────────────────────────────────────────────────────

#[test]
fn a_free_account_is_told_why_not_shown_a_bare_403() {
    let fake = Fake::start(|_, _| reply(403, r#"{"message":"You don't have permission to get download links from the API without visting nexusmods.com - this is for premium users only."}"#));
    let dir = tempfile::tempdir().unwrap();
    let err = client(&fake).fetch(&file(), &sha(ARCHIVE), &dir.path().join("a.7z"), &task()).unwrap_err();
    assert!(matches!(err, NexusError::NotPremium(_)), "{err:?}");
    assert!(err.to_string().contains("Premium"));
}

#[test]
fn the_preferred_mirror_is_tried_first_and_a_dead_one_falls_through() {
    let fake = Fake::start(|base, path| match path {
        LINKS_PATH => reply(200, links_json(base)),
        p if p.starts_with("/cdn/global/") => reply(503, "busy"),
        p if p.starts_with("/cdn/ams/") => reply(200, ARCHIVE),
        _ => reply(404, ""),
    });
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("downloads").join("a.7z");
    let got = client(&fake).fetch(&file(), &sha(ARCHIVE), &dest, &task()).unwrap();
    assert_eq!(got.via.as_deref(), Some("Amsterdam"));
    assert_eq!(std::fs::read(&dest).unwrap(), ARCHIVE);
    assert!(!dest.with_file_name("a.7z.eh-part").exists());

    let order: Vec<_> = fake.seen().iter().map(|s| s.path.clone()).collect();
    assert!(order[1].starts_with("/cdn/global/"), "Nexus CDN first: {order:?}");
    assert!(order[2].starts_with("/cdn/ams/"), "{order:?}");
    for s in fake.seen().iter().filter(|s| s.path.starts_with("/cdn/")) {
        assert!(!s.headers.contains_key("apikey"), "the key went to a CDN: {}", s.path);
    }
}

#[test]
fn a_truncated_transfer_is_a_failed_mirror_not_a_file() {
    let fake = Fake::start(|base, path| match path {
        LINKS_PATH => reply(200, links_json(base)),
        // Claims more than it sends, then hangs up: reads as a clean EOF.
        p if p.starts_with("/cdn/global/") => {
            let mut r = reply(200, &ARCHIVE[..5]);
            r.claim_len = Some(ARCHIVE.len());
            r
        }
        p if p.starts_with("/cdn/ams/") => reply(200, ARCHIVE),
        _ => reply(404, ""),
    });
    let dir = tempfile::tempdir().unwrap();
    let got = client(&fake).fetch(&file(), &sha(ARCHIVE), &dir.path().join("a.7z"), &task()).unwrap();
    assert_eq!(got.via.as_deref(), Some("Amsterdam"));
}

#[test]
fn different_bytes_fail_hard_and_are_not_retried_elsewhere() {
    let fake = Fake::start(|base, path| match path {
        LINKS_PATH => reply(200, links_json(base)),
        p if p.starts_with("/cdn/") => reply(200, &b"a re-uploaded, different file"[..]),
        _ => reply(404, ""),
    });
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("a.7z");
    let err = client(&fake).fetch(&file(), &sha(ARCHIVE), &dest, &task()).unwrap_err();
    assert!(matches!(err, NexusError::HashMismatch { .. }), "{err:?}");
    assert!(!dest.exists() && !dir.path().join("a.7z.eh-part").exists());
    let cdn_calls = fake.seen().iter().filter(|s| s.path.starts_with("/cdn/")).count();
    assert_eq!(cdn_calls, 1, "a second mirror serves the same wrong file");
}

#[test]
fn a_verified_copy_already_on_disk_costs_no_request() {
    let fake = Fake::start(|_, _| reply(500, ""));
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("renamed-by-the-user.7z");
    std::fs::write(&dest, ARCHIVE).unwrap();
    let got = client(&fake).fetch(&file(), &sha(ARCHIVE), &dest, &task()).unwrap();
    assert_eq!(got.via, None);
    assert!(fake.seen().is_empty());
}

#[test]
fn a_wrong_copy_on_disk_is_replaced_only_by_verified_bytes() {
    let fake = Fake::start(|base, path| match path {
        LINKS_PATH => reply(200, links_json(base)),
        p if p.starts_with("/cdn/") => reply(200, ARCHIVE),
        _ => reply(404, ""),
    });
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("a.7z");
    std::fs::write(&dest, b"stale").unwrap();
    client(&fake).fetch(&file(), &sha(ARCHIVE), &dest, &task()).unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), ARCHIVE);
}

#[test]
fn every_mirror_failing_names_each_failure_without_the_signed_url() {
    let fake = Fake::start(|base, path| match path {
        LINKS_PATH => reply(200, links_json(base)),
        _ => reply(502, ""),
    });
    let dir = tempfile::tempdir().unwrap();
    let err = client(&fake).fetch(&file(), &sha(ARCHIVE), &dir.path().join("a.7z"), &task()).unwrap_err();
    let NexusError::AllMirrorsFailed(tries) = &err else { panic!("{err:?}") };
    assert_eq!(tries.len(), 2);
    let text = err.to_string();
    assert!(text.contains("HTTP 502") && !text.contains("md5=") && !text.contains("expires="), "{text}");
}

#[test]
fn a_malformed_expected_hash_is_refused_before_any_request() {
    let fake = Fake::start(|_, _| reply(500, ""));
    let dir = tempfile::tempdir().unwrap();
    let err = client(&fake).fetch(&file(), "ABC", &dir.path().join("a.7z"), &task()).unwrap_err();
    assert!(matches!(err, NexusError::BadExpectedHash(_)));
    assert!(fake.seen().is_empty());
}

// ── collections ────────────────────────────────────────────────────────────

use eh_nexus::{parse_collection_link, CollectionRevision};

const REVISION_JSON: &str = r#"{"data":{"collectionRevision":{"id":813212,"revisionNumber":15,
  "downloadLink":"/v2/collections/510746/revisions/813212/download_link","adultContent":true,
  "modCount":1777,"totalSize":"74038709982",
  "collection":{"id":510746,"name":"Meridia's Panties - Event Horizon","game":{"domainName":"skyrimspecialedition"}}}}}"#;

const PACKAGE: &[u8] = b"PK pretend package bytes";

fn collection_server() -> Fake {
    Fake::start(|base, path| match path {
        "/v2/graphql" => reply(200, REVISION_JSON),
        "/v2/collections/510746/revisions/813212/download_link" => reply(
            200,
            format!(r#"{{"download_links":[{{"name":"Nexus CDN","short_name":"Nexus CDN","URI":"{base}/cdn/c.zip?sig=1"}}]}}"#),
        ),
        p if p.starts_with("/cdn/") => reply(200, PACKAGE),
        _ => reply(404, ""),
    })
}

fn revision(c: &Client, link: &str) -> Result<CollectionRevision, NexusError> {
    c.collection_revision(&parse_collection_link(link).unwrap())
}

#[test]
fn a_collection_link_resolves_to_its_revision_by_graphql() {
    let fake = collection_server();
    let r = revision(&client(&fake), "https://www.nexusmods.com/games/skyrimspecialedition/collections/ecb76c").unwrap();
    assert_eq!((r.revision_number, r.collection_id, r.revision_id), (15, 510746, 813212));
    assert_eq!(r.mods_total_size, Some(74_038_709_982), "the API sends this as a string");
    assert_eq!(r.game_domain, "skyrimspecialedition");
    let seen = &fake.seen()[0];
    assert_eq!((seen.method.as_str(), seen.path.as_str()), ("POST", "/v2/graphql"));
    assert_eq!(seen.headers.get("apikey").map(String::as_str), Some(KEY));
    let body: serde_json::Value = serde_json::from_str(&seen.body).unwrap();
    assert_eq!(body["variables"]["slug"], "ecb76c");
    assert_eq!(body["variables"]["viewAdultContent"], true);
    assert!(body["variables"].get("revision").is_none(), "no revision asked = the latest");
}

#[test]
fn a_pinned_revision_is_asked_for_by_number() {
    let fake = collection_server();
    revision(&client(&fake), "nxm://skyrimspecialedition/collections/ecb76c/revisions/14").unwrap();
    let body: serde_json::Value = serde_json::from_str(&fake.seen()[0].body).unwrap();
    assert_eq!(body["variables"]["revision"], 14);
}

#[test]
fn an_unknown_collection_is_not_found() {
    let fake = Fake::start(|_, _| {
        reply(200, r#"{"errors":[{"message":"Collection not found","extensions":{"code":"NOT_FOUND"}}],"data":null}"#)
    });
    assert!(matches!(revision(&client(&fake), "zzzzzz9"), Err(NexusError::NotFound(m)) if m.contains("not found")));
}

#[test]
fn a_link_for_one_game_naming_another_games_collection_is_refused() {
    let fake = collection_server();
    let err = revision(&client(&fake), "https://www.nexusmods.com/games/fallout4/collections/ecb76c").unwrap_err();
    assert!(err.to_string().contains("is for skyrimspecialedition"), "{err}");
}

#[test]
fn a_download_link_that_could_leave_the_api_host_is_never_followed() {
    for odd in ["https://evil.example/steal", "//evil.example/steal", "/v2/x\nHost: evil"] {
        let mut r = revision(&client(&collection_server()), "ecb76c").unwrap();
        r.download_link = odd.into();
        let fake = Fake::start(|_, _| reply(200, "[]"));
        let err = client(&fake).collection_download_links(&r).unwrap_err();
        assert!(matches!(err, NexusError::Unexpected(_)), "{odd:?}: {err}");
        assert!(fake.seen().is_empty(), "{odd:?} reached a server");
    }
}

#[test]
fn a_collection_file_is_kept_only_once_the_check_accepts_it_and_then_reused() {
    let fake = collection_server();
    let c = client(&fake);
    let r = revision(&c, "ecb76c").unwrap();
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("packages/r15.ehcoll");
    let checked = std::sync::atomic::AtomicUsize::new(0);
    let check = |p: &std::path::Path| {
        checked.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if std::fs::read(p).unwrap() == PACKAGE { Ok(()) } else { Err("not a package".to_owned()) }
    };
    let got = c.fetch_collection(&r, &dest, &task(), &check).unwrap();
    assert_eq!((got.via.as_deref(), std::fs::read(&dest).unwrap()), (Some("Nexus CDN"), PACKAGE.to_vec()));
    // The download-link GET carries the key; the CDN GET does not.
    let seen = fake.seen();
    assert!(seen.iter().any(|s| s.path.ends_with("/download_link") && s.headers.contains_key("apikey")));
    assert!(seen.iter().filter(|s| s.path.starts_with("/cdn/")).all(|s| !s.headers.contains_key("apikey")));

    let before = fake.seen().len();
    let again = c.fetch_collection(&r, &dest, &task(), &check).unwrap();
    assert_eq!(again.via, None, "a stored revision that still passes is reused");
    assert_eq!(fake.seen().len(), before, "and costs no request");
}

#[test]
fn a_collection_file_the_check_refuses_is_not_kept() {
    let fake = collection_server();
    let c = client(&fake);
    let r = revision(&c, "ecb76c").unwrap();
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("r15.ehcoll");
    let err = c.fetch_collection(&r, &dest, &task(), &|_| Err("has collection.json and no manifest.json".into())).unwrap_err();
    assert!(matches!(&err, NexusError::Rejected { why, .. } if why.contains("no manifest.json")), "{err}");
    assert!(!dest.exists() && !dir.path().join("r15.ehcoll.eh-part").exists());
}

#[test]
fn a_single_download_link_answer_is_read_too() {
    let fake = Fake::start(|base, path| match path {
        "/v2/graphql" => reply(200, REVISION_JSON),
        p if p.ends_with("/download_link") => reply(
            200,
            format!(r#"{{"download_link":{{"name":"Nexus CDN","short_name":"Nexus CDN","URI":"{base}/cdn/c.zip"}}}}"#),
        ),
        _ => reply(404, ""),
    });
    let c = client(&fake);
    let links = c.collection_download_links(&revision(&c, "ecb76c").unwrap()).unwrap();
    assert_eq!(links.len(), 1);
}

#[test]
fn a_refused_collection_download_is_not_blamed_on_premium() {
    // Collections are not Premium-gated; a 403 here means something else
    // (e.g. adult content not enabled on the account), and must say so.
    let fake = Fake::start(|_, path| match path {
        "/v2/graphql" => reply(200, REVISION_JSON),
        _ => reply(403, r#"{"message":"Adult content is not enabled"}"#),
    });
    let c = client(&fake);
    let err = c.collection_download_links(&revision(&c, "ecb76c").unwrap()).unwrap_err();
    assert!(matches!(&err, NexusError::Forbidden(m) if m.contains("Adult")), "{err}");
}

#[test]
fn a_stored_collection_file_that_no_longer_passes_is_downloaded_again() {
    let fake = collection_server();
    let c = client(&fake);
    let r = revision(&c, "ecb76c").unwrap();
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("r15.ehcoll");
    std::fs::write(&dest, b"damaged on disk").unwrap();
    let check = |p: &std::path::Path| if std::fs::read(p).unwrap() == PACKAGE { Ok(()) } else { Err("bad".to_owned()) };
    let got = c.fetch_collection(&r, &dest, &task(), &check).unwrap();
    assert_eq!(got.via.as_deref(), Some("Nexus CDN"));
    assert_eq!(std::fs::read(&dest).unwrap(), PACKAGE);
}
