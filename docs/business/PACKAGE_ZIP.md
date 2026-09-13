# Package `.ehcoll` — `EhcollManifest` + mods' files → `.ehcoll` file

**Source of truth:** `src/core/manifest/packageZip.ts` (Phase 2 slice 3), with
`bundleZip.ts` (a bundled mod's identity), `archiveInside.ts` (what counts as
an archive) and `sevenZip.ts` (vortex-api shim).
**Schema reference:** `src/types/ehcoll.ts` and [`MANIFEST_SCHEMA.md`](MANIFEST_SCHEMA.md).
**Upstream stage:** [`BUILD_MANIFEST.md`](BUILD_MANIFEST.md).

## Purpose

The packager turns one [`EhcollManifest`](../../src/types/ehcoll.ts) plus the
files of its bundled and mirrored mods into a single `.ehcoll` file on disk,
ready to ship to the user-side installer (Phases 3–4).

It does the I/O that `buildManifest` deliberately doesn't: writes the manifest,
writes optional `README.md` / `CHANGELOG.md`, hardlinks/copies mods' files into
a staging directory, and shells out to 7z to ZIP the whole thing.

## Nothing inside a package is an archive

Nexus Mods quarantines any upload with an archive inside it — its virus scan
cannot see into one — and its own help tells authors to extract them. Schema 1
carried each bundled mod as an archive, `bundled/<sha256>.<ext>`, so every
package with a bundled mod was quarantined. From schema 2:

- A **bundled mod** ships as its loose files at `bundled/<sha256>/<path>`. The
  sha is that of the mod's *canonical zip*: a zip written from the files alone
  (`bundleZip.ts` — sorted UTF-8 paths, stored, a fixed timestamp, no directory
  entries), so the same files make the same identity on every machine. The
  installer writes that zip back from the loose files and refuses it unless it
  hashes to the sha.
- A **mirrored file** ships loose as `mirror/<sha256>`, as before.
- A file in either that **is itself an archive** — judged by its first bytes
  (zip, 7z, rar, gzip, xz, bzip2, zstd, lz4, cab, wim, tar), whatever it is called — is
  left out, as if the curator had deleted it from staging: out of the bundle
  (`listBundleFolder`) and out of the file list the manifest records for a
  bundled or mirrored mod (`leaveOutArchiveFiles`, before the manifest is
  built), so users' installs verify, identify and mirror the mod without it.
  The log lists each one (`build.archives-left-out`). Bethesda's `.ba2` and
  `.bsa` are not archives in this sense.

## Why ZIP, not 7z

`.ehcoll` is the user-visible extension; the format inside is internal. ZIP
for **tooling compatibility**: Windows Explorer, WinRAR, `unzip`, and every
programming-language stdlib can read ZIPs. When debugging a user-side install
failure, "send me your `.ehcoll` so I can peek at `manifest.json`" has to work
without anyone installing extra software.

The format is forced via `7z a -tzip` — without it 7z infers the format from
the file extension and `.ehcoll` is unrecognized, so it'd default to its
native `.7z` format.

## Identity is `(package.id, package.version)` — NOT byte-equal builds

Two builds of the *same collection version* are not guaranteed to produce
byte-identical `.ehcoll` files. They will differ in:

- File mtimes baked into ZIP entry headers.
- Filesystem enumeration order (passed through to 7z).
- 7z's own version-to-version output details.

This is fine. The canonical identity of a release is
`(manifest.package.id, manifest.package.version)`:

- `package.id` is a UUIDv4 generated once per collection by the action handler
  and persisted by the curator. Stable across releases.
- `package.version` is semver, bumped by the curator per release.

Together they're a globally unique key for "this is collection X, revision Y."
The user-side install cache, CDN dedup, and "did I install this already?"
checks all key off `(id, version)` — never off content hash.

If the curator rebuilds the same version twice (say, to fix a typo in the
README) the bytes change but `(id, version)` stays the same. Users who already
have that version installed see no change. That's the right behavior. Byte
determinism would only matter if we wanted to detect "operator forgot to bump
version" by file fingerprint — which is a curator-discipline problem, not a
packager problem, and byte determinism doesn't actually help with it.

A bundled **mod** is the exception, and an exact one: its identity is its
canonical zip's sha256, made from its files alone, so nothing the package's own
zip does can move it.

The one stability concession we keep: **`manifest.json` keys are sorted via
`sortDeep` before serialization**. Cost: one function call. Benefit: when
debugging a problem report, `unzip` two `.ehcoll` files and `diff` the
manifests — the diff highlights real content changes, not JSON key-order
shuffles. Worth it.

## Inputs

