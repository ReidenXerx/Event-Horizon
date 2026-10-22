//! Where Event Horizon keeps things on disk, and how modpacks are kept apart.
//!
//! ─── AN INSTANCE IS ONE MODPACK ON ONE GAME INSTALLATION ────────────────
//! Fallout 4 with one collection and Skyrim with another are two instances;
//! so are two Fallout 4 collections on two Fallout 4 installs. Each instance
//! has its own staging, package and scratch space, so nothing one does can
//! touch another's files.
//!
//! ```text
//! <root>/                          $EH_HOME, else $XDG_DATA_HOME/event-horizon,
//!                                  else ~/.local/share/event-horizon
//!   downloads/<sha256>             downloaded mod archives, shared by EVERY instance
//!   packages/<game>/<slug>/r<n>.ehcoll   collection files, one per revision
//!   instances/<id>/
//!     instance.json                what this instance is
//!     package/                     the collection package it installs
//!     staging/<mod>/               one folder per mod (unless staging_dir says otherwise)
//!     receipts/<mod>               what each staged folder was built from
//!     work/                        scratch, e.g. unpacked archives
//!     .lock                        held while an install runs
//! ```
//!
//! ─── DOWNLOADS ARE STORED BY HASH ───────────────────────────────────────
//! A mod's identity is its archive's SHA-256, so that is its file name. The
//! same archive needed by two collections — or by two games — is downloaded
//! and stored once, and a file can never be mistaken for another one that
//! merely shares its name.
//!
//! ─── TWO INSTANCES NEVER SHARE A GAME FOLDER ────────────────────────────
//! Both would deploy into the same `Data/` and each would overwrite, or on
//! purge delete, the other's files — removing mods this instance did not
//! install (NS-2). Refused when the instance is created, not discovered at
//! deploy.
//!
//! ─── STAGING AND THE GAME SHOULD SHARE A DISK ───────────────────────────
//! Hardlink deployment only works within one filesystem. A game on another
//! drive needs `staging_dir` there; deployment will check it.

#![forbid(unsafe_code)]

use ehcoll::SupportedGameId;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The `instance.json` format. A file with any other number is refused:
/// a misread instance points staging and deployment at the wrong places.
pub const INSTANCE_FORMAT: u32 = 1;

/// A name for an instance: lowercase letters, digits and `-`, starting with
/// a letter or digit, at most 64 characters. Safe as a folder name on every
/// platform, and stable to type.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct InstanceId(String);

