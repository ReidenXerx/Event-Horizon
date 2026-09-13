# Architecture

A small TypeScript extension organized as **entry → actions → core → utils**. No global state of its own; reads everything from Vortex's Redux state via the API's `selectors`.

> Throughout this document "the Vortex API" / `vortex-api` refers to the package imported as
> **`@nexusmods/vortex-api`**. The unscoped `vortex-api` name still resolves at runtime — Vortex's
> loader accepts both ids — but the scoped name is what this codebase imports, and the old
> `github:Nexus-Mods/vortex-api` dependency points at an archived repo.

## File layout

```
src/
├── index.ts                              # Vortex entry — main page + 5 toolbar actions
├── actions/
│   ├── exportModsAction.ts               # Action handler: snapshot mods → JSON
│   ├── compareModsAction.ts              # Action handler: diff current vs reference JSON
│   ├── comparePluginsAction.ts           # Action handler: diff plugins.txt vs reference
│   ├── buildPackageAction.ts             # Action handler: snapshot pipeline → buildManifest → packageEhcoll → .ehcoll (Phase 2 slice 4a + 4b)
│   └── installCollectionAction.ts        # Action handler: file pick → readEhcoll → readReceipt → buildUserSideState → resolveInstallPlan → preview → runInstall
├── core/
│   ├── getModsListForProfile.ts          # Selectors + AuditorMod normalization (FOMOD, rules, fileOverrides, installOrder)
│   ├── archiveHashing.ts                 # Streaming SHA-256 + archive-path resolver + bulk enricher
│   ├── deploymentManifest.ts             # Per-modtype Vortex deployment manifest capture
│   ├── loadOrder.ts                      # Vortex LoadOrder API capture (per-game)
│   ├── exportMods.ts                     # exportModsToJsonFile — writes snapshot
│   ├── comparePlugins.ts                 # plugins.txt parser + diff + writer
│   └── manifest/
│       ├── buildManifest.ts              # Pure ExportedModsSnapshot → EhcollManifest converter (Phase 2)
│       ├── parseManifest.ts              # Pure manifest.json text → EhcollManifest validator (Phase 3 slice 1)
│       ├── packageZip.ts                 # EhcollManifest + bundled archives → .ehcoll ZIP packager (Phase 2)
│       ├── readEhcoll.ts                 # .ehcoll ZIP file → manifest + layout reader (Phase 3 slice 2)
│       ├── sevenZip.ts                   # Typed shim over vortex-api's util.SevenZip (node-7z)
│       └── collectionConfig.ts           # Per-collection state file: persisted package.id, per-mod overrides, README/CHANGELOG (Phase 2 slice 4b)
│   ├── resolver/
│   │   ├── resolveInstallPlan.ts         # Pure resolver: (manifest, userState, installTarget) → InstallPlan (Phase 3 slice 4)
│   │   └── userState.ts                  # Pure UserSideState builder + pickInstallTarget + Vortex-state shape readers (Phase 3 slice 5)
│   ├── installer/
│   │   ├── runInstall.ts                 # Install driver orchestrator — runs an InstallPlan, fresh- or current-profile
│   │   ├── profile.ts                    # Vortex profile create/switch/enable-mod helpers
│   │   ├── modInstall.ts                 # Mod install primitives: nexusDownload / start-install / bundled-archive extract; hang-watchdog input signal
│   │   ├── verifyModInstall.ts           # Post-install SHA-256 check → matches | differs | damaged | unknown
│   │   ├── checkArchiveIdentity.ts       # Same four verdicts for a user-picked archive
│   │   ├── purgeUserRules.ts             # Back up, then CLEAR the user's mod rules + LOOT userlist
│   │   ├── applyModRules.ts              # Apply the collection's mod rules
│   │   ├── applyUserlist.ts              # Apply the collection's LOOT userlist
│   │   ├── applyPluginOrder.ts           # Pin the curator's plugin order via Vortex; integrate the user's extras LOOT-style
│   │   ├── applyPluginLightFlags.ts      # Restore ESL/light flags (TES4 header bit 0x200)
│   │   ├── checkPluginOrder.ts           # Read the resulting order back from disk
│   │   ├── detectStagingDrift.ts         # Drift vs OUR previous install, over the manifest's tracked paths only
│   │   └── timeBudgets.ts                # Size- and platform-aware stall budgets (Proton gets more headroom)
│   └── installLedger.ts                  # On-disk receipt CRUD: <appData>/Vortex/event-horizon/installs/<package.id>.json
├── types/
│   ├── ehcoll.ts                         # .ehcoll manifest type schema (Phase 2 contract; type-only, no runtime)
│   ├── installPlan.ts                    # Resolver input/output contract: UserSideState + InstallPlan (Phase 3 slice 3; type-only, no runtime)
│   ├── installDriver.ts                  # Driver contract: DriverContext, DriverProgress, DriverPhase, InstallResult (type-only, no runtime)
│   └── installLedger.ts                  # Install-receipt schema (Phase 3 slice 5b; type-only, no runtime)
├── utils/
│   └── utils.ts                          # File pickers, openFile/openFolder, mod diff engine
└── scripts/
    └── deploy-to-vortex.js               # Copies dist/ into Vortex plugins folder
```

The compiled output lives in `dist/`; `index.js` at the repo root is the loader Vortex sees, which simply re-exports `./dist`.

## Layer responsibilities

### Entry — `src/index.ts`
- Implements Vortex's `init(context: types.IExtensionContext): boolean`.
- Constructs five handler closures and binds them to toolbar actions via `context.registerAction("global-icons", priority, ...)`.
- All actions are fire-and-forget (`void handler()`); errors are caught inside the handler and surfaced via `context.api.sendNotification`.

### Actions — `src/actions/*`
Each action follows the same shape:

1. Read state with `context.api.getState()`.
2. Resolve `gameId` (and for mod actions, `profileId`); throw if missing.
3. Read user input via an electron file picker (or skip — this is the export case).
4. Call into `core/` to do real work.
5. Compute output dir as `util.getVortexPath("appData") + "event-horizon/<subdir>"`.
6. `console.log` a one-line summary, then `sendNotification` with **Open Diff** / **Open Folder** actions wired through `openFile` / `openFolder`.
7. On error: notification + `console.error`.

This means the actions are **purely orchestration** — no business logic.

