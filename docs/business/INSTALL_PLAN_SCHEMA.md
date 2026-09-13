# Install Plan Schema (Phase 3 contract)

**TypeScript source of truth:** [`src/types/installPlan.ts`](../../src/types/installPlan.ts).
**Companion identity rule:** [`docs/PROPOSAL_INSTALLER.md` §5.5](../PROPOSAL_INSTALLER.md).

When prose disagrees with the types: **the types are the spec.** When the types disagree with this prose, open an issue.

---

## Trigger / scope

This spec defines two static data shapes used between the resolver and everything around it:

- **`UserSideState`** — the resolver's input. Built from Vortex Redux state by the Phase 3 action handler. The resolver itself never reads Vortex.
- **`InstallPlan`** — the resolver's output. Read by the action handler (to decide what to surface in the UI), the eventual Phase 5 React UI (to render the install preview), and the install driver (to actually do the work).

The plan **describes intent, never executes**. Even when a decision says `replace-existing`, that's a recommendation; the install driver only acts after the action handler/UI has confirmed with the user.

---

## v1 conservative-policy invariant (LOAD-BEARING)

> *Vortex's vanilla collections silently destroy user state on version upgrades. We do the opposite.*

Four rules that bind every Phase 3 slice and every UI/driver consumer:

1. **The resolver never recommends a destructive action in v1.** Every `*-version-diverged`, `*-bytes-diverged`, and `OrphanedModDecision` is emitted with `recommendation: "manual-review"`. The other two values (`replace-existing` / `keep-existing` for conflicts; `keep-installed` / `recommend-uninstall` for orphans) are reserved for future heuristics but the v1 resolver MUST NOT emit them.
2. **The driver never acts on a `recommendation` directly.** The action handler/UI is required to convert a recommendation into an explicit user choice (a separate input the driver receives alongside the plan). If the driver sees a conflict decision in the plan but no user choice, it MUST skip that mod and surface a drift entry.
3. **Names are never identity, even for upgrades.** A v1.0 SkyUI and a v1.1 SkyUI are the *same logical mod* only via the lineage tag from the install ledger — never by name match. If the ledger is lost, every existing mod becomes "user-installed by other means" and the resolver treats them as untouchable.
4. **No-receipt installs are FORCED into a fresh profile.** Without lineage we don't know which of the user's installed mods are ours, so we install into a brand-new empty Vortex profile, isolated from whatever the user has in their main profile. See ["Install target"](#install-target-current-profile-vs-fresh-profile) below. This is non-negotiable in v1 — there's no "install into current profile anyway" toggle. Same rule for first-time installs (no receipt by definition).

Together these rules guarantee that *no Event Horizon install can quietly destroy user state on a version upgrade or a fresh install*. The worst case is "we did nothing"; never "we removed the user's stuff."

---

## Install target: current-profile vs fresh-profile

Every plan carries an `installTarget` indicating which Vortex profile the install will land in. The action handler picks this BEFORE the resolver runs, based on a single signal: does the install ledger have a receipt for `manifest.package.id`?

| Receipt | `installTarget.kind` | Resolver behavior |
|---|---|---|
| Present | `"current-profile"` | In-place upgrade. Conflict + orphan decisions emitted as designed. |
| Missing (first install OR ledger lost) | `"fresh-profile"` | Forced new profile. No diverged decisions; no orphans; only fresh installs + byte-exact reuse. |

### Why fresh-profile is safe

Vortex's mod store (`state.persistent.mods[gameId]`) is **global** across profiles. What's per-profile is only:

- Which mods are enabled.
- Per-profile load order.
- Per-profile `plugins.txt`.

A fresh profile means:

- The user's old profile stays byte-identical — same enabled set, same load order, same plugins.
- The collection's mods get added to the shared global pool (sitting alongside whatever's already there).
- Only the new profile has the collection's mods enabled.
- Only the new profile has the collection's `plugins.txt`.
- Switching back to the old profile = collection becomes invisible (mods disabled, old plugins.txt restored).

If the user already had SkyUI fileId 5000 in the global pool, and the collection wants fileId 6000, both end up coexisting in the global pool. Old profile keeps using 5000; new profile uses 6000. **Zero collision risk by construction.**

### Resolver simplification in fresh-profile mode

When `installTarget.kind === "fresh-profile"`:

- **Diverged decisions disappear.** `nexus-version-diverged`, `nexus-bytes-diverged`, and `external-bytes-diverged` are NEVER emitted. Nothing in the new profile is "already installed" yet, so there's nothing to diverge from.
- **Byte-exact reuse still applies.** If the user's global pool already contains the exact same archive (same Nexus IDs + same SHA, or same external SHA), the resolver emits `nexus-already-installed` / `external-already-installed`. We re-use the existing mod entry rather than re-downloading. This isn't a collision — Vortex would refuse to install identical bytes anyway. It's deduplication.
- **Local downloads still apply.** If the archive is in `availableDownloads` we still emit `*-use-local-download`. The downloads folder is also global.
- **Orphans always `[]`.** No lineage, no orphans by definition.

### Driver behavior in fresh-profile mode

After the user confirms the plan, the driver:

1. Creates a new Vortex profile with `suggestedProfileName` (`"<collection-name> (Event Horizon v<package.version>)"`). Appends `(2)` / `(3)` / ... if a profile with that name already exists.
2. Runs every mod-install decision against the global pool (same code as in-place mode).
3. Enables the collection's mods in the new profile only.
4. Writes the new profile's `plugins.txt` from `manifest.plugins.order`.
5. Writes a fresh receipt to the install ledger.
6. Switches the user into the new profile, with a notification carrying an "undo: switch back to `<previous-profile-name>`" button.

The user's previous active profile is byte-untouched throughout.

### Driver behavior in current-profile mode

Same as we already designed — see "Version upgrades" below.

### When current-profile mode is allowed

ONLY when the install ledger contains a receipt for the manifest's `package.id`. Any other state — first install, ledger missing, ledger covers different `package.id` — produces fresh-profile.

---

## Why a typed plan exists at all

Vortex's vanilla collections wire "decide what to do" and "do it" into one tangle. When a Nexus download silently 404s, when a FOMOD wizard pops up an unexpected step, when a file override loses to another mod — the failure surfaces as a half-applied install with no clean record of what was supposed to happen.

The plan exists so that:

1. **Decisions are inspectable before any I/O.** A user can see the full picture (which mods will be downloaded, which already match, which conflict) and approve, modify, or abort *before* the first byte hits disk.
2. **The driver is mechanical.** Every code path in the install driver maps to one `decision.kind`. Adding a new kind = adding a new `case` to the driver's `switch`; TypeScript's exhaustiveness checking forces it.
3. **Re-running is idempotent.** The plan can be recomputed at any time (state changed? user installed a mod manually? collection updated?) and the driver picks up where it left off, because the plan tells it what's still pending.
4. **Failures are diagnosable.** If a user reports "the install broke at mod 47", we can ask for the plan that was generated and walk through exactly what the resolver thought it was doing.

---

## Top-level shape

```jsonc
{
  "manifest":             { /* EhcollManifest — carried by reference */ },
  "installTarget":        { /* InstallTarget — current-profile or fresh-profile */ },
  "previousInstall":      { /* PreviousCollectionInstall, optional — present iff installTarget is current-profile */ },
  "compatibility":        { /* CompatibilityReport */ },
  "modResolutions":       [ /* ModResolution[] — same length & order as manifest.mods */ ],
  "orphanedMods":         [ /* OrphanedModDecision[] — empty in fresh-profile mode */ ],
  "externalDependencies": [ /* ExternalDependencyDecision[] */ ],
  "pluginOrder":          { /* PluginOrderPlan — always present */ },
  "rulePlan":             [ /* RulePlanEntry[] — pre-resolved rules */ ],
  "summary":              { /* PlanSummary — derived counts + canProceed */ }
}
```

**INVARIANT** — `modResolutions[i].compareKey === manifest.mods[i].compareKey`. The resolver never reorders, drops, or duplicates mods. Same for `externalDependencies`/`manifest.externalDependencies`.

**INVARIANT** — `pluginOrder` is always present, even when the manifest has no plugins. `kind: "none"` is the no-op signal; the field is never absent.

**INVARIANT** — `installTarget.kind` and `previousInstall` are co-determined: `current-profile` ⇔ `previousInstall` defined; `fresh-profile` ⇔ `previousInstall` undefined. The two are picked atomically by the action handler from a single signal (presence of a ledger receipt for `manifest.package.id`).

**INVARIANT** — `orphanedMods` is `[]` whenever `installTarget.kind === "fresh-profile"`. Fresh profile starts empty; nothing to be orphaned against.

---

## `UserSideState` — the resolver's input

