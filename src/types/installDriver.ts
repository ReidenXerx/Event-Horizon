/**
 * Install-driver runtime contracts (Phase 3 slice 6).
 *
 * The driver consumes an `InstallPlan` (pure description) and a set of
 * user-confirmed decisions, then mutates the user's machine: creates
 * profiles, downloads mods, installs archives, writes `plugins.txt`,
 * deploys, writes the install ledger receipt.
 *
 * This file is **type-only**. The runtime lives under `src/core/installer/`.
 *
 * Spec: docs/business/INSTALL_DRIVER.md
 *
 * ─── DESIGN ────────────────────────────────────────────────────────────
 * Three rules govern this contract:
 *
 * 1. **Driver is a black-box state machine.** It progresses through a
 *    fixed sequence of phases (see {@link DriverPhase}). The action
 *    handler subscribes to {@link DriverProgress} and renders progress;
 *    it does NOT branch on phases for control flow.
 *
 * 2. **User choices are passed in, not collected by the driver.** The
 *    driver never opens dialogs. {@link UserConfirmedDecisions} is the
 *    full set of "what to do for ambiguous cases" the action handler
 *    has already resolved. Slice 6a's contract is empty (fresh-profile
 *    mode resolves everything cleanly); slice 6b populates it.
 *
 * 3. **Idempotency-on-restart, not idempotency-on-rerun.** A driver run
 *    aborted mid-way leaves a partial profile that the user can re-run
 *    against. The driver does NOT roll back. Slice 6a documents this
 *    via {@link InstallResult.kind === "failed"} carrying the partial
 *    profile id; the user can switch to it manually and inspect.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { FomodReplayMode } from "../core/installer/fomodReplayMode";
import type { ReadEhcollResult } from "../core/manifest/readEhcoll";
import type { InstallPlan } from "./installPlan";
import type {
  ModVerificationReceipt,
  RulesApplicationReceipt,
  UserlistApplicationReceipt,
} from "./installLedger";

// ===========================================================================
// User-confirmed decisions (input alongside the plan)
// ===========================================================================

/**
 * Choices the user has made about ambiguous situations. The driver
 * does NOT prompt; it consumes already-resolved decisions.
 *
 * **Slice 6a** (fresh-profile happy path): both fields are absent or
 * empty. The resolver collapses every diverged decision in
 * fresh-profile mode, and orphan detection is a no-op there.
 *
 * **Slice 6b** (current-profile mode + manual review): the action
 * handler builds two maps:
 *  - {@link conflictChoices} keyed by `ModResolution.compareKey` for
 *    every `*-version-diverged`, `*-bytes-diverged`, and
 *    `external-prompt-user` mod the resolver flagged as needing user
 *    input. Missing keys are an error (the driver refuses to run).
 *  - {@link orphanChoices} keyed by `OrphanedModDecision.existingModId`
 *    for every orphan. Missing keys default to `"keep"` (the safe
 *    no-op).
 *
 * Forward compatibility: the shape is additive. Slice 6c may add
 * more fields without breaking 6b consumers.
 */
export type UserConfirmedDecisions = {
  /**
   * Per-mod conflict resolutions, keyed by the manifest's
   * `compareKey` (mirrored on `ModResolution.compareKey`). Required
   * for every `ModResolution` whose decision needs user input.
   */
  conflictChoices?: Record<string, ConflictChoice>;
  /**
   * Per-orphan resolutions, keyed by the orphan's
   * `existingModId` (Vortex mod id). Missing entries default to
   * `"keep"` — the safest behavior since "uninstall" is destructive.
   */
  orphanChoices?: Record<string, OrphanChoice>;
  /**
   * Whether Vortex shows each FOMOD installer during the install, or applies
   * the curator's recorded answers silently.
   *
   * A decision like the other two: the user makes it once, before anything is
   * written, and it holds for the whole run. Omitted means nobody was asked —
   * callers predating the question — and the replay falls back to
   * `DEFAULT_FOMOD_REPLAY_MODE`.
   */
  fomodReplayMode?: FomodReplayMode;
};