impl InstanceId {
    pub fn new(raw: &str) -> Result<Self, LibraryError> {
        let ok = !raw.is_empty()
            && raw.len() <= 64
            && raw.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            && !raw.starts_with('-');
        if ok {
            Ok(Self(raw.to_owned()))
        } else {
            Err(LibraryError::BadId(raw.to_owned()))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for InstanceId {
    type Error = LibraryError;
    fn try_from(s: String) -> Result<Self, Self::Error> {
        Self::new(&s)
    }
}

impl From<InstanceId> for String {
    fn from(id: InstanceId) -> Self {
        id.0
    }
}

impl fmt::Display for InstanceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Which collection an instance installs, once one is chosen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageRef {
    /// `package.id` from the manifest — stable across the collection's releases.
    pub id: String,
    pub name: String,
    pub version: String,
    /// The package file last installed, so a run can continue without being
    /// handed it again. Absent before the first install.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<PathBuf>,
    /// That file's SHA-256 — also the name of its unpacked folder under
    /// `package/`, where the manifest is read from without reopening the zip.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

impl PackageRef {
    /// Just the identity, before anything is installed.
    pub fn named(id: impl Into<String>, name: impl Into<String>, version: impl Into<String>) -> Self {
        Self { id: id.into(), name: name.into(), version: version.into(), file: None, sha256: None }
    }
}

/// What `instance.json` holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceConfig {
    pub format: u32,
    pub id: InstanceId,
    pub game: SupportedGameId,
    /// The game's installation folder — the one holding `Data/`.
    pub game_dir: PathBuf,
    /// Where mod staging lives, when not inside the instance. Set it to a
    /// folder on the game's disk when the game is on another drive.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staging_dir: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package: Option<PackageRef>,
}

impl InstanceConfig {
    pub fn new(id: InstanceId, game: SupportedGameId, game_dir: PathBuf) -> Self {
        Self { format: INSTANCE_FORMAT, id, game, game_dir, staging_dir: None, package: None }
    }
}

/// One instance on disk.
#[derive(Debug, Clone)]
pub struct Instance {
    dir: PathBuf,
    config: InstanceConfig,
}

impl Instance {
    pub fn id(&self) -> &InstanceId {
        &self.config.id
    }

    pub fn config(&self) -> &InstanceConfig {
        &self.config
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Where this instance keeps the collection package it installs.
    pub fn package_dir(&self) -> PathBuf {
        self.dir.join("package")
    }

    /// Scratch space. Anything here may be deleted between runs.
    pub fn work_dir(&self) -> PathBuf {
        self.dir.join("work")
    }

    pub fn staging_root(&self) -> PathBuf {
        self.config.staging_dir.clone().unwrap_or_else(|| self.dir.join("staging"))
    }

    /// The staging folder of the mod a manifest knows by `compare_key`.
    pub fn staging_dir_for(&self, compare_key: &str) -> PathBuf {
        self.staging_root().join(mod_dir_name(compare_key))
    }

    /// Where the receipt for a mod's staging folder lives. Beside staging, not
    /// in it: anything inside a mod's staging folder gets deployed.
    fn receipt_path(&self, compare_key: &str) -> PathBuf {
        self.dir.join("receipts").join(mod_dir_name(compare_key))
    }

    /// The fingerprint a mod's staging folder was built from, if it was.
    pub fn staged_fingerprint(&self, compare_key: &str) -> Option<String> {
        fs::read_to_string(self.receipt_path(compare_key)).ok().map(|s| s.trim().to_owned())
    }

    /// Record that a mod's staging folder now holds what `fingerprint` names.
    pub fn record_staged(&self, compare_key: &str, fingerprint: &str) -> Result<(), LibraryError> {
        let file = self.receipt_path(compare_key);
        let dir = file.parent().expect("receipts/<name> has a parent");
        fs::create_dir_all(dir).map_err(|e| LibraryError::io(dir, e))?;
        let tmp = file.with_extension("eh-part");
        fs::write(&tmp, format!("{fingerprint}\n")).map_err(|e| LibraryError::io(&tmp, e))?;
        fs::rename(&tmp, &file).map_err(|e| LibraryError::io(&file, e))
    }

    /// Forget a mod's receipt — before its staging folder is rebuilt, so a
    /// crash mid-rebuild never leaves a receipt naming a half-built folder.
    pub fn forget_staged(&self, compare_key: &str) -> Result<(), LibraryError> {
        let file = self.receipt_path(compare_key);
        match fs::remove_file(&file) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(LibraryError::io(&file, e)),
        }
    }

    fn supplied_path(&self, compare_key: &str) -> PathBuf {
        self.dir.join("supplied").join(mod_dir_name(compare_key))
    }

    /// The SHA-256 of an archive the user supplied for a mod when it is NOT
    /// the archive the collection names, but provably holds every file the
    /// curator staged. An archive that matches needs no entry: its name is
    /// its hash.
    pub fn supplied_sha(&self, compare_key: &str) -> Option<String> {
        fs::read_to_string(self.supplied_path(compare_key)).ok().map(|s| s.trim().to_owned())
    }

    pub fn record_supplied(&self, compare_key: &str, sha256: &str) -> Result<(), LibraryError> {
        let file = self.supplied_path(compare_key);
        let dir = file.parent().expect("supplied/<name> has a parent");
        fs::create_dir_all(dir).map_err(|e| LibraryError::io(dir, e))?;
        let tmp = file.with_extension("eh-part");
        fs::write(&tmp, format!("{sha256}\n")).map_err(|e| LibraryError::io(&tmp, e))?;
        fs::rename(&tmp, &file).map_err(|e| LibraryError::io(&file, e))
    }

    /// Hold this instance for one run. A lock left by a process that is gone
    /// — a crash, a power cut — is taken over; one held by a live process is
    /// refused, because two runs staging one instance lose files.
    pub fn lock(&self) -> Result<InstanceLock, LibraryError> {
        let file = self.dir.join(".lock");
        for _ in 0..2 {
            match fs::OpenOptions::new().write(true).create_new(true).open(&file) {
                Ok(mut f) => {
                    use std::io::Write;
                    let _ = write!(f, "{}", std::process::id());
                    return Ok(InstanceLock { file });
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                    let holder = fs::read_to_string(&file).ok().and_then(|s| s.trim().parse::<u32>().ok());
                    match holder {
                        Some(pid) if pid != std::process::id() && process_alive(pid) => {
                            return Err(LibraryError::Locked { instance: self.config.id.clone(), pid })
                        }
                        // Ours, gone, or unreadable: stale.
                        _ => {
                            let _ = fs::remove_file(&file);
                        }
                    }
                }
                Err(e) => return Err(LibraryError::io(&file, e)),
            }
        }
        Err(LibraryError::io(&file, io::Error::other("could not take the lock")))
    }

    /// Record which collection this instance installs.
    pub fn set_package(&mut self, package: PackageRef) -> Result<(), LibraryError> {
        let mut next = self.config.clone();
        next.package = Some(package);
        write_config(&self.dir, &next)?;
        self.config = next;
        Ok(())
    }
}

/// Held while a run uses an instance; released when dropped.
#[derive(Debug)]
pub struct InstanceLock {
    file: PathBuf,
}

impl Drop for InstanceLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.file);
    }
}

