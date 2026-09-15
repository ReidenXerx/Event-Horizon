# User-Side State Builder

**Source of truth:** `src/core/resolver/userState.ts` (Phase 3 slice 5).

**Related specs:**
- [`INSTALL_PLAN_SCHEMA.md`](INSTALL_PLAN_SCHEMA.md) — defines the `UserSideState` shape consumed by the resolver.
- [`INSTALL_LEDGER.md`](INSTALL_LEDGER.md) — receipts the builder reads to attach lineage tags.
- [`RESOLVE_INSTALL_PLAN.md`](RESOLVE_INSTALL_PLAN.md) — what the resolver does with the state once it's built.
- [`INSTALL_ACTION.md`](INSTALL_ACTION.md) — the removed toolbar action that called this builder (history); the install page's loading pipeline calls it now.

## Purpose

The resolver is a pure function:

```
resolveInstallPlan(manifest, userState, installTarget) → InstallPlan
```

`UserSideState` is the narrowed projection of "everything Vortex knows about the user's machine that the resolver might care about." This module is the **only** code that constructs `UserSideState`, and the **only** code that picks an `InstallTarget`. Centralising those decisions keeps the load-bearing rules (lineage tagging, install-target selection) in one auditable place.

The action handler is responsible for the slow / dirty steps (state reads, archive hashing, receipt I/O). This module is pure and synchronous: it shapes prepared inputs into the resolver's contract.

## Public surface

### `buildUserSideState(input) → UserSideState`

Pure projection. Takes:

| Input | Meaning |
|---|---|
| `gameId` | Vortex's active game id. |
| `gameVersion` (optional) | Best-effort game-version string; `undefined` ⇒ resolver emits `"unknown"`. |
| `vortexVersion` | Vortex client version. |
| `deploymentMethod` (optional) | `"hardlink"` / `"symlink"` / `"copy"`; `undefined` ⇒ resolver emits `"unknown"`. |
| `enabledExtensions` | List of `{ id, version? }` for currently-enabled Vortex extensions. |
| `activeProfileId` | The Vortex profile id at the time the action ran. |
| `activeProfileName` | Display name of the same profile. |
| `installedMods` | `AuditorMod[]` from the existing snapshot pipeline, **already enriched with `archiveSha256`**. The builder never hashes anything. |
| `receipt` | The `InstallReceipt` for `manifest.package.id`, or `undefined`. |
| `availableDownloads` (optional) | Hashed downloads; omit when the action handler hasn't enriched. |
| `externalDependencyState` (optional) | Per-dep verification snapshot; omit when not yet verified. |

Returns a fully-populated `UserSideState`.

### `pickInstallTarget(manifest, receipt, profileId, profileName) → InstallTarget`

Pure picker. Implements **THE** load-bearing rule:

| Receipt state | Returned target |
|---|---|
| Receipt present | `{ kind: "current-profile", profileId, profileName }` |
| Receipt missing | `{ kind: "fresh-profile", suggestedProfileName: "<name> (Event Horizon v<version>)" }` |

The action handler **never branches on the receipt itself** — it always asks this picker. The function is intentionally tiny because it's a single fact: receipt ⇒ in-place upgrade, no receipt ⇒ forced fresh profile.

### `previousInstallFromReceipt(receipt) → PreviousCollectionInstall | undefined`

Pure projection. Receipt → the resolver's `previousInstall` field. Useful for the action handler when it wants to surface lineage in dialog text *before* the resolver runs.

### Vortex-state shape readers

Tiny narrowed accessors used by the install action when constructing inputs:

| Reader | Returns | Notes |
|---|---|---|
| `resolveVortexVersion(state)` | `string` | `"unknown"` fallback. |
| `resolveGameVersion(state, gameId)` | `string \| undefined` | `undefined` ⇒ resolver shows "unknown". Looks under `state.persistent.gameSettings.<gameId>.version` then `state.settings.gameMode.discovered.<gameId>.version`. |
| `resolveDeploymentMethod(state, gameId)` | `VortexDeploymentMethod \| undefined` | Maps Vortex's `"hardlink_activator"` / `"symlink_activator(_elevate)"` / `"move_activator"` to our enum. Unknown → `undefined` (NOT defaulted). |
| `resolveEnabledExtensions(state)` | `EnabledExtension[]` | Reads `state.session.extensions.installed`, applies `state.app.extensions[id].enabled === false` masking when present. |
| `resolveProfileName(state, profileId)` | `string \| undefined` | Action handler falls back to profile id when undefined. |

The build action (`buildPackageAction.ts`) currently keeps its own copies of `resolveVortexVersion` / `resolveGameVersion` / `resolveDeploymentMethod`. That duplication is intentional for now — slice 5 isn't a refactor of the build action. A later cleanup will consolidate.

## Behavior

### Trigger

Called by the install page's loading pipeline (`src/ui/pages/install/engine.ts`; formerly also by the removed toolbar action) once it has:
- a `.ehcoll` parsed via `readEhcoll`,
- an `InstallReceipt | undefined` from `readReceipt`,
- a freshly-hashed `AuditorMod[]` from `getModsForProfile` + `enrichModsWithArchiveHashes`.

Phase 5's React UI calls the same builder; the input shape is the same.

### `buildUserSideState` step-by-step