/**
 * What the user chose for a single ambiguous mod decision.
 *
 * Discriminated union so each kind carries only the data it needs:
 *  - `keep-existing`: skip the manifest's mod, leave the user's
 *    existing one untouched (but enable it in the install profile).
 *    Valid for any `*-diverged` decision.
 *  - `replace-existing`: uninstall the user's existing mod, install
 *    the manifest's version. Valid for any `*-diverged` decision.
 *  - `use-local-file`: install from a local archive path the user
 *    picked. Valid for `external-prompt-user` decisions only. The
 *    driver now HASHES that file and compares it against the manifest's
 *    recorded sha256, but still installs whatever the user chose — a
 *    browse-mode dependency legitimately resolves to a different-but-
 *    equivalent build, and the choice is theirs. A mismatch is reported
 *    through {@link InstallSuccess.externalArchiveNotice} so it is not
 *    made unknowingly.
 *  - `skip`: do not install. Records a `SkippedModReportEntry`.
 *    Valid for `external-prompt-user` decisions only (a diverged mod
 *    "skip" would be ambiguous between "skip new install" and
 *    "remove existing"; we use `keep-existing` to be explicit).
 */
export type ConflictChoice =
  | { kind: "keep-existing" }
  | { kind: "replace-existing" }
  | { kind: "use-local-file"; localPath: string }
  | { kind: "skip" };

/**
 * What the user chose for a single orphaned-mod decision.
 *
 *  - `keep`: leave the mod alone. The user wants it independently
 *    of the collection. Default when no entry is supplied.
 *  - `uninstall`: remove the mod (file system + Vortex state) via
 *    `util.removeMods`. Destructive; only the action handler/UI
 *    should set this after explicit user confirmation.
 */
export type OrphanChoice =
  | { kind: "keep" }
  | { kind: "uninstall" };

// ===========================================================================
// Driver context (input bundle)
// ===========================================================================

/**
 * The full input the driver consumes. The action handler builds one
 * of these and hands it in.
 */
export type DriverContext = {
  /**
   * Called the moment the run knows which profile it is filling.
   *
   * `runInstall` installs this so that a THROW out of the driver can still
   * record a resumable attempt: the profile id is a local of the driver body,
   * and an exception carries no result to put it in. Set by the harness, not
   * by callers.
   */
  onProfileResolved?: (profileId: string) => void;
  /** Vortex API. The driver dispatches actions and emits events through it. */
  api: import("@nexusmods/vortex-api").types.IExtensionApi;
  /** The fully-resolved plan from `resolveInstallPlan`. */
  plan: InstallPlan;
  /** Result of `readEhcoll` — needed for bundled archive metadata. */
  ehcoll: ReadEhcollResult;
  /**
   * Absolute path of the `.ehcoll` ZIP file on disk. The driver
   * reads bundled archives out of it on demand. Distinct from
   * {@link ehcoll} because `ReadEhcollResult` doesn't carry it.
   */
  ehcollZipPath: string;
  /** Absolute path of `util.getVortexPath("appData")`. Used for the receipt. */
  appDataPath: string;
  /** User's pre-resolved choices. Slice 6a: always empty. */
  decisions: UserConfirmedDecisions;
  /**
   * Optional progress callback. Called many times per phase. The
   * action handler usually maps it onto a Vortex notification.
   */
  onProgress?: (progress: DriverProgress) => void;
  /**
   * Optional cooperative cancellation. The driver checks this at
   * phase boundaries — it does NOT interrupt in-flight Vortex
   * operations (downloads can't be safely killed mid-stream).
   */
  abortSignal?: AbortSignal;
};

// ===========================================================================
// Phases & progress
// ===========================================================================

/**
 * Coarse-grained driver state. Surfaced for UI/logging only; the
 * action handler does NOT branch on this for control flow.
 *
 * Fresh-profile happy-path progresses linearly:
 *
 *   preflight → creating-profile → switching-profile → installing-mods
 *   → applying-mod-rules → applying-userlist → deploying
 *   → applying-load-order → writing-receipt → complete
 *
 * Current-profile mode skips `creating-profile` and `switching-profile`
 * entirely (we install into the active profile) and inserts a
 * `removing-mods` phase between `preflight` and `installing-mods`:
 *
 *   preflight → removing-mods → installing-mods → applying-mod-rules
 *   → applying-userlist → deploying → applying-load-order
 *   → writing-receipt → complete
 *
 * `removing-mods` runs every replace-existing and orphan-uninstall
 * choice the user has confirmed. It is skipped when there's nothing
 * to remove.
 *
 * Failures emit `failed` with the phase that broke. `aborted` is
 * emitted on cooperative cancel via `abortSignal`.
 *
 * Note: there is no longer a `writing-plugins-txt` phase. The
 * rules-only strategy lets Vortex's gamebryo-plugin-management +
 * LOOT auto-sort produce `plugins.txt` during deploy from the mod
 * rules + userlist we apply above. See the comment at the top of
 * `runInstall.ts` for the full rationale.
 */
