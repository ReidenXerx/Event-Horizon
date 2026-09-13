# Manifest Schema (`.ehcoll` v2)

The contract for the JSON document at the root of every Event Horizon collection package. Both sides of the pipeline — the curator-side packager (Phase 2) and the user-side resolver/installer (Phases 3–4) — read this spec; if either drifts from it, the other will reject the result.

The TypeScript source of truth is [`src/types/ehcoll.ts`](../../src/types/ehcoll.ts). When prose disagrees with the types: **the types are the spec**. When the types disagree with this prose: open an issue.

---

## Trigger / scope

This spec defines a static data shape, not a runtime operation. It applies to:

- **Producers** — code that builds a `manifest.json` from a Vortex profile. Currently only the Phase 2 packager (`src/core/manifest/...`, to be added next slice).
- **Consumers** — code that reads `manifest.json` from a `.ehcoll` package. Currently the Phase 3 resolver and Phase 4 installer (not yet implemented). Reconciler tooling (Phase 4.5+) also reads it.

Anything else (snapshots, diff reports) lives in [`DATA_FORMATS.md`](../DATA_FORMATS.md). The two formats are deliberately separate — a snapshot is a *capture* of a single profile; a manifest is a *recipe* the installer follows on someone else's machine.

---

## Top-level shape

```jsonc
{
  "schemaVersion": 2,                     // see "Versioning policy"
  "package":  { /* PackageMetadata */ },
  "game":     { /* GameMetadata */ },
  "vortex":   { /* VortexMetadata */ },
  "mods":     [ /* EhcollMod[] */ ],
  "rules":    [ /* EhcollRule[] */ ],
  "fileOverrides": [ /* EhcollFileOverride[] */ ],
  "plugins":  { /* EhcollPlugins */ },
  "iniTweaks":  [ /* EhcollIniTweak[]   — v1 packagers emit []  */ ],
  "externalDependencies": [ /* EhcollExternalDependency[] */ ]
}
```

**INVARIANT**: every field at this level is mandatory and non-null. Empty arrays/objects are valid; missing keys are not. The installer rejects a manifest that lacks any top-level field, regardless of the section's contents.

**INVARIANT**: an unknown extra top-level field is **ignored**, not rejected. This is what lets us add fields without bumping `schemaVersion`. Only renaming or removing a field is breaking.

---

## Sections

### `package` — `PackageMetadata`

Identifies the collection and steers high-level install policy.

| Field | Required | Format | Meaning |
|---|---|---|---|
| `id` | yes | UUIDv4 | Stable across re-exports of the *same* collection. The installer keys its install-cache and resume-from-crash files by this. |
| `name` | yes | string | User-visible. |
| `version` | yes | semver | User-visible. Distinguishes releases of the same `id`. |
| `author` | yes | string | User-visible. |
| `createdAt` | yes | ISO-8601 UTC | When this manifest was generated. |
| `description` | no | string | Free-form, shown in the install confirmation dialog. |
| `strictMissingMods` | yes | boolean | `true` ⇒ abort install if any mod can't be resolved. `false` ⇒ skip + warn, drift-report. Default for the packager: `false`. |

**INVARIANT**: `id` is generated once at first export and re-used by the packager forever. The user-facing "this is the same collection you installed before" check breaks if curators regenerate it per release.

---

### `game` — `GameMetadata`

| Field | Required | Format | Meaning |
|---|---|---|---|
| `id` | yes | one of `skyrimse \| fallout3 \| falloutnv \| fallout4 \| starfield` | Locked at the type level. The installer refuses any other id. |
| `version` | yes | string | Curator's installed game version. The installer reads `versionPolicy` to decide what to do on mismatch. |
| `versionPolicy` | yes | `"exact" \| "minimum"` | `"exact"`: byte-equal match. `"minimum"`: user's version `>=` curator's (semver compare). |

**INVARIANT**: `game.id` matches the Vortex `gameId` exactly — same string that flows through `selectors.activeGameId`. No display-name forms.

---

### `vortex` — `VortexMetadata`

