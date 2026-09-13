# Resolve Install Plan — `(manifest, userState, installTarget) → InstallPlan`

**Source of truth:** `src/core/resolver/resolveInstallPlan.ts` (Phase 3 slice 4).
**Contract reference:** [`INSTALL_PLAN_SCHEMA.md`](INSTALL_PLAN_SCHEMA.md), `src/types/installPlan.ts`.
**Identity rule:** [`docs/PROPOSAL_INSTALLER.md`](../PROPOSAL_INSTALLER.md) §5.5 (LOAD-BEARING).

## Purpose

The resolver is the brain of the installer. Given:

1. A validated `EhcollManifest` (from [`readEhcoll`](READ_EHCOLL.md) → [`parseManifest`](PARSE_MANIFEST.md)),
2. A `UserSideState` snapshot the action handler built from Vortex Redux + the install ledger,
3. An `InstallTarget` the action handler picked atomically with the ledger lookup,

it produces an [`InstallPlan`](INSTALL_PLAN_SCHEMA.md) — the typed description of "what would happen if we installed this collection right now."

The plan **describes intent, never executes**. The install driver (Phase 3 slice 6) is the only thing that mutates filesystem or Vortex state, and it consumes the plan exclusively.

The resolver is a **pure function**. No filesystem, no network, no state access, no `Date.now()`. Every input it sees is on the `(manifest, userState, installTarget)` triple; every byte of output is on the returned plan.

## Why pure?

Three concrete payoffs:

1. **Re-resolves are free.** The action handler can re-run the resolver any time the user supplies a missing external archive, switches profiles, or installs an extension. No invalidation logic, no caching gymnastics.
2. **The plan is auditable.** Dump it as JSON, ship it to a teammate, attach it to a bug report. The resolver behaves identically against the same inputs.
3. **The driver is forced to use the contract.** When the resolver doesn't read state, the only inputs to install behavior are the ones spelled out on `UserSideState`. A bug in the driver that reaches into Vortex state outside what's on the plan is structurally visible.

## Inputs

```
resolveInstallPlan(
  manifest: EhcollManifest,
  userState: UserSideState,
  installTarget: InstallTarget,
): InstallPlan
```