```
packageEhcoll({
  manifest,            // EhcollManifest from buildManifest
  bundles,             // [{ rootDir, sha256, modName }, ...] — one per bundled mod
  mirrorFiles?,        // [{ sourcePath, sha256, modName? }, ...]
  readme?,             // markdown string
  changelog?,          // markdown string
  outputPath,          // absolute path to write .ehcoll to
  stagingDir?,         // optional override (test injection)
  cleanupOnSuccess?,   // default true
  sevenZip?,           // optional injection of SevenZipApi (test injection)
  signal?,             // cancellation
  onProgress?,         // which step, and how far through it
})
```

`bundles` come from the build's measurement of each bundled mod's staging
folder (`measureBundledMods`, then `resolveBundles`, which refuses a
flagged mod that could not be measured and says why).

## Validation (fatal)

The packager collects every detectable problem into one `PackageEhcollError`
before throwing — same fail-fast philosophy as `buildManifest`.

| Cause | Why fatal |
| --- | --- |
| `outputPath` is missing or not absolute | We refuse to guess where the curator meant. |
| `bundle.sha256` doesn't match the lowercase-hex 64-char invariant | Identity is malformed; downstream resolver would reject. |
| Two bundles share the same sha256 | Each external mod has a unique identity by sha256; duplicates would share one folder in `bundled/`. |
| `bundle.sha256` doesn't correspond to any external mod with `bundled=true` in the manifest | The curator is shipping files the manifest doesn't promise — or vice versa. |
| Manifest has an external mod with `bundled=true` but no bundle supplied | Same problem from the other side: the manifest promises files that won't be in the package. |
| `bundle.rootDir` is not absolute | Path is ambiguous and we won't make assumptions about cwd. |
| A mirrored mod has no staged files, a file without a hash, or a hash missing from `mirrorFiles` | Users would receive an incomplete copy of the mod. |

## Behavior

1. Validate inputs (above). On any error, throw `PackageEhcollError` carrying
   the full list — no I/O has happened yet.
2. Prepare a staging directory. Default: `os.tmpdir()/event-horizon-pack-<random>`
   via `fs.mkdtemp`. When `stagingDir` is supplied (test path) the directory
   is `rm -rf`'d and recreated.
3. List every bundle's folder (`listBundleFolder`: follows links, and leaves out
   the volatile files a runtime writes, such as `Thumbs.db` and logs, and every
  file that is itself an archive). An
   unreadable folder is fatal, naming the mod; so is one that is missing or
   holds no files, since the build measured files in it.
4. **Check again that nothing is an archive.** Read the first bytes of every
   bundled and mirrored file. The build has already left archive files out, so
   a hit means a file changed after the build read its mod, or a caller skipped
   that step: fatal, listing every one (the message names up to 50, the log all
   of them). A file that can no longer be read is fatal, naming its mod.
   Nothing has been collected yet, so a refused build costs seconds.
5. Write `manifest.json`. Keys are sorted via `sortDeep`, serialized with 2-space
   indent, trailing newline. UTF-8.
6. Write optional `README.md` / `CHANGELOG.md`. Content gets a trailing newline
   if the source didn't have one — purely so unzipping the package doesn't
   produce surprise "no newline at end of file" diff noise.
7. **Check free space** (`requireFreeSpace`, `utils/diskSpace.ts`): the temp
   drive must hold copies of the files that live on another drive (those cannot
   be hardlinked), and the output drive the new package at its largest — every
   file at its own size plus deflate framing, and each entry's headers. A short
   drive is fatal, naming the drive, what needs the room and both numbers; a
   drive whose free space cannot be read is not checked. Then stage mirrored
   files at `mirror/<sha256>`, deduplicated, each re-hashed first: a file
   changed since the build recorded it is fatal, naming the mod.
8. Stage each bundle's files at `bundled/<sha256>/<path>`:
   - **Try `fs.link(src, dst)` first.** Hardlink is free and instant on the
     same volume. A symbolic link is resolved to the file it names first: a
     hardlink to the link would be another link, pointing out of the staged
     folder. A file that cannot be collected is fatal, naming mod and path.
   - **On failure (EXDEV cross-volume / EPERM / ENOSYS), fall back to
     `fs.copyFile`.** Slow but always works.
   - Then **re-measure the staged folder**: the canonical zip its files make
     must hash to `bundle.sha256`. The identity was measured before the
     decisions gate, which can stay open as long as the curator likes; a file
     edited in that window is fatal, naming the mod — with "Re-read every
     file" as the way past it when nothing really changed.
   - Each staged file is read once for both its CRC-32 and its SHA-256, and a
     SHA-256 that differs from the one the manifest records for that path is
     fatal, naming the file. Those hashes come from a cache keyed on path,
     size and modification time, so a file rewritten with all three intact
     would otherwise ship under its old hash and fail every user's check.
