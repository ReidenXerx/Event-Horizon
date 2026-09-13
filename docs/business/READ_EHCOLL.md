# Read `.ehcoll` — ZIP file → typed `EhcollManifest` + package layout

**Source of truth:** `src/core/manifest/readEhcoll.ts` (Phase 3 slice 2).
**Pure-validator delegate:** [`PARSE_MANIFEST.md`](PARSE_MANIFEST.md).
**Mirror of:** [`PACKAGE_ZIP.md`](PACKAGE_ZIP.md).

## Purpose

The user-side opener for `.ehcoll` packages. Takes one absolute path on
disk, opens the ZIP with the project's own native reader
(`src/core/manifest/readZip.ts`), validates the package structure, parses
`manifest.json`, and returns a typed result the resolver/installer can
consume.

This is the I/O wrapper around the pure {@link parseManifest} validator.
The split mirrors the producer side:

| Stage | Pure (no I/O) | I/O wrapper |
| --- | --- | --- |
| Producer | `buildManifest` | `packageEhcoll` |
| Consumer | `parseManifest` | **`readEhcoll`** |

After this slice, anything `packageEhcoll` writes, `readEhcoll` reads
back losslessly. That round-trip is the gate every Phase 3+ consumer
(resolver, installer, drift report, package inspector UI) builds on.

## Why this does not use 7-Zip

It used to, and that was the bug. `node-7z` shells out to `7z.exe`, and on a
Wine/Proton prefix that spawn fails for reasons unrelated to the archive —
a missing vcrun runtime under the prefix, not a corrupt package. The failure
surfaced as `7z failed to list`, which reads as "your collection is broken"
and is not.

Vortex ships 7-Zip and it is still the right tool for **third-party mod
archives**, which are as often `.7z` or `.rar` as `.zip` and are Vortex's job
to unpack. But a `.ehcoll` is our own format and is always a ZIP, so reading it
needs nothing but `fs` and `zlib`. `readZip.ts` is a zero-dependency ZIP
reader: it parses the central directory, handles ZIP64, verifies CRC on every
entry it decompresses, and refuses encrypted or unsupported-method entries by
name rather than returning wrong bytes.

The read flow:

1. **List** the archive's central directory (cheap; no decompression).
2. **Extract** `manifest.json` only, into a temp dir.
3. Read its bytes from disk, hand them to `parseManifest`.
4. Cleanup.

Step 2 still goes through a temp dir rather than memory. That is now a
deliberate choice rather than a 7-Zip constraint: it keeps this function's
contract identical to the version it replaced, and a manifest large enough to
matter is one worth streaming anyway.

Bundled mods are deliberately **not** read here. A package carries each
one as loose files in a folder, `bundled/<sha256>/` (Nexus quarantines a
package with an archive inside it); we only confirm the folders are present
in the central directory, match the manifest's `bundled: true` mods, and
that nothing else sits under `bundled/`. The installer writes each mod's
archive from its files when it installs it.

## Inputs

```
readEhcoll(zipPath: string, options?: ReadEhcollOptions)
```

`zipPath` must be an absolute path to a single regular file. Symlinks
and directories are rejected.

`options`:

| Field | Default | Effect |
| --- | --- | --- |
| `stagingDir` | `os.tmpdir()/event-horizon-read-<random>` | Where `manifest.json` is extracted to. Useful for tests. |
| `cleanupOnSuccess` | `true` | When `false`, the staging dir is left in place after a successful read for offline inspection. |

There is no `sevenZip` injection point. One existed and was removed: after the
switch to the native reader nothing read it, so passing a fake 7-Zip silently
had no effect — an option that invites you to test a code path that is not
running.

## Outputs

```
{
  manifest:          EhcollManifest,        // fully parsed + validated
  bundledArchives:   BundledArchiveEntry[], // sorted by sha256
  hasReadme:         boolean,
  hasChangelog:      boolean,
  iniTweakFiles:     string[],              // Phase 5; v1 producers emit []
  warnings:          string[]               // parse warnings + layout warnings
}
```

`BundledArchiveEntry` is one bundled mod: the sha256 its folder is named
after (the identity of the canonical zip its files make), the folder's
in-zip path (`bundled/<sha256>/`), how many files it holds, and their
uncompressed size, read straight from the central directory.

## Behavior — pipeline

The reader runs three phases. Phases 1 and 2 are short-circuit gates;
phase 3 accumulates errors.