Captures the curator's Vortex environment so the installer can refuse incompatible setups before any work happens.

| Field | Required | Format | Meaning |
|---|---|---|---|
| `version` | yes | string | Curator's Vortex version. Mismatch ⇒ warn-only (we don't refuse on Vortex version itself). |
| `deploymentMethod` | yes | `"hardlink" \| "symlink" \| "copy"` | Informational. The user's Vortex setting wins. |
| `requiredExtensions` | yes | array | Other Vortex extensions that MUST be present and enabled on the user side. The installer refuses-to-install if any are missing. |

#### `RequiredExtension`

```jsonc
{ "id": "loot-functionality", "minVersion": "..." }   // minVersion optional
```

LOOT is the canonical example — the installer needs LOOT to sort plugins, so a `.ehcoll` that depends on plugin order ships LOOT as a `requiredExtensions` entry.

---

### `mods` — `EhcollMod[]`

The heart of the manifest. Each entry is a discriminated union by `source.kind`:

```
EhcollMod
├─ NexusEhcollMod   (source.kind = "nexus")
└─ ExternalEhcollMod (source.kind = "external")
```

#### Common fields (`EhcollModBase`)

| Field | Required | Format | Meaning |
|---|---|---|---|
| `compareKey` | yes | string | Stable identity for diff/reconcile. See [`AUDITOR_MOD.md`](AUDITOR_MOD.md) for the full ladder. The packager uses Nexus ids when available, then `archive:`, then `external:<sha256>` for external mods. |
| `name` | yes | string | UI display only. **Never** used for identity. |
| `version` | no | string | UI display. |
| `install` | yes | `ModInstallSpec` | What the FOMOD installer should replay. |
| `state` | yes | `ModInstallState` | Enabled flag, install/deployment ordering, modtype, per-mod overrides. |
| `attributes` | no | `ModUiAttributes` | Optional UI metadata (`category`, `description`). |

#### `source` — `NexusModSource`

```jsonc
{
  "kind": "nexus",
  "gameDomain": "skyrimspecialedition",
  "modId": 1234,
  "fileId": 567890,
  "archiveName": "SkyUI_5_2_SE-12345-5-2SE-1234567890.7z",
  "sha256": "abc…"   // 64 hex lowercase, MANDATORY
}
```

- **Identity for retrieval**: `(gameDomain, modId, fileId)` — the installer downloads via the Nexus API using these.
- **Identity for verification**: `sha256`. After download, the installer streams the archive through SHA-256 and refuses to install on mismatch (Nexus served different bytes ⇒ HARD FAIL).
- `archiveName` is for the download UI; not used for identity.

#### `source` — `ExternalModSource`

```jsonc
{
  "kind": "external",
  "expectedFilename": "MyPrivateFix-1.0.7z",
  "sha256": "def…",  // 64 hex lowercase, MANDATORY — sole identity
  "instructions": "Download from <internal share URL> or DM curator.",
  "bundled": false   // true ⇒ the mod's files are in the package at bundled/<sha256>/
}
```

- **Identity is `sha256` alone.** No filename match, no version match, no "trust the user". See the load-bearing rule below.
- `expectedFilename` is a hint for the user-side picker prompt.
- `instructions` is shown when `bundled === false`. Should include a stable URL and any DM-the-curator language.
- `bundled === true` means the mod's files live, loose, at `bundled/<sha256>/` inside the package. The installer writes the archive back from them — the canonical zip (`bundleZip.ts`) whose SHA-256 is `sha256` — and installs it without prompting; files that do not make that hash are refused.

#### `install` — `ModInstallSpec`

```jsonc
{
  "fomodSelections": [ /* FomodSelectionStep[] */ ],
  "installerType": "fomod"   // optional: "fomod" | "raw" | other
}
```

- `fomodSelections` mirrors `AuditorMod.fomodSelections` (see [`AUDITOR_MOD.md`](AUDITOR_MOD.md)). Order is significant — it's the installer's step sequence.
- `installerType` is a hint; the installer picks behavior on the actual archive structure but uses this to validate up-front.