export type DriverPhase =
  | "preflight"
  | "creating-profile"
  | "switching-profile"
  | "removing-mods"
  | "installing-mods"
  | "verifying-mods"
  | "applying-mod-rules"
  | "applying-load-order"
  | "applying-userlist"
  | "deploying"
  | "writing-receipt"
  | "complete"
  | "aborted"
  | "failed";

/**
 * One progress beat. The driver emits these frequently inside the
 * `installing-mods` phase (one per mod) and sparingly elsewhere.
 *
 * `currentStep` / `totalSteps` are scoped to the **current phase**;
 * they reset every phase transition. This is a deliberate choice —
 * a global "0 of 47" counter is useless for the user (most steps
 * complete in milliseconds, while individual mod installs take
 * minutes).
 */
export type DriverProgress = {
  phase: DriverPhase;
  /** 1-indexed within the current phase; 0 ⇒ "starting." */
  currentStep: number;
  /** Total steps in the current phase, when known. */
  totalSteps: number;
  /** Plain-language description of the current step. UI-only. */
  message: string;
};

// ===========================================================================
// Result
// ===========================================================================

/**
 * The terminal value the driver returns. Always one of three kinds.
 * Errors and aborts carry enough context for the action handler to
 * surface a useful notification.
 */
export type InstallResult = InstallSuccess | InstallAborted | InstallFailed;

