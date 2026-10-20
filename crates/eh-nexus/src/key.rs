//! Where the Nexus API key comes from, and how it is kept out of output.
//!
//! The same places the release tooling reads (docs/PUBLISHING.md), plus a
//! `.env` for development:
//!
//!  1. `NEXUSMODS_API_KEY` in the environment.
//!  2. `NEXUSMODS_API_KEY=…` in a `.env` file in the working directory or
//!     the nearest ancestor that has one. `.env` is gitignored.
//!  3. The first line of `~/.nexusmods/api-key`.
//!
//! The key is created at <https://www.nexusmods.com/settings/api-keys>.

use std::fmt;
use std::path::{Path, PathBuf};

pub const KEY_VAR: &str = "NEXUSMODS_API_KEY";
pub const KEY_PAGE: &str = "https://www.nexusmods.com/settings/api-keys";

/// A Nexus API key. Never printed: `Debug` redacts it and there is no
/// `Display`, so a stray `{:?}` in a log cannot leak it.
#[derive(Clone, PartialEq, Eq)]
pub struct ApiKey(String);

impl ApiKey {
    /// Wrap a key. Surrounding whitespace is trimmed — a key pasted with a
    /// trailing newline is the common case, not an error.
    pub fn new(raw: impl AsRef<str>) -> Result<Self, KeyError> {
        let k = raw.as_ref().trim();
        if k.is_empty() {
            return Err(KeyError::Empty);
        }
        // Header values cannot carry control characters; a key with one is a
        // paste accident, and saying so beats an opaque HTTP error later.
        if k.chars().any(|c| c.is_control() || c == ' ') {
            return Err(KeyError::Malformed);
        }
        Ok(Self(k.to_owned()))
    }

    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ApiKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ApiKey(<redacted, {} chars>)", self.0.len())
    }
}

/// Where a key was found, for a message that tells the user which one is in
/// use without showing it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeySource {
    Environment,
    DotEnv(PathBuf),
    HomeFile(PathBuf),
}

impl fmt::Display for KeySource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Environment => write!(f, "${KEY_VAR}"),
            Self::DotEnv(p) | Self::HomeFile(p) => write!(f, "{}", p.display()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyError {
    NotFound,
    Empty,
    Malformed,
    /// A source exists but holds no usable key. Named, so the user fixes the
    /// right file instead of wondering why the other one was ignored.
    Unusable { source: String, why: Box<KeyError> },
}

impl fmt::Display for KeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound => write!(
                f,
                "no Nexus API key found. Create one at {KEY_PAGE} (\"Personal API Key\"), then set \
                 {KEY_VAR}, put {KEY_VAR}=<key> in a .env file, or save it as ~/.nexusmods/api-key"
            ),
            Self::Empty => write!(f, "the API key is empty"),
            Self::Malformed => write!(f, "the API key contains spaces or control characters"),
            Self::Unusable { source, why } => write!(f, "{source}: {why}"),
        }
    }
}

impl std::error::Error for KeyError {}

/// Find the key in the documented places, first match wins.
pub fn load_api_key() -> Result<(ApiKey, KeySource), KeyError> {
    let cwd = std::env::current_dir().ok();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    load_from(std::env::var(KEY_VAR).ok(), cwd.as_deref(), home.as_deref())
}

