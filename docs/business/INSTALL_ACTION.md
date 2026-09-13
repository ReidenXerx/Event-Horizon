# Install Event Horizon Collection — Action

**Source of truth:** `src/actions/installCollectionAction.ts` (Phase 3 slices 5 + 6a + 6b).

**Related specs:**
- [`USER_STATE.md`](USER_STATE.md) — what the builder produces.
- [`INSTALL_LEDGER.md`](INSTALL_LEDGER.md) — receipt I/O the action invokes.
- [`RESOLVE_INSTALL_PLAN.md`](RESOLVE_INSTALL_PLAN.md) — the pure resolver.
- [`INSTALL_PLAN_SCHEMA.md`](INSTALL_PLAN_SCHEMA.md) — the plan shape rendered in the dialog.
- [`INSTALL_DRIVER.md`](INSTALL_DRIVER.md) — what `runInstall` does when the user clicks Install.

## Purpose

Toolbar entry point that previews what installing a `.ehcoll` package would do on the user's machine, then — when the user confirms — collects per-mod decisions and runs the install. Wires every Phase 3 component together end-to-end:

```
file pick → readEhcoll → readReceipt → snapshot pipeline (hashing) →
buildUserSideState → pickInstallTarget → resolveInstallPlan → preview dialog
                                                              │
                                                              ▼
                                            user clicks Install? ── no ── done
                                                              │
                                                              yes
                                                              │
                                                              ▼
                                       per-conflict + per-orphan picker chain
                                                              │
                                                              │ (any cancel ⇒ exit)
                                                              ▼
                                                  runInstall(plan, decisions)
                                                              │
                                                              ▼
                                                       result dialog
```

The action grew in slices; all of them have landed. It now:

- accepts plans with **manual-review** decisions (`*-diverged`, `external-prompt-user`),
- accepts plans with **orphans**,
- accepts plans targeting the **current profile**,
- collects a `UserConfirmedDecisions` object via sequential picker dialogs after the user clicks Install,
- passes those decisions to `runInstall`.

The only decisions the action still refuses outright are the two structural blockers: `nexus-unreachable` and `external-missing`.

## ─── TRANSITIONAL UI ───────────────────────────────────────────────

Every `showDialog` / `sendNotification` / toolbar registration is scaffolding. Phase 5 introduces a dedicated React `mainPage` that owns:

- the file-pick + plan-preview panel,
- a per-mod conflict picker for `*-version-diverged` / `*-bytes-diverged` / `external-prompt-user`,
- a per-orphan picker for `OrphanedModDecision`,
- a progress panel for the install driver,
- a post-install drift report.

The **call sequence** in this file is permanent — `readEhcoll`, `readReceipt`, snapshot pipeline, `buildUserSideState`, `pickInstallTarget`, `resolveInstallPlan`, picker loop, `runInstall`. Phase 5 just replaces the rendering layer (`renderPlanDialog`, `pickConflictChoice`, `pickOrphanChoice`, `renderResultDialog`) with React. See [`PROPOSAL_INSTALLER.md`](../PROPOSAL_INSTALLER.md) §10 "Transitional UI vs Phase 5 UI".

## Trigger

User clicks **Install Event Horizon Collection** in Vortex's global icons toolbar (`global-icons` group, position 103).

## Step-by-step behavior

### 1. File pick

`pickEhcollFile()` opens an Electron file dialog filtered to `*.ehcoll`. User cancel ⇒ silent exit (no error notification).

### 2. Read .ehcoll

`readEhcoll(zipPath)` returns `{ manifest, bundledArchives, warnings }`. Failures bubble up as `ReadEhcollError` and are formatted into a single error notification with every parser problem listed.

### 3. Game-id gate (cheap fast-fail)

Three checks run before any expensive work:

1. Vortex has an active game. (No active game ⇒ error.)
2. The active game is supported by Event Horizon (`skyrimse` / `fallout3` / `falloutnv` / `fallout4` / `starfield`).
3. `manifest.game.id` matches the active game.

These run *before* hashing because hashing the wrong profile's mods is wasted work. The resolver's compatibility report would catch the same mismatches, but failing fast at the action layer is better UX.

### 4. Read receipt (lineage authority)

