//! The Nexus Mods REST API, and downloading what it points at.

use crate::key::ApiKey;
use eh_identity::{is_sha256_hex, sha256_file, HashingWriter};
use eh_progress::Task;
use serde::Deserialize;
use std::fmt;
use std::fs::{self, File};
use std::io::{self, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use ureq::http::Response;
use ureq::Body;

pub const API_BASE: &str = "https://api.nexusmods.com";

/// Nexus asks applications to name themselves on every request.
const APP_NAME: &str = "Event Horizon";
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// The CDN tried first. It is the only mirror every account is offered, and
/// the regional ones are tried after it in the order the API listed them.
const PREFERRED_CDN: &str = "Nexus CDN";

/// One file on Nexus — the identity of a Nexus-sourced mod.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NexusFile {
    pub game_domain: String,
    pub mod_id: u64,
    pub file_id: u64,
}

impl fmt::Display for NexusFile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/mods/{}/files/{}", self.game_domain, self.mod_id, self.file_id)
    }
}

/// Who the key belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Account {
    pub user_id: u64,
    pub name: String,
    pub is_premium: bool,
    pub is_supporter: bool,
}

/// One download mirror the API offered.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct CdnLink {
    pub name: String,
    pub short_name: String,
    #[serde(rename = "URI")]
    pub uri: String,
}

/// The rate-limit headers from the last API response, when Nexus sent them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RateLimits {
    pub daily_remaining: Option<u64>,
    pub hourly_remaining: Option<u64>,
    pub daily_reset: Option<String>,
    pub hourly_reset: Option<String>,
}

/// A file that is on disk and is the bytes the manifest named.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fetched {
    pub path: PathBuf,
    pub sha256: String,
    pub bytes: u64,
    /// The mirror it came from, or `None` when a verified copy was already
    /// at `path` and nothing was downloaded.
    pub via: Option<String>,
}

#[derive(Debug)]
pub enum NexusError {
    /// 401: the key is wrong, revoked, or not a key.
    InvalidKey(String),
    /// 403 on a download link: Nexus gives direct links to Premium only.
    NotPremium(String),
    /// 403 elsewhere.
    Forbidden(String),
    /// 404: wrong ids, or the file was removed from Nexus.
    NotFound(String),
    /// 429. Carries the limits Nexus reported, so the message can say when.
    RateLimited(RateLimits),
    Http { status: u16, message: String },
    /// The API answered with something that is not what it documents.
    Unexpected(String),
    Transport(String),
    Io(io::Error),
    /// The expected hash was not a hash. A caller bug, caught before any I/O.
    BadExpectedHash(String),
    /// Every mirror failed to deliver the file.
    AllMirrorsFailed(Vec<(String, String)>),
    /// A complete download whose bytes are not the ones the manifest names.
    /// NOT retried on another mirror: the file Nexus serves is different,
    /// and a second copy of it would be just as wrong.
    HashMismatch { file: String, expected: String, got: String },
}

impl fmt::Display for NexusError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidKey(m) => write!(f, "Nexus rejected the API key: {m}"),
            Self::NotPremium(m) => write!(
                f,
                "Nexus gives mod managers direct download links for Premium accounts only: {m}"
            ),
            Self::Forbidden(m) => write!(f, "Nexus refused the request: {m}"),
            Self::NotFound(m) => write!(f, "not on Nexus (wrong ids, or the file was removed): {m}"),
            Self::RateLimited(l) => write!(
                f,
                "Nexus rate limit reached (daily remaining {:?}, resets {}; hourly remaining {:?}, resets {})",
                l.daily_remaining,
                l.daily_reset.as_deref().unwrap_or("?"),
                l.hourly_remaining,
                l.hourly_reset.as_deref().unwrap_or("?"),
            ),
            Self::Http { status, message } => write!(f, "Nexus answered HTTP {status}: {message}"),
            Self::Unexpected(m) => write!(f, "unexpected answer from Nexus: {m}"),
            Self::Transport(m) => write!(f, "could not reach Nexus: {m}"),
            Self::Io(e) => write!(f, "{e}"),
            Self::BadExpectedHash(h) => write!(f, "{h:?} is not a lowercase 64-character SHA-256"),
            Self::AllMirrorsFailed(tries) => {
                write!(f, "every download mirror failed:")?;
                for (cdn, why) in tries {
                    write!(f, "\n  - {cdn}: {why}")?;
                }
                Ok(())
            }
            Self::HashMismatch { file, expected, got } => write!(
                f,
                "{file}: Nexus served different bytes than the collection names \
                 (expected sha256 {expected}, got {got}). This is not the file the curator installed."
            ),
        }
    }
}

impl std::error::Error for NexusError {}

impl From<io::Error> for NexusError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