The action handler builds this snapshot, hands it to the resolver, and never modifies it again. The resolver runs synchronously over a frozen view; if the user installs another mod mid-resolve we re-snapshot and re-plan.

| Field | Required | Meaning |
| --- | --- | --- |
| `gameId` | yes | User's active Vortex `gameId`. Compared to `manifest.game.id`. |
| `gameVersion` | no | User's installed game version. Optional because Vortex doesn't always know it for unmanaged installs. |
| `vortexVersion` | yes | User's Vortex client version. Warning-only mismatches. |
| `deploymentMethod` | no | User's deployment method. Warning-only mismatches. |
| `enabledExtensions` | yes | List of `{ id, version? }` for currently enabled Vortex extensions. |
| `activeProfileId` | yes | Active Vortex profile id. Used to scope `installedMods[i].enabled` and to populate `InstallPlan.installTarget` when staying in-place. |
| `activeProfileName` | yes | Active profile display name. UI-only. |
| `installedMods` | yes | Every mod currently in `state.persistent.mods[gameId]`, narrowed to identity-bearing fields. |
| `availableDownloads` | no | Archives in Vortex's downloads folder, hashed. `undefined` ⇒ resolver behaves as if no downloads exist (loses zero correctness, only ergonomics — Nexus mods just download instead of installing locally). |
| `externalDependencyState` | no | Per-external-dep verification snapshot. `undefined` ⇒ resolver emits `"not-verified"` decisions. |
| `previousInstall` | no | Pointer to the previous Event Horizon install of the same `package.id`, derived from the install ledger. `undefined` ⇒ fresh install (orphan list will be empty). |

### `InstalledMod`

The narrow projection of an existing installed mod. Subset of `AuditorMod`; the resolver doesn't need FOMOD selections, file overrides, install order, etc.

```
{
  id:                    string;                       // Vortex internal id; never used for cross-machine identity
  name:                  string;                       // UI-only — NEVER an identity match per §5.5
  nexusModId?:           number;                       // Nexus identity, when known
  nexusFileId?:          number;
  archiveSha256?:        string;                       // The resolver's identity oracle
  enabled:               boolean;                      // Whether the mod is currently enabled in the active profile
  eventHorizonInstall?:  ModEventHorizonInstallTag;    // Lineage tag from the install ledger
}
```

`eventHorizonInstall` is set by the action handler when the install ledger names this mod. **The resolver NEVER infers it** — Vortex strips/loses mod attributes randomly (the whole reason this project exists), so we trust nothing but our own ledger. If the ledger doesn't cover a mod, that mod is invisible to lineage logic.

```
ModEventHorizonInstallTag {
  collectionPackageId:    string;     // package.id of the install
  collectionVersion:      string;     // semver of that release
  originalCompareKey:     string;     // the compareKey the previous manifest used
  installedAt:            string;     // ISO-8601 UTC; UI-only
}
```

### `PreviousCollectionInstall`

Pointer to the previous install of the same `package.id`. Derived from the install ledger by the action handler.

```
{
  packageId:        string;     // ALWAYS equals manifest.package.id
  packageVersion:   string;     // semver of the previous release
  installedAt:      string;     // ISO-8601 UTC
  modCount:         number;     // UI-only
}
```

**INVARIANT** — `packageId === manifest.package.id`. The action handler enforces this; if the ledger has installs of different `package.id`s, the action handler is responsible for picking the right one (collection identity is `package.id`, not name).

**INVARIANT (the §5.5 rule restated)**: name and version are UI metadata. The resolver matches Nexus mods by `(nexusModId, nexusFileId)` AND verifies bytes via `archiveSha256`. External mods match on `archiveSha256` alone. There is no name fallback.

When `archiveSha256` is `undefined` on an installed mod (e.g. an un-enriched snapshot), the resolver treats byte-identity as **unknown**, not **different**. That means: a Nexus mod whose IDs match but whose `archiveSha256` is `undefined` produces `nexus-already-installed` (treated as the same mod), with the install driver responsible for re-verifying after deploy.

### `AvailableDownload`

```
{
  archiveId:  string;            // Vortex archive id (state.persistent.downloads.files key)
  localPath:  string;            // Absolute path
  sha256:     string;            // Mandatory — without it the entry is useless to the resolver
  fileName?:  string;            // UI-only
}
```

`sha256` is **required**. A download whose hash isn't known is invisible to the resolver — we won't trust filenames per §5.5.

### `ExternalDependencyVerification`

