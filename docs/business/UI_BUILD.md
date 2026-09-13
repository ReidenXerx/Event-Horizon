# UI Build Wizard — Phase 5.3

The curator-side React UI. Replaces the legacy `buildPackageAction.ts` dialog chain with a 4-step wizard: load context → fill the form → build → done. Wraps the existing build pipeline (snapshot → manifest → package) without duplicating logic — every core call still goes through `core/`.

> **Status:** shipped — the `build` route renders the wizard. The legacy toolbar entry (`Event Horizon: Build (legacy dialog)`) remains as a known-good fallback.

---

## Trigger

| Source | What happens |
|---|---|
| User clicks the **Build** tab in the EH nav | Mounts `<BuildPage>` |
| User clicks the **Build a collection** CTA on the dashboard | Same |
| User clicks **Build another** on the wizard's done step | Re-enters via `setState({ kind: "loading" })` (re-runs `loadBuildContext`) |

The page does not accept parameters. Curator state lives in the on-disk per-collection config file (`<appData>/Vortex/event-horizon/collections/.config/<slug>.json`); the page just loads it.

## Preconditions

- Active game is one of the supported set (`skyrimse`, `fallout3`, `falloutnv`, `fallout4`, `starfield`).
- The active profile for that game is the one the curator wants to capture — there is no profile picker.
- Vortex 1.x with `util.SevenZip` available (the packager calls 7z under the hood; see `PACKAGE_ZIP.md`).
- The standard provider stack (api / errors / toasts).

## Inputs

| Source | Used for |
|---|---|
| `useApi()` | All Vortex state reads + the build pipeline call |
| `loadBuildContext(api)` | Pre-flight: active game + profile, hashed mods, loaded/created collection config, default form values |
| `runBuildPipeline(api, ctx, curator, overrides)` | The actual build — see below |
| User form input (`CuratorInput`) | Name / version / author / description |
| User per-mod overrides (`Record<modId, ExternalModConfigEntry>`) | The bundled flag + instructions per external mod |
| User-supplied README and CHANGELOG markdown | Saved into the config and embedded into the package |

## Behavior

### 1. State machine

```
loading        ←─────────── (build another)
  ↓ ctx ready
form
  ↓ Build
building
  ↓ result
done
```

`error` is a fifth state, reachable from any of the above:
- From `loading` if `loadBuildContext` throws.
- From `form` if the user submits an invalid input or `runBuildPipeline` throws.
- The error state's `previous` field is the form state (so "Try again" can repopulate the form rather than re-running the loading pipeline).

The page tracks `stepIndex` (0…3) for the `StepDots` indicator at the top.

### 2. The loading state

`useEffect` on mount runs `loadBuildContext(api, { onProgress })`:

| Phase reported | What runs |
|---|---|
| `hashing-mods` | `enrichModsWithArchiveHashes(state, gameId, rawMods, { concurrency: 4 })` |

`loadBuildContext` then:
1. Reads `getActiveGameId(state)` + `getActiveProfileIdFromState(state, gameId)`. Throws on either failure with an actionable message.
2. Hashes every mod in the active profile.
3. Filters non-Nexus mods into `externalMods` (the only mods that can be bundled).
4. Computes a `slug` from `defaultName` (initially `"My Collection"`).
5. Calls `loadOrCreateCollectionConfig({ configDir, slug })`, which either reads `<configDir>/<slug>.json` or creates a fresh config with a synthesized `package.id`. Reports whether the file was newly created (`configCreated: true`) so the form can hint about lineage.
6. `reconcileExternalModsConfig` — if the active profile has external mods that aren't in the config, append default `{ bundled: false, instructions: "" }` entries. Saves on change so re-loading next time is in sync.
7. Returns a `BuildContext` containing all the form-population fields.

`LoadingPanel` shows the progress ring + the latest phase message ("Hashing 47 mod archives…").

### 3. The form state

When the context resolves, the page enters the `form` state with:

```ts
{
  kind: "form",
  ctx,                                      // BuildContext (mods, externalMods, collectionConfig, …)
  curator: { name, version, author, description },  // pre-populated from defaults
  overrides: { ...ctx.collectionConfig.externalMods }, // copied so edits don't mutate the loaded config
  readme: ctx.collectionConfig.readme ?? "",
  changelog: ctx.collectionConfig.changelog ?? ""
}
```

