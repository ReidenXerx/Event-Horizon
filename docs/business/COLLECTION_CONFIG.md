# Per-collection state file (`.config/<slug>.json`)

**Source of truth:** `src/core/manifest/collectionConfig.ts` (Phase 2 slice 4b).
**Consumed by:** [`BUILD_PACKAGE.md`](BUILD_PACKAGE.md).

> The Vortex `showDialog` in slice 4a only collects the absolute minimum (name / version / author / description). Everything richer — per-mod bundling choices, per-mod instructions, README/CHANGELOG markdown — lives in this JSON file and is hand-edited by the curator until the Phase 5 React UI takes over. The file shape stays stable across the UI transition; the React page will read and write the exact same schema.

## Why a file (and not Vortex Redux state, dialogs, or extension settings)

- **Persistence across rebuilds.** `package.id` MUST be the same UUID every time the curator rebuilds the same collection (so user-side install caches and "is this an upgrade?" checks work). Vortex state isn't suitable — it can be cleared by the user, doesn't survive `appData` migrations cleanly, and isn't visible.
- **Editable without us shipping a UI.** Slice 4b is "no UI work": the curator opens the file in a text editor and flips `bundled: false` → `bundled: true` for the mods they want to bundle. Phase 5's React page will replace the text editor, but the file format stays.
- **Inspectable.** Curators can grep, diff between revisions, version-control it (Git), share it with co-curators. None of that works if the data lives only in Vortex's binary state blob.
- **One file = one collection identity.** The slug-named file is the canonical handle for "this collection's persistent state."

## Location

```
%APPDATA%\Vortex\event-horizon\collections\.config\<slug>.json
```