export type InstallSuccess = {
  kind: "success";
  /** Vortex profile id the install landed in. */
  profileId: string;
  /** Profile display name. UI-only. */
  profileName: string;
  /** Mode the driver actually ran in (mirrors plan.installTarget.kind). */
  installTargetMode: "fresh-profile" | "current-profile";
  /**
   * Wall-clock time the run took, including any time it spent waiting on the
   * user to answer an installer dialog.
   *
   * Wall-clock rather than working time on purpose: "this took four hours"
   * is the honest answer even when three of them were a FOMOD prompt nobody
   * was there to click, and it is the number a curator needs when someone
   * reports that installing their collection takes all day.
   */
  durationMs: number;
  /**
   * Absolute path of the receipt file that was written.
   * `<appData>/Vortex/event-horizon/installs/<package.id>.json`.
   */
  receiptPath: string;
  /** Vortex mod ids of every successfully-installed mod. */
  installedModIds: string[];
  /** Per-mod report — useful for the post-install summary. */
  installedMods: InstalledModReportEntry[];
  /**
   * What the collection changed in the user's game settings, in words.
   *
   * Empty when it changed nothing, or when this release had already stated
   * its settings on an earlier run. Present so the post-install screen can
   * TELL them — a configuration edited silently is not acceptable even when
   * it is correct.
   */
  gameIniNotice?: string[];
  /**
   * Mods whose installed KIND differs from the curator's, in words.
   *
   * Empty when every type matched. Present because the failure is silent:
   * the files are all there and all correct, in a folder the game does not
   * read — and for a script extender that means nothing depending on it
   * works, with no error anywhere.
   */
  modTypeNotice?: string[];
  /**
   * INI tweaks the curator had enabled that could not be enabled here.
   *
   * Only the FAILURES are reported. A tweak that landed is indistinguishable
   * from a collection that shipped none, and neither is worth a sentence — but
   * a tweak that did not land changes how the game runs while changing nothing
   * visible, so it is the one thing here a user can neither see nor guess.
   */
  iniTweakNotice?: string[];
  /**
   * Ready-to-send reports for mods that could not be reproduced.
   *
   * One per mod that failed against the curator's staging, failed against its
   * ARCHIVE, and survived a reinstall. Everything softer is settled earlier —
   * a mod whose curator-side files were merely post-processed never reaches
   * this list — so an entry here is a genuine anomaly rather than one of the
   * ~11% of false alarms that used to look identical.
   *
   * Present as TEXT rather than structured data on purpose: its destination is
   * a Discord message or a Nexus comment, and the user should be able to send
   * it without composing anything.
   */
  curatorReports?: string[];
  /**
   * Hand-supplied archives that are not the ones the collection was built from.
   *
   * Distinct from `curatorReports`: nothing failed. The user browsed to a
   * website, picked a file, and it installed exactly as they asked — but its
   * bytes are not the curator's. A browse-mode dependency resolving to a
   * different build is the most invisible way an install stops reproducing
   * what the curator had, so it is said out loud rather than left for the user
   * to discover in-game.
   */
  externalArchiveNotice?: string[];
  /**
   * Mods whose archive on THIS machine is damaged — no reader can open it, and
   * its bytes are not the ones the collection was built from.
   *
   * Deliberately NOT in `curatorReports`. A hash mismatch alone cannot tell a
   * re-upload from a half-finished download, and sending the second to a
   * curator asks them to investigate a mod they never changed. Only this case
   * is fixed by downloading again, and it is fixed by the user, so it is the
   * one branch of the ladder that ends with an action they can take rather
   * than a message they should send.
   */
  damagedArchiveNotice?: string[];
  /**
   * What the "ship my files" pass did, and what it declined to do.
   *
   * Mirroring is the only phase that can DELETE a file from the user's disk,
   * and its outcome used to reach `ehLog` and stop — so a mod left half
   * reconciled, or skipped because it was the user's own copy, told the person
   * in front of the screen nothing at all. Every other correction phase has a
   * notice; this one is the one that most needs it.
   */
  mirrorNotice?: string[];
  /**
   * What clearing the user's own conflict and LOOT rules removed.
   *
   * The collection's rules replace the user's rather than merging with them:
   * a merged rule set exists on nobody's machine but theirs and changes what
   * the game loads without failing anything. Since Vortex stores neither mod
   * rules nor the LOOT userlist per-profile, this also removes rules for mods
   * outside the collection and for the user's other profiles — so it is said
   * out loud, with the path to the backup taken beforehand.
   */
  rulesPurgeNotice?: string[];
  /**
   * Present only when applying the curator's plugin order did not fully work.
   *
   * The install pins the curator's order, asks LOOT to sort the user's own
   * plugins into it, and has Vortex flush the result to plugins.txt. Each step
   * can fail independently — a rule cycle stops the sort, an older Vortex may
   * not know the events — and each failure leaves the load order in a
   * different, describable state. Absent on success: "your load order is
   * correct" is the expected outcome and would only compete for attention with
   * the notices that need reading.
   */
  pluginOrderNotApplied?: string[];
  /**
   * ESL / "light" flags restored, or a plugin count that will not load.
   *
   * Regular plugins are addressed with one byte, so 254 can load; light ones
   * share the `FE` index for free. A collection of this size fits only because
   * most of its plugins are light, so a handful of lost flags is the
   * difference between a working profile and a game that will not start.
   *
   * Absent when every flag already matched, which is the common case — the mod
   * author usually ships the plugin light. Present when flags had to be
   * rewritten, when a write failed, or when the profile is over the limit.
   */
  pluginFlagNotice?: string[];
  /**
   * Mods that changed on disk since a PREVIOUS install of this collection put
   * them there, and that this version did not update.
   *
   * Compared against what the last install left on THIS machine, never
   * against the curator's staging — theirs diverges from its own archive in
   * ways nobody notices, so it cannot be an etalon. A finding here means
   * "this changed since we installed it", which is a fact; it does not mean
   * "this is wrong", which is why the user is offered both directions rather
   * than having one chosen for them.
   */
  stagingDriftNotice?: string[];
  /**
   * How the user's resulting plugin order differs from the curator's.
   *
   * Applying the curator's LOOT rules is not the same as reproducing their
   * order: many orders satisfy the same rules, and which one LOOT picks
   * depends on the user's masterlist version and their own plugins. For a
   * Bethesda game that difference decides which mod's records win, so an
   * install can be file-perfect and still play differently.
   *
   * Present only when something actually differs.
   */
  pluginOrderNotice?: string[];
  /**
   * Mods the driver couldn't install for non-fatal reasons (user
   * chose `keep-existing`, `skip`, or the decision required input
   * the action handler did not supply).
   */
  skippedMods: SkippedModReportEntry[];
  /**
   * Mods the driver removed during the `removing-mods` phase
   * (replace-existing diverged + orphan-uninstall choices).
   * Slice 6a: always empty (no removals in fresh-profile mode).
   */
  removedMods: RemovedModReportEntry[];
  /**
   * Mods the driver carried forward from the previous release into
   * the new receipt without re-installing them. Two sources, both
   * current-profile only:
   *
   *  - `*-diverged + keep-existing`: user chose to stick with their
   *    own version. The driver records the existing mod here, enables
   *    it in the active profile so the collection still gets the mod,
   *    and includes it in the new receipt with its original
   *    `installedFromVersion` lineage tag preserved.
   *  - `orphan + keep`: user chose to keep the orphaned mod from the
   *    previous release. The driver does NOT enable it (it was
   *    already in the user's setup) but DOES include it in the new
   *    receipt so future releases can still see its lineage.
   *
   * Without this, kept mods would silently lose their lineage tag on
   * the next release and become invisible to orphan detection. See
   * docs/business/INSTALL_DRIVER.md § "Carry-forward semantics".
   */
  carriedMods: CarriedModReportEntry[];
  /**
   * Slice 6c summary — what `applyModRules` + `applyLoadOrder` did.
   * Mirrors the receipt's `rulesApplication` field exactly so the UI
   * can render counts, breakdowns, and skipped entries without
   * re-reading the receipt JSON from disk. Always present (zeroed
   * when the manifest had no rules / load order).
   */
  rulesApplication: RulesApplicationReceipt;
  /**
   * Slice 6d summary — what `applyUserlist` did. Mirrors the
   * receipt's `userlistApplication` field. Surfaced in the post-
   * install Done card so verification-on-dispatch failures
   * (Vortex's userlist reducer ignored a dispatch, action contract
   * changed, etc.) are visible to the user — without it those
   * failures would only live on disk in the receipt JSON.
   */
  userlistApplication: UserlistApplicationReceipt;
  /**
   * Slice 7 — Per-mod file integrity verification summary. Mirrors
   * the receipt's `verifications` field (always present here even
   * when manifest had no staging snapshots: each mod gets at
   * minimum a `kind: "skip"` entry explaining why). Drives the
   * "Integrity check" tile group in the Done card.
   *
   * Empty list ⇒ no mods were installed (e.g. fresh-profile install
   * where every mod was already-installed and re-used). The Done
   * card hides the integrity tile group in that case.
   */
  verifications: ModVerificationReceipt[];
};