9. Delete any `<outputPath>.partial` a crashed build left. 7z's `add` is
   *additive* — it would append to a pre-existing archive, not replace it.
   Ensure `outputPath`'s parent directory exists. A package already at
   `outputPath` is not touched.
10. Shell out to 7z via the `vortex-api`-bundled `node-7z`, writing
    `<outputPath>.partial`:
    - Source: `<staging>/*`, recursive.
    - Format: `-tzip` (forced via `$raw`), with `-mcu=on` so every non-ASCII
      name is stored as flagged UTF-8 — left to its defaults 7-Zip keeps a name
      that fits the machine's code page in that code page, unflagged, and no
      install could read it back as the same path.
    - Compression: 7z's default. Loose files compress; that is expected.
11. **Re-read the finished package**: rebuild every bundle out of it exactly as
    an install does and refuse the build unless each makes its sha — naming
    the mod and any file missing from the package. What users install is what
    7-Zip wrote, not what was handed to it.
12. `fs.stat` the produced file and hash it (`outputSha256`). On success and
    `cleanupOnSuccess !== false`, `rm -rf` the staging directory.
13. Move `<outputPath>.partial` over `outputPath`. Only now is a previous
    package of the same name replaced; one that cannot be replaced (held open
    elsewhere) is fatal, saying so.
14. Return `{ outputPath, outputBytes, outputSha256, bundledCount, warnings }`.

## Failure modes

- **Validation errors** ⇒ `PackageEhcollError` with the full list.
- **An archive inside, a changed mirrored file, or a bundle whose staged files
  no longer make its identity** ⇒ `PackageEhcollError` naming the mod.
- **Not enough free space** on the temp or output drive ⇒ `PackageEhcollError`
  before anything is staged, naming the drive and the numbers.
- **A bundled file whose SHA-256 differs from the manifest's** ⇒
  `PackageEhcollError` naming the mod and the file.
- **I/O errors during staging or 7z invocation** ⇒ wrapped in
  `PackageEhcollError`.
- In every failure the staging directory **and `<outputPath>.partial`** are
  removed. 7-Zip writes that file, and it takes `outputPath`'s place only
  after the package is read back and hashed, so a failed or cancelled build
  never leaves a corrupt `.ehcoll` and never deletes the package a previous
  build of the same version left there.
- **Cancellation** ⇒ `AbortError` at the next checkpoint; a running 7z is
  killed from its progress callback. Anything thrown once Cancel was pressed
  is reported as `AbortError` too, whatever the interrupted call threw.

## INVARIANTs

- Validation is exhaustive. The packager doesn't proceed past validation if
  *any* problem was detected; the curator gets one report.
- No archive is ever staged: step 4 reads every file that will ship before
  anything is collected.
- A bundle is staged only with files that make its identity: step 8's
  re-measurement is unconditional.
- The staging directory is always removed (`safeRmDir`) even on success when
  `cleanupOnSuccess !== false`. Failure to remove is swallowed — partial
  cleanup is better than crashing on a closed-file-handle race.
- Hardlinking is best-effort, never required. Cross-volume packaging works,
  it's just slower because we copy.
- `manifest.json` is the only file whose bytes are guaranteed stable across
  same-version rebuilds, apart from bundled mods' identities, which are exact
  by construction. Other package bytes (mtimes, ZIP entry order) may vary.

## Non-goals (explicit)

- **No byte-identical packages.** Identity is `(id, version)`, see above.
- **No upload / publish.** The packager produces a file; shipping it is the
  curator's job — see [`../DISTRIBUTING_COLLECTIONS.md`](../DISTRIBUTING_COLLECTIONS.md).
- **No signing.** Manifests are not signed. If we need signing for
  authenticity, it's an additive change: a new top-level field on the manifest
  + a signature file alongside `manifest.json`.
- **No incremental packaging.** Every call recreates the full package from
  scratch. What the build does remember is its *measurement* of a bundled mod's
  files (`bundleCache.ts`), which packaging then re-checks.

## See also

- [`MANIFEST_SCHEMA.md`](MANIFEST_SCHEMA.md) — the manifest we're packaging.
- [`BUILD_MANIFEST.md`](BUILD_MANIFEST.md) — where the manifest comes from.
- [`READ_EHCOLL.md`](READ_EHCOLL.md) — the reader, which refuses anything else
  under `bundled/`.
- [`ARCHIVE_HASHING.md`](ARCHIVE_HASHING.md) — `hashFileSha256`, used for
  mirrored files and the finished package.
- [`../PROPOSAL_INSTALLER.md`](../PROPOSAL_INSTALLER.md) §6 — the package
  on-disk layout this packager produces.