The form layout:

| Region | Contents |
|---|---|
| Game info card | Active game id (with "supported" pill), active profile id, mod count, external mod count, config path, "config created" pill if first run |
| Metadata fields | Name, Version, Author, Description (all `eh-input`); error helper text below the field that failed validation |
| External mods table | One row per `ctx.externalMods[i]`: name, mod-id (monospace), `bundled` checkbox, `instructions` textarea |
| README / CHANGELOG | Two `eh-input--textarea` fields, monospace, side-by-side on wide screens |
| Footer | "Build" (primary) + "Cancel" (ghost; navigates back to dashboard) |

Editing any field calls `handleChange` which clears `validationError` so the helper text disappears as soon as the user starts to fix it.

### 4. Validation (`validateCuratorInput`)

Before transitioning to `building`, the page runs `validateCuratorInput(curator)`:

| Rule | Error |
|---|---|
| `name.trim().length === 0` | "Collection name cannot be empty." |
| `author.trim().length === 0` | "Author cannot be empty." |
| `version` doesn't match `^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$` | "Version 'X' doesn't look like semver. Try e.g. '1.0.0' or '0.2.1-beta.1'." |

Per-mod overrides are **not** validated here — the engine's `resolveBundledArchives` does the bundling sanity checks (Nexus mods can't be bundled, bundled mods need an `archiveSha256`, etc.) and surfaces them as a `BundleResolutionError` thrown later.

### 5. The building state (`runBuildPipeline`)

When the user clicks Build:

1. Page transitions to `{ kind: "building", progress: { phase: "writing-config" } }`.
2. `runBuildPipeline(api, ctx, curator, overrides, { onProgress })` runs the full pipeline:

| Progress phase | Work |
|---|---|
| `writing-config` | Slug from `curator.name`. If renamed, `loadOrCreateCollectionConfig` for the new slug; else reuse the existing config. Apply form overrides on top. `saveCollectionConfig` to persist before the actual build (so a build crash leaves the config saved). |
| `capturing-deployment` | `captureDeploymentManifests(api, state, gameId)` — see `FILE_OVERRIDES_CAPTURE.md` |
| `capturing-load-order` | `captureLoadOrder(state, gameId)` — see `ORDERING.md` |
| `reading-plugins-txt` | Best-effort read of the game's `plugins.txt` (passed verbatim into `buildManifest`) |
| `building-manifest` | `buildManifest({ snapshot, package, game, vortex, pluginsTxtContent, externalMods, externalDependencies })` — see `BUILD_MANIFEST.md` |
| `resolving-bundled-archives` | Walks `config.externalMods` looking for `bundled === true` rows, locates each archive on disk, throws `BundleResolutionError` on any mismatch (mod missing, mod is Nexus, no archiveSha256, file disappeared) |
| `packaging` | `packageEhcoll({ manifest, bundledArchives, readme, changelog, outputPath })` — see `PACKAGE_ZIP.md` |

3. On success, the page receives `{ outputPath, outputBytes, bundledCount, modCount, warnings }` and transitions to `done`. A success toast also fires: "Built X v1.0.0 — N mods, S bytes."
4. On any throw, the page transitions to `error` with `previous: formState` so retrying re-enters the form with the same input.

The output filename is `${slug}-${version}.ehcoll` (slugified, lower-cased). Output dir is `<appData>/Vortex/event-horizon/collections/`.

### 6. The done state

Layout:

| Region | Contents |
|---|---|
| Outcome card | Success pill, "Built X v1.0.0", file path (monospace, click-to-copy) |
| Stats grid | Mod count, bundled count, output size, warning count |
| Warnings list | Collapsed by default; expands to show every non-fatal warning from `buildManifest` + `packageEhcoll` |
| Action row | **Open package** (calls `openShellPath(outputPath)`) · **Open folder** (calls `openShellPath(dirname(outputPath))`) · **Build another** (re-enters loading) · **Done** (navigates home) |

`openShellPath` is a defensive helper that `require("electron")`s and calls `shell.openPath`; if Electron is unreachable (very rare) it surfaces a toast instead of throwing.

### 7. The error state

A small `ErrorPanel` with:
- The card title taken from the formatted error.
- A short paragraph saying "the full report is open in the error panel — copy / save before retrying".
- A "Try again" button that reverts to `state.previous` if available, else re-enters `loading`.

