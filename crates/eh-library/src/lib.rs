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
//!   archives/<sha256>              downloads, shared by EVERY instance
//!   instances/<id>/
//!     instance.json                what this instance is
//!     package/                     the collection package it installs
//!     staging/<mod>/               one folder per mod (unless staging_dir says otherwise)
//!     work/                        scratch, e.g. unpacked archives
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

    /// Record which collection this instance installs.
    pub fn set_package(&mut self, package: PackageRef) -> Result<(), LibraryError> {
        let mut next = self.config.clone();
        next.package = Some(package);
        write_config(&self.dir, &next)?;
        self.config = next;
        Ok(())
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
        fs::create_dir_all(root.join("archives")).map_err(|e| LibraryError::io(&root, e))?;
        fs::create_dir_all(root.join("instances")).map_err(|e| LibraryError::io(&root, e))?;
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
        Ok(self.root.join("archives").join(sha256))
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
    IdTaken(InstanceId),
    NoSuchInstance(InstanceId),
    NoGameDir(PathBuf),
    GameDirTaken { game_dir: PathBuf, by: InstanceId },
    UnknownFormat(PathBuf, Option<u64>),
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
        }
    }
}

impl std::error::Error for LibraryError {}