### Phase 1 — file existence + listing

1. Reject if `zipPath` is not absolute.
2. `fs.stat` the path. `ENOENT` ⇒ "no file at...". Anything else ⇒
   "cannot stat...". Non-regular-file ⇒ "...is not a regular file."
3. Call `listZipEntries(zipPath)` (`readZip.ts`), which parses the whole
   central directory in one pass. The result is still shaped as
   `SevenZipListEntry` so the six downstream consumers did not have to
   change when the reader underneath did.
4. If it throws — no end-of-central-directory record, an encrypted entry,
   a ZIP64 layout it will not guess at — wrap as a `ReadEhcollError`
   ("the file may be corrupt, password-protected, or not a ZIP").

### Phase 2 — layout classification + manifest extract

5. For each list entry, normalize the path (`\` → `/`), drop directory
   entries (`attr` starts with `D`, or trailing slash), and classify:
   - `manifest.json` at root → `hasManifest = true`
   - `README.md` at root → `hasReadme = true`
   - `CHANGELOG.md` at root → `hasChangelog = true`
   - `bundled/<64-hex>/<path>` → counted into that bundled mod's entry
     (one per folder, with its file count and size).
   - a `bundled/` file whose name does not say how it is encoded (no UTF-8
     flag, and not plain ASCII) → `unflaggedBundled`. Its path is a guess, so
     its mod could not be written back; the cross-check refuses the package
     before anything installs.
   - anything else under `bundled/` → `unrecognizedBundled`. The
     cross-check refuses the package for it: schema 2 writes nothing
     else there, and an archive in the old `bundled/<sha256>.<ext>`
     layout is exactly what must not be read.
   - `ini-tweaks/...` → push to `iniTweakFiles`.
   - Anything else at root → ignored. Forward-compat headroom for
     additive v1.x schema changes that ship root-level files.
6. **Short-circuit gate:** if `hasManifest === false`, throw
   `ReadEhcollError`. The package is not a valid Event Horizon
   collection at all.
7. Prepare a staging directory (clears `options.stagingDir` if
   provided, else `mkdtemp` under the OS temp dir).
8. Call `extractZipEntryToFile` for `manifest.json` alone, into `stagingDir`.
   The reader verifies the entry's CRC-32 as it inflates, so a truncated or
   altered manifest fails here rather than downstream as a confusing parse
   error. On any failure, wrap as `ReadEhcollError`.
9. `fs.readFile(stagingDir + '/manifest.json', 'utf8')`.
10. Call `parseManifest(raw)`. If it throws `ParseManifestError`,
    repackage its `.errors[]` into a `ReadEhcollError` so callers have
    one error type to catch.
11. **`finally`-cleanup the staging dir** (when `cleanupOnSuccess` is
    truthy). Cleanup runs even on error.

### Phase 3 — cross-check `bundled/` against `manifest.mods`

12. Build the **expected** set: every `mod.source.kind === "external" && mod.source.bundled === true`,
    keyed by `sha256` → `compareKey`. Duplicate external SHAs survive
    (the parse layer already warns about them); the *first* mod claims
    the folder.
13. Any `unrecognizedBundled` entry → one error naming the first five and
    giving the count; likewise any `unflaggedBundled` entry. A folder is named by its sha, so two folders can
    never share one — there is no duplicate check left to make.
14. Every expected SHA without a folder → error
    ("...marked bundled=true in the manifest but the package has no folder
    bundled/X/ holding its files...").
15. Every folder whose SHA is not expected → error
    ("...is present in the package but does not correspond to any external
    mod with bundled=true...").
16. If any errors, throw `ReadEhcollError` with the full list. Otherwise
    return the survivors as `BundledArchiveEntry[]`, sorted by sha256
    for deterministic consumer ordering.

## Failure modes

| Symptom | Cause | Severity |
| --- | --- | --- |
| `zipPath` not absolute | Caller bug | Throw, single error |
| `ENOENT` | File moved / deleted | Throw, single error |
| `EACCES`, etc. | Filesystem issue | Throw, single error |
| Path is a directory or symlink | Wrong target | Throw, single error |
| central directory unreadable | Corrupt ZIP, encrypted entry, not a ZIP | Throw, single error |
| `manifest.json` missing | Not an Event Horizon package | Throw, single error |
| `manifest.json` not valid JSON | Hand-edit / producer bug | Throw, list from `parseManifest` |
| `schemaVersion` = 1 | Built before bundled mods shipped loose | Throw, single error: download the collection's current package |
| `schemaVersion` anything else but 2 | Future package | Throw, single error: update Event Horizon |
| Field-level shape problems | Hand-edit / producer bug | Throw, list from `parseManifest` |
| Bundled mod has no folder in `bundled/` | Producer bug, package corruption | Throw, accumulated |
| Stray folder in `bundled/` | Hand-edit, producer bug | Throw, accumulated |
| Anything under `bundled/` that is not a file in a `<64-hex>/` folder — an old-layout archive above all | Hand-edit, re-packing tool | Throw, accumulated |
| A `bundled/` file name that is not ASCII and carries no UTF-8 flag | Re-packed by a tool that does not mark UTF-8 names | Throw, accumulated |
| Unknown root-level file | Forward-compat additive change | Tolerated, no warning |
| Extension cannot stat staging dir | Permission issue | Bubbled up as `ReadEhcollError` |

## Quirks & invariants

1. **`readEhcoll` only extracts `manifest.json`.** Bundled mods are
   listed, never read. The installer writes each one's archive from its
   files (`extractBundledFromEhcoll`) and checks its SHA-256 there;
   `readEhcoll` is purely "tell me what's in here." This keeps a UI
   "inspect package" action fast on a 4 GB collection.
2. **Path normalization is forward-slash.** The ZIP spec says entry names
   use `/`, but writers exist that emit `\`; we rewrite them so
   cross-platform comparisons and the UI stay consistent. Producer-side
   `packageEhcoll` already stages with `/`.
3. **Directory entries are filtered.** ZIP writers commonly emit
   `bundled/` as its own entry — a trailing slash, or a `D` in the DOS
   attribute byte. We drop those: they are the directory marker, not a
   file, and counting them as files makes them look like package contents
   that can never be extracted.
4. **Unknown root-level files are tolerated.** The schema is additive;
   a v1.x producer might ship a new top-level file that this v1 reader
   doesn't recognize. We don't refuse the package — we just ignore the
   file. This keeps users on the older extension able to install
   newer packages whenever the additive change is compatible.
5. **Nothing but bundled mods' folders is accepted under `bundled/`.** An
   entry that is not a file inside `bundled/<64-hex>/` refuses the package,
   and the log (`ehcoll.read.bundled.unrecognized`) lists every one. This
   used to be tolerated. It is not now, because the one thing that rule
   would let through — an archive in the old layout — is exactly what a
   package must not carry.
6. **Short-circuit gates are categorical "no document" cases.** Missing
   ZIP, unreadable ZIP, missing `manifest.json`. Everything else
   accumulates so the operator gets a full diagnosis from one read.
7. **`parseManifest`'s warnings are forwarded as-is**, not wrapped or
   re-categorized. The reader adds nothing of its own to that list at
   present (the cross-check is error-only). Layout warnings (e.g.
   "manifest references a README but the package doesn't ship one")
   may be added here in a future slice if it turns out the resolver
   needs them.
8. **Staging cleanup is `finally`-bound.** A read that fails midway
   through extraction never leaks bytes into the temp dir, even when
   the error is `ReadEhcollError` (we don't catch-and-rethrow inside
   the try block — the `finally` does the work).
9. **The reader is stateless.** Two concurrent reads of two different
   `.ehcoll` files are safe; `mkdtemp` gives each a unique staging
   directory.
10. **No file is held open beyond the synchronous tail of each
    function.** All I/O is `await`ed; nothing leaks descriptors.

## Round-trip property

The Phase 3 slice 2 done-criterion. For any input `(input, bundles)`
that `packageEhcoll` accepts:

```
const { outputPath } = await packageEhcoll({ ... });
const result = await readEhcoll(outputPath);

result.manifest                           === input.manifest          (deep-equal)
result.bundledArchives.length             === bundles.length
result.bundledArchives[*].sha256          ⊆ bundles[*].sha256
result.hasReadme                          === (input.readme !== undefined)
result.hasChangelog                       === (input.changelog !== undefined)
result.iniTweakFiles                      === []                       (v1 producers)
result.warnings                           === parseManifest(JSON.stringify(input.manifest)).warnings
```

This contract is what lets later slices (resolver/installer) build on
the reader without re-parsing or re-validating the manifest.
