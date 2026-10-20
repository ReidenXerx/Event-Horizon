//! Reading a `.ehcoll` package — a port of `src/core/manifest/readEhcoll.ts`.
//!
//! ─── WHAT A PACKAGE IS ──────────────────────────────────────────────────
//! A ZIP with `manifest.json` at its root, and beside it:
//!
//! ```text
//! manifest.json              the collection (crates/ehcoll parses it)
//! collection.json            Vortex's marker, listing NO mods (ignored here)
//! bundled/<sha256>/<path>    a bundled mod's files, loose (schema 2)
//! mirror/<sha256>            a mirrored mod's file the archive cannot provide
//! presentation/…             images (not modelled in Rust yet)
//! ini-tweaks/…               placeholder
//! README.md, CHANGELOG.md
//! ```
//!
//! This is what a Nexus collection's file IS — the website's "Install"
//! downloads exactly this.
//!
//! ─── THE SPLIT, AS IN TYPESCRIPT ────────────────────────────────────────
//! `ehcoll` validates a manifest from a string and does no I/O. This crate is
//! the I/O around it: list the ZIP, read `manifest.json` out of it (CRC-
//! checked), and cross-check the `bundled/` folders against the mods the
//! manifest says are bundled.
//!
//! ─── EVERY PROBLEM AT ONCE ──────────────────────────────────────────────
//! Two gates stop immediately — the file is not a readable ZIP, or it has no
//! `manifest.json` — because there is no document to check. Everything else
//! is collected, so one read gives the whole diagnosis.
//!
//! ─── KNOWN DIFFERENCES FROM TYPESCRIPT ──────────────────────────────────
//! * Presentation images are not checked: `package.presentation` is not
//!   modelled in Rust yet (see `ehcoll`), so there is nothing to check
//!   them against.
//! * A bundled entry whose name is non-ASCII, carries no UTF-8 flag, and
//!   relies on an Info-ZIP Unicode-path extra field instead is accepted here
//!   and refused there: the zip crate resolves that field before we see the
//!   name. No Event Horizon build writes one.

#![forbid(unsafe_code)]

use ehcoll::{parse_manifest, EhcollManifest, ModSource};
use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

/// The file a collection page's older landing download carries instead of a
/// package — the likeliest wrong zip a user picks.
pub const LINK_FILE_NAME: &str = "event-horizon-link.json";

/// How many stray entries a refusal names; the rest are counted.
const STRAY_ENTRIES_NAMED: usize = 5;

/// A manifest larger than this is refused rather than read into memory. A
/// 1,755-mod collection's manifest is a few megabytes; this is two orders of
/// magnitude of headroom against a decompression bomb.
const MANIFEST_MAX_BYTES: u64 = 256 * 1024 * 1024;

/// A package that read cleanly.
#[derive(Debug, Clone)]
pub struct PackageRead {
    pub manifest: EhcollManifest,
    /// One per bundled mod's folder, sorted by sha256.
    pub bundled: Vec<BundledEntry>,
    pub has_readme: bool,
    pub has_changelog: bool,
    /// Files under `ini-tweaks/`. A placeholder; empty from every current build.
    pub ini_tweak_files: Vec<String>,
    /// Files under `mirror/`, as `mirror/<sha256>`. Not cross-checked — the
    /// TypeScript reader does not either; each is verified by hash when used.
    pub mirror_files: Vec<String>,
    /// The manifest's warnings plus any about the package's shape.
    pub warnings: Vec<String>,
}

/// One bundled mod as the package carries it: a folder of loose files.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundledEntry {
    /// SHA-256 of the canonical zip those files make — also the folder name.
    pub sha256: String,
    /// `bundled/<sha256>/`.
    pub bundle_folder: String,
    pub files: u64,
    /// Uncompressed bytes.
    pub size: u64,
}

/// Every problem found, not just the first.
#[derive(Debug, Clone)]
pub struct PackageError {
    pub errors: Vec<String>,
}

impl PackageError {
    fn one(msg: impl Into<String>) -> Self {
        Self { errors: vec![msg.into()] }
    }
}