The `.config` subdirectory keeps these files out of sight when the curator opens the `collections\` folder to grab a built `.ehcoll`. The dotfile-style name is intentional — Windows doesn't hide it, but it sorts above non-dot entries and signals "tooling state, not a deliverable."

The slug is computed from the curator's collection name by `buildPackageAction`'s `slugify`: lowercase the name, replace runs of non-alphanumerics with `-`, trim leading/trailing `-`, cap at 64 chars. Same function that produces the output `.ehcoll` filename, so file and config stay paired.

## Schema (`schemaVersion: 1`)

```jsonc
{
  "schemaVersion": 1,
  "packageId": "550e8400-e29b-41d4-a716-446655440000",
  "externalMods": {
    "<AuditorMod.id>": {
      "name": "Skyland AIO (curator-uploaded)",   // read-only hint
      "bundled": false,                            // default false
      "instructions": ""                           // shown when not bundled
    }
  },
  "readme": "## My Skyrim Build\n\n...",           // optional, written as README.md
  "changelog": "## 1.0.0\n\n- Initial release\n"   // optional, written as CHANGELOG.md
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `schemaVersion` | `1` | yes | Refuses any other value. Reserved for future breaking changes. |
| `packageId` | UUID string | yes | Any RFC 4122 UUID accepted (v1/v4/v5). Generated as v4 on first creation. **The single most important persisted bit** — uniqueness across rebuilds depends on it. |
| `externalMods` | object map | yes (may be `{}`) | Keyed by `AuditorMod.id`. Auto-populated on first build of a slug. |
| `externalMods[modId].name` | string | no | Read-only display hint for hand-editors. Curator-edits are preserved (not overwritten on reconciliation), but the field is **never read** when the action feeds the config into `buildManifest` — it gets stripped by `toBuildManifestExternalMods`. |
| `externalMods[modId].bundled` | bool | no, default `false` | When `true`, the build ships the mod's staging folder: its files, loose, inside the `.ehcoll` at `bundled/<sha256>/`, the sha being that of the canonical zip those files make — the mod's identity in the manifest. The mod's original archive is never shipped. |
| `externalMods[modId].instructions` | string | no | Free-form text shown to the user-side installer when the mod isn't bundled (typical: a Nexus URL with a "click here, download manually, this is hidden" note). |
| `readme` | string | no | When present and non-empty, written as `README.md` at the package root. |
| `changelog` | string | no | When present and non-empty, written as `CHANGELOG.md` at the package root. |

### Identity model

- **Identity = slug.** First build of "My Skyrim Build" → slug `my-skyrim-build` → file `my-skyrim-build.json` → fresh UUIDv4.
- Subsequent builds of "My Skyrim Build" → same slug → reuse the same UUID.
- **Renaming the collection starts a new release lineage.** "My EPIC Skyrim Build" → slug `my-epic-skyrim-build` → new file → new UUID.
- Rationale: simplest possible model. Curators tend to think "if I rename it, it's a new collection." Curators who really want to keep the same UUID across a rename can manually rename the JSON file before the next build.
- Phase 5 may decouple identity from name (the React UI gives the curator an explicit "release lineage" handle); for now, slug is identity.

### Field semantics — how the action consumes each piece

| Config field | Maps to | Where in pipeline |
|---|---|---|
| `packageId` | `BuildManifestInput.package.id` | Fed straight into `buildManifest`. Surfaces as `manifest.package.id`. |
| `externalMods[modId].bundled` | `BuildManifestInput.externalMods[modId].bundled` ⇒ `manifest.mods[i].source.bundled` | Determines whether the mod's archive ships inside the `.ehcoll`. |
| `externalMods[modId].instructions` | `BuildManifestInput.externalMods[modId].instructions` ⇒ `manifest.mods[i].source.instructions` | Shown to the user-side installer when the mod isn't bundled. |
| `externalMods[modId].name` | (stripped) | Hand-editor hint only. Never enters the manifest. |
| `readme` | `PackageEhcollInput.readme` | Written as `README.md` in the ZIP. |
| `changelog` | `PackageEhcollInput.changelog` | Written as `CHANGELOG.md` in the ZIP. |

## Behavior

### `loadOrCreateCollectionConfig({ configDir, slug })`

1. Validate `slug` — non-empty, no path-traversal characters (`\ / : * ? " < > |`), no `..`. Throws `CollectionConfigError` if invalid.
2. Compute `configPath = <configDir>/<slug>.json`.
3. Try to read the file:
   - **Missing file (`ENOENT`):** generate a fresh UUIDv4, write the default config (empty `externalMods`, no `readme`/`changelog`) atomically (mkdir-recursive + writeFile), return `{ config, created: true, configPath }`.
   - **Read fails for any other reason:** rethrow (e.g. EACCES).
4. Parse JSON. Bad JSON ⇒ throw `CollectionConfigError` with the parser's message — **do not silently rewrite** a corrupted file, that would discard the curator's edits.
5. Validate every field:
   - `schemaVersion` must equal `1`.
   - `packageId` must be a UUID string (matches `^[0-9a-f]{8}-…-[0-9a-f]{12}$`, case-insensitive).
   - `externalMods` (when present) must be a JSON object whose values are objects with optional `name` (string), `bundled` (boolean), `instructions` (string). Unknown fields per entry are silently dropped.
   - `readme` and `changelog` (when present) must be strings.
6. **Every problem is collected first**, then thrown together as a `CollectionConfigError`. Curators get one report.
7. Return `{ config, created: false, configPath }`.

### `reconcileExternalModsConfig({ config, externalMods })`

Pure function. Given the loaded config and the current snapshot's external mods (id+name pairs):

- For each external mod **missing** from `config.externalMods`: add a stub `{ name, bundled: false, instructions: "" }`.
- For each external mod **present** in `config.externalMods` whose `name` hint disagrees with the snapshot: refresh the `name` field (preserves the curator's `bundled` / `instructions`).
- **Never removes** entries — a curator who temporarily disables a mod and rebuilds shouldn't lose their previously-set instructions.

Returns `{ config, changed, added }`. The action handler writes the file back via `saveCollectionConfig` only if `changed` is true.

### `saveCollectionConfig({ configDir, slug, config })`

- Validate slug.
- Mkdir-recursive on the parent dir.
- `JSON.stringify(config, null, 2)` for human-readable output.
- Write atomically (single `writeFile`, no temp+rename for slice 4b — Phase 5 may upgrade to atomic-rename if we observe partial writes in practice).

### `toBuildManifestExternalMods(config)`

Strip `name` hints; return the `Record<string, { instructions?, bundled? }>` shape `BuildManifestInput.externalMods` expects.

## Failure modes

| Scenario | Behavior |
|---|---|
| Config file missing | Auto-created with fresh UUIDv4 + empty externalMods. **No error.** |
| Config file has malformed JSON | `CollectionConfigError` listing the parser message. Curator must fix the file by hand. The action **does not overwrite** to avoid discarding edits. |
| `schemaVersion` is anything other than `1` | `CollectionConfigError` with the actual value listed. Curator must update the extension or migrate the file. |
| `packageId` missing or not a UUID | `CollectionConfigError`. |
| `externalMods` is not an object (e.g. an array) | `CollectionConfigError`. |
| Per-entry field has wrong type (e.g. `bundled: "yes"`) | `CollectionConfigError` listing every offending field. |
| Curator deletes a Vortex mod that was flagged `bundled: true` in the config | `BundleResolutionError` from `buildPackageAction` listing the mod. The config entry is preserved (not auto-removed) so the curator can re-install the mod and rebuild without re-typing instructions. |
| Curator flags a Nexus mod (auto-detected by buildManifest as Nexus) with `bundled: true` | `BundleResolutionError` instructing them to set `bundled: false` — Nexus mods are auto-downloaded on the user side. |
| External mod has no `archiveSha256` (snapshot pipeline didn't manage to hash it) but is flagged `bundled: true` | `BundleResolutionError`. The export-side pipeline normally hashes everything, so this means the archive is gone from the downloads folder. |
| External mod's archive can't be found on disk via `getModArchivePath` | `BundleResolutionError` with the missing archive path. |
| Disk full / permission denied while writing the file | I/O error bubbles up, surfaces as a "Build failed: …" notification. The build does not proceed. |

## Quirks & invariants

- **INVARIANT: `name` hint is never authoritative.** The action populates it from the snapshot on every reconciliation pass, but `toBuildManifestExternalMods` strips it before feeding into the manifest pipeline. Curators who rename `name` in the JSON: it persists between builds (we don't overwrite when the snapshot agrees) but won't show in the user-facing `.ehcoll`.
- **INVARIANT: malformed file = hard error, not auto-overwrite.** A curator who's spent an hour writing instructions for 30 external mods cannot afford to have us silently nuke that file because their `bundled` value got typo'd to `bunddled`. Worst-case "the curator hand-edits the file again to fix one typo" beats best-case "we silently lose their work."
- **INVARIANT: identity = slug.** Two collections that happen to share a slug share a UUID. This is a deliberate trade-off — preventing it would require a separate "collection identity" prompt that we don't want to build before Phase 5. Curators who hit this in practice can rename one of the collections.
- **QUIRK: `name` field on external-mod entries is read-only-ish.** It updates when the snapshot's name disagrees, but never on a "curator-renamed it manually" basis (we have no way to detect intent). Curator edits to `name` will eventually be overwritten if the underlying mod's name changes.
- **QUIRK: stale entries are kept forever.** If a mod is removed from the active profile, its config entry stays. Cleanup is a future task — for now, the cost (a few stale entries in a JSON file) is much lower than the benefit (curator-typed instructions never get deleted by surprise).
- **QUIRK: README/CHANGELOG accept any markdown string.** No validation, no length limit. The packager truncates / warns if it's egregious; otherwise we ship whatever the curator wrote.

## Code references

- `src/core/manifest/collectionConfig.ts` — full module (types, load/save, reconciler, validator).
- `src/actions/buildPackageAction.ts` — `loadOrCreateCollectionConfig` + `reconcileExternalModsConfig` + `resolveBundledArchives` integration in the slice 4b extension to the build flow.
- `src/core/manifest/buildManifest.ts` — `BuildManifestInput.externalMods` is the consumer of `toBuildManifestExternalMods`'s output.
- `src/core/manifest/packageZip.ts` — `PackageEhcollInput.{readme,changelog,bundledArchives}` are the consumers of the rest.

## See also

- [`BUILD_PACKAGE.md`](BUILD_PACKAGE.md) — the action that consumes this file.
- [`BUILD_MANIFEST.md`](BUILD_MANIFEST.md) — how `externalMods` overrides flow into `manifest.mods[i].source`.
- [`PACKAGE_ZIP.md`](PACKAGE_ZIP.md) — how `bundledArchives` are staged and 7z'd into the `.ehcoll`.
- [`../PROPOSAL_INSTALLER.md`](../PROPOSAL_INSTALLER.md) §10 — why this is a JSON file and not a UI.