The action handler is the sole authority on `installTarget` — it picks `current-profile` vs `fresh-profile` based on whether the install ledger has a receipt for `manifest.package.id` ([INSTALL_PLAN_SCHEMA.md "Install target"](INSTALL_PLAN_SCHEMA.md#install-target-current-profile-vs-fresh-profile)). The resolver enforces the co-determination as an invariant: `current-profile` ⇔ `userState.previousInstall` defined. A mismatch throws (programming error, not data error).

## Outputs

A fully-populated `InstallPlan`. Every field is filled, even when no work is needed (`pluginOrder.kind === "none"`, `orphanedMods === []`, etc.). The driver can switch on each field's discriminator without null-checking.

## High-level resolution shape

The resolver runs eight independent passes over its inputs:

1. **Invariant guard** — verify `installTarget` and `userState.previousInstall` are co-determined.
2. **Compatibility checks** — game id, game version (per policy), required Vortex extensions, Vortex client version, deployment method.
3. **Per-mod resolution** — for each `manifest.mods[i]`, pick exactly one of the 12 `ModDecision` arms.
4. **Orphan detection** — only when in `current-profile` mode; produces empty list otherwise.
5. **External-dependency checks** — per-dep status (`ok` / `files-mismatch` / `missing` / `not-verified`) keyed against `userState.externalDependencyState`.
6. **Plugin order plan** — `replace` if the manifest carries plugins, `none` if not.
7. **Rule plan** — pre-resolved against the manifest's mod set; rules with absent sources or `ignored: true` become `skip` entries.
8. **Summary** — derive aggregate counts and the `canProceed` verdict.

The passes are independent by design: a curator inspecting a plan sees per-mod decisions even when compatibility fails (because game version is wrong), and the UI can surface a partial plan with "fix compatibility, then come back" guidance.

## Per-mod resolution ladder (LOAD-BEARING)

The per-mod ladder is the most identity-sensitive piece in the system. It encodes [§5.5](../PROPOSAL_INSTALLER.md) literally.

### Nexus mods, `current-profile` mode

For each `manifest.mods[i]` where `source.kind === "nexus"`:

| Step | Match against | Decision |
|---|---|---|
| 1 | An installed mod with `nexusModId === source.modId AND nexusFileId === source.fileId AND archiveSha256 === source.sha256` | `nexus-already-installed` |
| 2 | A download with `sha256 === source.sha256` | `nexus-use-local-download` |
| 3 | An installed mod with `nexusModId === source.modId AND nexusFileId !== source.fileId` | `nexus-version-diverged` (`recommendation: "manual-review"`) |
| 4 | An installed mod with `nexusModId === source.modId AND nexusFileId === source.fileId AND archiveSha256 !== source.sha256` (and SHA known) | `nexus-bytes-diverged` (`recommendation: "manual-review"`) |
| 5 | None of the above | `nexus-download` |

A few subtleties worth calling out:

- **An installed mod with no `archiveSha256` never matches step 1.** Absence of SHA means "byte-identity unknown," not "different bytes." The mod falls through to a diverged step (3 or 4) — and step 4 also gates on SHA being known, so a SHA-unknown mod with matching IDs gets caught by step 3 only if the file id also differs; otherwise it reaches step 5 (fresh download). This is conservative: we never claim drift on data we don't have.
- **Step 1 vs step 2** — the resolver prefers an existing installed mod over a local download. Same bytes either way; reusing the install entry is cheaper.

### Nexus mods, `fresh-profile` mode

The new profile starts empty, so there's nothing to be diverged from. Steps 3 and 4 collapse into step 5; nothing else changes:

| Step | Match against | Decision |
|---|---|---|
| 1 | An installed mod with `nexusModId === source.modId AND nexusFileId === source.fileId AND archiveSha256 === source.sha256` | `nexus-already-installed` (deduplicates from the global pool) |
| 2 | A download with `sha256 === source.sha256` | `nexus-use-local-download` |
| 3 | None of the above | `nexus-download` |

The user's drifted copies in the global pool are *invisible* to the resolver in this mode — they remain in the global pool, untouched, and the new profile gets the curator's exact bytes.

### External mods (both modes)

External mods are identified by SHA-256 alone (per §5.5 — there is no other identity). The mode flag doesn't change the ladder because external mods can only have `archive-already-installed` (byte exact) or fresh decisions; no diverged arm is reachable in v1 (see [`ExternalBytesDivergedDecision`](../../src/types/installPlan.ts) doc).

| Step | Match against | Decision |
|---|---|---|
| 1 | An installed mod with `archiveSha256 === source.sha256` | `external-already-installed` |
| 2 | A download with `sha256 === source.sha256` | `external-use-local-download` |
| 3 | `source.bundled === true` | `external-use-bundled` (resolver computes `zipPath`) |
| 4 | `manifest.package.strictMissingMods === true` and none of 1–3 | `external-missing` (blocks `canProceed`) |
| 5 | `manifest.package.strictMissingMods === false` and none of 1–3 | `external-prompt-user` (deferred to install-time picker; blocks per-mod confirmation) |

`zipPath` for `external-use-bundled` is the bundled mod's folder, `bundled/<sha256>/` — `bundleFolderInPackage` in `manifest/bundleLayout.ts`, the one spelling shared with the packager and the reader. It depends on the sha alone: a package carries no archive to take an extension from, so `source.expectedFilename` plays no part. See [`PACKAGE_ZIP.md`](PACKAGE_ZIP.md).

## Conflict policy (v1, LOAD-BEARING)

Per [INSTALL_PLAN_SCHEMA.md "v1 conservative-policy invariant"](INSTALL_PLAN_SCHEMA.md#v1-conservative-policy-invariant-load-bearing):

- Every `nexus-version-diverged`, `nexus-bytes-diverged`, and orphan decision the resolver emits has `recommendation: "manual-review"`.
- The resolver MUST NOT emit `"replace-existing"` / `"keep-existing"` / `"recommend-uninstall"` / `"keep-installed"` in v1, even when context would suggest one. Those values exist in the type set for future heuristics.
- The driver acts only on user-confirmed choices the action handler converts from these recommendations — never on the recommendation directly.

This is the structural guarantee that an Event Horizon install never silently destroys user state. The worst case is "we did nothing"; never "we removed the user's stuff."

## Compatibility severity

- **`compatibility.errors`** (forces `canProceed === false` and stops the install before any work):
  - Game id mismatch.
  - Game version: `policy === "exact"` and versions differ.
  - Game version: `policy === "minimum"` and installed `<` required (semver-ish numeric compare).
  - Required Vortex extension missing.
  - Required Vortex extension installed but older than `minVersion`.
- **`compatibility.warnings`** (informational; never blocks):
  - Game version unknown.
  - Game version unparseable under `minimum` policy.
  - Vortex client version differs from the curator's.
  - Deployment method differs (or the user's method is unknown).

The semver comparator is intentionally tiny — major.minor.patch numeric compare, no prerelease handling. Vortex extension versions and CE game versions in the wild rarely use prerelease/build metadata; falling back to "treat as compatible" via warning is the right conservative behavior. If a curator needs strict matching they set `versionPolicy: "exact"`.

## Orphan detection

Only fires when:

1. `installTarget.kind === "current-profile"` (fresh-profile is empty by definition), AND
2. `userState.previousInstall` is defined (no lineage = no orphans).

For each `installedMods[i]` with `eventHorizonInstall` tagged for the *same* `package.id` as the manifest, the resolver checks whether `eventHorizonInstall.originalCompareKey` is present in `manifest.mods[].compareKey`. If not, it's orphaned.

The action handler builds the lineage tags by reading the install ledger; the resolver never infers them. If the ledger is lost, lineage is lost, and the resolver degrades silently — every previously-installed mod becomes "user-installed by other means" and orphan detection produces an empty list. That's intentional: lineage data is always best-effort, and we never destroy mods we aren't certain we put there.

Every orphan carries `recommendation: "manual-review"`. Same conservative policy as conflicts.

## External-dependency status

Per `manifest.externalDependencies[i]`, look up `userState.externalDependencyState[i]` by `id`:

| Verification state | Result | Notes |
|---|---|---|
| `userState.externalDependencyState` is `undefined` or no entry for this dep | `not-verified` | Action handler has not run the hashing pass yet; UI shows a "verify now" button. |
| Every expected file is missing | `missing` | Pulls `instructions` and `instructionsUrl` from the manifest. |
| Some file mismatched (wrong SHA) or missing among the expected list | `files-mismatch` (with the per-file detail) | Mixed states are surfaced explicitly. |
| All expected files present and SHAs match | `ok` | |

In strict mode (`manifest.package.strictMissingMods === true`), `missing` and `files-mismatch` flip `canProceed` to false. In lenient mode they're informational — the user can install and fix the dep later.

## Plugin order plan

- `manifest.plugins.order.length === 0` → `pluginOrder.kind === "none"`. Nothing for the driver to do.
- Otherwise → `pluginOrder.kind === "replace"`. The driver overwrites `plugins.txt` for the target profile with the manifest's order, after backing up the existing file.

The resolver doesn't compute `backupPath` because the actual filesystem path of `plugins.txt` is per-game and only known at driver time.

`merge` is reserved for the future; v1 never emits it.

## Rule plan

For each `manifest.rules[i]`:

- If `rule.source` is not a compareKey of any `manifest.mods[j]` → `kind: "skip"` with reason. (`parseManifest` already warns on this; the resolver mirrors the warning into the plan so the driver doesn't blindly attempt to resolve a rule whose source we never install.)
- If `rule.ignored === true` → `kind: "skip"` with reason. The curator marked the rule as preserved-but-disabled.
- Otherwise → `kind: "apply"` with `sourceCompareKey: rule.source` and `targetCompareKey: rule.reference`. The reference may be partially-pinned (`"nexus:1234"` matches any file id of mod 1234); the driver resolves it at apply time against whatever fits.

## Summary derivation

| Field | Value |
|---|---|
| `totalMods` | `manifest.mods.length` |
| `alreadyInstalled` | Count of decisions in `{ nexus-already-installed, external-already-installed, nexus-use-local-download, external-use-local-download }`. |
| `willInstallSilently` | Count of decisions in `{ nexus-download, external-use-bundled, nexus-use-local-download, external-use-local-download }`. (Overlaps `alreadyInstalled` by design — local-download counts in both because it requires no Nexus round-trip AND no user input.) |
| `needsUserConfirmation` | Count of decisions in `{ nexus-version-diverged, nexus-bytes-diverged, external-bytes-diverged, external-prompt-user }`. |
| `missing` | Count of decisions in `{ nexus-unreachable, external-missing }`. |
| `orphans` | `orphanedMods.length`. |
| `canProceed` | `false` iff any of: `compatibility.errors.length > 0`, any `compatibility.extensions[i].status !== "ok"`, `strictMissingMods && missing > 0`, `strictMissingMods && any external-dep is missing or files-mismatch`. |

`needsUserConfirmation > 0` does NOT block `canProceed`. Conflicts are gated by the action handler/UI as a separate "you have N decisions to make first" step; the plan only reports them.

## Behavior matrix — full case grid

The combined behavior across modes for a single Nexus mod:

| User state | Current-profile mode | Fresh-profile mode |
|---|---|---|
| Same modId+fileId+SHA installed | `nexus-already-installed` | `nexus-already-installed` |
| Same SHA in downloads | `nexus-use-local-download` | `nexus-use-local-download` |
| Same modId, different fileId installed | `nexus-version-diverged` (`manual-review`) | `nexus-download` |
| Same modId+fileId, different SHA installed | `nexus-bytes-diverged` (`manual-review`) | `nexus-download` |
| Nothing matches | `nexus-download` | `nexus-download` |

For external mods (mode-independent):

| User state | Lenient | Strict |
|---|---|---|
| Same SHA installed | `external-already-installed` | `external-already-installed` |
| Same SHA in downloads | `external-use-local-download` | `external-use-local-download` |
| Bundled in `.ehcoll` | `external-use-bundled` | `external-use-bundled` |
| None of the above | `external-prompt-user` | `external-missing` (blocks `canProceed`) |

## Why the resolver throws on invariant violations

`enforceInstallTargetInvariant` throws on:

- `installTarget.kind === "current-profile"` but `userState.previousInstall` is undefined.
- `installTarget.kind === "fresh-profile"` but `userState.previousInstall` is defined.

These mismatches are programming errors in the action handler, not data errors in the manifest or user state. The action handler is contractually required to:

1. Read the install ledger.
2. Pick `installTarget` AND `previousInstall` atomically from the same lookup.
3. Pass both to the resolver.

If the resolver silently produced a plan from mismatched inputs, the resulting bug — installing into the wrong profile, or attempting orphan detection without a previous install — would be invisible until install time. Throwing at the boundary surfaces the bug at the call site.

## Quirks & invariants

1. **`modResolutions` mirrors `manifest.mods`.** Same length, same order, same compareKeys. The driver iterates by index.
2. **Fresh-profile mode never emits diverged decisions.** Tested by the absence of `*-version-diverged` and `*-bytes-diverged` in any plan with `installTarget.kind === "fresh-profile"`.
3. **Fresh-profile mode never emits orphans.** `orphanedMods === []` whenever `installTarget.kind === "fresh-profile"`.
4. **All recommendations are `"manual-review"` in v1.** No exceptions, no future heuristics fire yet.
5. **The resolver never reads Vortex state directly.** Every input is on `userState`. The single place the resolver uses Node primitives at all is `extractExtension` (string ops) and `parseSemver` (string ops).
6. **Plans are JSON-serializable.** No `Date` objects, no functions, no circular references.
7. **`previousInstall.packageId === manifest.package.id`** is an invariant the action handler enforces. The resolver trusts it and uses `manifest.package.id` as the orphan-detection key.
8. **`compatibility.warnings` is purely informational.** The resolver never gates anything on a warning. The UI surfaces them as soft hints.
9. **A SHA-unknown installed mod is invisible to byte-exact match and to byte-drift detection.** It only participates in `nexus-version-diverged` (different fileId) — never claims drift on missing data.
10. **`external-bytes-diverged` is unreachable in v1** (per its type doc). The resolver never emits it. Future heuristics (matching by `archiveName + version` etc.) may light this branch up; the install driver's `switch` is forced to handle it from day one.
11. **Bundled extension preservation.** `.tar.gz`, `.tar.bz2`, `.tar.xz` are kept as multi-part extensions when computing `zipPath`. Anything else falls back to single-extension or `.zip`.