#### `state` — `ModInstallState`

```jsonc
{
  "enabled": true,
  "installOrder": 14,
  "deploymentPriority": 14,
  "modType": "",
  "fileOverrides": ["meshes/foo.nif"],
  "enabledINITweaks": ["my-tweak.ini"]
}
```

- `installOrder` and `deploymentPriority` are usually equal but Vortex's rule engine and deployment engine consume them via different code paths — they're stored separately so we can capture either independently if Vortex ever diverges them.
- `fileOverrides` here is the **per-mod intent** (curator's "this mod wins") from `mod.fileOverrides`. The top-level `EhcollFileOverride[]` is the **outcome** (what actually deployed). Both are kept; see "File overrides" below.
- `enabledINITweaks` is the curator's INI tweak selection list (filenames). Empty array when none.

---

### `rules` — `EhcollRule[]`

Mod ordering and dependency rules, captured per-source-mod.

```jsonc
{
  "source": "nexus:1234:567890",          // compareKey of the rule's owner
  "type": "after",                         // before|after|requires|recommends|conflicts|provides
  "reference": "nexus:9999:111",          // compareKey OR partial "nexus:modId"
  "comment": "skyui must come after the patch",
  "ignored": false                         // optional, omitted unless true
}
```

- `source` is always a fully-pinned `compareKey`.
- `reference` may be either fully pinned (`"nexus:1234:567890"`, `"archive:..."`, `"external:<sha256>"`) or partially pinned by Nexus mod id only (`"nexus:1234"`), the latter matching any file id of that Nexus mod the user has.
- The packager **canonically sorts** rules so two manifests built from byte-equal Vortex states produce byte-equal manifests. See [`MOD_RULES_CAPTURE.md`](MOD_RULES_CAPTURE.md) for the canonical sort key.

**INVARIANT**: rules referencing a `compareKey` not present in `mods` are kept and pass through to the installer, which warns and ignores them. Curators sometimes leave rules referencing now-removed mods; we preserve them for audit.

---

### `fileOverrides` — `EhcollFileOverride[]`

The **outcome** side of conflict resolution: which mod won which file in the curator's actual deployment.

```jsonc
{
  "filePath": "Data/meshes/example.nif",   // POSIX-relative inside data target
  "winningMod": "nexus:1234:567890",
  "losingMods": ["nexus:1111:222", "nexus:3333:444"]
}
```

- Derived by the packager from the captured deployment manifests (see [`FILE_OVERRIDES_CAPTURE.md`](FILE_OVERRIDES_CAPTURE.md)).
- Sorted by `filePath` ascending for byte-stable manifests.
- POSIX separators (`/`) only, even though Vortex stores Windows paths internally — the packager normalizes.

**Why both this and `mod.state.fileOverrides`?** They model different things and they can disagree on a misconfigured curator machine:

| Source | Meaning |
|---|---|
| `mod.state.fileOverrides` | Curator's *intent* — "Vortex, please deploy this file from this mod." Set explicitly via the conflict-resolution UI. |
| Top-level `fileOverrides` | Curator's *outcome* — what Vortex actually deployed last time. From `vortex.deployment.json`. |

If they disagree, the installer reports it in the post-install drift report. The user-side install reproduces the *outcome* (deterministic), and the drift report tells the curator they have stale intent.

---

### `plugins` — `EhcollPlugins`

The exact contents of the curator's `plugins.txt`, normalized.

```jsonc
{
  "order": [
    { "name": "Skyrim.esm",  "enabled": true },
    { "name": "Update.esm",  "enabled": true },
    { "name": "MyMod.esp",   "enabled": true }
  ]
}
```

- `order` is in `plugins.txt` order. The user-side installer overwrites the user's `plugins.txt` to match (with backup).
- Plugin filenames are stored with **original casing** (Skyrim.esm vs skyrim.esm). The user-side normalization for matching uses `.toLowerCase()` (mirroring [`comparePlugins.ts`](../../src/core/comparePlugins.ts)) but the file written back preserves the curator's casing.
- The leading-`*` enabled marker is *not* stored in `name`; it's the `enabled` boolean.

**INVARIANT**: Phase 2 packagers must include `plugins` even when there's no `plugins.txt` (e.g. games that don't use one — none currently in our supported list, but this future-proofs the schema). Empty `order` array is valid.