export type InstallAborted = {
  kind: "aborted";
  /** Phase the abort happened in. */
  phase: DriverPhase;
  /** Profile the driver had created at the time of abort, if any. */
  partialProfileId?: string;
  reason: string;
  /**
   * Mods that DID install before the abort. Same contract as
   * {@link InstallFailed.installedSoFar}, and required for the same reason:
   * the driver does not roll back, so stopping at mod 600 of 954 leaves 600
   * real mods in a real profile.
   *
   * A user-initiated stop is the case that makes this load-bearing. A crash is
   * rare and unplanned; cancelling is a thing people do deliberately, expect to
   * understand, and expect to recover from — and "it stopped" without "and 600
   * mods are installed, here" is not something you can act on.
   *
   * No receipt is written on abort, which is deliberate: a receipt claims the
   * collection IS installed at that version, and a partial run has not earned
   * that claim. The mods are still recoverable without one, because re-running
   * matches them by Nexus ids and archive hash and reports them as already
   * installed — so a cancelled install resumes rather than restarts.
   */
  installedSoFar: string[];
};

export type InstallFailed = {
  kind: "failed";
  /** Phase the failure happened in. */
  phase: DriverPhase;
  /** Profile the driver had created at the time of failure, if any. */
  partialProfileId?: string;
  /** One-line error summary. */
  error: string;
  /**
   * Mods that DID install successfully before the failure. The user
   * can switch to `partialProfileId` and see them; they are not
   * automatically removed.
   */
  installedSoFar: string[];
  /**
   * Every mod that failed, not just the one that stopped the run.
   *
   * The driver used to return on the FIRST per-mod failure. On a real 967-mod
   * collection a single Nexus file that had been pulled killed the run at mod
   * 274, so 693 mods that would have installed fine never got the chance — and
   * re-running hit the same wall at the same index. Isolated failures are now
   * collected and the run continues, so one dead link costs one mod.
   */
  failedMods?: FailedModReportEntry[];
  /**
   * What the run DELETED, and where the backup went.
   *
   * The rules purge removes every mod rule for the game and clears the LOOT
   * userlist, and this string is the only thing that names the timestamped
   * backup. It was carried on the success result and dropped on this one — so
   * a run that purged the user's rules and then reported a partial failure
   * told them nothing, and the remedy is useless if unread.
   */
  rulesPurgeNotice?: string[];
  /**
   * Per-mod curator reports gathered during verification. Computed on this
   * path too and previously discarded with everything else.
   */
  curatorReports?: string[];
  /** Archives that could not be read. Same reason as above. */
  damagedArchiveNotice?: string[];
};

