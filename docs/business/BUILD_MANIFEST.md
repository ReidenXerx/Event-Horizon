# Build Manifest — `ExportedModsSnapshot` → `.ehcoll`

**Source of truth:** `src/core/manifest/buildManifest.ts` (Phase 2 slice 2).
**Schema reference:** `src/types/ehcoll.ts` and [`MANIFEST_SCHEMA.md`](MANIFEST_SCHEMA.md).

## Purpose

The packager's job is to take the curator's exported snapshot
([`ExportedModsSnapshot`](../DATA_FORMATS.md#event-horizon-mods-snapshot)) plus a
small bag of environmental inputs (game version, Vortex version, the curator's
`plugins.txt`, optional external-mod metadata) and produce one fully-typed
[`EhcollManifest`](../../src/types/ehcoll.ts) ready to be written to
`manifest.json` inside the `.ehcoll` ZIP.

`buildManifest` is a **pure function**. It does not read state, the filesystem,
or the network. The action handler (Phase 2 slice 4) is responsible for
gathering inputs; the builder is responsible for shape and validation. This
separation is deliberate and load-bearing for tests.

## Inputs

```
buildManifest({
  snapshot,             // the ExportedModsSnapshot we already produce on export
  package: {            // curator-supplied collection metadata
    id, name, version, author, description?, createdAt?, strictMissingMods?
  },
  game:    { version, versionPolicy? },
  vortex:  { version, deploymentMethod, requiredExtensions? },
  pluginsTxtContent?,   // raw contents of %LOCALAPPDATA%\<game>\plugins.txt
  externalMods?,        // per-mod overrides keyed by AuditorMod.id
  externalDependencies? // pass-through; defaults to []
})
```

### Defaults applied by the builder

| Field                                 | Default when missing            |
| ------------------------------------- | ------------------------------- |
| `package.createdAt`                   | `new Date().toISOString()`      |
| `package.strictMissingMods`           | `false` (skip + warn at install)|
| `game.versionPolicy`                  | `"exact"`                       |
| `vortex.requiredExtensions`           | `[]`                            |
| `pluginsTxtContent`                   | undefined ⇒ `plugins.order: []` |
| `externalDependencies`                | `[]`                            |
| `externalMods[id].bundled`            | `false`                         |
| `externalMods[id].expectedFilename`   | `mod.name`                      |

## Outputs

```
{
  manifest: EhcollManifest,   // ready for JSON.stringify
  warnings: string[]          // non-fatal issues for the UI
}
```

### Fatal errors

The builder collects every problem it sees, then throws a single
`BuildManifestError` with the full list. The toolbar action surfaces these
together so the curator gets one report instead of whack-a-mole.

| Cause                                                 | Message gist                                       |
| ----------------------------------------------------- | -------------------------------------------------- |
| Snapshot `gameId` is not in `SupportedGameId`         | `Unsupported gameId "<x>". Event Horizon supports: ...` |
| A mod has no `archiveSha256`                          | `Mod "<id>" has no archiveSha256. Cannot pack...` |
| Two mods resolve to the same `compareKey`             | `Duplicate compareKey "<key>" for mods "<a>" and "<b>"` |

### Non-fatal warnings

Returned as strings, never thrown. The UI lists them under "issues — install
will still work but the curator may want to investigate."

| Cause                                                          | Outcome                          |
| -------------------------------------------------------------- | -------------------------------- |
| Rule with unknown `type` (not in the schema's `ModRuleType` union) | Rule dropped                     |
| Rule's reference cannot resolve to any compareKey form        | Rule dropped                     |
| Deployment entry whose `source` doesn't match any snapshot mod | File-override entry dropped      |

## Mod identity (the load-bearing part)

The discriminator is `source.kind` and the rules are strict:

- **Nexus** — `mod.source === "nexus"` AND `mod.nexusModId !== undefined` AND
  `mod.nexusFileId !== undefined` AND `mod.archiveSha256` is present.
  - `compareKey = "nexus:<modId>:<fileId>"`
  - `source.gameDomain` is filled from the hardcoded
    `NEXUS_GAME_DOMAIN_BY_GAME_ID` table inside the converter (Vortex's
    gameId vs. Nexus's URL domain don't always match — `skyrimse` ↔
    `skyrimspecialedition`, `falloutnv` ↔ `newvegas`).
- **External** — anything else, provided `mod.archiveSha256` is present.
  - `compareKey = "external:<sha256>"` — diverges from
    `getModCompareKey()`'s `archive:<archiveId>` fallback because the local
    Vortex archive id has no meaning on the user's machine.

**INVARIANT:** No mod is included in the manifest without `archiveSha256`.
This is enforced at packaging time, not install time. If the curator's
snapshot has a mod with no hash (because the source archive was missing
from Vortex's download cache when they exported), the build fails with a
clear error and the curator re-exports.

## Rules

Walk every mod's `rules: CapturedModRule[]`, emit one `EhcollRule` per
captured rule, with these mappings:

- `source` ← the owning mod's manifest compareKey (the one we just synthesized).
- `type` ← `rule.type`, validated against `ModRuleType`. Unknown ⇒ **drop + warn**.
- `reference` ← strongest available pin from `rule.reference`, in priority order:
  1. `nexusModId` AND `nexusFileId` ⇒ `"nexus:<modId>:<fileId>"`
  2. `nexusModId` only ⇒ `"nexus:<modId>"` (partial pin — installer downgrades to "any file id")
  3. `id` that resolves to a mod in this same snapshot ⇒ that mod's compareKey
  4. `archiveId` ⇒ `"archive:<archiveId>"` (local-only; installer warns)
  5. None of the above ⇒ **drop + warn**
- `comment`, `ignored` pass through as-is.

Rules are sorted by `(source, type, reference)` ASC for byte-stable manifests.

## File overrides (top-level outcome)

Walk every `CapturedDeploymentManifest` in the snapshot. For each entry:

- `filePath` ← `relPath` with backslashes normalized to `/`.
- `winningMod` ← look up `entry.source` (a Vortex mod folder name = `AuditorMod.id`)
  in the snapshot, use that mod's compareKey. If not found ⇒ **drop + warn**
  ("mod was likely uninstalled between deploy and snapshot").
- `losingMods` ← `[]`.

**INVARIANT (v1):** `losingMods` is always `[]`. Vortex's deployment manifest
records the winner and any merge sources but does NOT record losers. Computing
losers requires walking every mod's staging tree, which the pure converter
cannot do without I/O. Empty list is the honest answer; the installer doesn't
need losers to deploy correctly. Losers can be added in a v1.x revision when
a state-aware capture pass populates them.

Output array is sorted by `filePath` ASC.

## Plugins

`pluginsTxtContent` is parsed via the existing `parsePluginsTxt` from
`comparePlugins.ts` (the same code we use for the diff action — single source
of truth for plugins.txt grammar). Each parsed entry becomes one
`EhcollPluginEntry { name, enabled }`. Order is preserved exactly as
`plugins.txt` had it.

When `pluginsTxtContent` is undefined the manifest emits `plugins: { order: [] }`.

## INI tweaks

`iniTweaks: []`. Schema placeholder for Phase 5 — the v1 packager has no INI
tweak handling yet.

## External dependencies

Pass-through from input. The builder does not validate `instructions`,
`destination`, or hashes — that's the action handler's job (it will run a
schema check before passing).

## Versioning policy

The builder always emits `schemaVersion: 1`. Additive changes (new optional
fields on existing types) keep `1`; breaking changes bump to `2` and require
a new builder. The producer-consumer contract is documented in detail in
[`MANIFEST_SCHEMA.md` § Versioning](MANIFEST_SCHEMA.md#versioning-policy).

## Why pure?

The converter never touches Vortex state, the disk, or the network. Three
reasons:

1. **Testability.** A pure transform is trivially unit-testable with hand-rolled
   fixtures. The action handler in slice 4 is the only code that needs heavy
   mocking.
2. **Re-entrancy.** A curator can preview the manifest in the UI (e.g. "show
   me what will be packed") without committing to write anything to disk.
3. **Single source of state-reading.** `getModsForProfile`, `captureDeploymentManifests`,
   and `captureLoadOrder` already own all state-reading in this codebase. The
   builder consuming their outputs preserves that invariant.

## Non-goals (explicit)

- **No byte-handling.** The builder doesn't know about the package's `bundled/`
  folders. The packager (slice 3) handles those, given the manifest.
- **No README/CHANGELOG generation.** Curator-supplied content goes in via
  the action handler's UI; the builder doesn't see it.
- **No de-duplication of identical mods.** If two AuditorMod entries resolve
  to the same compareKey it's a fatal error, not a silent dedupe — the curator
  needs to know the snapshot has a problem.
- **No reading from `state.persistent.downloads`.** The original archive
  filename is not currently in the snapshot, so `archiveName` falls back to
  `mod.name`. Slice 4 will pass real filenames through `externalMods` /
  per-mod overrides.

## See also

- [`MANIFEST_SCHEMA.md`](MANIFEST_SCHEMA.md) — the manifest shape we're producing.
- [`AUDITOR_MOD.md`](AUDITOR_MOD.md) — the snapshot shape we're consuming.
- [`FILE_OVERRIDES_CAPTURE.md`](FILE_OVERRIDES_CAPTURE.md) — where the
  deployment manifests we read here come from.
- [`ORDERING.md`](ORDERING.md) — `installOrder` and load order capture.
- [`../PROPOSAL_INSTALLER.md`](../PROPOSAL_INSTALLER.md) — full installer design.