Per-dep file verification snapshot. Filling it in requires hashing files at game-relative paths; the action handler decides whether to do this on every plan or only on demand.

---

## `CompatibilityReport`

Aggregate environment checks. Each sub-check is **categorical** so the UI can render each case differently — no string parsing.

| Field | Type | Meaning |
| --- | --- | --- |
| `gameMatches` | `boolean` | `userState.gameId === manifest.game.id`. False ⇒ fatal compatibility error. |
| `gameVersion` | `VersionCheckResult` | `"ok"` / `"mismatch"` (per `versionPolicy`) / `"unknown"` (user version not known). |
| `extensions` | `ExtensionCheckResult[]` | One per `manifest.vortex.requiredExtensions`. `"ok"` / `"missing"` / `"tooOld"`. |
| `vortexVersion` | `VortexVersionCheck` | Always warning-only; `"ok"` / `"warn-mismatch"`. |
| `deploymentMethod` | `DeploymentMethodCheck` | Always warning-only; `"ok"` / `"warn-mismatch"` / `"unknown"`. |
| `warnings` | `string[]` | Free-form. Layered on top of structured checks. The resolver never relies on this list for decisions. |
| `errors` | `string[]` | Free-form. When non-empty, `summary.canProceed` is forced false. |

### Hard vs. soft compatibility errors

**Hard** (forces `canProceed = false`):

- `gameMatches === false`.
- Any required extension `status !== "ok"`.
- `gameVersion.status === "mismatch"` AND `policy === "exact"`.

**Soft** (warning-only, does not block install):

- `gameVersion.status === "mismatch"` AND `policy === "minimum"` AND user version `>=` required (this is actually `"ok"` — so only the inverse, `<`, blocks under `minimum` policy).
- `gameVersion.status === "unknown"` (UI shows "we couldn't verify your game version").
- `vortexVersion.status === "warn-mismatch"`.
- `deploymentMethod.status !== "ok"`.

---

## `ModResolution` and `ModDecision`

One per mod in `manifest.mods`. The discriminator is `decision.kind`.

```
ModResolution {
  compareKey:   string;           // mirrors manifest.mods[i].compareKey
  name:         string;           // UI-only
  sourceKind:   "nexus" | "external";  // shadow of manifest.mods[i].source.kind
  decision:     ModDecision;
}
```

### Nexus arms

| `decision.kind` | When emitted | Driver action |
| --- | --- | --- |
| `nexus-download` | No installed mod or local download matches the manifest's `(modId, fileId)` and `sha256`. | Queue a Nexus download via Vortex's integration; verify SHA after; install. |
| `nexus-use-local-download` | An archive in `availableDownloads` has a sha that matches the manifest. Skip the network round-trip. | Install from `localPath` directly. |
| `nexus-already-installed` | An installed mod has matching `(modId, fileId)`. SHA either matches or is unknown. | Re-use existing mod entry; possibly adjust enabled state. |
| `nexus-version-diverged` | An installed mod has matching `modId` but a different `fileId`. | **Do not auto-replace.** Surface `recommendation` to the user; act on confirmation. |
| `nexus-bytes-diverged` | An installed mod has matching `(modId, fileId)` but different `archiveSha256`. | **Do not auto-replace.** Surface to the user. |
| `nexus-unreachable` | Structural problem — manifest's `gameDomain` doesn't match the user's active game family, or the manifest entry is malformed in a way the resolver can't recover from. | Skip; report. |

### External arms

| `decision.kind` | When emitted | Driver action |
| --- | --- | --- |
| `external-use-bundled` | The `.ehcoll` carries the mod's files in `bundled/<sha256>/`. | Write the archive back from them and check its SHA-256; install. |
| `external-use-local-download` | An archive in `availableDownloads` has a sha that matches the manifest. | Install from `localPath` directly. |
| `external-already-installed` | An installed mod has matching `archiveSha256`. | Re-use existing mod entry. |
| `external-bytes-diverged` | Reserved for future heuristics (currently unreachable through compareKey matching). Included in the union so the install driver's `switch` is forced to handle it. | n/a in v1 |
| `external-prompt-user` | Not bundled, not in downloads, not installed. **Lenient mode** (`strictMissingMods === false`). | Prompt user for a local file; verify SHA; re-prompt up to 3× per §5.5. |
| `external-missing` | Same as above but **strict mode** (`strictMissingMods === true`). | Skip; force `canProceed = false`. |

### `ConflictRecommendation`

A divergence-decision suggested action.

