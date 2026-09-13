# Build Event Horizon Collection — toolbar action

**Source of truth:** `src/actions/buildPackageAction.ts` (Phase 2 slice 4a + 4b).
**Upstream stages:** [`BUILD_MANIFEST.md`](BUILD_MANIFEST.md), [`PACKAGE_ZIP.md`](PACKAGE_ZIP.md), [`COLLECTION_CONFIG.md`](COLLECTION_CONFIG.md).

> ⚠️ **Transitional UI.** The Vortex `showDialog` for curator metadata, the toolbar button itself, and the "open the JSON config file by hand" workflow added in slice 4b are all **scaffolding**. Phase 5 introduces a dedicated Event Horizon page (custom React `mainPage`) that replaces every dialog with a proper build panel. The **business logic** (`buildManifest`, `packageEhcoll`, the per-collection config file shape) is permanent and stays unchanged when the React UI lands. See [`../PROPOSAL_INSTALLER.md`](../PROPOSAL_INSTALLER.md) §10 "Transitional UI vs Phase 5 UI" for the rationale.

## Trigger

Toolbar button **"Build Event Horizon Collection"** registered via
`context.registerAction("global-icons", 102, ...)` in `src/index.ts`.

## Preconditions

| Check | On failure |
|---|---|
| Vortex has an active game | `Error("No active game found")`, error notification, abort. |
| Active game is one of `skyrimse`, `fallout3`, `falloutnv`, `fallout4`, `starfield` | Error notification listing supported games, abort. |
| Active profile exists for the active game (with two-pass fallback — see [`PROFILE_RESOLUTION.md`](PROFILE_RESOLUTION.md)) | `Error("No profile found for game <id>")`, abort. |

## Inputs