---

### `iniTweaks` — `EhcollIniTweak[]`

```jsonc
{ "ini": "Skyrim.ini", "section": "Display", "key": "fGamma", "value": "1.0000" }
```

**STATUS**: schema placeholder. packagers emit `iniTweaks: []` and installers ignore the field. The Vortex Redux key for INI tweaks still has to be confirmed at runtime (see [`PROPOSAL_INSTALLER.md`](../PROPOSAL_INSTALLER.md) §7.4). Promoted to a real feature in Phase 5.

It's reserved in v1 anyway because:

- adding it later as a top-level field is a breaking change (a v1 manifest without it would still be rejected by a stricter v2 installer);
- adding it now with empty arrays lets future packagers populate it without bumping `schemaVersion`.

---

### `externalDependencies` — `EhcollExternalDependency[]`

Things the user has to install by hand: script extenders, ENB binaries, fixed loaders.

```jsonc
{
  "id": "skse64",
  "name": "Skyrim Script Extender",
  "category": "script-extender",
  "version": "2.2.6",
  "destination": "<gameDir>",
  "files": [
    { "relPath": "skse64_loader.exe",  "sha256": "…" },
    { "relPath": "skse64_1_5_97.dll",  "sha256": "…" }
  ],
  "instructionsUrl": "https://skse.silverlock.org/",
  "instructions": "Download SKSE 2.2.6 'Current SE build', extract loader+dll+steam_loader.dll into the Skyrim install folder."
}
```

- `destination` is a token — `"<gameDir>"`, `"<dataDir>"`, `"<scripts>"`. The user-side installer maps these to absolute paths per game. No literal absolute paths in manifests.
- `files[].relPath` is relative to `destination`, POSIX separators.
- `files[].sha256` is the verification hash. The installer hashes the file at `<resolved destination>/<relPath>` after the user reports the dep is installed; mismatch ⇒ re-prompt up to 3×, then offer "skip / abort all".
- `instructions` is mandatory because the user has to do work; `instructionsUrl` is a clickable link in the dialog.

**INVARIANT**: We never auto-overwrite files in the game directory. External deps are the user's responsibility; we only verify.

---

## The load-bearing mod identity rule

This is the single most important paragraph in the spec. It is **why** Event Horizon is reliable where Vortex's vanilla collections are not.

| `source.kind` | Identity | Verified by | On mismatch |
|---|---|---|---|
| `"nexus"` | `(gameDomain, modId, fileId)` | `source.sha256` after download | HARD FAIL — Nexus served different bytes |
| `"external"` | `source.sha256` (sole identity) | `source.sha256` of the user-supplied archive, or of the archive written back from `bundled/` | re-prompt up to 3× → HARD FAIL or skip |

There is no third tier. There is no name/version/filename fallback. **A mod whose archive bytes do not produce the expected SHA-256 is, by definition, a different mod**, and the installer treats it as missing.

Why this is the load-bearing rule:

- Vortex's vanilla collections identify mods by Nexus IDs only. For mods *not* on Nexus they effectively have no identity check — they ship "external dependency: download X manually" instructions and hope. Users download wrong versions, the collection breaks subtly, the curator gets blamed. Event Horizon replaces "hope" with a hash check.
- The `archiveSha256` field on `AuditorMod` (Phase 1 slice 1) is the source of truth here: same field, two consumers (the curator's drift detection AND the installer's identity check).
- The `bundled/` folder is keyed by SHA-256, never by filename: one folder per bundle, named by the hash of the canonical zip its files make. Two mods whose files are identical are stored once, resolved twice.

See [`PROPOSAL_INSTALLER.md`](../PROPOSAL_INSTALLER.md) §5.5 for the full design rationale and the edge case where a curator updates an external mod's archive between releases.

---

## Versioning policy

