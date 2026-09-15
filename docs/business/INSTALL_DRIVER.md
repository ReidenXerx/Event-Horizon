# Business logic: install driver (`runInstall`)

> Spec for `src/core/installer/runInstall.ts` and the `src/core/installer/`
> support modules (`profile.ts`, `modInstall.ts`, `verifyModInstall.ts`,
> `purgeUserRules.ts`, `applyModRules.ts`, `applyUserlist.ts`,
> `applyPluginOrder.ts`, `applyPluginLightFlags.ts`). There is no
> `pluginsTxt.ts` any more — see the `plugins.txt` section.

The install driver is the **only** part of Event Horizon that mutates Vortex
state or the filesystem. Every other module — auditor, manifest builder,
packager, reader, resolver — is a pure transform that produces or reads
files. The driver consumes a pure {@link InstallPlan} and writes the
result of that plan to disk.

This file is the authoritative spec for what `runInstall` does. The
companion type-level contract lives in `src/types/installDriver.ts`.

---

## How it got here

The driver landed in four slices, each independently testable end-to-end in a
real Vortex environment. All four have shipped:

| Slice  | Scope                                                                                    | Status |
|--------|------------------------------------------------------------------------------------------|--------|
| **6a** | Fresh-profile happy path. Refuses anything that needs user input.                         | shipped |
| **6b** | Current-profile mode. Manual-review pickers (conflict + orphan). Mod uninstall primitive. | shipped |
| **6c** | Apply mod rules. Apply Vortex `setLoadOrder`. Drift report.                               | shipped |
| **7**  | Replace the user's rules, pin the plugin order, restore ESL flags.                        | shipped |

**This document describes current behaviour.** It used to be scoped to "slices
6a + 6b" with everything later marked _(future)_, and those markers outlived
the work — the load-order sections in particular said the driver deliberately
did **not** touch plugin order, long after it did. Prefer this file over any
`_(future)_` phrasing you find elsewhere; if you find one still standing,
it is stale.

---

## Why a driver is its own thing

The line between "preview" and "install" is the line between "pure" and
"mutating." Drawing that line as a hard module boundary buys two things:

1. **Idempotent previews are cheap.** The action handler can call
   `resolveInstallPlan` repeatedly with no side effects — useful for
   "refresh preview" buttons later.
2. **The mutating code is small.** Every function that *writes* anything
   lives under `src/core/installer/`. Bugs that touch user state can
   only be in one place.

The driver is also the place where Vortex events live. The pure layers
never call `api.events.emit` or `api.store.dispatch`.

---

## Scope

The driver, when given a plan and a `UserConfirmedDecisions` bundle, will:

1. **Validate** the plan + decisions in `preflight` (see "Preflight
   validation" below).
2. **Set up the install target**:
   - `fresh-profile` ⇒ create a brand-new Vortex profile for the active
     game and switch into it.
   - `current-profile` ⇒ stay on the active profile; Vortex deployment
     is left in place.
3. **Remove** mods marked for removal by the user's choices:
   - any `replace-existing` conflict choice ⇒ uninstall the
     existing mod first, then install the manifest's version,
   - any `orphan-uninstall` orphan choice ⇒ uninstall the orphaned mod.
4. **Sequentially install** every mod the plan references, branching
   on the `decision.kind` (and the user's choice when relevant):
   - `nexusDownload` (with `allowInstall: true`) for `nexus-download`,
   - `start-install-download` for `*-use-local-download`,
   - writing the bundled mod's archive back out of the package + `start-install` for `external-use-bundled`,
   - profile-enable only (no install) for `*-already-installed`,
   - `start-install` from the user's local file for
     `external-prompt-user` + `use-local-file` choice,
   - re-derived install (Nexus / bundled / local-download) for any
     `*-diverged` + `replace-existing` choice.
5. **Enable** each newly-installed mod in the active profile (current
   or fresh).
6. **Verify** what landed — hash each installed archive against the manifest
   and classify it `matches` / `differs` / `damaged` / `unknown`.
7. **Replace** the user's mod rules and LOOT userlist with the collection's,
   after backing both up. See "Replacing the user's rules".
8. **Deploy** by emitting `deploy-mods` and waiting for `did-deploy`.
9. **Pin** the curator's plugin order and restore ESL flags, integrating any
   extra plugins the user has rather than appending them. `plugins.txt` is
   WRITTEN by Vortex, but it carries the order pinned here — see the
   `plugins.txt` section below.
10. **Write** the install ledger receipt for cross-release lineage.

**Refused** in `preflight` (returns `{kind: "failed", phase: "preflight"}`):
- `plan.summary.canProceed === false`,
- `plan.compatibility.gameMatches !== true`,
- any `nexus-unreachable` or `external-missing` decision (hard
  blockers — no user choice fixes them),
- any `*-diverged` or `external-prompt-user` decision **without** a
  matching entry in `decisions.conflictChoices`,
- any `decisions.conflictChoices` entry whose `ConflictChoice.kind` is
  invalid for the corresponding decision (e.g. `use-local-file` on a
  diverged decision),
- any `decisions.orphanChoices` entry whose `existingModId` doesn't
  match an actual `OrphanedModDecision` in `plan.orphanedMods`.

**Now applied** (this list used to read "deferred to slice 6c"):
- `plan.rulePlan` (mod rules — load-after, conflict-resolution, etc.), and
  they REPLACE the user's rather than merging with them: everything is backed
  up, all mod rules for the game and the whole LOOT userlist are cleared, then
  the collection's are applied. See "Replacing the user's rules" below.
- Vortex `setLoadOrder` (non-plugin load-order). Empty on Bethesda titles,
  which drive order through `plugins.txt` — `captureLoadOrder` documents that
  as an invariant, so a zero here is correct rather than a failure.
- The curator's plugin order and ESL flags, after deploy.

---

## Phases

The driver is a linear state machine:

```
preflight
  │
  ▼
creating-profile  ── only when installTarget.kind === "fresh-profile"
  │                  (dispatch setProfile)
  ▼
switching-profile ── only when installTarget.kind === "fresh-profile"
  │                  (dispatch setNextProfile, await profile-did-change)
  ▼
removing-mods    ── per mod in the removal plan, sequentially:
  │                  ┌── replace-existing  (diverged + user "Replace")
  │                  └── orphan-uninstall  (orphan + user "Uninstall")
  ▼
installing-mods   ── per mod, sequentially:
  │                  ┌── nexus-download                 │
  │                  ├── nexus-use-local-download       │   any throw →
  │                  ├── nexus-already-installed        │   { kind: "failed",
  │                  ├── external-use-bundled           │     phase, error,
  │                  ├── external-use-local-download    │     partialProfileId,
  │                  ├── external-already-installed     │     installedSoFar }
  │                  ├── *-diverged + replace-existing  │
  │                  └── external-prompt-user + use-local-file
  ▼
verifying-mods    ── hash what landed against the manifest; classify each
  │                  archive matches / differs / damaged / unknown
  ▼
applying-mod-rules ── back up the user's rules, CLEAR them, apply the
  │                   collection's  (before deploy, matching Vortex's own
  │                   collections)
  ▼
applying-userlist ── same treatment for the LOOT userlist
  │
  ▼
deploying ── (emit deploy-mods, await did-deploy)
  │
  ▼
applying-load-order ── AFTER deploy, because Vortex only persists the order
  │                    of plugins it considers deployed: pin the curator's
  │                    order (set-plugin-list), integrate any extra plugins
  │                    the user has, restore ESL flags
  ▼
writing-receipt ── game settings, then writeReceipt
  │
  ▼
complete ──────────────────────────────────────────────────►
```

The `deploying` / `applying-load-order` split is the one ordering constraint
that is not stylistic: `PluginPersistor` serializes from its **deployed** set,
so an order pinned before deploy is pinned against a plugin list that does not
exist yet and is silently discarded.

Each phase emits at least one `DriverProgress` beat. The
`installing-mods`, `removing-mods` and `verifying-mods` phases emit one per
mod. `currentStep`/`totalSteps` are scoped to the phase, not the run as a
whole — there's no useful global step count.

For `current-profile` mode the `creating-profile` and
`switching-profile` phases are skipped entirely.

---

## Why `fresh-profile` is the safest path

When a user installs a `.ehcoll` and there's no install receipt for it,
the driver **forces** the install into a brand-new profile. This is a
load-bearing safety choice; full justification is in
[INSTALL_LEDGER.md](INSTALL_LEDGER.md) and
[USER_STATE.md](USER_STATE.md). Summary:

- Mods are added to Vortex's **global pool** (not "the profile"). Every
  installed mod is visible in every profile of the same game; whether
  it deploys depends on `setModEnabled(profileId, modId, true)`.
- A fresh profile starts with **zero** mods enabled. Enabling only the
  collection's mods produces a clean isolated install.
- The user's previous profile is **never** touched. Switching back in
  Vortex's UI restores the previous deployed state.
- This makes the install effectively reversible without rollback logic.

---

## Per-decision behavior

Each `ModDecision.kind` maps to exactly one install primitive:

| Decision                       | Choice required             | Primitive                          | Notes |
|--------------------------------|-----------------------------|------------------------------------|-------|
| `nexus-download`               | _none_                      | `installNexusViaApi`               | `api.ext.nexusDownload(gameId, modId, fileId, fileName, true)`. Returns archiveId; we wait for `did-install-mod`. |
| `nexus-use-local-download`     | _none_                      | `installFromExistingDownload`      | Emits `start-install-download` with the archiveId. |
| `nexus-already-installed`      | _none_                      | _(no install)_                     | Re-uses `existingModId`. Driver enables it in the active profile. |
| `external-use-bundled`         | _none_                      | `installFromBundledArchive`        | Writes the canonical zip of the mod's `bundled/<sha256>/` folder into a temp dir (refused unless it hashes to the sha), checks free space, then `start-install` with the absolute path. |
| `external-use-local-download`  | _none_                      | `installFromExistingDownload`      | Same as Nexus local. |
| `external-already-installed`   | _none_                      | _(no install)_                     | Same re-use path as Nexus already-installed. |
| `nexus-version-diverged`       | `keep-existing` / `replace-existing` / `skip` | `installManifestEntry` (replace) | `keep-existing` ⇒ enable the existing mod in the active profile **and** carry-forward its lineage tag into the new receipt (see "Carry-forward semantics"). `replace-existing` ⇒ uninstall in `removing-mods`, then install the manifest's version. `skip` ⇒ record in `skippedMods` and do nothing else. |
| `nexus-bytes-diverged`         | same                        | same                               | same |
| `external-bytes-diverged`      | same                        | same                               | same |
| `external-prompt-user`         | `use-local-file` / `skip`   | `installFromLocalArchive`          | `use-local-file` ⇒ `start-install` with the user's local path. `skip` ⇒ no-op. SHA-256 is **not** verified post-install in v1. |
| `external-missing`             | _refused in preflight_      | _N/A_                              | Hard block — strict manifest declares no user-side recovery. |
| `nexus-unreachable`            | _refused in preflight_      | _N/A_                              | Hard block — manifest is structurally bad for the user's environment. |

`skip` choices on `*-diverged` and `external-prompt-user` decisions
are recorded in `result.skippedMods` for the result dialog. Receipt
write skips them too — only mods actually installed (or carried
forward; see below) are recorded.

### Carry-forward semantics

Two user choices in current-profile mode produce a mod that ends up
in the new receipt **without being re-installed**:

1. **`*-diverged` + `keep-existing`** — the user chose to stick with
   their version. The driver:
   - calls `enableModInProfile(api, profileId, decision.existingModId)`
     so the collection actually receives the mod (a globally-installed
     mod might be disabled in the active profile),
   - records a `CarriedModReportEntry` with
     `reason: "diverged-keep-existing"` and
     `enabledInProfile: true`,
   - includes the mod in `receipt.mods` so future releases that drop
     this `compareKey` will see it as an orphan.

2. **Orphaned mod + `keep` choice** — the user wants the orphan to
   stay. The driver:
   - does NOT touch the mod's enabled state ("keep" means "leave
     alone"),
   - records a `CarriedModReportEntry` with `reason: "orphan-keep"`
     and `enabledInProfile: false`,
   - includes the mod in `receipt.mods` so the lineage tag survives
     into the next release.

Without carry-forward, kept mods would silently lose their lineage
on the next install of the same collection: orphan detection would
miss them, and a future "we no longer reference this mod" decision
would never be made. The receipt is the only authoritative source for
"this collection currently controls these mods on this machine."

Carry-forward only occurs in current-profile mode. The resolver
collapses `*-diverged` decisions and produces no orphans in
fresh-profile mode, so `result.carriedMods` is always empty there.

---

## User-confirmed decisions (`UserConfirmedDecisions`)

The driver itself never prompts the user. The action handler collects
all decisions up-front (via the picker chain) and passes them in
`DriverContext.decisions`:

```ts
type UserConfirmedDecisions = {
  conflictChoices?: Record<string /* compareKey */, ConflictChoice>;
  orphanChoices?:   Record<string /* existingModId */, OrphanChoice>;
};

type ConflictChoice =
  | { kind: "keep-existing" }
  | { kind: "replace-existing" }
  | { kind: "use-local-file"; localPath: string }
  | { kind: "skip" };

type OrphanChoice =
  | { kind: "keep" }
  | { kind: "uninstall" };
```

### Preflight validation

`preflight` runs four checks:

1. **Compatibility gate** — `plan.summary.canProceed === true` and
   `plan.compatibility.gameMatches === true`.
2. **Hard blockers** — no `nexus-unreachable` or `external-missing`
   decision is present.
3. **Required choices present** — every `ModResolution` whose
   decision needs user input (any `*-diverged` or `external-prompt-user`)
   has a matching `conflictChoices[compareKey]` entry.
4. **Choice validity** — every supplied choice is logically valid for
   its decision:
   - `*-diverged` decisions accept `keep-existing` / `replace-existing` / `skip`,
   - `external-prompt-user` accepts `use-local-file` / `skip`,
   - `use-local-file` requires a non-empty `localPath`,
   - `orphanChoices` keys match an actual `OrphanedModDecision`.

Failing any check ⇒ `{kind: "failed", phase: "preflight"}` with a
descriptive error string. The action handler's gate runs the same
hard-blocker check, so this branch is unreachable in practice but
serves as a defensive backstop.

### Removal plan

A separate pre-pass over `(plan, decisions)` builds the removal plan:

- one entry per `replace-existing` conflict choice (uninstall before
  install),
- one entry per `orphan-uninstall` orphan choice (uninstall the
  orphaned mod).

The removal plan runs in the `removing-mods` phase, **before**
`installing-mods`, so any mod being replaced is gone before its new
version is installed. This avoids Vortex flagging the install as a
duplicate when both the existing and new versions briefly coexist.

The removal primitive is `uninstallMod(api, gameId, modId)`, which
wraps Vortex's `util.removeMods`. This removes the mod from disk,
clears its entries in `state.persistent.mods`, and unselects it in
every profile. It does **not** trigger a deploy — that happens once
at the end of the install.

Removed mods are tracked in `result.removedMods` (a
`RemovedModReportEntry[]`) for the result dialog.

---

## Replacing the user's rules

**The collection's rule set is the whole rule set.** The driver does not merge
its rules into whatever the user already had — it clears theirs first, then
applies the curator's, so the machine ends up with exactly the rules the
collection was built with.

The reason is that the failure mode of merging is silent. Mod rules decide
which mod wins a file conflict; LOOT userlist rules decide plugin order. One
leftover rule changes what the game actually loads while every check we run
still passes: the files are byte-correct, the manifest verifies, and the game
behaves differently from the curator's anyway. That lands as "your collection
is broken" with nothing to point at.

`purgeUserRules.ts` owns this. The sequence, in order:

1. `captureUserRuleState` snapshots **everything** first — every mod rule for
   the game and the entire LOOT userlist, verbatim.
2. The caller writes that snapshot beside the receipt. This is an interlock,
   not a courtesy: the purge does not run unless the backup landed on disk.
3. `CLEAR_USERLIST` empties the userlist in one dispatch. Mod rules are removed
   per mod.
4. The collection's rules are applied.

### What this deletes, stated plainly

Vortex stores mod rules on the **mod** (`persistent.mods[gameId][modId].rules`)
and the LOOT userlist per **game**. Neither is per-profile, so a
profile-scoped purge is not available to us and the blast radius is wider than
the profile being installed into:

- rules on mods that are not part of the collection, and
- rules the user set for their **other profiles of the same game**.

That is the intended scope, it is not recoverable from Vortex itself, and it is
why step 1 exists. A user who says "it deleted my rules" can be shown exactly
what was removed and have it put back.

The action names (`CLEAR_USERLIST`, `REMOVE_USERLIST_RULE`,
`REMOVE_PLUGIN_GROUP`) were read out of the shipped
`gamebryo-plugin-management` bundle rather than guessed — `CLEAR_USERLIST`
genuinely takes no payload.

---

## `plugins.txt` — the driver pins the order, Vortex persists it

**The driver DOES apply the curator's plugin order, and `plugins.txt` ends
up carrying it.** This section previously said the opposite, and the
reasoning behind that was half right.

The original design wrote the FILE, via a `src/core/installer/pluginsTxt.ts`
writer that emitted the manifest's order directly. That module was deleted for
a good reason: Vortex and LOOT own `plugins.txt` and regenerate it, so writing
it behind their back is undone the moment anything re-sorts. What followed was
a "rules-only" strategy — apply mod rules and the LOOT userlist, then merely
*report* how far the resulting order drifted from the curator's.

The premise that survived too long was that the order therefore could not be
applied at all. The file is Vortex's; the STATE is not. Vortex's own
`gamebryo-plugin-management` ships `PluginPersistor.syncFromState`, whose
purpose is to flush the redux load-order hive to `plugins.txt` after a
collection install — its error string names collection installs explicitly.

So `applyPluginOrder` (after deploy, in the `applying-load-order` phase) does
three things, and the order of them is the whole safety argument:

1. `set-plugin-list` — dispatches `updatePluginOrder(names, setEnabled=false)`.
   The curator's plugins take the recorded order; plugins the collection does
   not contain are appended after them, keeping their enabled state. Passing
   `true` here would disable every plugin the user added themselves, which is
   not ours to do.
2. `autosort-plugins` — LOOT. Vortex feeds it the list sorted by the CURRENT
   order and libloot's sort is topological with that as the tiebreak, so step 1
   becomes the baseline: the curator's relative order survives wherever nothing
   forces otherwise, while masters, the curator's userlist rules and the
   masterlist lift the user's own plugins into their correct places instead of
   stranding them at the end.
3. `collection-postprocess-complete` — `syncFromState` writes `plugins.txt`.

**Pinning first is what makes the attempt safe.** LOOT refuses to sort at all
when rules form a cycle. If the sort fails, times out, or the events do not
exist on an older Vortex, the curator's order is already in the hive and is
still written; the cost of failure is the interleaving of the user's own
plugins, never the order itself.

The drift report still runs afterwards, and now means something it did not
before: a remaining difference is LOOT actively disagreeing with the curator —
a master-order violation, or a newer masterlist — rather than nobody having
tried.

### ESL / light flags

Applied in the same phase, straight after the order. The flag is a bit in the
plugin file's TES4 header, so a plugin the curator marked light after
installing is a staged file the archive does not contain — the user installs
the archive and silently gets the unflagged copy. Nothing else catches that:
verification sees different bytes, the archive check finds the user's copy
matches the archive exactly, and accepts it as curator divergence. Correct for
every other difference, and fatal for this one, because only 254 regular
plugins can load and a large collection fits only because most of its plugins
are light.

The authority for this is `DriverPhase` in
`src/types/installDriver.ts`, which carries the same note above its
definition, and the comment at the top of `runInstall.ts`.

Consequence worth knowing: the captured `manifest.plugins.order` is an
*input* to rule/userlist derivation, not a literal file the installer
stamps on disk. A reproduced profile matches by construction, not by
byte-copy.

The write is atomic: temp file + `rename`. If the process dies
mid-write, the original (or its absence) is preserved.

---

## Deployment

The driver triggers Vortex's deployment pipeline by emitting:

```ts
api.events.emit("deploy-mods", profileId, callback);
```

It then waits for the canonical `did-deploy` event for the same
profileId. Both the callback's error path and the `did-deploy` event
are listened to; the timeout is 5 minutes (deployments of 100s of mods
on slow disks can take minutes).

The driver does NOT call `purge-mods` first — switching profiles
already triggers an automatic purge of the previous profile's
deployment. Doing it twice would just slow things down.

---

## Receipt write

After successful deploy, the driver builds an `InstallReceipt` from:

- `plan.manifest.package.{id, version, name}` — collection identity.
- `plan.manifest.game.id` — game id.
- `installedAt` — current ISO-8601 timestamp.
- `vortexProfileId` / `vortexProfileName` — the active profile (new or
  current).
- `installTargetMode` — `"fresh-profile"` or `"current-profile"`,
  taken from `plan.installTarget.kind`.
- `mods` — one `InstallReceiptMod` per:
  - successfully-installed mod, plus
  - mod carried forward into the new release (diverged-keep-existing
    or orphan-keep; see "Carry-forward semantics").

  `*-already-installed` decisions are also recorded — they're part of
  the collection's install state too. `skip` choices are NOT recorded.

The receipt is written via `writeReceipt(appDataPath, receipt)` which
uses an atomic tmp+rename and self-validates by parse-on-write. The
driver wraps it in a one-retry-after-250ms loop to absorb transient
filesystem stutters (antivirus locking the temp file, parallel I/O
contention) — failures that clear in <100ms in practice.

If both attempts fail the driver returns
`{kind: "failed", phase: "writing-receipt"}`. The install is otherwise
complete on disk (mods installed, `plugins.txt` written, deploy ran).
The user can re-run the install; the resolver will detect the existing
mods and the next attempt will short-circuit most decisions to
`*-already-installed`, then write the receipt. **Caveat:** without a
receipt, the second run will fall through `pickInstallTarget` to
fresh-profile mode and create a new empty profile rather than
re-using the one we just populated. The action handler surfaces the
receipt path on success precisely so the user can detect this case
(missing receipt) and either retry promptly or escalate.

---

## Failure semantics

The driver **does not roll back**. Three reasons:

1. **Rollback is unsound at this scope.** Vortex's mod pool is shared
   across profiles; deleting a mod that the user happens to have
   independently selected in another profile would silently break
   that profile. We refuse to play that game.
2. **Partial state is observable and useful.** A failure during the
   12th of 47 mods leaves 11 mods properly installed, deployable,
   and visible in the new profile. The user can fix the underlying
   issue (network, disk, Nexus auth) and re-run; the resolver's
   already-installed detection picks up where the failure left off.
3. **Idempotence-on-retry is more useful than rollback.** The receipt
   isn't written until after deploy succeeds, so a re-run starts from
   the same lineage state as the first run (no receipt → fresh
   profile mode again). The new profile is created from scratch each
   time; the user can delete the previous failed profile from
   Vortex's UI when they're confident the retry succeeded.

The `InstallFailed` result carries:
- `phase` — which phase broke,
- `partialProfileId` — the new profile (if it was created); for
  `current-profile` mode this is the active profile id (the profile
  itself wasn't created by the driver),
- `error` — one-line summary,
- `installedSoFar` — Vortex mod ids of mods that DID install.

The action handler renders all of this in the post-install dialog.

For `current-profile` mode, partial-state also includes mods that
were uninstalled in the `removing-mods` phase before the failure.
Those mods are gone from Vortex and must be reinstalled if the user
wants to revert.

---

## Cancellation

`DriverContext.abortSignal` is cooperative. The driver checks it at
phase boundaries — it does **not** interrupt in-flight Vortex
operations (you can't safely kill a download mid-stream without
risking corrupted archives in the cache).

When the signal aborts, the driver returns
`{kind: "aborted", phase, partialProfileId, reason}`. Same partial-state
guarantees as a failure.

**Nothing currently passes an `abortSignal`, and that is a decision rather than
an omission.** The legacy action handler never did. The React wizard
deliberately does not either (`installSession.ts:25-31`): the driver mutates
`mods/`, downloads and deployment, so stopping midway leaves a half-applied
state, and a Cancel button that cannot safely do what it says is worse than
none. The abort machinery stays wired through the driver because the hang
watchdog uses that path, and because the contract — an aborted run writes no
receipt — has to hold whoever triggers it.

---

## Concurrency

Mod installs run **sequentially**. Vortex's install pipeline serializes
internally — FOMOD UI is modal, the global download queue serializes
above a configurable limit, and the `start-install-download` event
chains into the same queue. Parallel calls would just contend for the
same lock.

Sequential is also the simplest mental model for the user-visible
progress notification. A bar that says "installing mod 7 of 23" is
something the user understands; a bar that says "47% installed across
6 concurrent operations" is not.

---

## What the driver does NOT do

Every entry that used to say "Slice 6c" has since been built; what follows is
what genuinely remains outside its scope.

- ✅ ~~Apply `manifest.rules`~~ — applied, and they replace the user's.
- ✅ ~~Apply Vortex `setLoadOrder`~~ — applied after deploy, alongside the
  plugin order and ESL flags.
- ✅ ~~Verify SHA-256 of `use-local-file` archives~~ — `checkArchiveIdentity`
  hashes a hand-picked archive against the manifest and tells the user when it
  is not the one the collection was built from. It still installs what they
  chose: a browse-mode dependency legitimately resolves to a different-but-
  equivalent build, and that call is theirs. What they should not do is make it
  unknowingly.
- ✅ ~~Verify SHA-256 of downloaded archives post-install~~ — the assumption
  that "downloads are trusted to be byte-correct because they come from Nexus's
  CDN" was wrong twice over: a mod can be re-uploaded under the same file id,
  and a download can simply be truncated. Both are checked, and told apart,
  because only one of them is fixed by downloading again.
- ❌ Roll back. A run that fails leaves what it installed in place; re-running
  picks up from there. Deliberate — see the idempotency note above.
- ❌ Apply INI tweaks (`state.enabledINITweaks`). Recorded, not applied; the
  build warns the curator so they do not assume otherwise.
- ❌ Apply `fileOverrides`. Recorded (4,382 entries on a real collection) and
  read by nothing. Decide whether it is load-bearing before promising
  byte-exact reproduction.
- ❌ Verify external dependencies (`plan.externalDependencies`). The
  external-deps verification flow is its own project (Phase 4); the
  driver records what was installed and the user-side verifier is a
  separate action.
- ❌ Write README/CHANGELOG into the per-collection state file. The
  packager produces them; future Phase 5 UI surfaces them. The
  driver doesn't need to copy them anywhere.
- ❌ Re-prompt the user mid-run. All decisions are collected up-front
  by the action handler. Phase 5 React UI may add mid-run recovery
  flows.
- ❌ Roll back removed mods on failure. `removing-mods` runs before
  `installing-mods`; if the install fails after a removal, the
  removed mod stays gone.

---

## Per-module breakdown

### `src/core/installer/profile.ts`

Three exported functions, all narrowly scoped:

- `createFreshProfile(api, gameId, suggestedName)` — dispatches a new
  `IProfile` into Vortex's store with a UUIDv4 id. Picks a non-colliding
  display name by appending `" (2)"`, `" (3)"`, ... if needed.
- `switchToProfile(api, profileId)` — dispatches `setNextProfile` and
  awaits the `profile-did-change` event for that profileId. 30 s
  timeout; usually completes in seconds.
- `enableModInProfile(api, profileId, modId)` — dispatches
  `setModEnabled`. The driver batches enables; deploy at end of
  install.

`pickNonCollidingName` is exported for future tests; the driver only
needs the three above.

### `src/core/installer/modInstall.ts`

Five primitives + helpers:

- `installNexusViaApi` — calls `api.ext.nexusDownload(...)` with
  `allowInstall=true`, then waits for `did-install-mod` for the
  resulting archiveId. Returns `{archiveId, vortexModId}`.
- `installFromExistingDownload` — emits `start-install-download` with
  the archiveId, waits for `did-install-mod`. Returns
  `{vortexModId}`.
- `installFromBundledArchive` — takes the archive `writeBundledArchive`
  wrote, checks that Vortex's download folder and staging folder have room
  for it (`requireFreeSpace`; the archive is stored, so its size stands in
  for both), then races a `start-install` callback against
  `did-install-mod`. Returns `{vortexModId, extractedPath}` so the caller
  can clean up the temp dir.
- `installFromLocalArchive` — `start-install` against an arbitrary
  user-supplied disk path (used for `external-prompt-user` +
  `use-local-file`). Returns `{vortexModId}`.
- `uninstallMod` — wraps Vortex's `util.removeMods(api, gameId,
  [modId])`. Removes the mod from disk, clears its entries in
  `state.persistent.mods`, and unselects it in every profile. Used
  by `removing-mods` for `replace-existing` and `orphan-uninstall`.
- `writeBundledArchive` — exposed helper; writes the canonical zip of a
  `bundled/<sha256>/` folder out of the package (`readZip.ts` reads,
  `bundleZip.ts` writes) and refuses it unless it hashes to the sha. It
  first claims room on the temp drive (`claimFreeSpace`) for the zip's
  largest size, counted against the other bundled mods being written there
  at the same time: a write that only fits alone waits for them, and one
  that cannot fit at all is refused, naming the drive.
- `safeRmTempDir` — best-effort temp cleanup (errors swallowed; OS
  GCs `os.tmpdir()` eventually).

The 10-minute install timeout is generous on purpose: real FOMOD
installs of large mods (textures, ENB packages) routinely take 30–60s
on slow disks. The user is far more annoyed by a false-positive
timeout than by waiting a minute longer.

### `src/core/installer/runInstall.ts`

The orchestrator. Public surface is one function, `runInstall(ctx)`.
Internally:

- `preflight(plan, decisions)` — synchronous validation. Refuses
  non-canProceed plans, hard-blocker decisions, missing/invalid user
  choices.
- `collectRemovalPlan(plan, decisions)` — pure pre-pass that produces
  a `RemovalItem[]` from `replace-existing` conflict choices and
  `orphan-uninstall` orphan choices.
- `executeDecision(...)` — `switch`-on-`decision.kind`. Each arm
  delegates to a primitive in `modInstall.ts`, short-circuits
  (already-installed cases), or branches into:
  - `executeDivergedChoice(...)` for `*-diverged` decisions —
    consults `decisions.conflictChoices[compareKey]` to pick
    `keep-existing` (re-use existing modId) / `replace-existing`
    (delegate to `installManifestEntry`) / `skip` (no-op).
  - `executePromptUserChoice(...)` for `external-prompt-user` —
    `use-local-file` ⇒ `installFromLocalArchive` / `skip` ⇒ no-op.
  - `installManifestEntry(...)` — re-derives the install path for a
    `replace-existing` choice from the manifest entry (Nexus or
    External). Reuses `installNexusViaApi` /
    `installFromBundledArchive` / `installFromExistingDownload` as
    appropriate.
- `deployAndWait(api)` — emits `deploy-mods`, waits for `did-deploy`.
- `buildReceipt(...)` — pure transform from driver state into the
  ledger schema; uses `plan.installTarget.kind` for
  `installTargetMode`.

---

## Failure modes (cataloged)

| Phase                  | Likely failure                                                | Result kind | Surfaced as |
|------------------------|---------------------------------------------------------------|-------------|-------------|
| `preflight`            | hard-blocker decisions / missing or invalid user choices       | `failed`    | "Plan contains 1 hard-blocker..." / "Missing conflict choice..." |
| `creating-profile`     | (none in practice — pure dispatch)                             | _N/A_       | _N/A_ |
| `switching-profile`    | Vortex deployment lock; another switch in flight              | `failed`    | "Profile switch did not complete within 30s." |
| `removing-mods`        | `util.removeMods` rejects (race; mod already deleted manually) | `failed`    | "Failed uninstalling X: Y." |
| `installing-mods`      | network failure on Nexus download; FOMOD UI cancellation       | `failed`    | "Failed installing X (decision=Y): Z." |
| `installing-mods`      | a bundled mod's files are missing, damaged or changed in the `.ehcoll` | `failed`    | "The files for X in Y do not make the mod the collection names..." |
| `installing-mods`      | `did-install-mod` timeout (10 min)                             | `failed`    | "Mod install did not complete within 600s." |
| `installing-mods`      | user-supplied local file missing / unreadable                  | `failed`    | "Failed installing X from <path>: ENOENT." |
| `deploying`            | deployment timeout (5 min); `deploy-mods` callback error       | `failed`    | "Deployment failed: <reason>." |
| `writing-receipt`      | `InstallLedgerError` (atomic write race); disk full            | `failed`    | "Failed writing install receipt: <reason>." |

In all `failed` cases the partial profile is preserved. The user can
switch back to it later or delete it from Vortex's UI.

---

## Action-handler integration

The toolbar action (`src/actions/installCollectionAction.ts`, removed on 2026-09-15) wrapped the driver as follows; today the install session (`src/ui/pages/install/installSession.ts`) is its only caller:

1. After `resolveInstallPlan` returns, the action runs
   `isPlanInstallable(plan)` — checks `canProceed` and the absence of
   hard blockers (`nexus-unreachable`, `external-missing`).
2. If installable, the dialog shows `[Cancel, Install]`; otherwise
   `[Close]` only.
3. On Install click, the action runs `collectUserDecisions(plan)` —
   one `showDialog` per `*-diverged` / `external-prompt-user` mod
   plus one per orphan. The user picks `keep` / `replace` / `skip`
   for conflicts and `keep` / `uninstall` for orphans. Cancellation
   at any prompt aborts the install.
4. The action builds a `DriverContext` with the collected decisions,
   supplies an `onProgress` callback that updates an activity
   notification, and invokes `runInstall`.
5. The result (`success` / `aborted` / `failed`) is rendered in a
   second dialog plus a final notification.

The action does **not** retry, prompt for user input mid-install, or
inspect intermediate driver state. All that policy lives in the
driver. Decisions flow exclusively through `UserConfirmedDecisions`.

The action **does** validate one thing the driver cannot: stale
install receipts. If `readReceipt` returns a receipt but its
`vortexProfileId` no longer exists in Vortex state (the user deleted
the profile), the action prompts the user to choose between:

- **Treat as fresh install** — delete the receipt; the install lands
  in a brand-new empty profile (the safe default; matches first-time
  install semantics).
- **Use current profile anyway** — keep the receipt; the install
  merges into the user's currently active profile. Only correct when
  the user intentionally wants lineage to carry across the deleted
  profile.
- **Cancel** — abort without modifying anything.

Without this check, `pickInstallTarget` would default to
`current-profile` mode based on the receipt's mere presence and
silently merge an unrelated collection into whatever profile happened
to be active.

---

## Acknowledged gaps

These are known limitations that v1 explicitly does not address.
They are not bugs — each has a documented rationale for being
deferred. Phase 5 (React UI) is the natural place to revisit any of
them.

- **D1 — No SHA-256 verification post-install.** The driver trusts
  Vortex's install pipeline. For `use-local-file` choices the user
  could pick a wrong file and we'd happily install it; for bundled
  archives we trust the curator-side `archiveSha256` matches the
  bytes in the `.ehcoll` ZIP (verified by `readEhcoll` on read, but
  not re-verified per-mod at install time). A Phase 5 enhancement
  could rehash post-install and surface mismatches in the drift
  report.

- **D2 — Manifest entries are looked up by `compareKey`.** The driver
  no longer relies on the resolver's positional invariant
  (`manifest.mods[i] ↔ plan.modResolutions[i]`). Lookup is via
  `Map<compareKey, EhcollMod>`. A resolver that produced a resolution
  with no matching manifest entry is rejected with an internal-error
  failure rather than indexed-into-undefined.

- **D3 — Removed mods are NOT restored on later-phase failure.** If
  the `removing-mods` phase succeeds (uninstalling A, B, C) but the
  next phase fails, A/B/C are gone and the user is left with a
  half-applied state. Reinstall by re-running the install (the
  resolver will plan their re-installation as `*-already-installed`
  for the new manifest version, or as a fresh install for orphans).
  This is consistent with the "no rollback, idempotent retry"
  philosophy.

- **D4 — Deploy timeout = 5 minutes.** If Vortex actually completes
  the deployment after the timeout fires, the driver still reports
  `{kind: "failed", phase: "deploying"}` and the receipt is never
  written. The deploy itself is fine on disk, but the missing
  receipt forces the next attempt into fresh-profile mode again.
  Surface area: very large collections (500+ mods) on slow disks.

- **H3 (mitigated, not eliminated) — `did-install-mod` listener
  fallback.** The bundled-archive and local-archive primitives now
  fire `start-install` AND attach a `did-install-mod` listener that
  accepts the first event for our gameId after registration
  (`acceptAny: true`). If the user starts a second unrelated install
  in the same Vortex session within the timeout window (10 minutes),
  the listener could grab the wrong event. Acceptable trade-off: the
  synchronous callback path wins in the common case, and the
  alternative (no fallback) had a real failure mode of timing out
  for 10 minutes on Vortex builds where the callback didn't fire.

- **H5 (mitigated) — Receipt-write retry.** The driver retries the
  receipt write once after a 250ms delay before reporting failure.
  This handles transient AV scans and filesystem stutters but does
  not protect against permanent issues (disk full, permissions). On
  hard failure the install is on disk but unreceiped; users must
  re-run.

---

## Open questions

Settled since this list was written, kept because the answers are load-bearing:

- ~~**Mod rule application timing**~~ — **before deploy**, matching Vortex's own
  collections. And rules now *replace* the user's rather than being applied on
  top; see "Replacing the user's rules".
- ~~**Conflict picker UI**~~ — the React install wizard batches conflicts and
  orphans into one table instead of a `showDialog` per mod.
- ~~**Drift report on success**~~ — built, and the reference had to be corrected:
  drift is measured against **our previous install's hashes**, never against the
  curator's staging folder, which can be corrupt without anyone knowing. It
  compares only the paths the manifest records, not a folder walk.
- ~~**SHA-256 verification of `use-local-file`**~~ — verified, and the outcome is
  reported as `matches` / `differs` / `damaged` / `unknown`. Telling `differs`
  from `damaged` is the point: only one of them is fixed by downloading again.

Genuinely still open:

- **Nexus auth fallback**: if `api.ext.nexusDownload` is missing (Nexus
  extension disabled / not logged in) the driver fails `installing-mods` with a
  hard error. A "Log in to Nexus" recovery action would be better than making
  the user restart the install.
- **`fileOverrides` are recorded and never applied.** A real collection carries
  4,382 entries. Either they matter to reproduction, in which case the driver
  has a gap, or they do not, in which case the manifest should stop claiming
  them. Nobody has measured which.
- **INI tweaks** (`enabledINITweaks`) are captured but never applied. The build
  warns the curator, so it is disclosed rather than silent — but it is still a
  hole in "deterministic reproduction".
- **Load-order integration policy at scale.** Extra plugins the user has that
  the collection does not know about are integrated LOOT-style rather than
  appended. That is the right behaviour on paper; the number to watch is how
  far the result drifts from the curator's on a real 954-mod profile.

---

## Related documents

- [INSTALL_PLAN_SCHEMA.md](INSTALL_PLAN_SCHEMA.md) — the input contract.
- [RESOLVE_INSTALL_PLAN.md](RESOLVE_INSTALL_PLAN.md) — how the plan is built.
- [USER_STATE.md](USER_STATE.md) — `UserSideState` builder + `pickInstallTarget`.
- [INSTALL_ACTION.md](INSTALL_ACTION.md) — the removed toolbar action that wrapped the driver (history).
- [INSTALL_LEDGER.md](INSTALL_LEDGER.md) — receipt schema + lifecycle.
- [../PROPOSAL_INSTALLER.md](../PROPOSAL_INSTALLER.md) — overall design doc.
- [../ARCHITECTURE.md](../ARCHITECTURE.md) — file-by-file index.