impl fmt::Display for PackageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.errors.as_slice() {
            [only] => write!(f, "{only}"),
            many => {
                write!(f, "Cannot read .ehcoll ({} problems):", many.len())?;
                for e in many {
                    write!(f, "\n  - {e}")?;
                }
                Ok(())
            }
        }
    }
}

impl std::error::Error for PackageError {}

/// One central-directory entry, as much of it as classification needs.
struct Listed {
    /// Forward slashes, as written.
    name: String,
    size: u64,
    is_dir: bool,
    /// The name is ASCII, or flagged UTF-8. Otherwise its bytes were decoded
    /// by guesswork (CP437), and a path built from it may not be the one the
    /// curator's files had.
    name_encoding_known: bool,
}

/// Open, validate and cross-check the package at `path`.
pub fn read_package(path: &Path) -> Result<PackageRead, PackageError> {
    let mut archive = open_zip(path)?;
    let entries = list(&mut archive, path)?;
    let layout = classify(&entries);

    if !layout.has_manifest {
        let zip_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let link_file = entries
            .iter()
            .any(|e| e.name.rsplit('/').next().map(str::to_ascii_lowercase).as_deref() == Some(LINK_FILE_NAME));
        return Err(PackageError::one(if link_file {
            format!(
                "\"{zip_name}\" is a collection's link file, not its package: it holds {LINK_FILE_NAME} \
                 and no manifest.json. Paste the link written inside it into \"Or paste the \
                 collection's link\" on the Install page."
            )
        } else {
            format!(
                "Archive \"{}\" does not contain manifest.json at its root. This is not a valid \
                 Event Horizon collection package.",
                path.display()
            )
        }));
    }

    let raw = read_manifest(&mut archive, path)?;
    let parsed = parse_manifest(&raw).map_err(|e| PackageError { errors: e.errors })?;

    let mut errors = Vec::new();
    let bundled = cross_check_bundled(&parsed.manifest, &layout, &mut errors);
    if !errors.is_empty() {
        return Err(PackageError { errors });
    }

    Ok(PackageRead {
        manifest: parsed.manifest,
        bundled,
        has_readme: layout.has_readme,
        has_changelog: layout.has_changelog,
        ini_tweak_files: layout.ini_tweak_files,
        mirror_files: layout.mirror_files,
        warnings: parsed.warnings,
    })
}

/// Whether the zip at `path` has a package's `manifest.json` at its root —
/// the one thing that makes a zip an Event Horizon package, whatever its name.
pub fn has_package_manifest(path: &Path) -> Result<bool, PackageError> {
    let mut archive = open_zip(path)?;
    Ok(classify(&list(&mut archive, path)?).has_manifest)
}

fn open_zip(path: &Path) -> Result<zip::ZipArchive<BufReader<File>>, PackageError> {
    let meta = std::fs::metadata(path).map_err(|e| {
        PackageError::one(if e.kind() == std::io::ErrorKind::NotFound {
            format!("No file at \"{}\". Has the package been moved or deleted?", path.display())
        } else {
            format!("Cannot stat \"{}\": {e}.", path.display())
        })
    })?;
    if !meta.is_file() {
        return Err(PackageError::one(format!(
            "\"{}\" is not a regular file (directory? device?). A .ehcoll must be a single ZIP file.",
            path.display()
        )));
    }
    let file = File::open(path).map_err(|e| PackageError::one(format!("Cannot open \"{}\": {e}.", path.display())))?;
    zip::ZipArchive::new(BufReader::new(file)).map_err(|e| PackageError::one(not_a_zip(path, &e.to_string())))
}