The full classified error (e.g. `BuildManifestError`, `PackageEhcollError`, `BundleResolutionError`, `CollectionConfigError`) is already surfaced through the global `ErrorReportModal` thanks to `formatError`'s named-class branches.

## Outputs

| Output | When | Path |
|---|---|---|
| Updated collection config | Always before packaging starts | `<appData>/Vortex/event-horizon/collections/.config/<slug>.json` |
| The `.ehcoll` package | On successful build | `<appData>/Vortex/event-horizon/collections/<slug>-<version>.ehcoll` |
| Reconciled config (on first load if external mods drifted) | During `loadBuildContext` | Same config file as above |
| Success toast | After the package writes | UI |
| Global error modal | On any thrown error | UI |

The page does **not** delete the previous `.ehcoll` for the same collection — both versions sit side by side, and "what's current" is decided by the curator at distribution time.

## Failure modes

| Symptom | Likely cause | Mitigation |
|---|---|---|
| Loading panel hangs on "Hashing 47 mod archives…" | A very large archive blocks one of the 4 concurrent hash workers | Wait it out — there is no abort button. Hashing is bounded. |
| Form opens but external mods table is empty | The active profile genuinely has only Nexus mods | Expected; bundled toggles only apply to non-Nexus mods. |
| `BundleResolutionError` on Build with "Config flags Nexus mod X as bundled" | An older config has a stale `bundled: true` for a mod that's now Nexus-tagged | Untick bundled on that row in the form, click Build again. |
| `BundleResolutionError` with "modId X is not in the active profile" | The user removed a mod between loading the form and clicking Build | Reload the page (Build → Build) so the table re-reconciles. |
| Build seems stuck in the "packaging" phase | Very large bundled mods: every staged file is read again to prove it still makes the mod's identity, then 7z compresses the loose files | The progress line says which step and how far it is; wait. |
| Build fails listing files that "are archives" | A bundled or mirrored mod contains a file that is itself an archive (.zip, .7z, .rar, a zip-based document…); Nexus quarantines a package with an archive inside | Extract it into its mod's folder, delete it if the mod does not need it, or stop bundling or mirroring that mod; rebuild. |
| Build fails: "its files changed after this build measured them" | A file in a bundled mod changed while the build was running (for example during the decisions step) | Rebuild. If nothing changed, tick "Re-read every file" first. |
| "Version doesn't look like semver" | The version field has e.g. `v1` or `1.0` | Use `1.0.0` form. |
| The output is suspiciously small | The curator forgot to flag any external mods as bundled | Look at "Bundled count" on the done step — if 0, the package is metadata-only. Re-build with bundled rows ticked. |
| `CollectionConfigError` thrown during `loadBuildContext` | A hand-edited config JSON is invalid | Open the config file, fix it (or delete it for a fresh start). The error modal points at the file. |
| The same collection name produces a brand new `package.id` between sessions | The slug changed between runs (e.g. punctuation diff) | The config file is keyed by slug; renaming = forking. Stick to one canonical name to keep lineage. See `COLLECTION_CONFIG.md`. |

## Quirks & invariants

- **INVARIANT: `package.id` is owned by the config file, not the form.** The curator can rename the collection in the form and the *new* slug's config gets a fresh `package.id`. The original slug's config is untouched. This matches the legacy action's behavior — see `COLLECTION_CONFIG.md`.
- **INVARIANT: the build engine never reads the UI state.** `runBuildPipeline` takes plain values (`ctx`, `curator`, `overrides`) and is invocable from non-React code. The legacy action calls the same lower-level functions.
- **INVARIANT: hashing happens once.** `loadBuildContext` enriches the mod list and `runBuildPipeline` reuses the same array. Re-hashing during the build would double the wait time for large profiles.
- **INVARIANT: every external mod row is reconciled at load time.** Curators never have to manually add rows for new external mods.
- **The form's `overrides` map is a shallow copy of the loaded config's `externalMods`.** Edits to the form don't touch the loaded config object — the engine merges them on save.
- **The validator gates only the curator-input fields.** Per-mod sanity is the engine's job because it has access to the live mod state. Surfacing engine errors back as inline form errors is acknowledged future work.
- **The "Open package" / "Open folder" buttons rely on Electron.** They no-op (with a toast) if Electron is somehow unavailable.
- **No "save and close" — every Build saves the config.** Closing the page after editing the form without clicking Build does **not** persist the field edits. Curators learn this quickly. Worth adding an explicit "Save draft" button if testers complain.
- **QUIRK:** `runBuildPipeline` passes `externalDependencies: []` because the v1 schema marks the field optional and the form has no UI for it yet. Curators wanting to declare external dependencies must hand-edit the manifest after build, which defeats the purpose. Acknowledged gap.
- **QUIRK:** README / CHANGELOG are markdown-as-string. There's no preview pane in the form. The eventual install-side preview will render them; for now, curators preview by opening the built `.ehcoll` and reading `README.md` / `CHANGELOG.md`.