/** One mod that could not be installed, and why. */
export type FailedModReportEntry = {
  /** compareKey from the manifest entry. */
  compareKey: string;
  name: string;
  /** The decision the resolver had made for it. */
  decision: string;
  /** One-line reason, already formatted for a human. */
  error: string;
};

export type InstalledModReportEntry = {
  /** compareKey from the manifest entry. */
  compareKey: string;
  /** Display name. */
  name: string;
  /** Vortex mod id assigned at install time. */
  vortexModId: string;
  /** Source kind from the manifest. */
  source: "nexus" | "external";
  /**
   * The specific decision arm that produced this install. Useful for
   * the post-install summary ("3 from local cache, 12 from Nexus,
   * 2 from bundled archives").
   */
  fromDecision: string;
};

export type SkippedModReportEntry = {
  compareKey: string;
  name: string;
  /** Why the driver skipped this mod. */
  reason: string;
};

/**
 * A mod the driver removed (uninstalled) during a current-profile
 * install. Two sources:
 *
 *  - `replace-existing` choice for a `*-diverged` decision: the
 *    user's existing mod was uninstalled before the manifest's
 *    version was installed in its place.
 *  - `uninstall` choice for an `OrphanedModDecision`: the user
 *    explicitly asked to remove an orphan from a previous release
 *    of the same collection.
 *
 * The driver records these in {@link InstallSuccess.removedMods}
 * for the post-install summary and audit trail.
 */
export type RemovedModReportEntry = {
  /** Vortex mod id that was removed. */
  vortexModId: string;
  /** Display name at the time of removal. UI-only. */
  name: string;
  /** Why the driver removed it. */
  reason: "replace-existing" | "orphan-uninstall";
  /**
   * For `replace-existing`: the manifest compareKey of the mod that
   * replaced it. For `orphan-uninstall`: the previous-release
   * compareKey from the orphan's `originalCompareKey`. Surfaced for
   * UI provenance.
   */
  compareKey?: string;
};

/**
 * A mod the driver carried forward from the previous release without
 * re-installing it. Recorded in the new receipt so cross-release
 * orphan detection keeps working.
 *
 * Two sources, both current-profile only:
 *  - `*-diverged + keep-existing`: user kept their version.
 *    `enabledInProfile` is true (driver enables it).
 *  - `orphan + keep`: user kept the previous-release orphan.
 *    `enabledInProfile` is false (we do not touch its enabled state).
 */
export type CarriedModReportEntry = {
  /** Vortex mod id that was carried (the existing mod's id). */
  vortexModId: string;
  /** Display name. */
  name: string;
  /** Source kind from the manifest (or previous receipt for orphans). */
  source: "nexus" | "external";
  /** Why the driver carried it. */
  reason: "diverged-keep-existing" | "orphan-keep";
  /**
   * compareKey from the manifest entry (for `diverged-keep-existing`)
   * or from the previous-release receipt (for `orphan-keep`).
   */
  compareKey: string;
  /**
   * Original collection version this mod was installed by, when the
   * driver could resolve it from `previousInstall.packageVersion` or
   * `OrphanedModDecision.installedFromVersion`. UI-only.
   */
  installedFromVersion?: string;
  /** Whether the driver enabled this mod in the active profile. */
  enabledInProfile: boolean;
};