/// Why a file that should be a package cannot be opened as a ZIP — a port
/// of `diagnoseArchive.ts`. "No end of central directory" is a poor way to
/// say "this is the HTML of an error page" or "the download was cut short".
fn not_a_zip(path: &Path, zip_error: &str) -> String {
    let p = path.display();
    match diagnose(path) {
        Diagnosis::Empty => format!("\"{p}\" is 0 bytes — the transfer produced an empty file. Download or copy it again."),
        Diagnosis::Truncated(n) => format!(
            "\"{p}\" is an INCOMPLETE copy: it starts like a valid collection but the end of the file \
             is missing ({} so far). Nothing is wrong with the collection itself — the transfer was \
             cut short. Send or download it again, and check the size matches the sender's.",
            format_bytes(n)
        ),
        Diagnosis::NotAnArchive(looks_like, n) => format!(
            "\"{p}\" is not a collection package — it looks like {looks_like} ({}). Check you picked \
             the right file, and that it was not renamed from something else.",
            format_bytes(n)
        ),
        // It IS shaped like a zip, so the zip reader's own reason is the
        // most specific thing to say.
        Diagnosis::LooksLikeAZip => format!("\"{p}\" cannot be read as a ZIP: {zip_error}."),
        Diagnosis::Unreadable(why) => format!(
            "\"{p}\" could not be read: {why}. Check the file is not open in another program and \
             that you have permission to read it."
        ),
    }
}

enum Diagnosis {
    Empty,
    Truncated(u64),
    NotAnArchive(&'static str, u64),
    LooksLikeAZip,
    Unreadable(String),
}

fn diagnose(path: &Path) -> Diagnosis {
    use std::io::{Seek, SeekFrom};
    const LOCAL_HEADER: &[u8] = b"PK\x03\x04";
    const EOCD: &[u8] = b"PK\x05\x06";
    let run = || -> std::io::Result<Diagnosis> {
        let mut f = File::open(path)?;
        let size = f.metadata()?.len();
        if size == 0 {
            return Ok(Diagnosis::Empty);
        }
        let mut head = [0u8; 8];
        let n = f.read(&mut head)?;
        let head = &head[..n];
        if !head.starts_with(LOCAL_HEADER) {
            return Ok(Diagnosis::NotAnArchive(identify(head), size));
        }
        // The end-of-central-directory record sits in the last 64 KiB plus
        // its own 22 bytes; without it the file was cut short.
        let tail_len = size.min(66_000);
        f.seek(SeekFrom::Start(size - tail_len))?;
        let mut tail = Vec::with_capacity(tail_len as usize);
        f.take(tail_len).read_to_end(&mut tail)?;
        if !tail.windows(EOCD.len()).any(|w| w == EOCD) {
            return Ok(Diagnosis::Truncated(size));
        }
        Ok(Diagnosis::LooksLikeAZip)
    };
    run().unwrap_or_else(|e| Diagnosis::Unreadable(e.to_string()))
}

/// What the first eight bytes say a file is.
fn identify(head: &[u8]) -> &'static str {
    let starts = |b: &[u8]| head.starts_with(b);
    if starts(&[0x37, 0x7a, 0xbc, 0xaf]) {
        return "a 7z archive (not a ZIP)";
    }
    if starts(b"Rar!") {
        return "a RAR archive (not a ZIP)";
    }
    if starts(&[0x1f, 0x8b]) {
        return "a gzip file (not a ZIP)";
    }
    if starts(b"PK\x05\x06") {
        return "an empty ZIP";
    }
    let text = String::from_utf8_lossy(head).trim_start().to_lowercase();
    if text.starts_with("<!do") || text.starts_with("<htm") {
        return "an HTML page — the download probably returned an error page";
    }
    if text.starts_with('{') || text.starts_with('[') {
        return "a JSON file";
    }
    "something that is not a ZIP"
}

fn format_bytes(n: u64) -> String {
    if n < 1024 {
        format!("{n} bytes")
    } else if n < 1024 * 1024 {
        format!("{:.1} KB", n as f64 / 1024.0)
    } else {
        format!("{:.1} MB", n as f64 / (1024.0 * 1024.0))
    }
}