## Acknowledged gaps

- **No external-dependencies UI.** Curators can't yet list external dependency packages from the form.
- **No "preview manifest" button.** Would let curators sanity-check the manifest before packaging. Trivial to add — the manifest is already in memory.
- **No "save draft" button.** Field edits are only persisted when Build runs.
- **No rule-editing UI.** `manifest.modRules` is generated automatically from the active profile's rules; curators can't add/remove rules from the wizard. Hand-edit the config or the manifest if needed.
- **No FOMOD selection editor.** Same as rules — captured automatically, not editable.
- **No file-overrides editor.** Same.
- **No "version bump" helper.** Curators type the version manually. A bump-major / bump-minor / bump-patch trio next to the version field would be nice.
- **No localization.**
- **No estimate of bundled-archive size before Build.** "How big is this collection going to be?" requires running the build. Adding a precompute is straightforward but not done yet.
- **The form doesn't surface `manifestWarnings` until Done.** Warnings such as "loadOrder.dataDir is empty" only appear after the build completes. Good for tester throughput; bad for tight feedback loops.

## Code references

| File | What it owns |
|---|---|
| `src/ui/pages/build/BuildPage.tsx` | The wizard shell, state machine, loading / form / building / done / error panels, header with `StepDots`, `openShellPath`, `formatBytes` |
| `src/ui/pages/build/engine.ts` | `loadBuildContext`, `runBuildPipeline`, `validateCuratorInput`, `BundleResolutionError`, internal helpers (`isNexusMod`, `resolveBundledArchives`, `readPluginsTxtIfPresent`, `slugify`, `buildOutputFileName`, etc.) |
| `src/core/getModsListForProfile.ts` | `getActiveGameId`, `getActiveProfileIdFromState`, `getModsForProfile` |
| `src/core/archiveHashing.ts` | `enrichModsWithArchiveHashes`, `getModArchivePath` — see `ARCHIVE_HASHING.md` |
| `src/core/deploymentManifest.ts` | `captureDeploymentManifests` — see `FILE_OVERRIDES_CAPTURE.md` |
| `src/core/loadOrder.ts` | `captureLoadOrder` — see `ORDERING.md` |
| `src/core/comparePlugins.ts` | `getCurrentPluginsTxtPath` (used by the engine's plugins.txt read) |
| `src/core/manifest/buildManifest.ts` | `buildManifest` — see `BUILD_MANIFEST.md` |
| `src/core/manifest/packageZip.ts` | `packageEhcoll`, `BundledArchiveSpec` — see `PACKAGE_ZIP.md` |
| `src/core/manifest/collectionConfig.ts` | `loadOrCreateCollectionConfig`, `reconcileExternalModsConfig`, `saveCollectionConfig`, `toBuildManifestExternalMods` — see `COLLECTION_CONFIG.md` |
| `src/types/installLedger.ts`, `src/types/ehcoll.ts` | Shared types for game/profile ids and config shapes |
| `src/actions/buildPackageAction.ts` | The legacy toolbar action — same call sequence, dialog-based UI |

## Relationship to the rest of the system

The Build wizard is one of two consumers of the snapshot / manifest / package pipeline; the legacy `buildPackageAction` is the other. Both call into the same `core/manifest/` modules. Splitting the engine into `loadBuildContext` + `runBuildPipeline` lets the React UI pre-populate the form before the curator clicks Build, and lets a future automation entry point (CLI, headless test) skip the form entirely.

The dashboard's curator panel (see `UI_DASHBOARD.md`) lists the most recent built `.ehcoll` files and the most recently modified configs by reading the same `<appData>/Vortex/event-horizon/collections/` directory the wizard writes to.