| Value | Meaning |
| --- | --- |
| `replace-existing` | Resolver thinks it's safe to uninstall the user's current and install the required. |
| `keep-existing` | Resolver thinks the divergence is too risky to auto-fix; leave the user's mod in place even though drift will result. |
| `manual-review` | Resolver has no clear opinion; ask the user. |

**v1 POLICY (LOAD-BEARING)** — the v1 resolver ALWAYS emits `"manual-review"` for every conflict arm regardless of strict/lenient mode. The other two values are **reserved** for future heuristics (e.g. "the user's installed file is archived on Nexus and can't be redownloaded — recommend keep") but the v1 resolver MUST NOT emit them. This is enforced by code review on slice 4 and by the spec; future relaxations require a new spec section explicitly listing which heuristics are allowed.

**INVARIANT** — even when a future heuristic recommends `replace-existing`, the install driver MUST NOT act on `recommendation` directly. The action handler/UI is required to convert recommendations into explicit user choices via a separate input. Driver contract: if it sees a `*-diverged` decision and no user choice for that mod, it skips the mod and emits a drift entry.

---

## Orphaned mods (cross-release lineage)

`InstallPlan.orphanedMods` lists mods that:

1. Are currently installed in the user's profile.
2. Carry an `eventHorizonInstall` tag whose `collectionPackageId === manifest.package.id`.
3. Have a previous-release `compareKey` that does NOT appear in the new manifest's `mods`.

These are mods the curator dropped between releases. The resolver surfaces them so the user can decide what to do; **never auto-uninstalled.**

```
OrphanedModDecision {
  existingModId:           string;                  // Vortex mod id; driver acts on this
  name:                    string;                  // UI-only
  originalCompareKey:      string;                  // compareKey the previous manifest used
  installedFromVersion:    string;                  // semver of the release that installed it
  recommendation:          OrphanRecommendation;    // ALWAYS "manual-review" in v1
}
```

| `recommendation` | Meaning |
| --- | --- |
| `keep-installed` | Resolver thinks the user wants the mod independently of the collection. |
| `recommend-uninstall` | Resolver thinks since we put it there and the curator dropped it, it should go. |
| `manual-review` | No clear opinion; ask the user. |

**v1 POLICY** — same as conflict recommendations. The v1 resolver ALWAYS emits `"manual-review"`. The action handler/UI must confirm before any uninstall.

**INVARIANT** — `orphanedMods` is `[]` when `userState.previousInstall` is undefined. Orphan detection requires lineage; we never delete mods we didn't put there, ever.

**INVARIANT** — orphans never affect `summary.canProceed`. Install can proceed even with unresolved orphans (they just sit there until the user decides). The UI surfaces them as a separate section.

### Why a separate slot, not a `ModResolution` arm

Orphans are not in `manifest.mods`. They have no `compareKey` in the new manifest. Putting them on `modResolutions` would violate the 1:1 mirror invariant. They belong in their own list; the action handler/UI renders them in a separate "you previously had these — what now?" section.

---

## End-to-end flows

Two flows. The action handler picks one based on the install ledger:

### Flow A — receipt present (in-place upgrade, `current-profile`)

**Scenario.** Curator publishes `my-collection v1.0`. User installs it (Event Horizon writes a receipt). Curator publishes `v1.1` which:
- bumps SkyUI's Nexus `fileId` 5000 → 6000 (Nexus version update),
- replaces an external archive (e.g., a curator-private patch) — its SHA-256 changes,
- drops a Nexus mod entirely,
- adds two new Nexus mods.

User opens `my-collection-v1.1.ehcoll` in their existing Vortex profile.

1. **Action handler reads the ledger.** Receipt for `package.id` exists → picks `installTarget = { kind: "current-profile", profileId, profileName }`. Builds `userState` from the active profile, populates `previousInstall`, tags matching `installedMods[i].eventHorizonInstall`.

2. **Resolver decides per-mod.** For every `manifest.mods[i]` (the v1.1 list):
   - **SkyUI** (Nexus, modId 1234, fileId 6000): user has fileId 5000 with `eventHorizonInstall` tagged. → `nexus-version-diverged` with `recommendation: "manual-review"`. Driver does nothing without a user click.
   - **Curator-private patch** (external, sha = NEW): no installed mod has the new SHA, so the resolver emits `external-use-bundled` (if curator bundled) or `external-prompt-user`. The OLD external becomes an orphan in step 3.
   - **New Nexus mods**: not in `installedMods`, not in `availableDownloads` → `nexus-download`.
   - **Every other unchanged mod**: `nexus-already-installed` / `external-already-installed`.