| Input | Source | Treatment |
|---|---|---|
| Collection name | Curator dialog (text) | Required, non-empty after trim. |
| Version | Curator dialog (text) | Required. Lightweight semver check `^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$`. |
| Author | Curator dialog (text) | Required, non-empty after trim. |
| Description | Curator dialog (multiline) | Optional. Empty string ⇒ `description: undefined` in manifest. |
| Mods snapshot | Vortex Redux state via existing pipeline | Same as the export action. |
| Archive SHA-256s | `enrichModsWithArchiveHashes` | Same as the export action. Mods missing a hash will fail in `buildManifest`. |
| Deployment manifests | `captureDeploymentManifests` | Same as the export action. |
| Load order | `captureLoadOrder` | Same as the export action. |
| `plugins.txt` content | `getCurrentPluginsTxtPath` + `fs.readFile` | Optional. Missing file or unsupported game ⇒ `pluginsTxtContent: undefined`, manifest emits `plugins.order: []`. |
| `package.id` | Persisted in per-collection config file (`<configDir>/<slug>.json`) | **Slice 4b**: stable across rebuilds of the same slug. First build of a slug = fresh UUIDv4 written to the file. Renaming the collection ⇒ new slug ⇒ new file ⇒ new release lineage. See [`COLLECTION_CONFIG.md`](COLLECTION_CONFIG.md). |
| External-mod overrides (`bundled` / `instructions`) | Per-collection config file (auto-populated stubs on first build) | **Slice 4b**: curator hand-edits `<configDir>/<slug>.json` between builds. Phase 5 React UI replaces the hand-edit step. |
| Bundled mods | Measured from each mod's staging folder by `measureBundledMods` | **Slice 4b**: any external mod with `bundled: true` in the config ships its staging folder's files, loose, inside the `.ehcoll` — never its source archive. Failures (mod not in profile, a Nexus mod not marked external, a staging folder that could not be measured) accumulate into one `BundleResolutionError`. |
| README / CHANGELOG | Per-collection config file | **Slice 4b**: optional `readme` / `changelog` fields in the JSON. When non-empty, written as `README.md` / `CHANGELOG.md` at the package root. |
| Vortex version | `state.app.appVersion ?? state.app.version ?? "unknown"` | Best-effort. `"unknown"` is a valid (per-schema) string. |
| Game version | `state.persistent.gameSettings[gameId].version` ?? `state.settings.gameMode.discovered[gameId].version` ?? `"unknown"` | Best-effort. Phase 5 may add a real per-game version resolver. |
| Deployment method | `state.settings.mods.activator[gameId]` mapped to `hardlink`/`symlink`/`copy` | Defaults to `hardlink` (Vortex's default). Informational only — the user-side installer respects whatever the user has configured. |
| External dependencies | None | **Phase 3+** input. |

## Behavior

1. Read state, resolve `gameId` + `profileId`. Abort early on misses (see Preconditions).
2. Refuse if `gameId` is not in the supported set.
3. **Show curator dialog** (`api.showDialog`) collecting name / version / author / description in a single modal.
   - On **Cancel** (or any non-"Build" button): silent exit. No notification.
   - On **Build**: validate inputs. If anything fails, show an error dialog explaining the problem and re-prompt with the previous values pre-filled (curator does not lose typing).
4. Run the existing snapshot pipeline:
   - `getModsForProfile` → raw `AuditorMod[]`.
   - Show "Hashing N mod archives..." activity notification.
   - `enrichModsWithArchiveHashes` (concurrency 4) → mods with `archiveSha256` populated where possible.
   - Dismiss the hashing notification.
   - `captureDeploymentManifests` → per-modtype deployment manifests.
   - `captureLoadOrder` → per-game load order.
   - `readPluginsTxtIfPresent(gameId)` → `plugins.txt` contents or `undefined`.
5. **Slice 4b — load per-collection state file:**
   - Compute `slug` from curator's name. Compute `configDir = <appData>/Vortex/event-horizon/collections/.config`.
   - `loadOrCreateCollectionConfig({ configDir, slug })` → `{ config, created, configPath }`. First build of a slug ⇒ fresh UUIDv4 written to disk; subsequent builds reuse it. See [`COLLECTION_CONFIG.md`](COLLECTION_CONFIG.md).
   - `reconcileExternalModsConfig({ config, externalMods })` walks the snapshot's external mods and adds stub `{ name, bundled: false, instructions: "" }` entries for any newcomers, refreshes `name` hints on existing entries.
   - If reconciliation changed anything, persist the updated config via `saveCollectionConfig`. Curators who hand-edit the file see every external mod pre-listed by name on the next open.
6. Build the in-memory `ExportedModsSnapshot` and call `buildManifest` with:
   - Curator metadata (name/version/author/description).
   - `package.id` from `config.packageId`.
   - `externalMods` from `toBuildManifestExternalMods(config)` (strips `name` hints, passes `bundled` + `instructions`).
   - State-derived fields (`game.version`, `vortex.version`, `vortex.deploymentMethod`).
7. Compute output path: `%APPDATA%\Vortex\event-horizon\collections\<slug>-<safe-version>.ehcoll`.
   - Slug: lowercase the name, replace runs of non-alphanumerics with `-`, trim leading/trailing `-`, cap at 64 chars. Empty slug falls back to `"collection"`.
   - Safe-version: any character outside `[a-zA-Z0-9.-]` becomes `-`.
8. **Slice 4b — resolve bundled mods:**
   - Walk `config.externalMods` for entries with `bundled: true`.
   - For each: look up the matching `AuditorMod` from the snapshot, verify it's still present, verify it may be bundled (a Nexus mod only once marked external), and take the bundle `measureBundledMods` measured from its staging folder. A mod that could not be measured is refused with the reason. Each problem is accumulated in a list; at the end, if non-empty, throw `BundleResolutionError` with every entry. The build aborts before staging anything.
9. Call `packageEhcoll` with the resolved `bundles` + `config.readme` + `config.changelog` (when non-empty).
10. **On success:**
    - One-line `console.log` summary including bundled count, output bytes, warning count, and the `(NEW)` marker if the config file was just created.
    - Each warning from `buildManifest` and `packageEhcoll` is `console.warn`'d with the `[Vortex Event Horizon]` prefix.
    - Success notification: "Built `<name>` v`<version>` (`<count>` mods[, `<bundled>` bundled], `<bytes>`)" with **Open Package** / **Open Folder** / **Open Config** actions.

## Outputs

| Output | Where | Format |
|---|---|---|
| Collection package | `%APPDATA%\Vortex\event-horizon\collections\<slug>-<version>.ehcoll` | ZIP (see [`PACKAGE_ZIP.md`](PACKAGE_ZIP.md)). |
| Per-collection state file | `%APPDATA%\Vortex\event-horizon\collections\.config\<slug>.json` | JSON (see [`COLLECTION_CONFIG.md`](COLLECTION_CONFIG.md)). Created on first build, mutated only when reconciliation adds stubs. |
| Console diagnostics | Devtools console | `[Vortex Event Horizon] Built collection package | <name> v<version> | mods=N | rules=N | fileOverrides=N | plugins=N | bundled=N | bytes=B | warnings=N | configFile=<path>[ (NEW)]` |
| Console warnings | Devtools console | One `console.warn` per `BuildManifestResult.warnings` and `PackageEhcollResult.warnings` entry. |
| Success notification | Vortex | "Built `<name>` v`<version>` (`<count>` mods[, `<bundled>` bundled], `<bytes>`)" + Open Package / Open Folder / Open Config actions. |
| Error notification | Vortex | `Build failed: <message>` where `<message>` lists every problem when the underlying error is `BuildManifestError` / `PackageEhcollError` / `BundleResolutionError` / `CollectionConfigError`. |

## Failure modes

- **No active game** ⇒ error notification, no .ehcoll written, no staging dir created.
- **Unsupported game** ⇒ error notification, no .ehcoll written.
- **No active profile** ⇒ error notification.
- **Curator hits Cancel** ⇒ silent exit, no notification, no .ehcoll written. Hashing notification is dismissed in `finally`.
- **Curator validation failure** ⇒ error dialog re-prompt with values preserved. No state mutation.
- **Per-collection config malformed** (`CollectionConfigError`) ⇒ error notification listing every problem. The action does NOT auto-overwrite the file (would discard curator edits). Curator must fix it manually. See [`COLLECTION_CONFIG.md`](COLLECTION_CONFIG.md) failure-modes table.
- **Bundled-archive resolution fails** (`BundleResolutionError` — config flags a mod for bundling that's not in the profile, is a Nexus mod, has no SHA, or whose archive is missing on disk) ⇒ error notification listing every problem. Build aborts before any staging.
- **Manifest build fatal** (`BuildManifestError` — e.g. mod missing `archiveSha256`, duplicate compareKey) ⇒ error notification listing every problem. Hashing notification is dismissed in `finally`.
- **Package build fatal** (`PackageEhcollError` — e.g. SHA-256 format violation, manifest/archives mismatch) ⇒ error notification listing every problem.
- **`plugins.txt` read fails** with anything other than `ENOENT` ⇒ error bubbles up. (We swallow `ENOENT` because some games legitimately don't have one.)
- **Vortex/PC crash mid-build** ⇒ staging directory inside the OS temp dir is best-effort cleaned up on the next run by the OS; a crash mid-pack leaves `<name>.ehcoll.partial` beside the package, never a half-written `.ehcoll`, and the next build of that version removes it before 7-Zip starts. The per-collection config file is written atomically before any packaging starts, so a crash mid-pack doesn't corrupt it.

## Quirks & invariants

- **INVARIANT:** the action handler is the *only* place state-reading and disk I/O are mixed in. `buildManifest` and `packageEhcoll` stay pure / I/O-only respectively. `collectionConfig` exposes pure helpers (`reconcileExternalModsConfig`, `toBuildManifestExternalMods`) alongside its I/O ones (`loadOrCreateCollectionConfig`, `saveCollectionConfig`). Tests can hit any of these with hand-rolled fixtures.
- **INVARIANT:** the hashing activity notification is dismissed in `finally`, regardless of success or failure. (Same pattern we already use in `exportModsAction` after the slice 1 bug fix.)
- **INVARIANT:** Cancel produces no error notification. Curators who change their mind shouldn't see a "build failed" toast.
- **INVARIANT:** `package.id` is stable across rebuilds of the same slug. The first build of a slug writes the id to disk; every subsequent build reads it.
- **INVARIANT:** Bundled-archive resolution is fail-fast and accumulates every problem before throwing. The curator gets one report listing every misconfigured entry, not whack-a-mole.
- **QUIRK:** Renaming the collection produces a new slug ⇒ new config file ⇒ new UUID ⇒ new release lineage. Curators who really want to preserve the UUID across a rename can manually rename the JSON file before the next build. Phase 5 may decouple identity from name.
- **QUIRK:** `archiveName` for Nexus mods is the curator's mod name (buildManifest's fallback). Slice 4b doesn't plumb real download filenames yet — that's a Phase 5 enhancement. Field is informational, not used for identity.
- **QUIRK:** Game version may legitimately be `"unknown"`. The schema accepts any string for `game.version`; the `versionPolicy: "exact"` default still works as long as the user-side installer resolves the same `"unknown"` (it won't — this is a known v1 limitation that Phase 3+ will address with a real per-game version resolver).
- **QUIRK:** The config file's `externalMods` keeps stale entries forever (a mod removed from the profile keeps its config entry). Cleanup is deferred — losing curator-typed instructions to a transient profile change is the worse failure mode.

## Code references

- `src/actions/buildPackageAction.ts` — full handler.
- `src/index.ts` lines registering the toolbar button (priority 102).
- `src/core/manifest/buildManifest.ts` — pure converter the action calls.
- `src/core/manifest/packageZip.ts` — packager the action calls.
- `src/core/manifest/collectionConfig.ts` — per-collection state file (load/save/reconcile/validate).
- Reused from existing pipeline: `getActiveGameId`, `getActiveProfileIdFromState`, `getModsForProfile`, `enrichModsWithArchiveHashes`, `getModArchivePath`, `captureDeploymentManifests`, `captureLoadOrder`, `getCurrentPluginsTxtPath`, `openFile`, `openFolder`.

## See also

- [`COLLECTION_CONFIG.md`](COLLECTION_CONFIG.md) — the per-collection state file this action loads/saves.
- [`BUILD_MANIFEST.md`](BUILD_MANIFEST.md) — the converter this action calls.
- [`PACKAGE_ZIP.md`](PACKAGE_ZIP.md) — the packager this action calls.
- [`EXPORT_MODS.md`](EXPORT_MODS.md) — the action whose pipeline we reuse.
- [`../PROPOSAL_INSTALLER.md`](../PROPOSAL_INSTALLER.md) §8 — the curator flow this implements.