`buildPackageAction.ts` is a slightly fatter orchestrator: it gates on supported gameIds, runs a curator-metadata dialog (with re-prompt on validation failure, silent exit on Cancel), reuses the entire snapshot pipeline (`getModsForProfile` + `enrichModsWithArchiveHashes` + `captureDeploymentManifests` + `captureLoadOrder` + `getCurrentPluginsTxtPath`), wires everything into `buildManifest` + `packageEhcoll`, and writes one `.ehcoll` to `%APPDATA%\Vortex\event-horizon\collections\<slug>-<version>.ehcoll`. **Slice 4a is intentionally minimal** — every external mod uses defaults, `package.id` is freshly generated each build, and there is no README/CHANGELOG input. Slices 4b/4c add the per-mod table, README/CHANGELOG textareas, and `package.id` persistence. Full prose contract: [`docs/business/BUILD_PACKAGE.md`](business/BUILD_PACKAGE.md).

`installCollectionAction.ts` is the user-side counterpart, and it is the **legacy dialog path** — the React install wizard is the supported UX; this one is kept as a scriptable fallback. The orchestration is: (1) `pickEhcollFile` → `.ehcoll` path, (2) `readEhcoll` for the typed manifest, (3) early game-id gate (no active game / unsupported game / manifest game mismatch all bail before hashing), (4) `readReceipt(appDataPath, manifest.package.id)` for cross-release lineage, (5) snapshot pipeline (`getModsForProfile` + `enrichModsWithArchiveHashes` with the activity notification/finally pattern), (6) `scanAvailableDownloads`, (7) `buildUserSideState`, (8) `pickInstallTarget` (the load-bearing receipt-vs-no-receipt rule lives there), (9) `resolveInstallPlan`, (10) a `showDialog` rendering verdict + install target + summary counts + compatibility report + per-decision-kind buckets, (11) on confirm, `runInstall(...)` with progress as a single activity notification and a final result dialog.

> Step 6 is not decoration. `availableDownloads` used to be scanned in the engine pipeline only, and passed as `undefined` here — so a resume driven through this path could never find a download the user already had. One scanner in `core/resolver/scanAvailableDownloads.ts` is imported by both call sites; do not copy it.

Full prose contract: [`docs/business/INSTALL_ACTION.md`](business/INSTALL_ACTION.md).

### Core — `src/core/*`

`getModsListForProfile.ts`
- `getActiveGameId(state)` — wraps `selectors.activeGameId`, returns `undefined` for empty.
- `getActiveProfileIdFromState(state, gameId)` — finds the active profile for a game; falls back to any profile for that game.
- `getModsForProfile(state, gameId, profileId)` — the workhorse. Walks `state.persistent.mods[gameId]`, joins with `state.persistent.profiles[profileId].modState`, and produces an array of `AuditorMod`.
- Internal normalizers worth knowing:
  - `pickInstallerChoices(attributes)` — tries a long list of attribute keys (`installerChoices`, `installerChoicesData`, `fomodChoices`, `fomod`, `choices`, `installChoices`, `installerOptions`) because Vortex/installers store this inconsistently.
  - `normalizeFomodSelections(installerChoices)` — converts whatever shape `pickInstallerChoices` returned into the canonical `FomodSelectionStep[]` (step → groups → choices).
  - `normalizeCollectionIds(value)` — coerces scalar/array/missing into `string[]`.
  - `hasAnySelectedFomodChoices(steps)` — boolean for whether the FOMOD tree actually contains anything.
  - `normalizeRuleReference(reference)` / `normalizeModRules(rules)` — flatten Vortex's `IModRule[]` into `CapturedModRule[]` and sort canonically. See [`docs/business/MOD_RULES_CAPTURE.md`](business/MOD_RULES_CAPTURE.md).
  - `normalizeStringArray(value)` — defensive dedupe + alphabetical sort, used for `fileOverrides` and `enabledINITweaks`. See [`docs/business/FILE_OVERRIDES_CAPTURE.md`](business/FILE_OVERRIDES_CAPTURE.md).
  - `normalizeInstallTime(raw)` — coerces `Date | string | number` to a canonical ISO-8601 UTC string, returns `undefined` for unparseable input. See [`docs/business/ORDERING.md`](business/ORDERING.md).
  - `assignInstallOrder(mods)` — second pass that mutates each mod's `installOrder` to a deterministic 0-indexed ordinal sorted by `installTime` then `id`.

`deploymentManifest.ts`
- `collectDistinctModTypes(state, gameId)` — walks `state.persistent.mods[gameId]` and returns the set of distinct `mod.type` strings (always includes `""` for the default modtype).
- `captureDeploymentManifests(api, state, gameId)` — for each modtype, calls `util.getManifest(api, modType, gameId)` and normalizes the result into a `CapturedDeploymentManifest` (absolute paths and Vortex instance UUIDs stripped). Per-modtype failures are swallowed with a `console.warn` so partial capture beats no capture. **INVARIANT**: never throws.

`loadOrder.ts`
- `captureLoadOrder(state, gameId)` — flattens `state.persistent.loadOrder[gameId]` into a sorted `CapturedLoadOrderEntry[]` (drops `prefix` and `data`, keeps `modId`/`pos`/`enabled`/`locked`/`external`). Synchronous, defensive, never throws. Returns `[]` for games that don't use Vortex's LoadOrder API.

`exportMods.ts`
- Pure I/O. `exportModsToJsonFile` ensures the output dir exists, builds a wrapper object (`exportedAt`, `gameId`, `profileId`, `count`, `mods`, optionally `deploymentManifests`, optionally `loadOrder`), and writes pretty-printed JSON. Both optional fields are omitted from the JSON entirely when `undefined`, preserving older-format compatibility.

`archiveHashing.ts`
- `hashFileSha256(path)` — streaming SHA-256 (low memory; archives can be hundreds of MB).
- `getModArchivePath(state, archiveId, gameId)` — resolves a mod's source archive on disk via `selectors.downloadPathForGame` + the `IDownload.localPath` field on `state.persistent.downloads.files[archiveId]`.
- `enrichModsWithArchiveHashes(state, gameId, mods, options)` — bulk-hashes archives with bounded concurrency (default 4). Mods without a resolvable archive pass through unchanged; per-mod failures don't abort the batch. Called by `exportModsAction` after `getModsForProfile`.

