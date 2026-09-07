//! Turning an archive's idea of a path into one we are willing to write.
//!
//! ─── A MOD ARCHIVE IS UNTRUSTED INPUT ───────────────────────────────────
//! It came from a forum post, a Google Drive link, or a Nexus upload nobody
//! reviewed. An entry named `../../../.bashrc` is a request to write outside
//! the destination, and an extractor that honours it is a remote code
//! execution bug with a progress bar.
//!
//! ─── ONE IMPLEMENTATION FOR EVERY FORMAT ────────────────────────────────
//! `zip` ships `enclosed_name()` and would cover the ZIP case. It is not used
//! as the primary check, because 7z and RAR need the same rule and a
//! traversal must be refused IDENTICALLY whatever the container was. A path
//! that is unsafe in a `.zip` and tolerated in a `.rar` is the worst of both.
//!
//! ─── REFUSAL IS PER ENTRY, NOT PER ARCHIVE ──────────────────────────────
//! One bad entry does not abort the extraction — it is skipped and reported.
//! The caller decides whether a refusal is fatal, because "this mod contains
//! a traversal" is a finding it may want to show a human rather than a crash
//! it wants to swallow.

use std::path::{Component, Path, PathBuf};

/// Why an entry was not written. Every variant is reported, never silent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefusalReason {
    /// A `..` component: an attempt to escape the destination.
    Traversal,
    /// Rooted at `/`, a Windows drive (`C:\`), or a UNC share.
    Absolute,
    /// Nothing left after normalisation — e.g. `./` or `.`.
    Empty,
    /// Contains a NUL, which no filesystem accepts and some C APIs truncate at.
    Nul,
}

impl RefusalReason {
    pub fn as_str(self) -> &'static str {
        match self {
            RefusalReason::Traversal => "path escapes the destination directory",
            RefusalReason::Absolute => "path is absolute",
            RefusalReason::Empty => "path is empty after normalisation",
            RefusalReason::Nul => "path contains a NUL byte",
        }
    }
}

/// Resolve an archive entry's path against `dest`, or refuse it.
///
/// Deliberately textual: it never calls `canonicalize`, because `dest` and its
/// subdirectories do not exist yet during an extraction, and a check that
/// needs the filesystem cannot run before the write it is meant to guard.
pub fn safe_join(dest: &Path, raw: &str) -> Result<PathBuf, RefusalReason> {
    if raw.contains('\0') {
        return Err(RefusalReason::Nul);
    }

    // Archives written on Windows use `\`. On Linux that is a legal filename
    // character, so without this a Windows path becomes one giant filename
    // rather than a directory tree.
    let normalised = raw.replace('\\', "/");

    if is_rooted(&normalised) {
        return Err(RefusalReason::Absolute);
    }

    let mut out = PathBuf::from(dest);
    let mut kept = 0usize;
    for segment in normalised.split('/') {
        match segment {
            "" | "." => continue,
            ".." => return Err(RefusalReason::Traversal),
            other => {
                // Belt and braces: reject anything the OS would itself read as
                // a traversal or root once parsed.
                if Path::new(other)
                    .components()
                    .any(|c| !matches!(c, Component::Normal(_)))
                {
                    return Err(RefusalReason::Traversal);
                }
                out.push(other);
                kept += 1;
            }
        }
    }

    if kept == 0 {
        return Err(RefusalReason::Empty);
    }
    Ok(out)
}

fn is_rooted(path: &str) -> bool {
    if path.starts_with('/') {
        return true;
    }
    // `C:` or `C:/…` — a drive-qualified Windows path.
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

/// Detects entries that differ only by case.
///
/// Windows treats `Textures/a.dds` and `textures/A.DDS` as one file; Linux
/// treats them as two. A mod archive built on Windows can therefore contain a
/// collision its author never saw, and under Proton the game will look for
/// exactly one of them. Extraction still writes both — this only reports, so
/// the caller can warn rather than silently produce a tree that behaves
/// differently from the curator's.
#[derive(Default)]
pub struct CaseWatch {
    seen: std::collections::HashMap<String, String>,
}

/// Two entry paths that collide case-insensitively.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaseCollision {
    pub first: String,
    pub second: String,
}