/// Whether a process id is running. Linux answers through `/proc`; elsewhere
/// a lock is assumed live, which errs toward refusing rather than racing.
fn process_alive(pid: u32) -> bool {
    if cfg!(target_os = "linux") {
        Path::new("/proc").join(pid.to_string()).exists()
    } else {
        true
    }
}

/// The folder name for a mod's staging: readable, and unique per key.
///
/// compareKeys contain `:` (`nexus:111:222`), which Windows forbids, so
/// unsafe characters become `_` — and since that can make two keys look
/// alike, a short hash of the EXACT key is appended.
pub fn mod_dir_name(compare_key: &str) -> String {
    let readable: String = compare_key
        .chars()
        .take(48)
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '.' { c } else { '_' })
        .collect();
    let readable = readable.trim_matches('.');
    let (hash, _) = eh_identity::sha256_reader(compare_key.as_bytes(), None)
        .expect("hashing an in-memory slice cannot fail");
    format!("{readable}-{}", &hash[..12])
}

/// The root of everything Event Horizon keeps.
#[derive(Debug, Clone)]
pub struct Library {
    root: PathBuf,
}

impl Library {
    /// `$EH_HOME`, else `$XDG_DATA_HOME/event-horizon`, else
    /// `~/.local/share/event-horizon`.
    pub fn default_root() -> Result<PathBuf, LibraryError> {
        let var = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
        if let Some(p) = var("EH_HOME") {
            return Ok(p);
        }
        if let Some(p) = var("XDG_DATA_HOME") {
            return Ok(p.join("event-horizon"));
        }
        var("HOME")
            .map(|h| h.join(".local").join("share").join("event-horizon"))
            .ok_or(LibraryError::NoHome)
    }

    /// Open (creating if needed) the library at `root`.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, LibraryError> {
        let root = root.into();
        fs::create_dir_all(root.join("downloads")).map_err(|e| LibraryError::io(&root, e))?;
        fs::create_dir_all(root.join("instances")).map_err(|e| LibraryError::io(&root, e))?;
        fs::create_dir_all(root.join("packages")).map_err(|e| LibraryError::io(&root, e))?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Where the archive with this SHA-256 lives, whichever instance wants it.
    pub fn archive_path(&self, sha256: &str) -> Result<PathBuf, LibraryError> {
        if !eh_identity::is_sha256_hex(sha256) {
            return Err(LibraryError::BadHash(sha256.to_owned()));
        }
        Ok(self.root.join("downloads").join(sha256))
    }

    /// Where a collection revision's file lives. A published revision never
    /// changes, so `(game, slug, revision)` names it exactly; a later revision
    /// is a different file beside it. Both names come from a link and from the
    /// API, so they are held to [a-z0-9] before they become a path.
    pub fn package_path(&self, game_domain: &str, slug: &str, revision: u32) -> Result<PathBuf, LibraryError> {
        let plain = |s: &str| {
            !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        };
        let (game, slug) = (game_domain.to_ascii_lowercase(), slug.to_ascii_lowercase());
        if !plain(&game) || !plain(&slug) || revision == 0 {
            return Err(LibraryError::BadPackageName(format!("{game_domain}/{slug} revision {revision}")));
        }
        Ok(self.root.join("packages").join(game).join(slug).join(format!("r{revision}.ehcoll")))
    }

    /// Every instance, sorted by id. A damaged `instance.json` is an error,
    /// not a silent omission: an instance that vanishes from the list is one
    /// whose game folder stops being protected by the overlap check.
    pub fn instances(&self) -> Result<Vec<Instance>, LibraryError> {
        let dir = self.root.join("instances");
        let mut out = Vec::new();
        for entry in fs::read_dir(&dir).map_err(|e| LibraryError::io(&dir, e))? {
            let entry = entry.map_err(|e| LibraryError::io(&dir, e))?;
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                out.push(read_instance(&entry.path())?);
            }
        }
        out.sort_by(|a, b| a.id().cmp(b.id()));
        Ok(out)
    }

    pub fn instance(&self, id: &InstanceId) -> Result<Instance, LibraryError> {
        let dir = self.root.join("instances").join(id.as_str());
        if !dir.is_dir() {
            return Err(LibraryError::NoSuchInstance(id.clone()));
        }
        read_instance(&dir)
    }

    /// Create an instance. Refuses an id already taken, a game folder that
    /// does not exist, and a game folder another instance already uses.
    pub fn create_instance(&self, mut config: InstanceConfig) -> Result<Instance, LibraryError> {
        config.format = INSTANCE_FORMAT;
        let game_dir = fs::canonicalize(&config.game_dir)
            .ok()
            .filter(|p| p.is_dir())
            .ok_or_else(|| LibraryError::NoGameDir(config.game_dir.clone()))?;
        for other in self.instances()? {
            if same_dir(&other.config.game_dir, &game_dir) {
                return Err(LibraryError::GameDirTaken { game_dir, by: other.config.id.clone() });
            }
        }
        config.game_dir = game_dir;

        let dir = self.root.join("instances").join(config.id.as_str());
        // create_dir, not create_dir_all: it fails if the folder exists, which
        // is the id check — and it cannot race another create of the same id.
        match fs::create_dir(&dir) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                return Err(LibraryError::IdTaken(config.id.clone()))
            }
            Err(e) => return Err(LibraryError::io(&dir, e)),
        }
        if let Err(e) = write_config(&dir, &config) {
            let _ = fs::remove_dir_all(&dir);
            return Err(e);
        }
        Ok(Instance { dir, config })
    }
}