/// [`load_api_key`] with its inputs injected, so it is testable without
/// touching the real environment.
pub fn load_from(
    env_value: Option<String>,
    cwd: Option<&Path>,
    home: Option<&Path>,
) -> Result<(ApiKey, KeySource), KeyError> {
    if let Some(v) = env_value {
        return ApiKey::new(v)
            .map(|k| (k, KeySource::Environment))
            .map_err(|why| KeyError::Unusable { source: format!("${KEY_VAR}"), why: Box::new(why) });
    }
    if let Some(dir) = cwd {
        for d in dir.ancestors() {
            let file = d.join(".env");
            let Ok(text) = std::fs::read_to_string(&file) else { continue };
            // A .env without our variable is someone else's .env: keep looking.
            if let Some(v) = dotenv_value(&text, KEY_VAR) {
                return ApiKey::new(v).map(|k| (k, KeySource::DotEnv(file.clone()))).map_err(|why| {
                    KeyError::Unusable { source: file.display().to_string(), why: Box::new(why) }
                });
            }
        }
    }
    if let Some(home) = home {
        let file = home.join(".nexusmods").join("api-key");
        if let Ok(text) = std::fs::read_to_string(&file) {
            let first = text.lines().next().unwrap_or("");
            return ApiKey::new(first).map(|k| (k, KeySource::HomeFile(file.clone()))).map_err(|why| {
                KeyError::Unusable { source: file.display().to_string(), why: Box::new(why) }
            });
        }
    }
    Err(KeyError::NotFound)
}

/// The value of `name` in a `.env` file: `NAME=value`, optionally `export`ed,
/// optionally quoted. Comments and blank lines are skipped. The LAST
/// assignment wins, as a shell sourcing the file would have it.
fn dotenv_value(text: &str, name: &str) -> Option<String> {
    let mut found = None;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").map(str::trim_start).unwrap_or(line);
        let Some((k, v)) = line.split_once('=') else { continue };
        if k.trim() != name {
            continue;
        }
        let v = v.trim();
        let unquoted = ['"', '\'']
            .iter()
            .find_map(|q| v.strip_prefix(*q).and_then(|s| s.strip_suffix(*q)))
            .unwrap_or(v);
        found = Some(unquoted.to_owned());
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_never_shows_the_key() {
        let k = ApiKey::new("supersecretvalue").unwrap();
        let shown = format!("{k:?}");
        assert!(!shown.contains("supersecret"), "{shown}");
        assert!(shown.contains("16 chars"));
    }

    #[test]
    fn dotenv_forms() {
        let text = "# comment\nOTHER=x\nexport NEXUSMODS_API_KEY = \"abc\"\n";
        assert_eq!(dotenv_value(text, KEY_VAR).as_deref(), Some("abc"));
        assert_eq!(dotenv_value("NEXUSMODS_API_KEY='q'", KEY_VAR).as_deref(), Some("q"));
        assert_eq!(dotenv_value("NEXUSMODS_API_KEY=a\nNEXUSMODS_API_KEY=b", KEY_VAR).as_deref(), Some("b"));
        assert_eq!(dotenv_value("NEXUSMODS_API_KEYX=a", KEY_VAR), None);
    }

    #[test]
    fn environment_beats_dotenv_beats_home_file() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("proj").join("sub");
        std::fs::create_dir_all(&project).unwrap();
        // A .env without our key is skipped, the ancestor's is used.
        std::fs::write(project.join(".env"), "SOMETHING_ELSE=1\n").unwrap();
        std::fs::write(dir.path().join("proj").join(".env"), "NEXUSMODS_API_KEY=from-dotenv\n").unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(home.join(".nexusmods")).unwrap();
        std::fs::write(home.join(".nexusmods").join("api-key"), "from-home\nignored\n").unwrap();

        let (k, src) = load_from(Some("from-env".into()), Some(&project), Some(&home)).unwrap();
        assert_eq!((k.expose(), src), ("from-env", KeySource::Environment));

        let (k, src) = load_from(None, Some(&project), Some(&home)).unwrap();
        assert_eq!(k.expose(), "from-dotenv");
        assert!(matches!(src, KeySource::DotEnv(_)));

        let (k, src) = load_from(None, None, Some(&home)).unwrap();
        assert_eq!(k.expose(), "from-home");
        assert!(matches!(src, KeySource::HomeFile(_)));

        assert_eq!(load_from(None, None, None).unwrap_err(), KeyError::NotFound);
    }

    #[test]
    fn an_empty_key_names_where_it_came_from() {
        let err = load_from(Some("   ".into()), None, None).unwrap_err();
        assert!(err.to_string().contains(KEY_VAR), "{err}");
    }
}