`readReceipt(appDataPath, manifest.package.id)` returns:
- `InstallReceipt` ⇒ this collection has been installed before; we have lineage.
- `undefined` ⇒ first install OR receipt was deleted/lost; lineage gone.

`appDataPath` comes from `util.getVortexPath("appData")` — a per-OS, per-Vortex-install constant. See [`INSTALL_LEDGER.md`](INSTALL_LEDGER.md) for the file layout.

A corrupt receipt throws `InstallLedgerError`. The action surfaces every parser error in the notification — it does NOT silently treat corruption as "missing" because that would discard lineage data the user might want to recover.

#### Stale-receipt detection (post-receipt sanity check)

A receipt may reference a Vortex profile the user has since deleted (e.g. they nuked the Event Horizon-created profile to "start over"). Without a check, `pickInstallTarget` would return `current-profile` mode based purely on the receipt's presence and silently merge an unrelated collection into the user's currently active profile.

If `state.persistent.profiles[receipt.vortexProfileId]` is missing, the action prompts the user via `showDialog`:

| Button | Outcome |
|---|---|
| **Treat as fresh install** (default) | `deleteReceipt` is called; `receipt` is set to `undefined`; install proceeds in fresh-profile mode (matches first-install safety semantics). |
| **Use current profile anyway** | Receipt is kept; install proceeds in current-profile mode (legacy behavior). Only correct when the user intentionally wants lineage to carry across the deleted profile. |
| **Cancel** | Action returns; nothing is written. |

If `deleteReceipt` itself fails, the action shows an error dialog with the underlying file-system reason and treats the choice as "cancel" — never silently swallowing the failure.

### 5. Snapshot pipeline (hash installed mods)

```ts
rawMods         = getModsForProfile(state, gameId, profileId);
installedMods   = enrichModsWithArchiveHashes(state, gameId, rawMods, { concurrency: 4 });
```