fn same_dir(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        // A recorded folder that no longer resolves is compared as written.
        _ => a == b,
    }
}

fn read_instance(dir: &Path) -> Result<Instance, LibraryError> {
    let file = dir.join("instance.json");
    let raw = fs::read_to_string(&file).map_err(|e| LibraryError::io(&file, e))?;
    let value: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| LibraryError::Corrupt(file.clone(), e.to_string()))?;
    // The format is checked before anything else is interpreted.
    match value.get("format").and_then(serde_json::Value::as_u64) {
        Some(f) if f == u64::from(INSTANCE_FORMAT) => {}
        other => return Err(LibraryError::UnknownFormat(file, other)),
    }
    let config: InstanceConfig =
        serde_json::from_value(value).map_err(|e| LibraryError::Corrupt(file.clone(), e.to_string()))?;
    let folder = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if folder != config.id.as_str() {
        return Err(LibraryError::Corrupt(file, format!("id {:?} does not match its folder {folder:?}", config.id.as_str())));
    }
    Ok(Instance { dir: dir.to_path_buf(), config })
}

/// Write `instance.json` whole or not at all.
fn write_config(dir: &Path, config: &InstanceConfig) -> Result<(), LibraryError> {
    let file = dir.join("instance.json");
    let tmp = dir.join("instance.json.eh-part");
    let json = serde_json::to_string_pretty(config).expect("instance config serialises") + "\n";
    fs::write(&tmp, json).map_err(|e| LibraryError::io(&tmp, e))?;
    fs::rename(&tmp, &file).map_err(|e| LibraryError::io(&file, e))
}

#[derive(Debug)]
pub enum LibraryError {
    Io(PathBuf, io::Error),
    NoHome,
    BadId(String),
    BadHash(String),
    BadPackageName(String),
    IdTaken(InstanceId),
    NoSuchInstance(InstanceId),
    NoGameDir(PathBuf),
    GameDirTaken { game_dir: PathBuf, by: InstanceId },
    UnknownFormat(PathBuf, Option<u64>),
    /// Another live process holds the instance.
    Locked { instance: InstanceId, pid: u32 },
    Corrupt(PathBuf, String),
}

impl LibraryError {
    fn io(path: &Path, e: io::Error) -> Self {
        Self::Io(path.to_path_buf(), e)
    }
}

impl fmt::Display for LibraryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(p, e) => write!(f, "{}: {e}", p.display()),
            Self::NoHome => write!(f, "cannot tell where to keep data: set EH_HOME or HOME"),
            Self::BadId(s) => write!(
                f,
                "{s:?} is not a usable instance name: use lowercase letters, digits and '-', \
                 up to 64 characters, not starting with '-'"
            ),
            Self::BadHash(s) => write!(f, "{s:?} is not a lowercase 64-character SHA-256"),
            Self::BadPackageName(s) => write!(f, "{s:?} cannot name a stored collection file"),
            Self::IdTaken(id) => write!(f, "an instance named {id} already exists"),
            Self::NoSuchInstance(id) => write!(f, "there is no instance named {id}"),
            Self::NoGameDir(p) => write!(f, "{} is not a folder", p.display()),
            Self::GameDirTaken { game_dir, by } => write!(
                f,
                "{} is already the game folder of instance {by}. Two modpacks deploying into one \
                 game would overwrite each other's files.",
                game_dir.display()
            ),
            Self::UnknownFormat(p, v) => write!(
                f,
                "{}: instance format {v:?} is not one this version reads (expects {INSTANCE_FORMAT})",
                p.display()
            ),
            Self::Corrupt(p, why) => write!(f, "{}: {why}", p.display()),
            Self::Locked { instance, pid } => write!(
                f,
                "instance {instance} is in use by another Event Horizon run (process {pid}); wait for it to finish"
            ),
        }
    }
}

impl std::error::Error for LibraryError {}