impl CaseWatch {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a path; returns a collision if one differing only by case was
    /// already recorded.
    pub fn observe(&mut self, raw: &str) -> Option<CaseCollision> {
        let key = raw.replace('\\', "/").to_lowercase();
        match self.seen.get(&key) {
            Some(first) if first != raw => {
                Some(CaseCollision { first: first.clone(), second: raw.to_owned() })
            }
            Some(_) => None,
            None => {
                self.seen.insert(key, raw.to_owned());
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dest() -> PathBuf {
        PathBuf::from("/tmp/dest")
    }

    #[test]
    fn an_ordinary_nested_path_is_joined() {
        assert_eq!(
            safe_join(&dest(), "Textures/armour/x.dds").unwrap(),
            PathBuf::from("/tmp/dest/Textures/armour/x.dds")
        );
    }

    #[test]
    fn a_windows_separator_becomes_a_directory_tree_not_a_filename() {
        let got = safe_join(&dest(), "Textures\\armour\\x.dds").unwrap();
        assert_eq!(got, PathBuf::from("/tmp/dest/Textures/armour/x.dds"));
        // The failure this guards: one segment named "Textures\armour\x.dds".
        assert_eq!(got.components().count(), 6);
    }

    #[test]
    fn traversal_is_refused_however_it_is_spelled() {
        for raw in [
            "../x",
            "a/../../x",
            "..\\x",
            "a\\..\\..\\x",
            "./../x",
            "a/b/../../../x",
        ] {
            assert_eq!(
                safe_join(&dest(), raw),
                Err(RefusalReason::Traversal),
                "should have refused {raw:?}"
            );
        }
    }

    #[test]
    fn a_traversal_that_stays_inside_is_still_refused() {
        // `a/../b` resolves inside dest, but honouring `..` at all means
        // trusting the archive's arithmetic. We do not.
        assert_eq!(safe_join(&dest(), "a/../b"), Err(RefusalReason::Traversal));
    }

    #[test]
    fn absolute_paths_are_refused_in_both_dialects() {
        for raw in ["/etc/passwd", "C:/Windows/system32", "C:\\Windows", "//server/share/x"] {
            assert_eq!(
                safe_join(&dest(), raw),
                Err(RefusalReason::Absolute),
                "should have refused {raw:?}"
            );
        }
    }

    #[test]
    fn a_nul_byte_is_refused_rather_than_truncated() {
        assert_eq!(safe_join(&dest(), "a\0b"), Err(RefusalReason::Nul));
    }

    #[test]
    fn a_path_that_normalises_to_nothing_is_refused() {
        for raw in ["", ".", "./", "././"] {
            assert_eq!(safe_join(&dest(), raw), Err(RefusalReason::Empty), "{raw:?}");
        }
    }

    #[test]
    fn redundant_current_directory_segments_are_dropped() {
        assert_eq!(
            safe_join(&dest(), "./a//b/./c").unwrap(),
            PathBuf::from("/tmp/dest/a/b/c")
        );
    }

    #[test]
    fn case_collisions_are_reported_once_and_only_when_real() {
        let mut watch = CaseWatch::new();
        assert_eq!(watch.observe("Textures/a.dds"), None);
        // Same bytes again: not a collision, just a duplicate entry.
        assert_eq!(watch.observe("Textures/a.dds"), None);
        assert_eq!(
            watch.observe("textures/A.DDS"),
            Some(CaseCollision {
                first: "Textures/a.dds".into(),
                second: "textures/A.DDS".into()
            })
        );
    }

    #[test]
    fn case_watch_sees_through_separator_dialects() {
        let mut watch = CaseWatch::new();
        watch.observe("Textures/a.dds");
        assert!(watch.observe("textures\\A.DDS").is_some());
    }
}
