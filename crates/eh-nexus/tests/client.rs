//! The client against a local fake of the Nexus API and its CDNs.
//!
//! Every behaviour here is one a real install depends on and the real API
//! would make expensive or impossible to provoke on demand: a mirror that
//! dies mid-transfer, a file whose bytes changed, a redirect that would carry
//! the key somewhere else.

use eh_nexus::{ApiKey, Client, NexusError, NexusFile};
use eh_progress::{Progress, Unit};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

const KEY: &str = "test-key-not-real";

#[derive(Clone, Debug)]
struct Seen {
    path: String,
    headers: HashMap<String, String>,
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
                log.lock().unwrap().push(Seen { path: path.clone(), headers });
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