| Change | New `schemaVersion`? |
|---|---|
| Add a new optional sub-field | no |
| Add a new entry to a string union | no — older installers see the new value as unknown and fall through to a default |
| Add a new mandatory sub-field with a documented default | no — installers fill in the default; producers must always emit it |
| Add a new top-level array/object | yes if missing-key behavior is "reject"; no if it's "ignore" — pick "ignore" by default and stay on the current version |
| Rename a field | yes |
| Change a field's type or semantics | yes |
| Remove a field | yes |

**INVARIANT**: an installer rejects every `schemaVersion` but its own. It does not "best-effort". This is intentional — silent partial reads break reproducibility worse than a hard refusal.

**v2 (2026-09-13).** Bundled mods ship as their loose files, `bundled/<sha256>/<path>`, instead of as archives — Nexus quarantines a package with an archive inside it — and a bundled mod's `source.sha256` is the sha256 of the canonical zip its files make (`bundleZip.ts`), which the installer writes back and checks. A v1 installer refuses a v2 manifest ("Update the Event Horizon extension to install newer manifests"). A v2 installer refuses a v1 manifest as well, saying the package was built by an older Event Horizon and to download the collection's current package — the curator's decision was the new layout only, so there is no toggle to emit or read v1.

---

## Producer / consumer responsibilities

### Packager (Phase 2)

- Validates types at build time using the TypeScript definitions.
- Emits canonical, byte-stable JSON: keys in declaration order, arrays sorted per their per-section invariants (rules canonical sort, fileOverrides by `filePath`, plugins by `order` index, etc.).
- Computes `sha256` of every archive *before* writing the manifest (no placeholder hashes).
- Refuses to emit when any mod lacks `archiveSha256` and is needed for `manifest.mods` — this is what catches "manual mod with no resolvable archive" early.

### Installer (Phases 3–4)

- Parses with type validation. Rejects unknown `schemaVersion`, missing top-level fields, malformed SHA-256 strings.
- Treats unknown extra fields as ignored (forward compat within a version).
- Verifies every SHA-256 — Nexus mods after download, external mods at resolution time. Refuses to proceed on any mismatch.
- Resolves `compareKey` references (in `rules`, `fileOverrides`) against `mods[].compareKey`. References pointing to absent mods are warnings, not errors.

---

## Quirks and invariants

- **INVARIANT**: every SHA-256 string is lowercase hex, exactly 64 characters. Producers normalize. Consumers reject anything else (catches corrupted manifests early).
- **INVARIANT**: every timestamp is ISO-8601 UTC ending in `Z`. No local-time, no offsets.
- **INVARIANT**: every relative path uses POSIX separators (`/`). The packager normalizes Vortex's Windows paths.
- **INVARIANT**: empty arrays and empty strings are valid; `null` and `undefined` are not. Producers must emit empty containers, not omit the keys.
- **INVARIANT**: `compareKey` strings are stable across re-exports of the same Vortex state. Two packager runs against an unchanged profile produce byte-equal manifest mods arrays.
- **QUIRK**: the schema has both per-mod and top-level `fileOverrides`. They model different things (intent vs outcome) and may disagree. See "File overrides" above.
- **QUIRK**: `iniTweaks` is in the schema as a placeholder; packagers emit `[]`. Real INI tweak support arrives in Phase 5.
- **QUIRK**: `installOrder` and `deploymentPriority` are usually equal but always captured separately. We model them independently because Vortex consumes them via different code paths internally.

---

## Code references

- TypeScript types: [`src/types/ehcoll.ts`](../../src/types/ehcoll.ts)
- Related: [`src/core/getModsListForProfile.ts`](../../src/core/getModsListForProfile.ts) — `AuditorMod`, `FomodSelectionStep`, `CapturedModRule`, `CapturedRuleReference`
- Design: [`docs/PROPOSAL_INSTALLER.md`](../PROPOSAL_INSTALLER.md) (§5–§6, §5.5)
- Snapshot format (sibling, not part of `.ehcoll`): [`docs/DATA_FORMATS.md`](../DATA_FORMATS.md)