/// A Nexus API client. Blocking, and meant to be used one request at a time:
/// installs are sequential by design.
pub struct Client {
    /// Talks to the API. Carries the key, and follows NO redirects, so the
    /// key cannot be forwarded to a host it was not meant for.
    api: ureq::Agent,
    /// Talks to CDNs. Never carries the key.
    cdn: ureq::Agent,
    base: String,
    key: ApiKey,
    limits: Mutex<Option<RateLimits>>,
}

impl Client {
    pub fn new(key: ApiKey) -> Self {
        Self::with_base(key, API_BASE)
    }

    /// Point at a different API host. For tests.
    pub fn with_base(key: ApiKey, base: impl Into<String>) -> Self {
        Self {
            api: agent(0),
            cdn: agent(5),
            base: base.into().trim_end_matches('/').to_owned(),
            key,
            limits: Mutex::new(None),
        }
    }

    /// The rate limits Nexus reported on the most recent API call.
    pub fn rate_limits(&self) -> Option<RateLimits> {
        self.limits.lock().ok()?.clone()
    }

    /// Check the key and say whose it is. Call once before a long run: a bad
    /// or free key is better refused before mod 1 than discovered at mod 900.
    pub fn validate(&self) -> Result<Account, NexusError> {
        let body = self.api_get("/v1/users/validate.json", false)?;
        serde_json::from_str(&body).map_err(|e| NexusError::Unexpected(format!("validate: {e}")))
    }

    /// The download mirrors for one file. Premium keys only.
    pub fn download_links(&self, file: &NexusFile) -> Result<Vec<CdnLink>, NexusError> {
        let path = format!(
            "/v1/games/{}/mods/{}/files/{}/download_link.json",
            file.game_domain, file.mod_id, file.file_id
        );
        let body = self.api_get(&path, true)?;
        let links: Vec<CdnLink> =
            serde_json::from_str(&body).map_err(|e| NexusError::Unexpected(format!("download_link: {e}")))?;
        if links.is_empty() {
            return Err(NexusError::Unexpected(format!("{file}: no download mirrors offered")));
        }
        Ok(links)
    }

    /// Make `dest` hold exactly the bytes `expected_sha256` names, downloading
    /// them from Nexus if it does not already.
    ///
    /// Identity is the hash and nothing else: a file already at `dest` is
    /// reused only if its bytes match, whatever it is called. A download is
    /// written beside `dest` and renamed into place only once verified, so
    /// `dest` never holds unverified bytes.
    pub fn fetch(
        &self,
        file: &NexusFile,
        expected_sha256: &str,
        dest: &Path,
        task: &Task,
    ) -> Result<Fetched, NexusError> {
        if !is_sha256_hex(expected_sha256) {
            return Err(NexusError::BadExpectedHash(expected_sha256.to_owned()));
        }
        if dest.is_file() {
            task.message("checking the copy already on disk");
            let (sha, bytes) = sha256_file(dest, None)?;
            if sha == expected_sha256 {
                return Ok(Fetched { path: dest.to_path_buf(), sha256: sha, bytes, via: None });
            }
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }

        let mut links = self.download_links(file)?;
        // Stable: the preferred CDN first, the rest in the API's own order.
        links.sort_by_key(|l| l.short_name != PREFERRED_CDN);

        let part = part_path(dest);
        let mut failures = Vec::new();
        for link in &links {
            task.message(format!("downloading via {}", link.short_name));
            match self.download_to(&link.uri, &part, task) {
                Ok((sha, bytes)) => {
                    if sha != expected_sha256 {
                        let _ = fs::remove_file(&part);
                        return Err(NexusError::HashMismatch {
                            file: file.to_string(),
                            expected: expected_sha256.to_owned(),
                            got: sha,
                        });
                    }
                    fs::rename(&part, dest)?;
                    return Ok(Fetched {
                        path: dest.to_path_buf(),
                        sha256: sha,
                        bytes,
                        via: Some(link.short_name.clone()),
                    });
                }
                Err(why) => {
                    let _ = fs::remove_file(&part);
                    failures.push((link.short_name.clone(), why));
                }
            }
        }
        Err(NexusError::AllMirrorsFailed(failures))
    }

    /// GET an API path with the key. `is_download_link` decides what a 403
    /// means: on a download link it is Nexus's Premium-only rule.
    fn api_get(&self, path: &str, is_download_link: bool) -> Result<String, NexusError> {
        let url = format!("{}{}", self.base, path);
        let resp = self
            .api
            .get(&url)
            .header("apikey", self.key.expose())
            .header("Application-Name", APP_NAME)
            .header("Application-Version", APP_VERSION)
            .header("Accept", "application/json")
            .call()
            .map_err(|e| NexusError::Transport(e.to_string()))?;
        let limits = rate_limits_of(&resp);
        if let Ok(mut slot) = self.limits.lock() {
            *slot = Some(limits.clone());
        }
        let status = resp.status().as_u16();
        let body = resp
            .into_body()
            .read_to_string()
            .map_err(|e| NexusError::Transport(e.to_string()))?;
        match status {
            200..=299 => Ok(body),
            401 => Err(NexusError::InvalidKey(message_of(&body))),
            403 if is_download_link => Err(NexusError::NotPremium(message_of(&body))),
            403 => Err(NexusError::Forbidden(message_of(&body))),
            404 => Err(NexusError::NotFound(message_of(&body))),
            429 => Err(NexusError::RateLimited(limits)),
            300..=399 => Err(NexusError::Unexpected(format!(
                "HTTP {status} redirect from the API; not followed, so the key stays with Nexus"
            ))),
            _ => Err(NexusError::Http { status, message: message_of(&body) }),
        }
    }