`comparePlugins.ts`
- `parsePluginsTxt(content)` — splits lines, drops comments/blanks, peels the `*` enabled-prefix, normalizes name (trim + lowercase) for matching.
- `comparePluginsEntries({...})` — builds two maps keyed by `normalizedName`, walks both to fill `onlyInReference`, `onlyInCurrent`, `enabledMismatch`, `positionChanged`.
- `getCurrentPluginsTxtPath(gameId)` — joins `%LOCALAPPDATA%` + the per-game folder name.
- `comparePluginsTxtFiles({...})` — async wrapper that reads both files and calls the diff.
- `exportPluginsDiffReport({...})` — writes the diff JSON.

`proton/*` — the Proton service
- Everything Event Horizon knows about running under Wine/Proton on Linux, and the only code that probes for it: `looksLikeWine()` (`detect.ts`); what Wine reports about the Linux side — the home, Vortex's own prefix, `Z:` path translation (`host.ts`); which prefix Heroic or Steam runs the game in, read from the launcher's own records (`launcherRecords.ts`, `gamePrefix.ts`); and whether Vortex's settings folders reach the game, proven by a write probe (`sharedFolders.ts`).
- What a feature SAYS about Wine stays with the feature: the environment checks word the prefix verdict, the 7-Zip preflight its advice, the resolver its game-version note. `protonBoundary.test.ts` fails when a Wine probe — a `Z:\` path, Wine's `WINE*` environment variables, a launcher's prefix records — appears anywhere else.

`manifest/buildManifest.ts`
- `buildManifest(input)` — pure transform from `ExportedModsSnapshot` (+ curator-supplied package/game/vortex metadata, optional `plugins.txt` content, optional per-mod external-mod overrides) into a fully-typed `EhcollManifest`. No I/O, no state access — testable with hand-rolled fixtures.
- Identity: emits `compareKey="nexus:<modId>:<fileId>"` for Nexus-sourced mods, `compareKey="external:<sha256>"` for everything else. Refuses to build when any mod lacks `archiveSha256` (fail-fast at packaging time, not at install time on a user's machine).
- Validation: collects fatal problems (unsupported gameId, missing hashes, duplicate compareKeys) and throws a single `BuildManifestError` carrying the full list. Non-fatal issues (rules referencing unknown mods, deployment entries whose source mod isn't in the snapshot) come back as `result.warnings`.
- Hardcoded `NEXUS_GAME_DOMAIN_BY_GAME_ID` table maps Vortex gameIds to Nexus URL domains (e.g. `skyrimse → skyrimspecialedition`, `falloutnv → newvegas`) because `AuditorMod` doesn't currently capture the per-mod domain.
- v1 simplifications: `losingMods: []` on every file override (Vortex's deployment manifest doesn't record losers), `iniTweaks: []` (Phase 5), `archiveName` falls back to `mod.name` when no real filename is supplied (slice 4 will pass real filenames in).
- Full prose contract: [`docs/business/BUILD_MANIFEST.md`](business/BUILD_MANIFEST.md).

`manifest/packageZip.ts`
- `packageEhcoll(input)` — takes one `EhcollManifest` plus a list of bundled archive specs (`{ sourcePath, sha256 }`), stages everything in a temp directory, and runs 7z to produce one `.ehcoll` file. Returns `{ outputPath, outputBytes, bundledCount, warnings }`.
- ZIP format (forced via `-tzip`), not 7z native — bundled archives are already compressed, ZIP wins on tooling compatibility for debugging.
- Bundled archives are hardlinked into staging where possible (free, instant) with `fs.copyFile` fallback on EXDEV/EPERM. 7z reads them off disk directly; Node never holds bundled bytes in memory.
- Validation is fail-fast and exhaustive — every detectable problem (sha256 format violations, manifest/archives mismatch, non-absolute paths, etc.) goes into one `PackageEhcollError`.
- **Identity is `(package.id, package.version)`, not byte-equal builds.** The only stable-bytes concession kept is `manifest.json` key sorting via `sortDeep`, purely for `unzip + diff` debuggability.
- Optional `verifyHashes` re-streams every bundled archive through SHA-256 before staging — slow on big archives but catches "curator's archive cache changed since snapshot export."
- Staging directory is `rm -rf`'d in `finally`, so partial output never leaks into the temp dir.
- Full prose contract: [`docs/business/PACKAGE_ZIP.md`](business/PACKAGE_ZIP.md).

`manifest/parseManifest.ts`
- `parseManifest(raw)` — pure mirror of `buildManifest`. Takes the raw text of a `.ehcoll` package's `manifest.json`, parses + validates against the v1 schema, returns `{ manifest, warnings }` or throws a single `ParseManifestError` carrying every problem found.
- Two severity tiers: **errors** (JSON parse failure, `schemaVersion !== 1`, missing/wrong-typed fields, malformed UUID/SHA-256/semver, unsupported gameId, unknown source kind, duplicate compareKeys) abort the parse; **warnings** (rule references that don't resolve, file-override mods missing from `mods[]`, two external mods sharing a SHA-256) survive — those are resolver concerns.
- `schemaVersion` is the only short-circuit gate. Every other error accumulates so the curator/user sees the full diagnosis from one parse, not fix-rerun-fix-rerun.
- Cross-reference validation (compareKey lookups) runs as a single post-pass after all per-section validation succeeds. Partially-pinned rule references like `nexus:1234` (no fileId) are intentionally allowed — those are meant to be resolved at install time.
- No I/O, no state, no side effects. The Phase 3 slice 2 ZIP reader (`readEhcoll`) handles file I/O and feeds the JSON text in.
- Hand-written validator on purpose, not Zod/io-ts: avoids a parallel schema definition that drifts, keeps the runtime surface tiny, and lets us write plain-English error messages with manifest field paths.
- Round-trip property: `parseManifest(JSON.stringify(buildManifest(...).manifest)).manifest` deep-equals the input. The validator is the gate every Phase 3+ consumer goes through.
- Full prose contract: [`docs/business/PARSE_MANIFEST.md`](business/PARSE_MANIFEST.md).

`manifest/readEhcoll.ts`
- `readEhcoll(zipPath, options?)` — I/O mirror of `packageEhcoll`. Pre-flights the file (ENOENT/EACCES/non-regular-file all become readable errors), lists the ZIP central directory with the project's **own** reader (`listZipEntries` in `readZip.ts` — not 7-Zip), extracts `manifest.json` alone to a temp dir via `extractZipEntryToFile`, hands the bytes to `parseManifest`, and cross-checks the package's `bundled/` directory against `manifest.mods` (every `bundled: true` mod must be present, no stray archives allowed, no duplicate sha256 entries).
- Returns `{ manifest, bundledArchives, hasReadme, hasChangelog, iniTweakFiles, warnings }`. Bundled archives are listed (sha256 + zipPath + extension + size) but never extracted — the resolver owns extraction. This keeps a future "inspect package" UI fast on multi-GB collections.
- Two short-circuit gates: file-not-readable, and `manifest.json`-not-present-at-root. Everything else accumulates into one `ReadEhcollError`. `parseManifest`'s thrown errors are repackaged so the caller has a single error type to catch.
- Path normalization is forward-slash. Directory entries (`attr` starting with `D`, or a trailing-slash name) are filtered. Unknown root-level files are tolerated as forward-compat headroom for additive v1.x schema additions.
- The listing result is still *shaped* as `SevenZipListEntry` even though 7-Zip no longer produces it — that is what let the reader swap underneath without touching its six consumers.
- Staging cleanup is `finally`-bound; partial reads never leak temp bytes. Two concurrent reads are safe — `mkdtemp` gives each a unique scratch directory.
- Full prose contract: [`docs/business/READ_EHCOLL.md`](business/READ_EHCOLL.md).

`manifest/sevenZip.ts`
- Narrow typed wrapper around `vortex-api`'s `util.SevenZip` (re-export of `node-7z`'s default). Defines `SevenZipApi`, `SevenZipStream`, `SevenZipListEntry`, `SevenZipAddOptions`, `SevenZipReadOptions` for our exact callsites — the messy `as unknown as` cast is contained here so the rest of the codebase consumes a clean typed surface and tests can inject a fake.
- Surface methods used: `add` (the packager, `packageZip.ts` — still 7-Zip) and `list` (fallback only). `list`'s `data` event yields `SevenZipListEntry { file, size?, attr? }`; `extract` accepts `$cherryPick: string[]` for surgical pulls.
- **The reader no longer goes through here.** Reading and extracting from a `.ehcoll` is native (`readZip.ts`), and archive *listing* is native-first with 7-Zip only as a fallback (`listArchive.ts`). The reason is a real failure: `node-7z` shells out to `7z.exe`, which fails under a Wine/Proton prefix for reasons unrelated to the archive — a missing vcrun runtime — and surfaces as `7z failed to list`, i.e. "your collection is broken" when it is not.
- Writing stayed on 7-Zip deliberately: packaging is curator-side, and the Proton failure is user-side.
- `node-7z` ships no usable types and `@types/node-7z` is not in our deps; this file is the workaround. If `vortex-api` ever exposes proper types it collapses to a re-export.

`manifest/collectionConfig.ts`
- Per-collection state file management. Defines `CollectionConfig` (schemaVersion: 1, packageId UUID, externalMods record, optional readme/changelog), the `CollectionConfigError` type, and four functions:
  - `loadOrCreateCollectionConfig({ configDir, slug })` — read-or-create. Missing file ⇒ fresh UUIDv4, write to disk, return. Malformed file ⇒ `CollectionConfigError` listing every problem; **never auto-overwrite** (would discard curator edits).
  - `saveCollectionConfig({ configDir, slug, config })` — pretty-print + writeFile. Creates the parent dir if missing.
  - `reconcileExternalModsConfig({ config, externalMods })` — pure. Adds stub `{ name, bundled: false, instructions: "" }` entries for any external mod missing from `config.externalMods`; refreshes `name` hints. **Never removes** stale entries (preserves curator-typed instructions across temporary mod removals).
  - `toBuildManifestExternalMods(config)` — strip `name` hints; return the shape `BuildManifestInput.externalMods` expects.
- File location: `<appData>/Vortex/event-horizon/collections/.config/<slug>.json`. Slug = identity; renaming a collection starts a new release lineage.
- Defensive validation: slug refuses path-traversal (`\ / : * ? " < > |` and `..`); `packageId` must be RFC 4122 UUID; `bundled` must be boolean; `instructions` / `readme` / `changelog` / `name` must be strings; unknown per-entry fields silently dropped.
- Phase 5 React UI consumes the same load/save pair — no separate code path.
- Full prose contract: [`docs/business/COLLECTION_CONFIG.md`](business/COLLECTION_CONFIG.md).