fn list(archive: &mut zip::ZipArchive<BufReader<File>>, path: &Path) -> Result<Vec<Listed>, PackageError> {
    let mut out = Vec::with_capacity(archive.len());
    for i in 0..archive.len() {
        let f = archive
            .by_index_raw(i)
            .map_err(|e| PackageError::one(format!("\"{}\": entry {i} is unreadable: {e}.", path.display())))?;
        let name = f.name().replace('\\', "/");
        if f.encrypted() {
            return Err(PackageError::one(format!(
                "\"{name}\" in \"{}\" is encrypted. Collection packages are never password-protected, \
                 so this is not the file you meant.",
                path.display()
            )));
        }
        let raw = f.name_raw();
        // The zip crate decodes a name as UTF-8 only when the entry is flagged
        // UTF-8, and as CP437 otherwise. CP437 turns every byte >= 0x80 into a
        // multi-byte character, so a decoded name equal to its raw bytes was
        // either ASCII or flagged UTF-8 — exactly the TypeScript rule.
        let name_encoding_known = raw.is_ascii() || f.name().as_bytes() == raw;
        // An unflagged name is shown as TypeScript shows it — its bytes read
        // as UTF-8, lossily — rather than as the CP437 guess, so both readers
        // name the same file the same way in their refusal.
        let name = if name_encoding_known {
            name
        } else {
            String::from_utf8_lossy(raw).replace('\\', "/")
        };
        out.push(Listed { is_dir: f.is_dir() || name.ends_with('/'), size: f.size(), name, name_encoding_known });
    }
    Ok(out)
}

fn read_manifest(archive: &mut zip::ZipArchive<BufReader<File>>, path: &Path) -> Result<String, PackageError> {
    let fail = |why: String| {
        PackageError::one(format!("Could not read manifest.json from \"{}\": {why}", path.display()))
    };
    let entry = archive.by_name("manifest.json").map_err(|e| fail(e.to_string()))?;
    if entry.size() > MANIFEST_MAX_BYTES {
        return Err(fail(format!("it declares {} bytes, more than any real manifest", entry.size())));
    }
    // Reading to the end makes the zip crate check the entry's CRC-32: a
    // manifest that decompressed to plausible but wrong bytes would be
    // trusted by every stage after this one.
    let mut raw = String::new();
    entry.take(MANIFEST_MAX_BYTES + 1).read_to_string(&mut raw).map_err(|e| fail(e.to_string()))?;
    if raw.len() as u64 > MANIFEST_MAX_BYTES {
        return Err(fail("it is larger than any real manifest".into()));
    }
    Ok(raw)
}

#[derive(Default)]
struct Layout {
    has_manifest: bool,
    has_readme: bool,
    has_changelog: bool,
    ini_tweak_files: Vec<String>,
    mirror_files: Vec<String>,
    /// Keyed by sha256, in first-seen order via `order`.
    bundles: HashMap<String, BundledEntry>,
    order: Vec<String>,
    unrecognized_bundled: Vec<String>,
    unflagged_bundled: Vec<String>,
}

fn classify(entries: &[Listed]) -> Layout {
    let mut l = Layout::default();
    for e in entries.iter().filter(|e| !e.is_dir) {
        let n = e.name.as_str();
        match n {
            "manifest.json" => l.has_manifest = true,
            "README.md" => l.has_readme = true,
            "CHANGELOG.md" => l.has_changelog = true,
            // Vortex's marker, put there on purpose; says nothing a reader needs.
            "collection.json" => {}
            _ if n.starts_with("bundled/") => {
                if !e.name_encoding_known {
                    l.unflagged_bundled.push(n.to_owned());
                    continue;
                }
                let Some(sha) = bundle_sha_of(n) else {
                    l.unrecognized_bundled.push(n.to_owned());
                    continue;
                };
                let b = l.bundles.entry(sha.to_owned()).or_insert_with(|| {
                    l.order.push(sha.to_owned());
                    BundledEntry {
                        sha256: sha.to_owned(),
                        bundle_folder: format!("bundled/{sha}/"),
                        files: 0,
                        size: 0,
                    }
                });
                b.files += 1;
                b.size += e.size;
            }
            _ if n.starts_with("ini-tweaks/") => l.ini_tweak_files.push(n.to_owned()),
            _ if n.starts_with("mirror/") => l.mirror_files.push(n.to_owned()),
            // presentation/ and unknown top-level entries are tolerated: a
            // later build may add files at the root, and refusing them would
            // strand a reader that cannot use them anyway.
            _ => {}
        }
    }
    l
}