    /// Stream one CDN URL into `part`, hashing as it goes. The error is a
    /// human-readable reason, collected per mirror. CDN URLs are signed and
    /// personal, so reasons name the host, never the URL.
    fn download_to(&self, uri: &str, part: &Path, task: &Task) -> Result<(String, u64), String> {
        let host = host_of(uri);
        let resp = self.cdn.get(uri).call().map_err(|e| format!("{host}: {e}"))?;
        let status = resp.status().as_u16();
        if !(200..=299).contains(&status) {
            return Err(format!("{host}: HTTP {status}"));
        }
        let expected_len = resp
            .headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok());
        if let Some(n) = expected_len {
            task.set_total(n);
        }
        let mut reader = resp.into_body().into_reader();
        let file = File::create(part).map_err(|e| format!("{}: {e}", part.display()))?;
        let mut writer = HashingWriter::new(BufWriter::new(file));
        let mut buf = vec![0u8; 1 << 16];
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(format!("{host}: transfer interrupted: {e}")),
            };
            writer.write_all(&buf[..n]).map_err(|e| format!("{}: {e}", part.display()))?;
            task.advance(n as u64);
        }
        let (inner, sha, bytes) = writer.finish().map_err(|e| format!("{}: {e}", part.display()))?;
        let file = inner.into_inner().map_err(|e| format!("{}: {}", part.display(), e.error()))?;
        file.sync_all().map_err(|e| format!("{}: {e}", part.display()))?;
        // A backstop: ureq already fails a body that ends short of its
        // Content-Length (the truncation test passes without this line). It
        // stays because a whole file and a truncated one differ ONLY here,
        // and the hash check after it would misreport truncation as "Nexus
        // served different bytes" — a hard failure instead of a retry.
        if let Some(n) = expected_len {
            if bytes != n {
                return Err(format!("{host}: truncated ({bytes} of {n} bytes)"));
            }
        }
        Ok((sha, bytes))
    }
}

fn agent(max_redirects: u32) -> ureq::Agent {
    use ureq::tls::{RootCerts, TlsConfig, TlsProvider};
    let tls = TlsConfig::builder()
        .provider(TlsProvider::Rustls)
        .root_certs(RootCerts::PlatformVerifier)
        .unversioned_rustls_crypto_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .build();
    ureq::Agent::config_builder()
        .tls_config(tls)
        .http_status_as_error(false)
        .max_redirects(max_redirects)
        .user_agent(format!("EventHorizon/{APP_VERSION}"))
        .timeout_connect(Some(Duration::from_secs(30)))
        .timeout_recv_response(Some(Duration::from_secs(60)))
        .build()
        .new_agent()
}

fn part_path(dest: &Path) -> PathBuf {
    let name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    dest.with_file_name(format!("{name}.eh-part"))
}

fn host_of(uri: &str) -> String {
    let rest = uri.split_once("://").map(|(_, r)| r).unwrap_or(uri);
    rest.split(['/', '?']).next().unwrap_or("").to_owned()
}

/// Nexus errors are `{"code": 403, "message": "..."}`. Anything else is
/// shown raw, shortened.
fn message_of(body: &str) -> String {
    #[derive(Deserialize)]
    struct ApiMessage {
        message: String,
    }
    match serde_json::from_str::<ApiMessage>(body) {
        Ok(m) => m.message,
        Err(_) => body.chars().take(200).collect(),
    }
}

fn rate_limits_of(resp: &Response<Body>) -> RateLimits {
    let h = |name: &str| resp.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
    RateLimits {
        daily_remaining: h("x-rl-daily-remaining").and_then(|v| v.parse().ok()),
        hourly_remaining: h("x-rl-hourly-remaining").and_then(|v| v.parse().ok()),
        daily_reset: h("x-rl-daily-reset"),
        hourly_reset: h("x-rl-hourly-reset"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_are_named_without_their_signed_query() {
        assert_eq!(host_of("https://cf-files.nexus-cdn.com/a/b.7z?md5=x&expires=1"), "cf-files.nexus-cdn.com");
        assert_eq!(host_of("http://127.0.0.1:9/x"), "127.0.0.1:9");
    }
}