### Resolver — `src/core/resolver/*`

`resolveInstallPlan.ts`
- The pure brain of the installer. Signature: `resolveInstallPlan(manifest, userState, installTarget) → InstallPlan`. No I/O, no Vortex API calls, no `Date.now()` — every byte of output is a function of the three inputs.
- Eight independent passes: invariant guard (the action handler must keep `installTarget.kind` and `userState.previousInstall` co-determined), compatibility checks, per-mod resolution, orphan detection, external-dependency checks, plugin-order plan, rule plan, summary derivation.
- **Per-mod ladder.** Nexus mods (`current-profile` mode): byte-exact installed → local download with matching SHA → version-diverged (modId match, fileId differs) → bytes-diverged (modId+fileId match, SHA differs) → fresh download. Nexus mods (`fresh-profile` mode): collapses the diverged steps into fresh download because the new profile starts empty. External mods: byte-exact installed → local download with matching SHA → bundled in `.ehcoll` → strict-mode `external-missing` (blocks `canProceed`) / lenient-mode `external-prompt-user` (deferred to install-time picker).
- **Identity is SHA, not name** (LOAD-BEARING). Nexus mods match on `(modId, fileId, sha256)` triples; external mods match on `sha256` alone. A SHA-unknown installed mod is invisible to byte-exact match and to byte-drift detection — we never claim drift on data we don't have.
- **Orphan detection** only fires when `installTarget.kind === "current-profile"` AND `userState.previousInstall` is defined. Walks `installedMods` for `eventHorizonInstall` tags pointing at `manifest.package.id`; flags any whose `originalCompareKey` isn't in the new manifest.
- **Conservative policy (v1, LOAD-BEARING)**: every conflict/orphan recommendation is `"manual-review"`. The driver acts only on user-confirmed choices the action handler converts from those recommendations. Defense-in-depth against silent destruction.
- **Compatibility severity**: game id mismatch, exact-policy version mismatch, minimum-policy version too old, missing/too-old required Vortex extensions → errors (block `canProceed`). Game version unknown, unparseable, Vortex client version differs, deployment method differs → warnings (informational only).
- **Summary derivation**: counts the per-mod arms into `alreadyInstalled` / `willInstallSilently` / `needsUserConfirmation` / `missing` (with deliberate overlap — local-download counts in both `alreadyInstalled` and `willInstallSilently`). `canProceed` flips false on compatibility errors, missing required extensions, strict-mode missing mods, or strict-mode external-dep mismatches.
- Tiny semver comparator built in (`major.minor.patch`, no prerelease handling). Falls back to "treat as compatible" via warning when either side is unparseable, on the principle that we never gate the install on data we couldn't parse.
- The plan is JSON-serialisable: no `Date` objects, no functions, no circular references.
- Full prose contract: [`docs/business/RESOLVE_INSTALL_PLAN.md`](business/RESOLVE_INSTALL_PLAN.md).