/// The sha256 of `bundled/<sha256>/<path>`, when the entry is exactly that.
fn bundle_sha_of(name: &str) -> Option<&str> {
    let rest = name.strip_prefix("bundled/")?;
    let (sha, path) = rest.split_once('/')?;
    let is_hex = sha.len() == 64 && sha.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    (is_hex && !path.is_empty()).then_some(sha)
}

fn named(list: &[String]) -> String {
    let shown: Vec<String> = list.iter().take(STRAY_ENTRIES_NAMED).map(|p| format!("\"{p}\"")).collect();
    let more = list.len().saturating_sub(STRAY_ENTRIES_NAMED);
    format!("{}{}", shown.join(", "), if more > 0 { format!(" and {more} more") } else { String::new() })
}

fn cross_check_bundled(manifest: &EhcollManifest, l: &Layout, errors: &mut Vec<String>) -> Vec<BundledEntry> {
    // Every external mod marked bundled. A second mod with the same hash is
    // the manifest parser's warning to give; the first one claims the bundle.
    let mut expected: BTreeMap<&str, &str> = BTreeMap::new();
    for m in &manifest.mods {
        if let ModSource::External(src) = &m.source {
            if src.bundled {
                if let Some(sha) = &src.sha256 {
                    expected.entry(sha.as_str()).or_insert(m.compare_key.as_str());
                }
            }
        }
    }

    // Anything else under bundled/ refuses the package. Schema 1 put archives
    // there and the parser has already turned schema 1 away, so under this
    // schema such an entry is an edit, or a rebuild by a tool that does not
    // know the format: not the package the curator built.
    let strays = &l.unrecognized_bundled;
    if !strays.is_empty() {
        errors.push(format!(
            "The package's bundled/ folder holds {} {} not a file inside a bundled mod's folder \
             (bundled/<sha256>/…): {}. A package carries bundled mods as loose files only, so this \
             one was changed after it was built. Download it again.",
            strays.len(),
            if strays.len() == 1 { "entry that is" } else { "entries that are" },
            named(strays),
        ));
    }
    let unflagged = &l.unflagged_bundled;
    if !unflagged.is_empty() {
        let one = unflagged.len() == 1;
        errors.push(format!(
            "The package's bundled/ folder holds {} {} not say how {} encoded: {}. An install could \
             not read them back as the same paths, so the bundled mods they belong to cannot be \
             installed. The package was re-packed by a tool that does not mark UTF-8 names — \
             download the original.",
            unflagged.len(),
            if one { "file whose name does" } else { "files whose names do" },
            if one { "it is" } else { "they are" },
            named(unflagged),
        ));
    }

    for (sha, key) in &expected {
        if !l.bundles.contains_key(*sha) {
            errors.push(format!(
                "External mod \"{key}\" is marked bundled=true in the manifest but the package has no \
                 folder bundled/{sha}/ holding its files. The package is incomplete."
            ));
        }
    }
    for sha in &l.order {
        if !expected.contains_key(sha.as_str()) {
            errors.push(format!(
                "Folder \"{}\" is present in the package but does not correspond to any external mod \
                 with bundled=true in the manifest. The package contains stray files.",
                l.bundles[sha].bundle_folder
            ));
        }
    }

    let mut out: Vec<BundledEntry> =
        l.bundles.values().filter(|b| expected.contains_key(b.sha256.as_str())).cloned().collect();
    out.sort_by(|a, b| a.sha256.cmp(&b.sha256));
    out
}

#[cfg(test)]
mod tests {
    use super::bundle_sha_of;

    #[test]
    fn only_a_file_inside_a_hash_folder_is_a_bundled_entry() {
        let sha = "a".repeat(64);
        assert_eq!(bundle_sha_of(&format!("bundled/{sha}/Data/x.esp")), Some(sha.as_str()));
        assert_eq!(bundle_sha_of(&format!("bundled/{sha}.zip")), None, "schema 1 layout");
        assert_eq!(bundle_sha_of(&format!("bundled/{sha}/")), None);
        assert_eq!(bundle_sha_of(&format!("bundled/{}/x", "A".repeat(64))), None);
        assert_eq!(bundle_sha_of("bundled/short/x"), None);
    }
}