This is the slow step — potentially many MB read off disk per install. We surface it as an `"activity"` notification and dismiss it on success or failure (try/finally, mirroring the export action's pattern).

Hashing is **required** for the resolver to produce accurate per-mod decisions. Without `archiveSha256` on installed mods:

- byte-exact match cannot be detected ⇒ already-installed Nexus mods misclassify as `nexus-download`,
- byte drift cannot be detected ⇒ no `*-bytes-diverged` decisions ever fire.

A future optimisation may add a "skip hashing" toggle for power users who know their cache is fresh; v1 always hashes for correctness.

### 6. Build UserSideState

```ts
buildUserSideState({
  gameId,
  gameVersion: resolveGameVersion(state, gameId),
  vortexVersion: resolveVortexVersion(state),
  deploymentMethod: resolveDeploymentMethod(state, gameId),
  enabledExtensions: resolveEnabledExtensions(state),
  activeProfileId,
  activeProfileName,
  installedMods,    // already hashed
  receipt,
  availableDownloads: undefined,         // slice 5: not enriched
  externalDependencyState: undefined,    // slice 5: not verified
})
```

The builder is pure — see [`USER_STATE.md`](USER_STATE.md). The action's job is to harvest each input from Vortex state.

### 7. Pick install target

```ts
installTarget = pickInstallTarget(manifest, receipt, activeProfileId, activeProfileName);
```

Receipt present ⇒ `current-profile`. Receipt missing ⇒ `fresh-profile` (forced). The action **never overrides** the picker's choice. See [`USER_STATE.md`](USER_STATE.md) — install-target rule.

### 8. Resolve install plan

```ts
plan = resolveInstallPlan(manifest, userState, installTarget);
```

Pure transform; no I/O. See [`RESOLVE_INSTALL_PLAN.md`](RESOLVE_INSTALL_PLAN.md).

### 9. Log + render preview dialog

Console line summarises the plan for debugging:

```
[Vortex Event Horizon] Install preview | <name> v<version> | target=<kind> |
mods=N (already=A, silent=S, confirm=C, missing=M, orphans=O) |
canProceed=<bool> | source=<path>
```

Compatibility warnings/errors are echoed to console.

The dialog renders a multi-line text block:

1. **Verdict** — one-line tl;dr (clean / needs input / cannot proceed).
2. **Install target** — current-profile (with previous-version lineage) vs fresh-profile (with suggested name).
3. **Summary** — total / already / silent / confirm / missing / orphans / canProceed.
4. **Compatibility** — game / version / extensions / Vortex / deployment, plus warnings & errors.
5. **Mod resolution buckets** — count per `decision.kind`. Phase 5's panel will show the per-mod table.
6. **Orphans / external deps** — non-zero counts mention them; per-entry detail is Phase 5.
7. **Footer** — either "Ready to install" describing what Install will do (mode-aware: fresh-profile vs current-profile, plus a heads-up when pickers will be shown), or "Cannot install" with the specific reason.

#### Install button gating

The action runs `isPlanInstallable(plan)` to decide which buttons appear:

- **Installable** ⇒ buttons are `[Cancel, Install]`. Cancel is the default; the user must explicitly click Install.
- **Not installable** ⇒ buttons are `[Close]` only.

Installable iff:
1. `plan.summary.canProceed === true`,
2. no mod decision is `nexus-unreachable` or `external-missing`.

These are the two **hard blockers** — there is no user choice that fixes them. Every other decision (`*-diverged`, `external-prompt-user`, orphans) is resolved via the picker chain in step 10.

The dialog uses `type: "info"` when `canProceed === true`, `"error"` otherwise.

### 10. Picker chain (slice 6b)

Once the user clicks **Install**, `collectUserDecisions(api, plan)` walks the plan and shows one `showDialog` per item that needs input:

#### Conflict pickers

Iterates `plan.modResolutions` in manifest order. Skips any decision that doesn't need user input. For each remaining decision:

| `decision.kind` | Buttons | Choice mapping |
|---|---|---|
| `nexus-version-diverged` | `Keep existing` / `Replace with new` / `Abort install` | `keep-existing` / `replace-existing` / cancel |
| `nexus-bytes-diverged` | same | same |
| `external-bytes-diverged` | same | same |
| `external-prompt-user` | `Pick file...` / `Skip this mod` / `Abort install` | `use-local-file` / `skip` / cancel |

For `external-prompt-user` + **Pick file...**: an Electron file picker pops up. The picker's `defaultPath` is `decision.expectedFilename` so the user's filename match is highlighted.

If the user cancels the OS file picker, the action **re-shows the same conflict dialog** with an explanatory note appended ("File picker was cancelled — choose Pick file... again, or pick Skip this mod / Abort install explicitly."). The user must make an explicit choice — accidental Esc no longer silently degrades to skip. The loop terminates only when the user picks a real file, explicitly chooses Skip, or explicitly aborts.

The dialog body for each conflict explains:

- the manifest's expected version/SHA-256 (truncated for readability),
- the user's installed version/SHA-256,
- what each button does in plain language ("Keep existing" / "Replace with new" / "Abort install").

Cancel / Abort install at any conflict picker ⇒ the entire chain returns `undefined`; the install does not run.

#### Orphan pickers

Iterates `plan.orphanedMods`. For each:

| Buttons | Choice mapping |
|---|---|
| `Keep installed` / `Uninstall it` / `Abort install` | `keep` / `uninstall` / cancel |

Body explains which previous release of the collection installed the mod and what the difference between Keep and Uninstall means.

#### Picker-chain output

`collectUserDecisions` returns `UserConfirmedDecisions`:

```ts
{
  conflictChoices: { [compareKey]: ConflictChoice },
  orphanChoices:   { [existingModId]: OrphanChoice },
}
```

Or `undefined` ⇒ user cancelled; install aborts before the driver runs.

The shape matches the driver's contract exactly (`src/types/installDriver.ts`). The driver's preflight will reject any malformed bundle (missing or invalid choices), but in practice this branch is unreachable since the action always supplies one entry per item the resolver flagged.

### 11. Run install

```ts
runInstall({
  api,
  plan,
  ehcoll,            // ReadEhcollResult — for bundled inventory
  ehcollZipPath,     // absolute path; needed to write bundled mods' archives back out of it
  appDataPath,       // for receipt write
  decisions,         // from step 10
  onProgress,        // updates an activity notification per phase beat
})
```

Progress is surfaced as a single Vortex `"activity"` notification with id `"vortex-event-horizon:install-progress"`. The notification's message is rebuilt every time the driver emits a `DriverProgress` beat:

```
[<phase>] (<currentStep>/<totalSteps>) <message>
```

When the driver emits its `complete` / `aborted` / `failed` terminal beat, the notification is dismissed (try/finally). Then a result dialog renders:

- **Success** ⇒ `info` dialog with:
  - mode (fresh profile vs current profile),
  - profile name + id,
  - mod counts (installed, removed if any, carried forward if any),
  - receipt path,
  - install breakdown (counts per `decision.kind`),
  - removed breakdown (counts per `replace-existing` / `orphan-uninstall`),
  - carried-forward breakdown (counts per `diverged-keep-existing` / `orphan-keep`) — mods preserved in the new receipt without being re-installed,
  - skipped list,
  - a mode-aware "next steps" footer.
- **Aborted** ⇒ `info` dialog explaining the abort phase + reason and the partial profile id.
- **Failed** ⇒ `error` dialog with the failed phase, the error message, and (when applicable) a note that the partial profile is preserved for inspection.

A final terminal notification (`success` / `error`) confirms the outcome at the toast level, since the user may have closed the result dialog.

See [`INSTALL_DRIVER.md`](INSTALL_DRIVER.md) for the driver's full behavior — phases, primitives, failure semantics.

## Error handling

A single try/catch wraps **everything except `runInstall`**. On error in steps 1–10:

1. The hashing notification is dismissed if it was shown (try/finally).
2. The error is formatted via `formatError` (special-cases `ReadEhcollError`, `InstallLedgerError`).
3. A `type: "error"` notification fires.
4. The error is logged to console for debugging.

The user never sees an unhandled-promise toast; every code path either succeeds or surfaces a clean message.

`runInstall` itself never throws — it returns a discriminated `InstallResult`. Failures during install render via the result dialog, not the outer error notification. Throws inside `runInstall` would be a driver contract violation; if one ever escapes, the action's outer try/catch catches it as a defensive backstop.

## Quirks & invariants

1. **Preview always runs first.** Even when the plan is installable, the user sees the dialog and must click **Install** explicitly. There is no "one-click install."
2. **Game-id gate runs before hashing.** Mismatched game ⇒ instant error, no wasted hashing.
3. **Hashing is mandatory.** No skip toggle in v1. The resolver's correctness depends on it.
4. **Receipt corruption is surfaced, not swallowed.** Unlike "missing" receipts (treated as fresh install), corrupt receipts throw — the user is told.
5. **Picker is the single rule site.** The action does not branch on `receipt`; it asks `pickInstallTarget`.
6. **Picker-chain cancellation aborts cleanly.** Cancelling any conflict or orphan picker exits before the driver runs. No partial state is created.
7. **External-prompt-user file picker is best-effort.** If the user cancels the file picker, the mod is silently skipped (mapped to `kind: "skip"`). Phase 5's React UI will let the user retry without restarting the chain.
8. **SHA-256 IS verified for `use-local-file`** — and the install still proceeds. `checkArchiveIdentity` hashes the picked file against the manifest and reports `matches` / `differs` / `damaged` / `unknown`. It does not block: a browse-mode dependency legitimately resolves to a different-but-equivalent build, and that call is the user's. What they must not do is make it unknowingly. (This entry used to read "SHA-256 is NOT verified... v1 trusts the user.")
9. **`availableDownloads` is populated in both pipelines.** It used to be `undefined` here while the engine pipeline scanned properly — which is precisely the bug that stranded a tester on a resume that could never find its download. One scanner (`core/resolver/scanAvailableDownloads.ts`) is imported by both call sites; never copy it. `externalDependencyState` is still `undefined` and the resolver still degrades cleanly without it.
10. **Driver emits no rollback.** If `runInstall` fails midway, the partial profile / state is preserved (see [`INSTALL_DRIVER.md`](INSTALL_DRIVER.md) "Failure semantics"). The action does not attempt to clean up.
11. **Progress notification id is fixed** (`"vortex-event-horizon:install-progress"`). The driver emits many beats per phase; reusing one id avoids spamming the notification stack.
12. **Result dialog always fires.** Even for `aborted` / `failed`, the user gets a structured summary, not just a toast. The toast is supplementary.