`userState.ts`
- Pure builder + install-target picker for the resolver's input. Two public functions: `buildUserSideState(input) → UserSideState` (no I/O, sync) and `pickInstallTarget(manifest, receipt, profileId, profileName) → InstallTarget`. Plus `previousInstallFromReceipt` and a handful of narrowed Vortex-state shape readers (`resolveVortexVersion`, `resolveGameVersion`, `resolveDeploymentMethod`, `resolveEnabledExtensions`, `resolveProfileName`).
- **Lineage authority is the receipt, full stop** (LOAD-BEARING). A mod gets `eventHorizonInstall` iff `receipt.mods[i].vortexModId === installedMod.id`. No name fallback, no Nexus-ID fallback, no SHA fallback. Lost receipt = lost lineage = degrades cleanly to fresh-profile mode.
- **Install-target rule** (LOAD-BEARING): `pickInstallTarget` is the SINGLE site of the rule. Receipt present ⇒ `current-profile`. Receipt missing ⇒ `fresh-profile` with suggested name `"<package.name> (Event Horizon v<package.version>)"`. The action handler never branches on the receipt directly.
- **Co-determination invariant**: `installTarget.kind === "current-profile"` ⇔ `receipt !== undefined` ⇔ `userState.previousInstall !== undefined`. The picker enforces it on the input side; the resolver throws if violated on the output side.
- Action-handler responsibilities (NOT this module): hashing installed-mod archives, reading the receipt, reading Vortex state. The builder takes already-prepared inputs.
- `resolveDeploymentMethod` returns `undefined` for unknown deployment activators rather than defaulting to `"hardlink"` like the build action does — the resolver wants ground truth so it can report `status: "unknown"` rather than misreporting a guess as `"ok"`.
- The build action (`buildPackageAction.ts`) currently keeps its own copies of `resolveVortexVersion` / `resolveGameVersion` / `resolveDeploymentMethod`. That duplication is intentional for now (slice 5 didn't refactor the build action). A later pass may consolidate them.
- Full prose contract: [`docs/business/USER_STATE.md`](business/USER_STATE.md).

### Installer — `src/core/installer/*`

`runInstall.ts`
- The install driver. Signature: `runInstall(ctx: DriverContext) → Promise<InstallResult>`. Consumes a frozen `InstallPlan` (the resolver's output) and orchestrates the actual mutations: profile creation, mod install (Nexus/local/bundled), post-install verification, rule replacement, deployment, plugin-order pinning, receipt write. Never throws — failures land in the discriminated `InstallResult` (`success | aborted | failed`).
- **Both install targets are supported.** Preflight refuses to run when a mod decision is a hard blocker (`external-missing`, `nexus-unreachable`), when a decision needing manual review has no matching user choice, or when the plan says `canProceed === false`. Fresh-profile and current-profile both run; conflict and orphan pickers are part of the flow rather than a reason to refuse.
- **Phases, surfaced via `DriverProgress`** (`DriverPhase`, `src/types/installDriver.ts:197`): `preflight` → `creating-profile` → `switching-profile` → `removing-mods` → `installing-mods` → `verifying-mods` → `applying-mod-rules` → `applying-userlist` → `deploying` → `applying-load-order` → `writing-receipt` → `complete` (or terminal `aborted` / `failed`). `onProgress` fires once per phase transition and once per mod within the per-mod phases.
- **`applying-load-order` is after `deploying`, and that ordering is load-bearing.** Vortex's `PluginPersistor` serializes from its *deployed* plugin set, so an order pinned before deploy is pinned against a list that does not exist yet and is silently dropped.
- **Rules are replaced, not merged.** `applying-mod-rules` and `applying-userlist` back up the user's entire mod-rule set and LOOT userlist, clear them, then apply the collection's. The backup reaching disk is an interlock — the purge does not run without it. Merging would produce a rule set that exists on no other machine and fails invisibly: every file verifies and the game still loads something else.
- **Sequential mod installs.** Vortex's install pipeline is not safe to drive concurrently (the `did-install-mod` event is global, race-prone, and the installer holds locks on the staging dir). The driver awaits each mod's completion before starting the next, even though that's slower — correctness wins.
- **Failure semantics (LOAD-BEARING)**: NO ROLLBACK. A failure mid-install leaves the partial profile + partially-installed mods on disk, so the user can inspect, recover, or retry. The driver's contract is **idempotent on restart**, NOT idempotent on rerun — restarting the driver from scratch on the same `.ehcoll` will create a NEW profile (different UUID), so re-runs are additive, not destructive. This is intentional: silently rolling back partial installs on Vortex (a system that loses state randomly) would compound the very problem we exist to fix.
- **Cancellation** via `AbortSignal`. Checked between phases and between mod installs, never mid-mod (we cannot safely interrupt an extraction or Vortex's install pipeline). On cancel: the driver returns the `aborted` result with the current phase + partial profile id, and **writes no receipt**; cleanup is the user's call.
- **A hang watchdog can end a run** — a per-phase stall window plus an absolute cap, both sized by archive size and platform (`timeBudgets.ts`; a Proton prefix gets more headroom). Both **pause while Vortex is blocked on user input** (`session.base.visibleDialog` / `overlayOpen`, via `isAwaitingUserInput` in `modInstall.ts`): a user sitting on a FOMOD prompt makes no progress and is not a hang, and treating them as one cancelled a real install. It never force-closes Vortex.
- **Receipt write is the last side effect.** Until receipts are written, the install is "in-flight" from the ledger's perspective — a crash during deploy means no receipt, which means a re-run picks `fresh-profile` mode again (deterministic recovery, no orphan ghosts).
- Full prose contract: [`docs/business/INSTALL_DRIVER.md`](business/INSTALL_DRIVER.md).

`profile.ts`
- Pure helpers around Vortex's profile API: `createFreshProfile(api, gameId, suggestedName)` (UUIDv4 id + collision-free name via `pickNonCollidingName`), `switchToProfile(api, profileId)` (dispatches `setNextProfile` and awaits the `profile-did-change` event with a 30s timeout), `enableModInProfile(api, profileId, modId)` (dispatches `setModEnabled(true)`).
- The collision check rejects names already in `state.persistent.profiles[*].name` for the given `gameId`, suffixing `(2)`, `(3)`, … until it lands on a free slot. Receipt-bearing re-installs (slice 6b+) reuse the existing profile id, but this module always treats the name picker as a fresh nameservice.
- No I/O outside Vortex's Redux store (and the event bus). No filesystem touches — Vortex's profile machinery handles disk writes for us.

`modInstall.ts`
- Three install primitives, one per `ModDecision` flavour:
  - `installNexusViaApi({ gameId, nexusModId, nexusFileId, fileName? })` — emits `api.ext.nexusDownload` with `allowInstall: true`. Awaits the `did-install-mod` event matched against the returned `archiveId`. Used for `nexus-download` decisions.
  - `installFromExistingDownload({ gameId, archiveId })` — emits `start-install-download(archiveId)`. Used for `nexus-use-local-download` and `external-use-local-download` (a fast path that skips re-downloading a Nexus file the user already has).
  - `installFromBundledArchive({ gameId, ehcollZipPath, bundledZipEntry })` — uses `extractBundledFromEhcoll` to pull one `bundled/<sha>.<ext>` file out of the `.ehcoll` ZIP into a `mkdtemp` scratch dir, then emits `start-install(extractedPath)`. The temp dir is removed in `finally` (`safeRmTempDir` swallows ENOENT).
- Each primitive returns `{ vortexModId, archiveId? }` after the install completes. The `did-install-mod` listener has a timeout — if Vortex never fires the event (download hung, antivirus interference), the driver records a `failed` result with the phase and the mod that hung. Budgets are size- and platform-aware (`timeBudgets.ts`): a Wine/Proton prefix gets more headroom than Windows, and a 2 GB extract more than a 5 MB one.
- Bundled extraction is native (`readZip.ts`) and writes straight to disk rather than buffering the archive in Node. Memory stays constant regardless of bundled-archive size.
- `isAwaitingUserInput(state)` reads `session.base.visibleDialog` / `overlayOpen` — the signal that Vortex is blocked on a human, used to pause the hang watchdog.

**Plugin order and flags** — there is no `pluginsTxt.ts` any more; the driver stopped writing that file. What replaced it:
- `applyPluginOrder.ts` — pins the curator's order through Vortex (`set-plugin-list` → `autosort-plugins`), integrating plugins the user has that the collection does not know about LOOT-style rather than appending them last. `describePluginOrderApplication` turns the outcome into user-facing prose.
- `applyPluginLightFlags.ts` — restores the ESL/light flag (bit `0x200` of the TES4 header flags) so a curator's light-flagged plugins stay light. This matters because the regular plugin limit is 254 and a lost flag can break a load order that fits on the curator's machine.
- `checkPluginOrder.ts` — reads the resulting order back **from disk**, because `plugins.txt` is what the game reads, not what Redux believes.

### Install ledger — `src/core/installLedger.ts`

- Pure CRUD over `<appData>/Vortex/event-horizon/installs/<package.id>.json`. One file per collection `package.id`, overwritten in-place on every successful install. The single source of truth for cross-release lineage; Vortex mod attributes are **never** consulted.
- Three-tier API: pure helpers (`getReceiptPath`, `parseReceipt`, `serializeReceipt`), async I/O wrappers (`readReceipt`, `writeReceipt`, `deleteReceipt`, `listReceipts`), and the `InstallLedgerError` type that lists every detected schema problem at once.
- **Atomic writes**: write to `<file>.tmp`, then `fs.rename`. Same-directory rename is filesystem-atomic, so a half-written receipt is impossible — important because mid-write failures (forced shutdown, antivirus) would otherwise mis-tag installed mods or hide orphans.
- **Self-validating serializer**: `serializeReceipt` round-trips through `parseReceipt` before returning, so a malformed runtime object can never land on disk.
- **Defensive path construction**: `getReceiptPath` rejects non-UUID `packageId`s before joining, defending against accidental path traversal in the action handler.
- **Idempotent delete**: `deleteReceipt` returns `{ deleted: false }` on ENOENT; never throws on absence. Safe for "double-uninstall" UI flows.
- **Best-effort listing**: `listReceipts` skips files that don't match `<uuid>.json` and surfaces parse failures via an optional `onError(filename, err)` callback — one bad receipt does not invalidate the rest.
- **No silent overwrite of corrupt receipts**: parse failures throw `InstallLedgerError`; the action handler must surface the error and let the user decide. Silently regenerating would erase the lineage data the ledger exists to protect.
- Schema is additive: future v1.x revisions add fields, never rename or remove. Breaking changes bump `INSTALL_LEDGER_SCHEMA_VERSION`.
- Consumed by Phase 3 slice 5 (the install action calls `readReceipt`, the userState builder uses the receipt to attach lineage tags and choose the install target) and Phase 3 slice 6 (the install driver writes a receipt after a successful install).
- Full prose contract: [`docs/business/INSTALL_LEDGER.md`](business/INSTALL_LEDGER.md).

### Types — `src/types/*`

Pure TypeScript type declarations. No runtime code lives here — adding any would change the dependency graph for files that should only depend on contracts.

`ehcoll.ts`
- The `.ehcoll` package manifest schema (v1). Defines `EhcollManifest` and every nested shape: `PackageMetadata`, `GameMetadata`, `VortexMetadata`, the `EhcollMod` discriminated union (`NexusEhcollMod` / `ExternalEhcollMod`), `EhcollRule`, `EhcollFileOverride` (curator-deployment outcome side), `EhcollPlugins`, `EhcollIniTweak` (Phase 5 placeholder), `EhcollExternalDependency`.
- Imports `FomodSelectionStep` from `core/getModsListForProfile` so the manifest's installer spec is byte-compatible with what `AuditorMod` already captures.
- Full prose contract: [`docs/business/MANIFEST_SCHEMA.md`](business/MANIFEST_SCHEMA.md).

`installPlan.ts`
- Phase 3 resolver contract. Two top-level shapes: `UserSideState` (the narrowed projection of Vortex Redux state the resolver consumes) and `InstallPlan` (everything the install driver, action handler, and eventual UI need to act on a manifest against the user's machine).
- `InstallPlan.modResolutions` is a length- and order-preserving mirror of `manifest.mods`. Each entry's `decision` is a discriminated union with twelve arms (`nexus-download`, `nexus-use-local-download`, `nexus-already-installed`, `nexus-version-diverged`, `nexus-bytes-diverged`, `nexus-unreachable`, `external-use-bundled`, `external-use-local-download`, `external-already-installed`, `external-bytes-diverged`, `external-prompt-user`, `external-missing`). Conflicts carry a `ConflictRecommendation` (`replace-existing` / `keep-existing` / `manual-review`) — never an instruction the driver auto-executes.
- **Cross-release lineage**: `InstalledMod.eventHorizonInstall` carries the install-ledger tag, `UserSideState.previousInstall` and `InstallPlan.previousInstall` mark upgrades, and `InstallPlan.orphanedMods: OrphanedModDecision[]` lists mods a previous release of the same `package.id` installed but the new manifest dropped. Orphans are never auto-uninstalled; recommendations are always `manual-review` in v1.
- **Install target (LOAD-BEARING)**: every plan carries `installTarget: InstallTarget` (`"current-profile"` or `"fresh-profile"`), picked atomically with `previousInstall` from a single signal — does the install ledger have a receipt for `manifest.package.id`? Receipt present ⇒ in-place upgrade in the active profile (Flow A). Receipt missing ⇒ FORCED fresh Vortex profile, isolated from whatever the user has in their main profile (Flow B). Same rule applies to first-time installs (no receipt by definition). Vortex's mod store is global across profiles, so fresh-profile installs share the global pool (deduplicating byte-exact matches) but only enable the collection's mods + write a new `plugins.txt` in the new profile — old profile is byte-untouched. In fresh-profile mode the resolver never emits diverged decisions; orphans are always `[]`.
- **v1 conservative-policy invariant (LOAD-BEARING)**: the resolver ALWAYS emits `manual-review` for every conflict and orphan recommendation. The other values (`replace-existing` / `keep-existing` / `keep-installed` / `recommend-uninstall`) are reserved for future heuristics. The install driver MUST NOT act on a `recommendation` directly — the action handler/UI converts recommendations into explicit user choices, and the driver only acts on those. Combined with forced fresh-profile mode for no-receipt installs, this is the structural reason an Event Horizon install can never silently destroy user state.
- Sibling shapes in the plan: `CompatibilityReport` (game id/version/extensions/Vortex/deployment cross-checks), `ExternalDependencyDecision[]`, `PluginOrderPlan` (always present, may be `kind: "none"`), `RulePlanEntry[]` (pre-resolved rule applications, `apply` or `skip`), `PlanSummary` (derived counts + `canProceed`; orphans and conflicts never block `canProceed`).
- Re-exports `EhcollManifest`, `EhcollExternalDependency`, `GameVersionPolicy`, `ModRuleType`, `SupportedGameId`, `VortexDeploymentMethod` so the resolver and its consumers can one-stop import.
- No runtime; pure type declarations. Phase 3 slice 4 (`src/core/resolver/resolveInstallPlan.ts`) implements the pure transform; slice 5 (`src/core/resolver/userState.ts` + an action) builds `UserSideState` from Vortex and reads the install ledger; slice 6 is the install driver that consumes the plan and writes the ledger after a successful install.
- The install ledger lives at `<appData>/Vortex/event-horizon/installs/<package.id>.json` and is the SINGLE source of truth for cross-release lineage. Vortex's mod attributes are NEVER trusted for lineage (they get stripped randomly — the whole reason this project exists).
- Full prose contract: [`docs/business/INSTALL_PLAN_SCHEMA.md`](business/INSTALL_PLAN_SCHEMA.md).

`installLedger.ts`
- The on-disk receipt schema. Defines `InstallReceipt` (top-level shape: `schemaVersion`, `packageId`, `packageVersion`, `packageName`, `gameId`, `installedAt`, `vortexProfileId`, `vortexProfileName`, `installTargetMode`, `mods[]`) and `InstallReceiptMod` (per-mod entry: `vortexModId`, `compareKey`, `source`, `name`, `installedAt`).
- `InstallTargetMode = "current-profile" | "fresh-profile"` mirrors the resolver's `InstallTarget.kind` so the receipt records which install mode produced it (surfaced in UI as "this collection lives in profile X because we created it for the install").
- Schema version exported as `INSTALL_LEDGER_SCHEMA_VERSION = 1`. Additive evolution policy: new fields land in v1.x without bumping; breaking changes require a new major.
- Type-only file. Runtime CRUD lives in `src/core/installLedger.ts`.
- Full prose contract: [`docs/business/INSTALL_LEDGER.md`](business/INSTALL_LEDGER.md).

### Utils — `src/utils/utils.ts`
A grab-bag, but mostly stable surfaces:

- **Shell**: `openFolder(path)`, `openFile(path)` — both shell out to `start "" "<path>"` (Windows-only).
- **Pickers**: `pickJsonFile()`, `pickTxtFile()` — wrap `electron.dialog.showOpenDialog`.
- **Mod diff engine**:
  - `getModCompareKey(mod)` — identity priority: `nexus:{modId}:{fileId}` → `archive:{archiveId}` → `id:{id}`. Stable across reinstalls when Nexus IDs are present.
  - `sortDeep(value)` / `deepEqualStable(a, b)` — order-insensitive deep equality via canonicalized JSON.
  - `compareMods(ref, cur)` — produces `ModFieldDifference[]` for a fixed list of fields.
  - `compareSnapshots(ref, cur)` — full report: `onlyInReference`, `onlyInCurrent`, `changed`.
  - `exportDiffReport({...})` — writes the diff JSON.
- **Misc**: `findInObject(obj, predicate)` — debugging helper, not currently called from production paths.

## Execution flows (top-level)

GitNexus identifies 18 flows; the three user-facing entry points map to:

**Export Mods**
```
init → exportModsAction()
   → getActiveGameId, getActiveProfileIdFromState
   → getModsForProfile
        → pickInstallerChoices, normalizeFomodSelections,
          normalizeCollectionIds, hasAnySelectedFomodChoices,
          normalizeModRules → normalizeRuleReference,
          normalizeStringArray (×2 — fileOverrides, enabledINITweaks),
          normalizeInstallTime (per mod)
        → assignInstallOrder (single pass after walk)
   → enrichModsWithArchiveHashes (concurrency-bounded SHA-256)
   → captureDeploymentManifests
        → collectDistinctModTypes → util.getManifest (per modtype)
   → captureLoadOrder
   → exportModsToJsonFile
   → sendNotification(Open Diff/Folder)
```

**Compare Mods**
```
init → compareModsAction()
   → pickJsonFile → fs.readFile + JSON.parse  (referenceSnapshot)
   → getModsForProfile                         (currentSnapshot)
   → compareSnapshots
        → buildModsMap (uses getModCompareKey)
        → compareMods → deepEqualStable → sortDeep
   → exportDiffReport
   → sendNotification
```

**Compare Plugins**
```
init → comparePluginsAction()
   → pickTxtFile
   → getCurrentPluginsTxtPath (uses getLocalAppDataPath)
   → comparePluginsTxtFiles
        → parsePluginsTxt (uses normalizePluginName)
        → comparePluginsEntries (uses toPluginMap)
   → exportPluginsDiffReport
   → sendNotification
```

**Install Event Horizon Collection**
```
init → installCollectionAction()
   → pickEhcollFile
   → readEhcoll                              (manifest + bundled inventory, native ZIP)
   → game-id gate                            (active game / supported / matches manifest)
   → readReceipt(appData, package.id)        (lineage authority)
   → getModsForProfile + enrichModsWithArchiveHashes  (activity notification + finally)
   → scanAvailableDownloads                  (ONE scanner, shared with the engine pipeline)
   → buildUserSideState
   → pickInstallTarget                       (receipt → current-profile vs fresh-profile)
   → resolveInstallPlan                      (pure, no I/O)
   → preview → per-conflict / per-orphan decisions → confirm
   ↓ user confirms
   → runInstall                              (ctx: api + plan + ehcoll + zipPath + appData)
        → preflight                          (hard blockers, missing choices, canProceed)
        → createFreshProfile + switchToProfile   (fresh-profile only)
        → removing-mods                      (replace-existing / orphan-uninstall)
        → for each ModResolution sequentially:
              installNexusViaApi          (nexus-download)
            | installFromExistingDownload (nexus-use-local-download / external-use-local-download)
            | installFromBundledArchive   (external-use-bundled — extracts from .ehcoll)
            → enableModInProfile
        → verifying-mods                     (SHA-256 → matches | differs | damaged | unknown)
        → applying-mod-rules + applying-userlist  (BACK UP, clear, then apply the curator's)
        → emit deploy-mods + await did-deploy
        → applying-load-order                (pin order, integrate extras, restore ESL flags)
        → writeReceipt                       (last side effect — locks in lineage)
   → renderResultDialog + sendNotification    (success / aborted / failed)
```
An aborted run writes **no receipt**, so the next attempt is not misled into
treating a partial install as a completed one.

**Build Event Horizon Collection** (Phase 2 slice 4a + 4b)
```
init → buildPackageAction()
   → getActiveGameId, getActiveProfileIdFromState  (reject unsupported gameIds)
   → showDialog (curator metadata: name/version/author/description, re-prompt on validation failure)
   → getModsForProfile
   → enrichModsWithArchiveHashes (concurrency 4)
   → captureDeploymentManifests
   → captureLoadOrder
   → getCurrentPluginsTxtPath + fs.readFile  (ENOENT swallowed)
   → loadOrCreateCollectionConfig      (slice 4b — persistent package.id + overrides)
   → reconcileExternalModsConfig       (auto-populate stub entries for new external mods)
   → saveCollectionConfig              (only when reconciliation changed something)
   → buildManifest                     (pure transform → EhcollManifest)
   → resolveBundledArchives            (slice 4b — for each bundled:true entry, resolve archive on disk)
   → packageEhcoll                     (stages bundled archives → 7z -tzip → .ehcoll)
   → sendNotification(Open Package / Open Folder / Open Config)
```

## Design notes & quirks

- **Two actions register at priority `101`** (`Compare Current Mods With JSON` and `Compare Plugins With TXT`). Vortex tolerates this but the relative order isn't guaranteed; consider giving them distinct priorities (e.g., `101`, `102`). The new `Build Event Horizon Collection` action sits at `102`.
- **Project rebranded to Event Horizon** (2026-04-26): the npm package is `vortex-event-horizon`, the Vortex extension name is `Event Horizon`, the AppData folder is `event-horizon/`, log prefixes are `[Vortex Event Horizon]`, and the upcoming standalone collection package format uses the `.ehcoll` extension. The previous `mod-monitor` / `mod-auditor` / `[Vortex Mod Monitor]` identifiers are gone. See [`docs/PROPOSAL_INSTALLER.md`](PROPOSAL_INSTALLER.md) for the metaphor (Vortex is the black hole; we capture state at the boundary).
- **`index.ts` exports `default init`**. After tsc, `index.js` (`module.exports = require('./dist')`) yields `{ default: init, __esModule: true }`. Vortex's loader is generally lenient, but if you ever see "extension didn't load," that's the first thing to check — flip to `module.exports = init` or `export = init`.
- **Windows-only assumptions**: `openFolder` / `openFile` use `start`, and `getCurrentPluginsTxtPath` reads `%LOCALAPPDATA%`. Vortex itself runs on Windows primarily, so this is acceptable for now.
- **No tests** and no linter config. Adding a small Jest setup around `core/comparePlugins.ts` and the diff engine in `utils.ts` would catch regressions cheaply — those modules are pure.