1. **Project installed mods.** Walk `installedMods: AuditorMod[]`, emit one `InstalledMod` per entry:
   - Copy `id`, `name`, `enabled` verbatim.
   - Coerce `nexusModId` / `nexusFileId` to `number` (drop unparseable).
   - Copy `archiveSha256` if present (skip when missing — absence is "byte-identity unknown" per the resolver's contract).
2. **Tag lineage.** When `receipt !== undefined`, build a map `vortexModId → ModEventHorizonInstallTag` from `receipt.mods`. For each projected `InstalledMod`, attach `eventHorizonInstall` if its `id` is in the map. The tag carries:
   - `collectionPackageId` from the receipt's `packageId`,
   - `collectionVersion` from the receipt's `packageVersion`,
   - `originalCompareKey` from the per-mod entry,
   - `installedAt` from the per-mod entry.
3. **Project `previousInstall`** from the receipt, or leave undefined.
4. **Pass through everything else** (`gameId`, `gameVersion`, etc.) verbatim.

### `pickInstallTarget` step-by-step

1. If `receipt !== undefined`, return `{ kind: "current-profile", profileId, profileName }`.
2. Otherwise, return `{ kind: "fresh-profile", suggestedProfileName: "<package.name> (Event Horizon v<package.version>)" }`.

The action handler never overrides this. There is no "always install into current profile" toggle in v1 — that's a deliberate part of the safety contract.

## Lineage rule (LOAD-BEARING)

A mod's `eventHorizonInstall` tag attaches **iff** `receipt.mods[i].vortexModId === installedMod.id`.

We never:
- match by name (Vortex changes display names freely);
- match by Nexus IDs (different installs of the same Nexus mod can collide);
- match by archive SHA-256 (a mod can have the same archive across multiple collections).

The receipt is the **only** authority. If the receipt is lost, lineage is lost — and the install gracefully degrades to fresh-profile mode (no orphans, no diverged decisions). See [`INSTALL_LEDGER.md`](INSTALL_LEDGER.md).

## Install-target rule (LOAD-BEARING)

Recap from [`INSTALL_PLAN_SCHEMA.md`](INSTALL_PLAN_SCHEMA.md):

> Receipt present ⇒ `current-profile`. Receipt missing ⇒ `fresh-profile`. Forced.

This module is the only place that rule lives. Every install path goes through `pickInstallTarget`, so adding a future install entry point (e.g. CLI, automation) cannot accidentally bypass the rule.

The fresh-profile suggested name is a deterministic function of the manifest:

```
"<package.name> (Event Horizon v<package.version>)"
```

The driver may append a `(2)` / `(3)` collision suffix at install time — the resolver doesn't know the final name, only the suggestion.

## Inputs the builder does NOT collect

These are the action-handler's responsibility, by design:

| Input | Why action-handler owns it |
|---|---|
| Hashing `installedMods` archives | Async / slow. The action runs the snapshot pipeline (`enrichModsWithArchiveHashes`) and feeds in already-hashed `AuditorMod[]`. |
| Reading the receipt | Async I/O. Action handler calls `installLedger.readReceipt`. |
| Reading state | Synchronous but specific. The state-shape readers exposed by this module are called by the action handler, not by the builder. |
| Hashing `availableDownloads` | Slow; the action handler decides when (slice 5 leaves it `undefined`). |
| Verifying external dependencies | Requires game-relative path resolution; deferred to slice 6. |

Keeping the builder pure / sync makes it trivially testable with hand-rolled fixtures.

## Quirks & invariants

1. **Pure & sync.** `buildUserSideState` and `pickInstallTarget` perform zero I/O and never call `Date.now()`. Every byte of output is a function of the inputs.
2. **Lineage authority is the receipt, full stop.** No name fallback, no Nexus-ID fallback, no SHA fallback. See [`INSTALL_LEDGER.md`](INSTALL_LEDGER.md).
3. **Co-determination invariant.** `installTarget.kind === "current-profile"` ⇔ `receipt !== undefined` ⇔ `userState.previousInstall !== undefined`. The picker enforces this; the resolver throws if violated.
4. **`enabledExtensions` is permissive.** Extensions found in `state.session.extensions.installed` are considered enabled unless `state.app.extensions[id].enabled === false` is explicitly set. Vortex builds with neither field collapse to "no extensions reported."
5. **`deploymentMethod` returns `undefined` not a default.** Unlike the build action (which defaults to `"hardlink"`), the install path returns `undefined` so the resolver can emit `status: "unknown"` rather than misreporting a guess as "ok."
6. **`coerceNexusId` drops unparseable.** Vortex stores Nexus IDs as numbers in normal use; some legacy importers wrote strings. The coercer accepts both, drops anything else (the mod becomes invisible to Nexus identity matching).
7. **Suggested fresh-profile name is deterministic.** Same manifest ⇒ same name. The driver handles collision suffixes; the resolver/builder never touches them.
8. **Byte-identity-unknown is forwarded as `undefined`.** When `mod.archiveSha256` is missing on a hashed `AuditorMod` (e.g. archive deleted from downloads folder), it stays missing on `InstalledMod`. The resolver treats absent `archiveSha256` as "byte-identity unknown," NOT "different bytes" — see [`RESOLVE_INSTALL_PLAN.md`](RESOLVE_INSTALL_PLAN.md).