3. **Resolver computes orphans.** Dropped Nexus mod + OLD external patch (different SHA than v1.1) both fail the "is original `compareKey` in new manifest?" check. Both go into `orphanedMods` with `recommendation: "manual-review"`, `installedFromVersion: "1.0.0"`.

4. **Compatibility & summary.** `canProceed = true`. `needsUserConfirmation = 1`. `orphans = 2`.

5. **UI surfaces the upgrade.** Banner: "Upgrading my-collection from 1.0.0 to 1.1.0." Conflicts section gates the "Install" button until SkyUI's conflict is resolved. Orphans section is non-blocking.

6. **Driver runs only on user-confirmed decisions.** For SkyUI, user picks "replace existing" → driver uninstalls fileId 5000, downloads fileId 6000, installs. Orphans handled per user clicks. New external patch extracted from `bundled/`. At end, driver overwrites the receipt with the v1.1 install record.

### Flow B — no receipt (forced fresh profile)

Same `v1.1` package, but the user is **either**:
- Installing for the first time (no v1.0 receipt because they've never had this collection), OR
- Installing v1.1 with the v1.0 receipt missing (PC migration, AppData wiped, ledger corrupted, etc.), OR
- Installing v1.1 but their old receipt is for a different `package.id` (a different collection that happens to share a name).

The user might have hundreds of unrelated mods in their current profile from manual installs and other collections. We can't tell what's ours; we don't try.

1. **Action handler reads the ledger.** No receipt for `package.id` → picks `installTarget = { kind: "fresh-profile", suggestedProfileName: "my-collection (Event Horizon v1.1.0)" }`. `previousInstall` stays `undefined`. `userState.installedMods[].eventHorizonInstall` is `undefined` for every entry (no ledger to tag from).

2. **Resolver decides per-mod.** For every `manifest.mods[i]`:
   - **Byte-exact match in global pool** (Nexus IDs match AND SHA matches, or external SHA matches in `installedMods`): `*-already-installed`. We'll just enable it in the new profile, no work.
   - **Match in `availableDownloads`** (downloads folder is global): `*-use-local-download`. Install from local archive.
   - **External in `bundled/`**: `external-use-bundled`.
   - **Otherwise**: `nexus-download` / `external-prompt-user`.
   - **Never `*-version-diverged` or `*-bytes-diverged`.** Nothing in the new profile is "already installed"; the user's drifted copies in their old profile are irrelevant to the new profile.

3. **Orphans empty.** No lineage, nothing to orphan against. `orphanedMods = []`, `summary.orphans = 0`.

4. **Compatibility & summary.** Same checks. `canProceed = true` if compatibility OK and no missing strict-mode mods.

5. **UI surfaces the install.** Banner: *"Installing my-collection v1.1.0 into a new Vortex profile: 'my-collection (Event Horizon v1.1.0)'. Your current profile won't be touched."* No conflicts section (none possible). No orphans section (none possible). External-prompt-user mods still gate the "Install" button per usual.

6. **Driver runs.** Creates the new profile (with collision-suffix if needed). Installs every mod into the global pool (deduplicating against byte-exact matches). Enables only the collection's mods in the new profile. Writes the new profile's `plugins.txt`. Writes a fresh receipt. Switches the user into the new profile, with an "undo: switch back" notification.

**The user's old profile is byte-identical before and after Flow B.** That's the safety guarantee.

### What can go wrong, and what doesn't

| Scenario | Behavior |
|---|---|
| Ledger missing on upgrade | Falls into Flow B (fresh profile). Old profile untouched. User keeps their existing setup. |
| Curator regenerates `package.id` between releases | Receipt doesn't match → Flow B. Old profile untouched. (Documented as a curator anti-pattern in `MANIFEST_SCHEMA.md`.) |
| Vortex strips a mod's attributes | Doesn't matter — we don't store lineage on Vortex attributes. The receipt is our ground truth. |
| User downgrades from 1.1 to 1.0 with receipt intact | Flow A. The 1.1 receipt's mod set has more entries than the 1.0 manifest, so the v1.1-only mods become orphans. User decides per-mod. |
| User has SkyUI fileId 5000 manually-installed (not via collection); installs collection that wants fileId 6000 | Flow B (no receipt for THIS collection). New profile uses fileId 6000. Old profile's manual fileId 5000 still works. Both versions coexist in the global pool. |
| Profile name collides | Driver appends `(2)` / `(3)` / ... |
| User cancels mid-Flow-B install | New profile may exist but be incomplete. User can delete it from Vortex's profile manager; old profile is untouched. (Resume-from-crash is a future improvement.) |

This is the full story. Vortex-vanilla's failure modes — "rules randomly disappear, FOMOD selections are lost, bytes are silently swapped, my unrelated mods got modified" — are structurally impossible here because we (a) verify SHA on every byte, (b) track lineage in our own ledger, (c) never auto-execute destructive actions, (d) isolate no-receipt installs into a fresh profile.

---

## External-dependency decisions

One per `manifest.externalDependencies[i]`. Discriminated by `status.kind`.

| `status.kind` | When emitted |
| --- | --- |
| `ok` | Every file the manifest declares is present and SHA-matches. |
| `files-mismatch` | Dep is partially present; some files missing or wrong SHA. `mismatches[]` lists each. |
| `missing` | Dep not present at all. `instructions` and `instructionsUrl` from the manifest are surfaced. |
| `not-verified` | Action handler deferred verification (didn't hash the files yet). UI surfaces a "verify now" button. |

External-dep status feeds into `summary.canProceed` only when `manifest.package.strictMissingMods === true` (a missing dep blocks strict installs). Otherwise it's surfaced as a warning and install proceeds.

---

## `PluginOrderPlan`

```
{
  kind:                 "replace" | "merge" | "none";
  backupPath?:          string;     // only when kind === "replace"
  manifestEntryCount:   number;
}
```

| `kind` | Behavior |
| --- | --- |
| `"replace"` | The curator's order becomes the order. See below — the driver no longer writes `plugins.txt` itself. |
| `"merge"`   | Never emitted. Kept in the union so an older plan still parses; the *merging* it described now happens inside `"replace"`. |
| `"none"`    | Manifest declares no plugins, or the user's order already matches. No work. |

**`"replace"` does not mean "overwrite the file".** It used to: the driver wrote
`plugins.txt` directly after backing it up. That was wrong in a way that only
shows up on a live install — Vortex's `PluginPersistor` owns that file and
rewrites it from its own state on the next deploy, so a direct write is
reverted at an unpredictable moment.

What happens now: the driver pins the order through Vortex
(`set-plugin-list` → `autosort-plugins`), and Vortex persists it. Plugins the
user has that the collection does not know about are **integrated LOOT-style**
rather than appended last — which is what the retired `"merge"` kind was
reserved for, so the distinction between the two kinds stopped being real. See
[`INSTALL_DRIVER.md`](INSTALL_DRIVER.md) → "`plugins.txt` — the driver pins the
order, Vortex persists it".

**The `backupPath` backup is gone, and that is not a regression.** It existed
because the driver overwrote `plugins.txt`; a destructive write needs something
to restore from. The driver no longer performs that write, so there is nothing
to restore — the user's order is changed through Vortex, the same way pressing
Sort changes it.

`backupPath` is still declared in the type and is now read by nothing. Treat it
as vestigial rather than as a promise: a plan that sets it gets no backup.

What *is* still backed up is the user's **rule** state — every mod rule and the
whole LOOT userlist — because that purge genuinely is destructive and is not
recoverable from Vortex. That backup is an interlock: it must land on disk
before the purge runs. Different mechanism, different field
(`purgeUserRules.ts`), do not conflate the two.

---

## `RulePlanEntry`

One per `manifest.rules[i]`. The resolver pre-resolves each rule's `source` and `reference` (which point to `compareKey` strings) against the user's eventual mod set (after install).

| `status.kind` | Meaning |
| --- | --- |
| `apply` | Both source and target resolve cleanly. The driver issues a Vortex `setModAttribute`/`addModRule` call. |
| `skip`  | The source or target is missing from the user's eventual mod set (e.g. the rule references a mod with a partially-pinned key like `nexus:1234` that doesn't match anything). `reason` is plain English. |

Unresolved-rule warnings from `parseManifest` flow through here as `skip` entries, so the UI can surface them in one place.

---

## `PlanSummary`

```
{
  totalMods:                  number;     // manifest.mods.length
  alreadyInstalled:           number;     // *-already-installed + *-use-local-download
  willInstallSilently:        number;     // *-download + *-use-bundled + *-use-local-download
  needsUserConfirmation:      number;     // *-diverged + external-prompt-user
  missing:                    number;     // *-unreachable + external-missing
  orphans:                    number;     // orphanedMods.length
  canProceed:                 boolean;    // see below
}
```

`canProceed` is **false** iff any of:

- `compatibility.errors.length > 0`.
- Any `compatibility.extensions[i].status !== "ok"`.
- `manifest.package.strictMissingMods === true` AND `summary.missing > 0`.
- `manifest.package.strictMissingMods === true` AND any external-dep status is `missing` or `files-mismatch`.

Otherwise **true**.

`needsUserConfirmation > 0` does NOT block `canProceed`. Conflicts (version drift, byte drift, prompt-user) are gated by the action handler/UI as a separate step: the user must explicitly resolve each one before the driver runs. The plan simply reports them.

`orphans > 0` does NOT block `canProceed`. Orphan resolution is non-blocking and can be done before, after, or never relative to the install.

The action handler/UI uses `canProceed` to gate the "Install" button; conflicts and orphans are surfaced as separate "you have N decisions to make first" gates on top. The install driver double-checks at start time (defense in depth — a future UI might hand-edit the plan).

---

## Quirks & invariants

1. **Plan describes intent, never executes.** Even `replace-existing` recommendations are suggestions. The install driver only acts on user-confirmed decisions.
2. **v1 resolver always recommends `manual-review` for conflicts and orphans.** No exceptions. Future heuristics that emit other recommendations require explicit policy updates here.
3. **Plans are recomputable.** The resolver is a pure function. Re-running with updated `userState` produces a fresh plan; nothing in the old plan needs to be invalidated or migrated.
4. **`modResolutions` mirrors `manifest.mods` 1:1.** Same length, same order, same `compareKey`s. The resolver never reorders, drops, or duplicates.
5. **`pluginOrder` is always present.** Use `kind: "none"` to signal no work; never omit the field.
6. **`externalDependencies` mirrors `manifest.externalDependencies` 1:1.** Same as mods.
7. **`rulePlan` mirrors `manifest.rules` by index** via `manifestRuleIndex`, not by 1:1 ordering. Indices are preserved so reports can cite "rule #5" back to the manifest.
8. **The discriminated unions are exhaustive.** Adding a new `decision.kind` requires adding the type, updating this spec, updating the resolver, AND updating the install driver's `switch`. TypeScript's exhaustiveness check is the safety net.
9. **Names and versions are never identity.** §5.5 binds the entire plan: only Nexus IDs (verified by SHA) and external SHAs are identity-bearing. The plan never contains a "match by name" path.
10. **Lineage is never inferred.** `eventHorizonInstall` tags come exclusively from the install ledger written by the driver. Vortex attribute drift (the whole reason this project exists) cannot corrupt our lineage data.
11. **Orphan detection requires lineage.** No ledger ⇒ no orphans. We never delete mods we're not certain we put there.
12. **`installTarget` and `previousInstall` are co-determined.** Picked atomically by the action handler from one signal: the presence of a ledger receipt for `manifest.package.id`.
13. **Fresh-profile mode is forced, not optional, in v1.** No "install into current profile anyway" toggle. The safety guarantee depends on isolation; the toggle would defeat it. (The eventual Phase 5 UI may add an advanced option; v1 doesn't.)
14. **Diverged decisions are mode-dependent.** `nexus-version-diverged`, `nexus-bytes-diverged`, and `external-bytes-diverged` are emitted ONLY in `current-profile` mode. In `fresh-profile` mode they collapse into fresh installs; the user's drifted copies in the old profile are never touched.
15. **Strict mode is a manifest decision, not a user decision.** `manifest.package.strictMissingMods` is set by the curator. The user can't toggle it from the UI without modifying the manifest itself (out of scope).
16. **`previousInstall.packageId === manifest.package.id`.** The action handler enforces this when reading the ledger.
17. **Plans are JSON-serializable.** Useful for debugging dumps and for the eventual UI's "save plan" feature. No `Date` objects, no functions, no circular refs.

---

## Versioning policy

The plan is an **in-memory** contract, not an on-disk one. We do not write `InstallPlan` to disk in v1. That means:

- No `schemaVersion` field on the plan.
- Type changes are free as long as the resolver/driver/UI roll together.
- If we ever start persisting plans (e.g. for resume-from-crash), we add `planVersion` and follow the same additive-change rules as `EhcollManifest` does.

Until that day, the only contract surface is the TypeScript types in `installPlan.ts`. Keep them stable across slices 4–6.
