/**
 * Install driver — Phase 3 slices 6a + 6b + 6c.
 *
 * Consumes a resolved {@link InstallPlan} and the user's confirmed
 * decisions, then mutates the user's machine to match the curator's
 * intent: optionally creates a fresh Vortex profile, removes
 * replaced/orphaned mods, installs each new mod, applies mod rules
 * + Vortex's per-game LoadOrder, deploys, and finally writes the
 * install ledger receipt.
 *
 * **Slice 6c scope** (additive over 6a/6b):
 *  - `applying-mod-rules` phase — dispatch every manifest
 *    `EhcollRule` via `actions.addModRule`, with a "collection-wins"
 *    conflict pass that overwrites pre-existing user rules pointing
 *    at the same target. Rules ignored by the curator are NOT
 *    applied. Skipped/applied/overwritten counts go into the receipt.
 *  - `applying-load-order` phase — dispatch the curator's per-game
 *    LoadOrder (Vortex's generic LoadOrder API, distinct from
 *    plugins.txt) via `actions.setLoadOrder`. Empty manifests no-op.
 *  - **plugins.txt is no longer written manually.** Locked design
 *    choice: rules-only strategy. Vortex + LOOT auto-sort during
 *    deploy compute the user's plugins.txt from our rules + the
 *    user's local masterlist + any layered mods. The manifest's
 *    plugin order is captured into the receipt's `baselinePluginOrder`
 *    for drift detection in the post-install summary.
 *
 * **Slice 6b scope** (preserved):
 *  - `installTarget.kind === "fresh-profile"` — fresh profile create
 *    + switch + install. (Slice 6a behavior; unchanged.)
 *  - `installTarget.kind === "current-profile"` — install in-place
 *    into the user's active profile.
 *  - `*-version-diverged`, `*-bytes-diverged`, `external-prompt-user`
 *    decisions are accepted IF the action handler supplied a
 *    matching `ConflictChoice` in `decisions.conflictChoices`. Without
 *    a choice the driver refuses to run.
 *  - `OrphanedModDecision`s are accepted in current-profile mode;
 *    each is acted on per the matching `OrphanChoice` in
 *    `decisions.orphanChoices` (default `keep`).
 *  - `nexus-unreachable` and `external-missing` remain hard-blocking;
 *    they have no user-resolution path.
 *
 * Spec: docs/business/INSTALL_DRIVER.md
 *
 * ─── EXECUTION MODEL ───────────────────────────────────────────────────
 * The driver progresses through a fixed sequence of phases. Some
 * phases are skipped depending on `installTarget.kind` and the
 * manifest contents:
 *
 *   1. preflight          — sanity-check plan + decisions.
 *   2. creating-profile   — fresh-profile only; dispatch new profile.
 *   3. switching-profile  — fresh-profile only; await `profile-did-change`.
 *   4. removing-mods      — current-profile only; uninstall replaced
 *                           and orphan-uninstall mods.
 *   5. installing-mods    — sequentially per mod (downloads/installs).
 *   5b. applying-mod-rules — dispatch curator's mod rules (slice 6c).
 *                           Skipped when manifest.rules is empty.
 *   5c. applying-userlist  — dispatch curator's LOOT userlist plugin
 *                           rules + group assignments (slice 6d).
 *                           Skipped when manifest.userlist is empty.
 *   6. plugins.txt is intentionally NOT written. The rules-only
 *      strategy lets Vortex + LOOT auto-sort produce it during
 *      deploy from the rules + userlist we applied above.
 *   7. deploying          — emit `deploy-mods`, await activation.
 *   7b. applying-load-order — dispatch curator's Vortex LoadOrder
 *                            (slice 6c). Skipped when manifest's
 *                            loadOrder is empty.
 *   8. writing-receipt    — persist the install ledger entry.
 *   9. complete           — emit final progress beat.
 *
 * Failures at any phase return {@link InstallResult.kind === "failed"};
 * the partial state is preserved (NOT rolled back) so the user can
 * inspect it manually. Idempotent on retry.
 *
 * Slice-6c phases are **non-fatal**: if rule application or
 * LoadOrder application throws unexpectedly, we log + continue to
 * the receipt. The user gets a successful install with a partial
 * rule application surfaced via `receipt.rulesApplication.skippedRules`.
 *
 * Concurrency: mod installs run **sequentially**. Vortex's install
 * pipeline serializes internally (FOMOD UI is modal); parallel calls
 * conflict over the global download/install lock. Sequential is also
 * the simplest mental model for the user-visible progress.
 * ──────────────────────────────────────────────────────────────────────
 */

import { isAbort } from "../../utils/abortError";
import { planInstallEpochs } from "../resolver/installEpochs";
import { actions, types, util } from "@nexusmods/vortex-api";
import { stagingRootForModId } from "../stagingPath";

import {
  InstallLedgerError,
  writeReceipt,
} from "../installLedger";
import {
  type GameIniApplicationReceipt,
  type InstallReceipt,
  type InstallReceiptMod,
  type ModVerificationFailExample,
  type ModVerificationReceipt,
  type ReceiptPluginEntry,
  type RulesApplicationReceipt,
  type UserlistApplicationReceipt,
  INSTALL_LEDGER_SCHEMA_VERSION,
} from "../../types/installLedger";
import type {
  CarriedModReportEntry,
  ConflictChoice,
  DriverContext,
  DriverPhase,
  InstallAborted,
  InstallResult,
  InstalledModReportEntry,
  FailedModReportEntry,
  OrphanChoice,
  RemovedModReportEntry,
  SkippedModReportEntry,
  UserConfirmedDecisions,
} from "../../types/installDriver";
import type {
  EhcollMod,
  EhcollManifest,
  ExternalEhcollMod,
  NexusEhcollMod,
} from "../../types/ehcoll";
import type {
  ModDecision,
  ModResolution,
  OrphanedModDecision,
} from "../../types/installPlan";
import type { SupportedGameId } from "../../types/ehcoll";
import { countMods, deployBudgetMs } from "./timeBudgets";
import {
  clearInstallAttempt,
  writeInstallAttempt,
} from "./attemptRecord";
import { clearInstallMarker, writeInstallMarker } from "./installMarker";
import { ehLog } from "../logging/ehLog";
import { judgeReinstall } from "./judgeReinstall";
import { applyMirrorPlan, describeMirrorOutcome } from "./applyMirrors";
import { mirrorProvesTarget, planMirror } from "./mirrorStaging";
import {
  hashStagingFiles,
  walkStagingFolder,
} from "../manifest/stagingFileWalker";
import { buildCuratorReport } from "./curatorReport";
import * as path from "path";
import { selectors } from "@nexusmods/vortex-api";
import { readReceipt } from "../installLedger";
import { computeStagingSetHash } from "../manifest/stagingSetHash";
import type { EhcollStagingFile } from "../../types/ehcoll";
import {
  checkArchiveIdentity,
  describeArchiveIdentity,
} from "./checkArchiveIdentity";
import { getModArchivePath } from "../archiveHashing";
import type { ArchiveHashCache } from "../archiveHashCache";
import {
  captureUserRuleState,
  describePurge,
  purgeUserRuleState,
  type UserRuleSnapshot,
} from "./purgeUserRules";
import {
  applyPluginOrder,
  describePluginOrderApplication,
  type PluginOrderApplication,
} from "./applyPluginOrder";
import {
  applyPluginLightFlags,
  describePluginFlagRepair,
  type PluginFlagRepair,
} from "./applyPluginLightFlags";
import { detectCaseSensitivity } from "../paths";
import { describeSkippedFinishing } from "./finishingNotice";
import {
  orderDiffers,
  repinCuratorOrder,
} from "./repinPluginOrder";
import { compareSelections } from "../curator/fomodSelectionDiff";
import { liveFomodSelections } from "../getModsListForProfile";
import type { PluginOrderEntry } from "./checkPluginOrder";
import { InstallStreaks } from "./installStreaks";
import { getGameDirectory } from "../manifest/externalDependencies";
import {
  applyModRules,
  type ApplyModRulesResult,
  type ExistingRule,
} from "./applyModRules";
import {
  applyIniTweaks,
  describeIniTweaks,
  emptyIniTweakApplication,
} from "./applyIniTweaks";
import {
  comparePluginOrder,
  describePluginOrderDrift,
  emptyPluginOrderDrift,
  readUserPluginsTxt,
} from "./checkPluginOrder";
import {
  applyLoadOrder,
  type ApplyLoadOrderResult,
} from "./applyLoadOrder";
import { discoveredStore } from "../comparePlugins";
import {
  applyUserlist,
  type ApplyUserlistResult,
} from "./applyUserlist";
import {
  createFreshProfile,
  disableModInProfile,
  enableModInProfile,
  switchToProfile,
} from "./profile";
import {
  downloadNexusArchiveOnly,
  extractBundledFromEhcoll,
  installFromBundledArchive,
  installFromExistingDownload,
  installFromLocalArchive,
  installNexusViaApi,
  safeRmTempDir,
  uninstallMod,
} from "./modInstall";
import { looksLikeWine } from "./checkSevenZipHealth";
import {
  describeMissingDeploymentMethod,
  isDeploymentMethodMissing,
} from "./deploymentMethod";
import {
  classifyModFailure,
  describeSystemicFailure,
} from "./downloadFailureShape";
import { dismissNoisyNotifications } from "./quietNotifications";
import { replayArgs } from "./installerChoices";
import {
  applyGameIni,
  describeGameIniApplication,
  shouldApplyGameIni,
} from "./applyGameIni";
import {
  describeModTypeMismatches,
  findModTypeMismatches,
} from "./checkModTypes";
import {
  applyModTypeChanges,
  describeModTypeChanges,
  planModTypeChanges,
  readCurrentModTypes,
} from "./applyModTypes";
import {
  summarizeVerifyFail,
  verifyModInstall,
  type VerifyResult,
} from "./verifyModInstall";
import {
  BundledPrefetchPool,
  type PrefetchRequest,
} from "./bundledPrefetch";
import { logInstallCallShapes } from "./probeInstallerApi";
import { installAlongside } from "./installAlongside";
import {
  appendJournalEntry,
  clearJournal,
  logJournalSummary,
  ownedModIds,
  readJournal,
} from "./installJournal";
import { repairDecisionFor } from "../resolver/resolveInstallPlan";
// NOTE: there used to be a `pluginsTxt.ts` writer module here. It
// was deleted along with the `writing-plugins-txt` driver phase
// when the rules-only strategy locked. Vortex's
// gamebryo-plugin-management + LOOT auto-sort produce plugins.txt
// during deploy from the mod rules + userlist we apply above.

// Mod counting lives in timeBudgets alongside the budgets that consume it —
// a copy here and another in profile.ts would drift.

/**
 * Mods that changed on disk since the previous install of this collection.
 *
 * Never throws and never blocks: it is an observation about the user's own
 * files, offered at the end of a run that has already succeeded. Failing an
 * install because a diagnostic could not read a folder would be an absurd
 * trade.
 */
async function detectDrift(args: {
  ctx: DriverContext;
  gameId: string;
  reportProgress: (
    phase: DriverPhase,
    done: number,
    total: number,
    detail: string,
  ) => void;
}): Promise<string[] | undefined> {
  const { ctx, gameId } = args;
  try {
    const previous = await readReceipt(
      ctx.appDataPath,
      ctx.plan.manifest.package.id,
    );
    if (previous === undefined) return undefined; // first install: nothing to compare

    const { selectDriftCandidates, findDriftedMods, describeStagingDrift } =
      await import("./detectStagingDrift");

    const candidates = selectDriftCandidates({
      receiptMods: previous.mods,
      manifestMods: ctx.plan.manifest.mods,
    });
    if (candidates.length === 0) return undefined;

    const state = ctx.api.getState();
    // No local installRoot: stagingRootForModId resolves it and answers
    // undefined when it cannot, so a second gate here would only be another
    // place to get the falsy check wrong.

    // The manifest's list for each mod, which is what the recorded hash was
    // built from. Candidates were selected for having an UNCHANGED compareKey,
    // so this version's list for them is the same list the previous install
    // recorded — which is what makes both sides describe one file set.
    const stagingFilesByKey = new Map(
      ctx.plan.manifest.mods.map((m) => [m.compareKey, m.state.stagingFiles]),
    );

    const found = await findDriftedMods({
      candidates,
      manifestFilesFor: (compareKey) => stagingFilesByKey.get(compareKey),
      cacheDir: ctx.appDataPath,
      ...(ctx.abortSignal !== undefined ? { signal: ctx.abortSignal } : {}),
      stagingRootFor: (vortexModId) => {
        return stagingRootForModId(state, gameId, vortexModId);
      },
      onProgress: (done, total, name) => {
        args.reportProgress(
          "verifying-mods",
          done,
          total,
          `Checking "${name}" for changes since the last install...`,
        );
      },
    });

    ehLog("info", "install.drift", {
      candidates: candidates.length,
      drifted: found.length,
      names: found.slice(0, 25).map((f) => f.name),
    });
    return describeStagingDrift(found);
  } catch (err) {
    ehLog("warn", "install.drift.failed", {
      why: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * The `stagingSetHash` field for one receipt entry, or nothing.
 *
 * Split out because the condition matters more than the computation: only a
 * mod whose verification PASSED gets a hash. Verification passing is exactly
 * the proof that the curator's recorded file list describes this disk, which
 * is what makes deriving the fingerprint from the manifest legitimate rather
 * than circular.
 *
 * Returns an empty object, not `{ stagingSetHash: undefined }` — the receipt
 * parser keeps an absent field absent, and writing an explicit `undefined`
 * would serialise to nothing anyway while reading as though a value had been
 * considered and rejected.
 */
function stagingSetHashFor(
  mod: InstalledModReportEntry,
  verifiedOkKeys: ReadonlySet<string>,
  expectedFilesByCompareKey: ReadonlyMap<string, EhcollStagingFile[]>,
): { stagingSetHash?: string } {
  if (!verifiedOkKeys.has(mod.compareKey)) return {};
  const files = expectedFilesByCompareKey.get(mod.compareKey);
  if (files === undefined || files.length === 0) return {};
  // Returns undefined unless every file carries a sha256 — i.e. unless the
  // collection was built "thorough". A "fast" package simply gets no drift
  // reference, which is the correct outcome: there is nothing to build one
  // from.
  const hash = computeStagingSetHash(files);
  return hash === undefined ? {} : { stagingSetHash: hash };
}

/**
 * Host description for a report that gets pasted in public.
 *
 * `process.platform` says "win32" under Proton, which is the single most
 * misleading line a curator can be handed: it sends them to reason about a
 * Windows install that is nothing of the sort.
 */
function describeHostForReport(): string {
  const base = typeof process !== "undefined" ? process.platform : "unknown";
  try {
    return looksLikeWine() ? `${base} (Wine/Proton)` : base;
  } catch {
    return base;
  }
}

/**
 * The archive a mod was installed from, if Vortex still has it.
 *
 * Best-effort and defensive: this only decides whether a second opinion is
 * available. `undefined` means the judgement degrades to "undecidable", which
 * reinstalls — the behaviour that existed before the check.
 */
/**
 * Save the user's rules before we delete them, and return where.
 *
 * Rejects rather than returning undefined on failure, because the caller's
 * whole decision hinges on it: no backup means the purge does not run. A
 * silent "" here would delete someone's rules with nothing to restore from.
 *
 * Timestamped rather than overwritten — a second install must not destroy the
 * backup taken by the first, which is the one holding their original rules.
 */
async function writeRuleBackup(
  appDataPath: string,
  snapshot: UserRuleSnapshot,
): Promise<string> {
  const fsp = await import("fs/promises");
  const nodePath = await import("path");
  const dir = nodePath.join(appDataPath, "event-horizon", "rule-backups");
  await fsp.mkdir(dir, { recursive: true });
  const stamp = snapshot.capturedAt.replace(/[:.]/g, "-");
  const file = nodePath.join(dir, `rules-${snapshot.gameId}-${stamp}.json`);
  // Write-then-rename: a half-written backup that looks complete is worse than
  // none, because the purge would proceed on the strength of it.
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(snapshot, null, 2), "utf8");
  await fsp.rename(tmp, file);
  return file;
}

/**
 * The game's Data folder, where the plugins the game actually loads live.
 *
 * Deployed rather than staged on purpose: two mods can stage a plugin of the
 * same name and only one wins deployment, so a staged copy may be a file that
 * never runs.
 */
function gameDataDirFor(
  api: types.IExtensionApi,
  gameId: string,
): string | undefined {
  try {
    const dir = getGameDirectory(api.getState() as never, gameId);
    return dir === undefined ? undefined : path.join(dir, "Data");
  } catch {
    return undefined;
  }
}

/**
 * Every Vortex profile for this game, as `id — name`.
 *
 * Logged beside a refused resume so "the profile was deleted" can be checked
 * rather than believed. Capped, because a profile list is a user's own data
 * and a log is something they send to a stranger: enough to answer the
 * question, not a copy of their setup.
 */
function listProfilesForGame(
  api: types.IExtensionApi,
  gameId: string,
): string[] {
  try {
    const profiles = (
      api.getState() as unknown as {
        persistent?: {
          profiles?: Record<string, { gameId?: string; name?: string }>;
        };
      }
    ).persistent?.profiles;
    if (profiles === undefined) return ["<no profiles in state>"];
    return Object.entries(profiles)
      .filter(([, p]) => p?.gameId === gameId)
      .slice(0, 20)
      .map(([id, p]) => `${id} — ${p?.name ?? "<unnamed>"}`);
  } catch {
    // Never let a diagnostic break an install.
    return ["<could not read profiles>"];
  }
}

function archivePathForMod(
  api: types.IExtensionApi,
  gameId: string,
  entry: InstalledModReportEntry,
): string | undefined {
  try {
    const state = api.getState();
    const mod = (
      state as unknown as {
        persistent?: { mods?: Record<string, Record<string, unknown>> };
      }
    )?.persistent?.mods?.[gameId]?.[entry.vortexModId] as
      | { archiveId?: string }
      | undefined;
    if (mod === undefined) return undefined;
    // (state, archiveId, gameId) — the order every other caller uses. This
    // read `getModArchivePath(state, gameId, mod as never)`, which handed the
    // gameId in as the archive id and the mod OBJECT in as the game, so the
    // download lookup was `downloads["fallout4"]` and the function returned
    // undefined every single time. `as never` is assignable to anything, so it
    // silenced the one check that would have caught it.
    //
    // Nothing failed loudly: judgeReinstall read the missing path as "cannot
    // consult the archive" → undecidable → reinstall, and checkArchiveIdentity
    // read it as "unknown". Both features were dead in production while their
    // unit tests — which pass the path in directly — stayed green.
    return getModArchivePath(state, mod.archiveId, gameId) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * How the plan breaks down by decision kind, for the log header.
 *
 * A resumed install and a first install produce very different shapes — the
 * second run of an interrupted collection is mostly `*-already-installed` —
 * and knowing which one you are reading changes what "stopped at mod 38"
 * means.
 */
function countByDecision(
  resolutions: readonly ModResolution[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of resolutions) {
    const k = r.decision.kind;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/**
 * Number of attempts to write the install receipt. The receipt is the
 * single source of cross-release lineage; a transient AV scan or
 * filesystem stutter that fails the first write but would succeed on
 * a second is worth a quick retry. Beyond that we surface the error.
 */
const RECEIPT_WRITE_ATTEMPTS = 2;
const RECEIPT_WRITE_RETRY_DELAY_MS = 250;

/**
 * Run the install. The driver is the only part of Event Horizon that
 * mutates Vortex state or the filesystem; everything else is pure.
 */
/**
 * Describe an abort, including what it left installed.
 *
 * Every abort has to carry `installedSoFar`, because the driver does not roll
 * back: stopping at mod 600 of 954 leaves 600 real mods in a real profile, and
 * a result that says only "stopped" is not something a user can act on. Making
 * the field required found FIVE abort sites beyond the obvious one, which is
 * why they all route through here — the next one cannot be written without it.
 *
 * The interrupted mod is never in the list. One call site fires from a catch
 * while a mod is mid-install, so "after a completed unit of work" is not true
 * of all six; what is true is that entries are appended only after an install
 * succeeds, so a mod caught halfway is absent either way.
 *
 * Exported for its tests: inside {@link runInstall} it is a closure over two
 * mutable locals, which is correct there and unreachable from outside.
 */
export function buildAbortedResult(args: {
  phase: DriverPhase;
  reason: string;
  partialProfileId: string | undefined;
  installedMods: readonly { vortexModId: string }[];
}): InstallAborted {
  return {
    kind: "aborted",
    phase: args.phase,
    partialProfileId: args.partialProfileId,
    reason: args.reason,
    installedSoFar: args.installedMods.map((m) => m.vortexModId),
  };
}

/**
 * Run the install, and record how it ended.
 *
 * A thin wrapper around the driver so the outcome is observed in exactly ONE
 * place. The alternatives were both worse: the driver has thirteen return
 * paths, and `runInstall` has four callers — recording at either would be a
 * rule spread across a dozen sites, which this file has already learned costs
 * more than it saves.
 */
export async function runInstall(ctx: DriverContext): Promise<InstallResult> {
  /**
   * ─── A THROW IS AN OUTCOME TOO ──────────────────────────────────────────
   * This used to be three lines with no `catch`, so any exception escaping
   * `runInstallImpl` skipped `recordAttemptOutcome` entirely — and the profile
   * the run had already created went unrecorded.
   *
   * That is not hypothetical: `switchToProfile` rejects with a PLAIN Error
   * when Vortex misses the switch budget (purging a profile that holds ~1,100
   * deployed mods), the driver re-throws anything that is not an AbortError,
   * and Vortex's `setNextProfile` cannot be recalled — so the user is left
   * sitting in the brand-new profile while nothing on disk remembers it. The
   * next run finds no attempt record, logs `whyNotResumed: "no-attempt"`, and
   * forks ANOTHER profile. A tester hit exactly that, twice.
   *
   * `escapedProfileId` is how the profile id gets out: `runInstallImpl` owns
   * it as a local, and on a throw there is no result to carry it.
   */
  const escaped: { profileId?: string; installed: string[] } = {
    installed: [],
  };
  ctx.onProfileResolved = (profileId: string): void => {
    escaped.profileId = profileId;
  };
  ctx.onModInstalled = (vortexModId: string): void => {
    escaped.installed.push(vortexModId);
  };

  let result: InstallResult;
  try {
    result = await runInstallImpl(ctx);
  } catch (err) {
    await recordAttemptOutcome(ctx, {
      kind: "failed",
      // Not a lie about where it stopped: an exception carries no phase, and
      // every named phase would be a guess. The log's `install.phase` line is
      // the record of how far it got.
      phase: "failed",
      ...(escaped.profileId !== undefined
        ? { partialProfileId: escaped.profileId }
        : {}),
      error: formatError(err),
      /**
       * What actually got installed before the throw, not an empty list.
       *
       * `installedMods` is a local of `runInstallImpl` and an exception
       * carries none of it out, so this used to be `[]` unconditionally —
       * and `describeInstallAttempt` leads with that number, because how far
       * a run got is what decides what the user does next. It read "0 of 954
       * mods were installed before it stopped. Those mods are still on your
       * machine" in the same sentence, and pointed at "start again".
       */
      installedSoFar: [...escaped.installed],
    });
    throw err;
  }
  await recordAttemptOutcome(ctx, result);
  return result;
}

/**
 * Persist (or clear) the record of this attempt. Never throws.
 *
 * A success DELETES any previous failure: a panel that keeps warning about a
 * problem the user has just fixed teaches them to ignore it.
 */
async function recordAttemptOutcome(
  ctx: DriverContext,
  result: InstallResult,
): Promise<void> {
  const pkg = ctx.plan.manifest.package;
  try {
    if (result.kind === "success") {
      await clearInstallAttempt(ctx.appDataPath, pkg.id);
      // The receipt is now the record of what is installed. Leaving the
      // journal behind would leave two answers to one question.
      await clearJournal(ctx.appDataPath, pkg.id);
      ehLog("info", "install.attempt.cleared", { packageId: pkg.id });
      return;
    }
    // Both remaining kinds carry `installedSoFar` — the list exists precisely
    // so a stopped run can say what it left behind.
    const installed = Array.isArray(result.installedSoFar)
      ? result.installedSoFar.length
      : 0;

    await writeInstallAttempt(ctx.appDataPath, {
      packageId: pkg.id,
      packageName: pkg.name,
      packageVersion: pkg.version,
      gameId: ctx.plan.manifest.game.id,
      endedAt: new Date().toISOString(),
      outcome: result.kind === "aborted" ? "aborted" : "failed",
      phase: typeof result.phase === "string" ? result.phase : "unknown",
      installedCount: installed,
      totalMods: ctx.plan.manifest.mods.length,
      // Only `failed` carries an error; an abort is the user's own doing and
      // has nothing to report beyond where it stopped.
      ...(result.kind === "failed" && typeof result.error === "string"
        ? { error: result.error }
        : {}),
      ...(typeof result.partialProfileId === "string"
        ? { profileId: result.partialProfileId }
        : {}),
    });

    /**
     * ─── BOTH SIDES OF THE HANDOFF, IN ONE FILE ─────────────────────────
     * The next run reads this record to decide whether to resume. When it
     * refuses, the only way to tell "the profile was deleted" from "we wrote
     * an id that can never match" is to see what was WRITTEN — and that
     * happened in a previous run, whose only trace was a file on the user's
     * disk that nobody thinks to ask for.
     *
     * A tester's fourth forked profile came down to exactly that gap. Both
     * halves are now in the log, so one file answers it.
     */
    ehLog("info", "install.attempt.recorded", {
      packageId: pkg.id,
      packageVersion: pkg.version,
      outcome: result.kind === "aborted" ? "aborted" : "failed",
      phase: typeof result.phase === "string" ? result.phase : "unknown",
      installedCount: installed,
      profileId:
        typeof result.partialProfileId === "string"
          ? result.partialProfileId
          : null,
      // `null` is the finding, not a formatting choice: a record with no
      // profile is one the next run cannot resume from, and that is worth
      // seeing at the moment it is written rather than inferring later.
      willBeResumable: typeof result.partialProfileId === "string",
    });
  } catch {
    // The install has already ended. Losing the record of a failure is a far
    // smaller harm than turning a partial install into a crash.
  }
}

async function runInstallImpl(ctx: DriverContext): Promise<InstallResult> {
  const { plan, api } = ctx;
  const installedMods: InstalledModReportEntry[] = [];
  /**
   * Isolated per-mod failures. Collected rather than returned, so one mod that
   * cannot be fetched does not cost the user every mod after it.
   */
  const failedMods: FailedModReportEntry[] = [];
  /**
   * Mods whose archive the USER supplied by hand and which is NOT the one the
   * collection was built from, keyed by compareKey.
   *
   * Different bytes install different files, so this is the explanation for
   * every difference verification is about to find. Without it the curator
   * report lists them and then asks whether the mod was re-uploaded on Nexus
   * — a question the same run had already answered and logged.
   */
  const suppliedArchiveMismatches = new Map<
    string,
    { expected: string; actual: string }
  >();
  /**
   * Consecutive failures, to tell "this mod is broken" from "everything is
   * broken". A dead extractor or a lost connection fails every mod in turn,
   * and grinding through 900 of them to say so helps nobody.
   */
  /**
   * What this run has learned so far.
   *
   * The first piece of the driver's state to move out of the 200-line
   * preamble. The streak counters live here because they are the only part of
   * it with a RULE rather than storage — a success resets both, and that reset
   * used to be two assignments forty lines from the increments they undo.
   */
  const run = new InstallStreaks();
  const SYSTEMIC_FAILURE_STREAK = 8;
  // A timing-out mod costs ~70 seconds; eight of them burn ten minutes proving
  // what four already proved. Fast failures are cheap, so they keep the
  // higher threshold.
  const SYSTEMIC_TIMEOUT_STREAK = 4;
  const skippedMods: SkippedModReportEntry[] = [];
  const removedMods: RemovedModReportEntry[] = [];
  const carriedMods: CarriedModReportEntry[] = [];
  const tempArchivesToCleanup: string[] = [];
  /**
   * Did THIS run write the install marker?
   *
   * The `finally` that clears it covers thirteen return paths, and several of
   * them return before the marker is ever written. Since the marker is keyed
   * by packageId rather than by run, clearing one this run did not create
   * destroys the record left by a previous, killed run.
   */
  let markerWritten = false;
  let activeProfileId: string | undefined;
  let activeProfileName: string | undefined;
  /**
   * The Event-Horizon-owned profile this run is filling — created by it, or
   * continued from an interrupted one.
   *
   * It was `createdProfileId` and set ONLY when a profile was created, on the
   * reasoning that a resumed profile is not ours to offer to delete. Nothing
   * in this codebase deletes a profile, so that bought nothing — and it cost
   * the resume fix outright: every failure path writes the attempt record
   * from this, so a resumed run that failed recorded NO profile, and the run
   * after it forked a new one. Five restarts became three.
   */
  /**
   * The profile this run is filling — created, resumed, or the one already
   * active. Published to `ctx.onProfileResolved` as soon as it is known so a
   * THROW can still record a resumable attempt; see {@link runInstall}.
   */
  let ehProfileId: string | undefined;
  const setEhProfileId = (id: string): void => {
    ehProfileId = id;
    ctx.onProfileResolved?.(id);
  };

  // Lookup manifest entries by compareKey rather than by index.
  // The resolver currently produces a 1:1 index alignment, but that
  // is an implementation detail the driver should not depend on —
  // compareKey is the canonical identity (it's what receipts use,
  // what conflict-choice maps key on, etc.).
  const manifestByCompareKey = buildManifestIndex(plan.manifest.mods);
  let rulesApplication: RulesApplicationReceipt = emptyRulesApplication();
  let userlistApplication: UserlistApplicationReceipt =
    emptyUserlistApplication();
  const verifications: ModVerificationReceipt[] = [];
  /**
   * Pasteable reports for mods that survived the whole escalation.
   *
   * Kept out of the receipt on purpose: `serializeReceipt` validates THROUGH
   * `parseReceipt`, so a field the parser does not know about is silently
   * destroyed at write — a bug this codebase has already had once. These ride
   * on the result instead, where the UI can offer them.
   */
  const curatorReports: string[] = [];
  /**
   * Notes about hand-supplied archives that are not the curator's.
   *
   * Separate from curatorReports: nothing FAILED here. The user picked a file
   * we could not match to the collection and we installed it as asked — they
   * simply ought to know, because a browse-mode dependency that resolves to a
   * different build is the most invisible way an install stops reproducing
   * what the curator had.
   */
  const externalNotices: string[] = [];
  /**
   * Mods whose archive on this machine is damaged rather than different.
   *
   * Kept out of `curatorReports` on purpose. A hash mismatch alone cannot tell
   * a re-upload from a truncated download; sending the second to the curator
   * asks them to hunt a mod they never touched, and at scale that is how the
   * report channel stops being read. This is the one rung of the ladder the
   * user can act on themselves.
   */
  const damagedArchives: string[] = [];
  /** What clearing the user's own rules removed, when it removed anything. */
  let rulesPurgeNotice: string[] | undefined;
  /**
   * When this run began, for the duration on the Done screen.
   *
   * Wall clock, including time spent waiting on the user to answer an
   * installer dialog — "this took four hours" is the honest answer even when
   * most of it was a prompt nobody was there to click.
   */
  const runStartedAtMs = Date.now();

  /**
   * The package's own sha256, hashed at most once and only if asked.
   *
   * `buildCuratorReport` has always accepted this and documented why a curator
   * needs it — two builds can share a version string — and no caller ever
   * passed it, so the field existed, typechecked, was unit-tested in
   * isolation, and never once appeared in a real report.
   *
   * Lazy because the package is large and almost every install produces no
   * report at all. Returns an empty object on failure rather than a wrong
   * hash: an absent line is honest, a fabricated one is not.
   */
  /**
   * The user's archive-hash cache, loaded at most once.
   *
   * `checkArchiveIdentity` takes a cache precisely so "a mod already hashed by
   * the download scan is not read twice", and neither call site passed one —
   * harmless while `archivePathForMod` was broken and the check never ran at
   * all, and a real cost the moment it started working: a full SHA-256 of
   * every failed mod's archive, some of them gigabytes, on the machine least
   * able to afford it, for numbers already sitting on disk from the scan.
   *
   * A miss costs a map lookup, so there is no case where passing it is worse.
   */
  let hashCacheLoaded = false;
  let hashCache: ArchiveHashCache | undefined;
  const archiveHashCache = async (): Promise<ArchiveHashCache | undefined> => {
    if (!hashCacheLoaded) {
      hashCacheLoaded = true;
      const { loadArchiveHashCache } = await import("../archiveHashCache");
      hashCache = await loadArchiveHashCache(ctx.appDataPath).catch(
        () => undefined,
      );
    }
    return hashCache;
  };

  let packageHashed = false;
  let packageSha256Cache: string | undefined;
  const packageIdentity = async (): Promise<{ packageSha256?: string }> => {
    if (!packageHashed) {
      packageHashed = true;
      const { hashFileSha256 } = await import("../archiveHashing");
      packageSha256Cache = await hashFileSha256(
        ctx.ehcollZipPath,
        ctx.abortSignal,
      ).catch(() => undefined);
    }
    return packageSha256Cache !== undefined
      ? { packageSha256: packageSha256Cache }
      : {};
  };

  /**
   * Mods whose verification PASSED, and the file list that was proven.
   *
   * Only these get a drift reference in the receipt. A mod that diverged from
   * the curator (correct, but not matching the manifest) or that failed
   * outright has no proven description of its disk, and inventing one would
   * make every future drift check compare against a fiction.
   */
  const verifiedOkKeys = new Set<string>();
  const expectedFilesByCompareKey = new Map<string, EhcollStagingFile[]>();
  const noteVerifiedOk = (
    compareKey: string,
    files: EhcollStagingFile[] | undefined,
  ): void => {
    if (files === undefined || files.length === 0) return;
    verifiedOkKeys.add(compareKey);
    expectedFilesByCompareKey.set(compareKey, files);
  };

  // Bundled-archive prefetch pool. We extract up to 2 archives ahead
  // of the install loop so Vortex's per-mod install (which is
  // serialized internally) overlaps with disk-bound 7z extraction.
  // Empty manifest sets ⇒ pool is created but never primed; its
  // dispose() is a no-op. See {@link BundledPrefetchPool} for the
  // concurrency-2 rationale.
  const bundledPool = new BundledPrefetchPool({
    ehcollZipPath: ctx.ehcollZipPath,
    concurrency: 2,
    signal: ctx.abortSignal,
  });

  const reportProgress = (
    phase: DriverPhase,
    currentStep: number,
    totalSteps: number,
    message: string,
  ): void => {
    ctx.onProgress?.({ phase, currentStep, totalSteps, message });
  };

  /**
   * The one way this driver reports an abort. See {@link buildAbortedResult}.
   *
   * `installedMods` and `ehProfileId` are read at the moment of the abort
   * rather than captured earlier — that is the entire point, and a closure is
   * how these two mutable locals stay live at six different call sites.
   */
  const abortedResult = (phase: DriverPhase, reason: string): InstallAborted =>
    buildAbortedResult({
      phase,
      reason,
      partialProfileId: ehProfileId,
      installedMods,
    });

  const checkAbort = (phase: DriverPhase): InstallResult | undefined =>
    ctx.abortSignal?.aborted
      ? abortedResult(phase, "User aborted the install.")
      : undefined;

  try {
    // ── 1. preflight ────────────────────────────────────────────────
    reportProgress("preflight", 0, 1, "Validating install plan...");

    const preflightError = preflight(plan, ctx.decisions);
    if (preflightError) {
      return {
        kind: "failed",
        phase: "preflight",
        error: preflightError,
        installedSoFar: [],
      };
    }

    let aborted = checkAbort("preflight");
    if (aborted) return aborted;

    // ── 2 + 3. profile resolution ───────────────────────────────────
    if (plan.installTarget.kind === "fresh-profile") {
      // Fresh-profile mode: create a new profile and switch into it — or
      // continue the one an interrupted attempt already made.
      reportProgress(
        "creating-profile",
        0,
        1,
        plan.installTarget.resumeProfileId !== undefined
          ? `Resuming into "${plan.installTarget.resumeProfileName ?? "the previous profile"}"...`
          : `Creating Vortex profile "${plan.installTarget.suggestedProfileName}"...`,
      );

      /**
       * ─── A RESUME CONTINUES A PROFILE; IT DOES NOT FORK ONE ─────────
       * An interrupted install writes no receipt, so the next run is
       * fresh-profile mode again — and used to make ANOTHER profile every
       * time. One tester's log has five `install.start` lines with five
       * different profile ids. Since enablement is per-profile, everything
       * the earlier runs installed reads "Disabled" in the newest one, and
       * Vortex reopens on whichever profile was last active, so they were
       * usually looking at a different profile than the one filling up.
       *
       * The resolver only sets this when a recorded attempt for this
       * package names a profile that still exists for this game.
       */
      const resumeId = plan.installTarget.resumeProfileId;
      if (resumeId !== undefined) {
        activeProfileId = resumeId;
        activeProfileName =
          plan.installTarget.resumeProfileName ?? resumeId;
        // Recorded exactly like a created one. It IS the profile this run is
        // filling, and the attempt record has to carry it or the NEXT resume
        // has nothing to find.
        setEhProfileId(resumeId);
      } else {
        const created = createFreshProfile(
          api,
          plan.manifest.game.id,
          plan.installTarget.suggestedProfileName,
        );
        setEhProfileId(created.id);
        activeProfileId = created.id;
        activeProfileName = created.name;
      }

      /**
       * ONE event for both branches, always. The create branch used to log
       * nothing at all, so a log without `install.profile.resumed` was equally
       * consistent with "created a profile", "upgraded in place" and "this
       * build does not have the fix" — and absence of a line is not a
       * diagnosis.
       */
      ehLog("info", "install.profile.resolved", {
        mode: resumeId !== undefined ? "resumed" : "created",
        profileId: activeProfileId,
        profileName: activeProfileName,
        ...(resumeId === undefined
          ? {
              whyNotResumed: plan.installTarget.resumeRefusedWhy ?? "no-attempt",
              /**
               * ─── THE THREE FACTS THAT SETTLE IT ───────────────────────
               * A tester forked a fourth profile and the log said only
               * "profile-deleted". That is equally consistent with them
               * deleting it between attempts — a habit worth mentioning —
               * and with us recording an id that can never match, which is a
               * bug that forks a profile on every run forever. Reading the
               * log could not tell those apart, so neither could anyone.
               *
               * Together these do: the id we wanted, and every profile Vortex
               * actually has for this game. If the id is absent from the
               * list, it was deleted. If the list is empty or shaped
               * differently, the lookup is wrong. No follow-up question.
               */
              ...(plan.installTarget.resumeRefusedProfileId !== undefined
                ? { attemptProfileId: plan.installTarget.resumeRefusedProfileId }
                : {}),
              knownProfiles: listProfilesForGame(api, plan.manifest.game.id),
            }
          : {}),
      });

      aborted = checkAbort("creating-profile");
      if (aborted) return aborted;

      reportProgress(
        "switching-profile",
        0,
        1,
        `Switching to "${activeProfileName}"...`,
      );

      try {
        await switchToProfile(api, activeProfileId, ctx.abortSignal);
      } catch (err) {
        // AbortError → fall through to the usual abort handling
        // (caller has already cleared the active profile in Vortex
        // OR Vortex will eventually catch up and emit
        // profile-did-change; either way the install can't proceed).
        if (isAbort(err)) {
          aborted = checkAbort("switching-profile");
          if (aborted) return aborted;
          // Defensive: if the signal isn't aborted but we got an
          // AbortError anyway (impossible by construction, but
          // belt-and-suspenders for future refactors), treat it as
          // a user-aborted switch.
          return abortedResult(
            "switching-profile",
            "Profile switch aborted before completion.",
          );
        }
        throw err;
      }

      aborted = checkAbort("switching-profile");
      if (aborted) return aborted;
    } else {
      // Current-profile mode: install in-place, into the profile the RECEIPT
      // names — which is usually the active one.
      activeProfileId = plan.installTarget.profileId;
      activeProfileName = plan.installTarget.profileName;
      // Recorded like the other two. This IS the profile the run is filling,
      // which is what the field means — leaving it unset made every in-place
      // failure write an unresumable attempt, and that record then OVERWRITES
      // a good one from an earlier fresh-profile run.
      setEhProfileId(plan.installTarget.profileId);

      /**
       * ─── AND GO WHERE THE COLLECTION ACTUALLY LIVES ───────────────────
       * Set only when the receipt's profile is NOT the one Vortex is on. The
       * old code took the ACTIVE profile unconditionally, so a same-version
       * re-run from a vanilla profile enabled 978 mods there, purged the
       * user's mod rules and rewrote their plugins.txt — the hazard the
       * version-changed branch of `pickInstallTarget` already refuses for.
       *
       * It is reachable by following our own advice: after a partial run the
       * Done screen says to switch back to your previous profile AND to run
       * the install again to finish, in that order.
       *
       * Enabling mods in a profile Vortex is not on would also deploy
       * nothing, so the switch is required for correctness and not only for
       * safety.
       */
      const switchFrom = plan.installTarget.switchFromProfileId;
      if (switchFrom !== undefined) {
        ehLog("info", "install.profile.switching-to-receipt", {
          from: switchFrom,
          to: activeProfileId,
          profileName: activeProfileName,
          why:
            "the receipt records this collection as installed in that " +
            "profile; installing into the active one instead would merge it " +
            "where the user did not ask for it",
        });
        reportProgress(
          "switching-profile",
          0,
          1,
          `Switching to "${activeProfileName}"...`,
        );
        try {
          await switchToProfile(api, activeProfileId, ctx.abortSignal);
        } catch (err) {
          if (isAbort(err)) {
            aborted = checkAbort("switching-profile");
            if (aborted) return aborted;
            return abortedResult(
              "switching-profile",
              "Profile switch aborted before completion.",
            );
          }
          throw err;
        }
        aborted = checkAbort("switching-profile");
        if (aborted) return aborted;
      }
    }

    /**
     * ─── PREFETCH ONLY ONCE THE PROFILE SWITCH IS DONE ─────────────────
     * This used to run before profile resolution, and it cost a tester their
     * install. Their log:
     *
     *   22:12:44  bundled-prefetch.primed {requested: 13}
     *   22:12:44  install.profile.resolved {mode: "created"}
     *   22:13:25  extract.ok    311 MB in  41s
     *   22:13:47  bundled-prefetch.dispose        <- the run died here, 63s in
     *   22:16:34  extract.ok  2,577 MB in 177s    (still finishing)
     *   22:16:46  extract.ok  4,890 MB in 242s
     *
     * "Profile switch did not complete within 64s." Vortex had to purge a
     * profile holding ~1,100 deployed mods, and we had just pointed 7.7 GB of
     * concurrent archive extraction at the same disk. It was not a stuck
     * deployment — the error text said to go looking for one — it was us
     * starving the switch we were waiting on.
     *
     * The prefetch exists to overlap extraction with INSTALLS, and the
     * switch is a one-time step before any of those. Moving it here costs
     * nothing and removes the contention entirely.
     */
    const prefetchEntries = collectBundledZipEntriesForPrefetch(plan, ctx);
    if (prefetchEntries.length > 0) {
      bundledPool.prime(prefetchEntries);
    }

    // ── 4. remove replaced + orphan-uninstalled mods ────────────────
    // Skipped silently when nothing to do (fresh-profile mode produces
    // an empty removal list by construction).
    const removalPlan = collectRemovalPlan(plan, ctx.decisions);
    if (removalPlan.length > 0) {
      const totalRemovals = removalPlan.length;
      for (let i = 0; i < totalRemovals; i++) {
        const item = removalPlan[i];
        reportProgress(
          "removing-mods",
          i + 1,
          totalRemovals,
          `[${i + 1}/${totalRemovals}] Removing "${item.name}" (${item.reason})...`,
        );

        try {
          await uninstallMod(api, {
            gameId: plan.manifest.game.id,
            modId: item.modId,
          });
        } catch (err) {
          return {
            kind: "failed",
            phase: "removing-mods",
            partialProfileId: ehProfileId,
            error:
              `Failed removing "${item.name}" (${item.reason}): ` +
              formatError(err),
            installedSoFar: installedMods.map((m) => m.vortexModId),
          };
        }

        removedMods.push({
          vortexModId: item.modId,
          name: item.name,
          reason: item.reason,
          compareKey: item.compareKey,
        });

        aborted = checkAbort("removing-mods");
        if (aborted) return aborted;
      }
    }

    // ── 5. install each mod sequentially ────────────────────────────
    const total = plan.modResolutions.length;

    // Record that a run is in flight, so a CRASH leaves a trace.
    //
    // A receipt is written only on completion and that stays true — it
    // asserts the collection IS installed, which a half-finished run has not
    // earned. But the consequence was that a force-quit left nothing at all
    // on disk: a tester killed Vortex here, reopened it, and Event Horizon
    // had no idea anything had been running or which of the profiles in his
    // list we had made.
    //
    // Written HERE rather than at the top of the function because this is
    // where the long, interruptible part begins and where the profile is
    // finally known. Nothing reads it to decide what to install — that stays
    // with the resolver's re-match, which is evidence-based. It only lets the
    // next launch explain itself.
    markerWritten = true;
    await writeInstallMarker(ctx.appDataPath, {
      packageId: plan.manifest.package.id,
      packageName: plan.manifest.package.name,
      // Carried so a crash-recovered marker can be used for RESUME: the
      // resume guard refuses a profile built for a different release.
      packageVersion: plan.manifest.package.version,
      startedAt: new Date().toISOString(),
      profileId: activeProfileId,
      gameId: plan.manifest.game.id,
      totalMods: total,
    });

    // The header a remote log needs to be readable at all: what was being
    // installed, how much of it, into what, and — since a resumed run looks
    // very different from a first one — how the plan breaks down by decision.
    // A log that starts mid-way through mod 400 with no context is a list of
    // names.
    ehLog("info", "install.start", {
      package: plan.manifest.package.name,
      packageId: plan.manifest.package.id,
      gameId: plan.manifest.game.id,
      profileId: activeProfileId,
      totalMods: total,
      decisions: countByDecision(plan.modResolutions),
    });
    /**
     * ─── TWO EPOCHS, DECLARED RATHER THAN DISCOVERED ────────────────────
     * Some FOMOD installers ask the game whether a plugin is ACTIVE, and
     * Vortex answers from live state — `getAllPlugins(activeOnly)` reads
     * `loadOrder[name].enabled`, and pre-filling the curator's answers does
     * not suppress it. So a mod naming a plugin THIS COLLECTION provides
     * behaves differently depending on where it sits in the install order,
     * which is a coin toss nobody chose.
     *
     * One real mod, 801 of 979, refused eleven times across the tester logs:
     * "Prerequisits not fulfilled: File 'aaf.esm' is Active OR File 'aaf.esp'
     * is Active" — with AAF in the same collection, uninstalled at that
     * moment. The retry pass rescues that, because refusing is loud.
     *
     * The same dependency in a step's `<visible>` or a conditional pattern
     * does NOT refuse. It takes a different branch, installs a different file
     * set, and nothing fails — so nothing retries, and verification later
     * reports the mod as unreproducible while blaming its archive. Discovering
     * the population by letting mods FAIL can never find those.
     *
     * So the build declares them (`install.readsPluginState`) and they install
     * in a second epoch, after the plugins are actually active. The retry pass
     * stays as the net for anything the declaration missed.
     *
     * The ORDER is a permutation of the same queue, not a second loop: every
     * mod still goes through one code path, with one set of journalling,
     * failure-streak and abort rules.
     */
    const epochs = planInstallEpochs(plan.manifest);
    const secondEpochKeys = new Set(epochs.second);
    const firstEpoch = plan.modResolutions.filter(
      (r) => !secondEpochKeys.has(r.compareKey),
    );
    const secondEpoch = plan.modResolutions.filter((r) =>
      secondEpochKeys.has(r.compareKey),
    );
    const installQueue = [...firstEpoch, ...secondEpoch];
    const secondEpochStartsAt = firstEpoch.length;
    if (secondEpoch.length > 0) {
      ehLog("info", "install.epoch.planned", {
        firstEpoch: firstEpoch.length,
        secondEpoch: secondEpoch.length,
        deferred: epochs.deferred.slice(0, 20),
        why:
          "these mods' installers ask the game whether a plugin this " +
          "collection ships is active; installing them before it is active " +
          "makes the outcome depend on manifest position",
      });
    }

    for (let i = 0; i < total; i++) {
      /**
       * The boundary. Deploy so the plugins exist in the game folder, then
       * write the curator's order so they are ACTIVE — `activeOnly` reads
       * enablement, not presence, so the deploy alone is not enough.
       *
       * `skipSort`: this pin exists to activate plugins, not to settle the
       * final order. The real ordering pass runs later and re-pins after LOOT;
       * sorting here would spend a full LOOT run on a load order that is about
       * to change again.
       */
      if (i === secondEpochStartsAt && secondEpoch.length > 0) {
        try {
          reportProgress(
            "installing-mods",
            i,
            total,
            "Activating plugins before the remaining mods...",
          );
          /**
           * ─── TYPES BEFORE ANY DEPLOY, INCLUDING THIS ONE ──────────────
           * A modType decides WHERE a mod's files land: SSE Engine Fixes
           * Part 2 is loose binaries the curator typed `dinput`, which
           * deploys to the game ROOT. Deploying it before the type is
           * restored puts those DLLs in `Data`, where nothing loads them —
           * and this boundary introduced a deploy that runs ~1,300 lines
           * before the modType phase.
           *
           * `applyModTypes.test.ts` caught exactly that, which is what a
           * source-ordering test is for. So the types are restored here too,
           * for the mods installed so far. The later phase still runs and is
           * still the authority; this one only makes the intermediate deploy
           * honest.
           */
          const epochTypes = applyModTypeChanges(
            ctx.api,
            plan.manifest.game.id,
            planModTypeChanges({
              installed: new Map(
                installedMods.map(
                  (m) => [m.compareKey, m.vortexModId] as const,
                ),
              ),
              currentTypes: readCurrentModTypes(ctx.api, plan.manifest.game.id),
              manifestMods: plan.manifest.mods,
            }),
            actions,
          );
          await deployAndWait(api, activeProfileId);
          const pin = await applyPluginOrder({
            api,
            gameId: plan.manifest.game.id,
            collectionId: plan.manifest.package.id,
            order: plan.manifest.plugins.order,
            skipSort: true,
            ...(ctx.abortSignal !== undefined
              ? { signal: ctx.abortSignal }
              : {}),
          });
          ehLog("info", "install.epoch.second.start", {
            mods: secondEpoch.length,
            modTypesRestored: epochTypes.length,
            pluginOrderPinned: pin.pinned,
            writeRequested: pin.writeRequested,
          });
        } catch (err) {
          /**
           * Non-fatal, and it degrades to exactly the old behaviour: the mods
           * install anyway, an installer that refuses lands in `failedMods`,
           * and the retry pass picks it up after the real deploy. Saying so
           * beats failing an install over an optimisation.
           */
          ehLog("error", "install.epoch.second.activation-failed", {
            mods: secondEpoch.length,
            consequence:
              "the deferred mods install without their prerequisites active, " +
              "which is what happened before this pass existed — the retry " +
              "pass remains their safety net",
            err,
          });
        }
        aborted = checkAbort("installing-mods");
        if (aborted) return aborted;
      }

      const resolution = installQueue[i]!;
      const manifestEntry = manifestByCompareKey.get(resolution.compareKey);
      if (!manifestEntry) {
        // Resolver invariant violation — every modResolution must
        // reference a real manifest entry by compareKey.
        return {
          kind: "failed",
          phase: "installing-mods",
          partialProfileId: ehProfileId,
          error:
            `Internal error: resolution for "${resolution.name}" ` +
            `(compareKey=${resolution.compareKey}) has no matching manifest entry.`,
          installedSoFar: installedMods.map((m) => m.vortexModId),
        };
      }

      reportProgress(
        "installing-mods",
        i + 1,
        total,
        `[${i + 1}/${total}] ${resolution.name}: ${describeDecision(
          resolution.decision,
          ctx.decisions,
        )}`,
      );

      // Logged BEFORE the work, not after.
      //
      // This is the whole diagnostic value: when an install hangs there is no
      // "after". A completion-only log ends with the last mod that SUCCEEDED
      // and says nothing about the one still running, which is the only one
      // anybody wants to know about. Written this way, the final line of the
      // log names the mod it stopped on, and its timestamp says for how long.
      //
      // A tester's install sat and we had no idea where, because the driver
      // logged nothing at all.
      const modStartedAt = Date.now();
      ehLog("info", "install.mod.start", {
        i: i + 1,
        total,
        name: resolution.name,
        decision: resolution.decision.kind,
        compareKey: resolution.compareKey,
      });

      let installEntry: InstalledModReportEntry | undefined;
      try {
        installEntry = await executeDecision({
          ctx,
          resolution,
          manifestEntry,
          profileId: activeProfileId,
          onTempArchive: (p) => tempArchivesToCleanup.push(p),
          onSkip: (entry) => skippedMods.push(entry),
          onCarry: (entry) => carriedMods.push(entry),
          onNotice: (line) => externalNotices.push(line),
          onSuppliedArchiveDiffers: (info) =>
            suppliedArchiveMismatches.set(info.compareKey, {
              expected: info.expected,
              actual: info.actual,
            }),
          bundledPool,
        });
        // Clear the prompts Vortex raises per multi-plugin mod. Swept here
        // rather than once at the end: the point is that the user is not
        // watching a wall of "Enable all" buttons grow for an hour, each of
        // which is the WRONG answer during a collection install — we set
        // plugin enablement from the manifest at the end.
        dismissNoisyNotifications(ctx.api);

        ehLog("info", "install.mod.done", {
          i: i + 1,
          total,
          name: resolution.name,
          ms: Date.now() - modStartedAt,
        });
      } catch (err) {
        // Honor user aborts even if they bubbled out of a primitive
        // before checkAbort had a chance to catch them. The signal is
        // the source of truth — the AbortError is only a faster
        // exit path than letting the timeout/watchdog trip.
        if (
          isAbort(err) ||
          ctx.abortSignal?.aborted
        ) {
          ehLog("info", "install.aborted", {
            i: i + 1,
            total,
            name: resolution.name,
            ms: Date.now() - modStartedAt,
          });
          return abortedResult(
            "installing-mods",
            `Install aborted while processing "${resolution.name}".`,
          );
        }
        const phase: DriverPhase = "installing-mods";

        // ── a machine problem wearing a mod's name ───────────────────────
        //
        // "No deployment method active" is not about this mod. Vortex cannot
        // link ANYTHING into the game folder, so mod 490 will fail exactly as
        // mod 489 did and so will the nine hundredth. A tester's run learned
        // this at mod 489 of 967, treated it as one bad mod, and ground on for
        // another 478 before dying with no receipt — seventy minutes, and the
        // answer was in the first failure.
        if (isDeploymentMethodMissing(err)) {
          ehLog("error", "install.no-deployment-method", {
            i: i + 1,
            total,
            name: resolution.name,
            installedSoFar: installedMods.length,
          });
          return {
            kind: "failed",
            phase,
            partialProfileId: ehProfileId,
            error: describeMissingDeploymentMethod({
              modName: resolution.name,
              atIndex: i + 1,
              total,
              wine: looksLikeWine(),
            }),
            installedSoFar: installedMods.map((m) => m.vortexModId),
            failedMods,
          };
        }

        // The error text reaches the user; this reaches us. Same failure,
        // but with the index, the decision kind and how long it ran — which
        // is what separates "this mod is broken" from "everything after mod
        // 400 is slow".
        ehLog("error", "install.mod.failed", {
          i: i + 1,
          total,
          name: resolution.name,
          decision: resolution.decision.kind,
          ms: Date.now() - modStartedAt,
          error: formatError(err),
        });
        failedMods.push({
          compareKey: resolution.compareKey,
          name: resolution.name,
          decision: resolution.decision.kind,
          error: formatError(err),
        });
        const failureShape = classifyModFailure(Date.now() - modStartedAt);
        run.noteModFailed(failureShape);

        // A streak means the cause is not this mod. Stop and say which one it
        // looks like, rather than reporting 900 identical failures.
        const systemicTimeout =
          run.consecutiveTimeouts >= SYSTEMIC_TIMEOUT_STREAK;
        if (
          systemicTimeout ||
          run.consecutiveFailures >= SYSTEMIC_FAILURE_STREAK
        ) {
          ehLog("error", "install.systemic-failure", {
            streak: run.consecutiveFailures,
            timeoutStreak: run.consecutiveTimeouts,
            shape: systemicTimeout ? "timed-out" : "unclear",
            atIndex: i + 1,
            total,
          });
          return {
            kind: "failed",
            phase,
            partialProfileId: ehProfileId,
            error: describeSystemicFailure({
              streak: run.consecutiveFailures,
              lastModName: resolution.name,
              lastError: formatError(err),
              remaining: total - i,
              shape: systemicTimeout ? "timed-out" : "unclear",
            }),
            installedSoFar: installedMods.map((m) => m.vortexModId),
            failedMods,
          };
        }
        continue;
      }

      if (installEntry === undefined) {
        // Soft-skip OR carry-forward — onSkip / onCarry already
        // recorded the entry. The carry-forward path also enabled
        // the mod in the active profile inside executeDivergedChoice.
        continue;
      }

      installedMods.push(installEntry);
      // Also out through the escape hatch, so a throw can still say how far
      // this run got. See `escaped` in `runInstall`.
      ctx.onModInstalled?.(installEntry.vortexModId);
      run.noteModSucceeded();
      enableModInProfile(api, activeProfileId, installEntry.vortexModId);

      /**
       * ─── RECORD WHAT WE CREATED, AS WE CREATE IT ──────────────────
       * Only mods this run actually INSTALLED. An `*-already-installed`
       * arm produced no mod — it adopted one — and journaling that would
       * launder a match into evidence that we put it there, which is the
       * exact confusion the journal exists to end.
       *
       * Awaited rather than fired-and-forgotten so the ordering matches
       * reality: a kill between the install and the append costs one
       * redone mod, a kill between the append and the install would claim
       * a mod that does not exist.
       */
      await appendJournalEntry(ctx.appDataPath, plan.manifest.package.id, {
        compareKey: installEntry.compareKey,
        vortexModId: installEntry.vortexModId,
        /**
         * An `*-already-installed` arm ADOPTED a mod the user already had —
         * matched byte-for-byte, so their copy is the curator's. Worth
         * remembering: a later run can prefer this exact mod over an
         * unrelated namesake, and can skip re-deciding it.
         *
         * It does NOT make the mod ours. Only "installed" grants the repair
         * path permission to uninstall, because a mod that is byte-identical
         * today can be an edited mod next month.
         */
        kind: installEntry.fromDecision.endsWith("already-installed")
          ? "adopted"
          : "installed",
        decision: installEntry.fromDecision,
        at: new Date().toISOString(),
      });

      aborted = checkAbort("installing-mods");
      if (aborted) return aborted;
    }

    // Record orphan-keep choices into carriedMods so they remain
    // tagged in the new receipt (cross-release lineage preservation).
    // We do not enable these — the user said "keep" meaning "leave
    // alone," and we honor that.
    for (const orphan of plan.orphanedMods) {
      const choice = ctx.decisions.orphanChoices?.[orphan.existingModId];
      if (choice?.kind !== "keep") continue;
      carriedMods.push(buildOrphanCarriedEntry(api, plan, orphan));
    }

    // ── 5a-verify. file integrity verification (slice 7) ────────────
    // Cross-checks every freshly installed mod's staging folder
    // against the curator's `stagingFiles` snapshot from the
    // manifest. Catches Vortex's "did-install-mod fired but the
    // archive wasn't fully extracted" bug — the famous "Vortex
    // randomly loses files" symptom we saw in the wild.
    //
    // EVERY installed entry is verified, `*-already-installed` re-uses
    // included. This comment used to claim the opposite — that we only
    // checked freshly-installed mods — while the loop below has always
    // iterated the whole list. It mattered: "was this mod installed
    // correctly?" is the question the tool exists to answer, and a mod we
    // skipped because it was already there is no less able to be broken.
    // Identity ("is this the same mod?") and integrity ("did the right bytes
    // land?") are separate passes, and this is the second one.
    //
    // Failures don't abort the install. Each failing mod is given
    // ONE retry (uninstall + reinstall via the same decision path,
    // re-verify); if the retry recovers the mod we record success
    // with `retryAttempted: true`. If it still fails, we keep the
    // mod and surface the failure in the receipt + Done card so
    // the user can decide (often the answer is "antivirus quarantined
    // a file, click reinstall in Mods tab").
    //
    // Manifest carries `package.verificationLevel`. If the curator
    // built with `"none"` we skip the entire phase fast (zero disk
    // walks). The receipt still records `kind: "skip"` per mod so
    // the audit trail is uniform.
    /**
     * ─── WHICH MODS DID *WE* PUT HERE? ────────────────────────────────
     * The repair below uninstalls before reinstalling, so this set is the
     * difference between fixing our own half-extracted mod and DELETING
     * one the user brought. It is read from the journal — our own record of
     * what this collection's runs created — and every id is confirmed
     * against live Vortex state, because a mod the user has since removed
     * must not be reported as ours.
     *
     * Freshly-installed mods of THIS run are owned by construction; the
     * journal is what carries that fact across a restart.
     */
    const journal = await readJournal(ctx.appDataPath, plan.manifest.package.id);
    /**
     * The previous run's receipt, for provenance only. A failure to read one
     * is not a failure here — it just means the journal is the sole source,
     * which is what it was before.
     */
    const previousReceipt = await readReceipt(
      ctx.appDataPath,
      plan.manifest.package.id,
    );
    const previousReceiptMods = previousReceipt?.mods ?? [];
    const liveMods = ((api.getState() as unknown as {
      persistent?: {
        mods?: Record<
          string,
          Record<string, { attributes?: { installTime?: unknown } }>
        >;
      };
    }).persistent?.mods ?? {})[plan.manifest.game.id] ?? {};
    const liveModIds = new Set(Object.keys(liveMods));

    /**
     * ─── WHEN DID THE MOD IN THAT SLOT ARRIVE? ──────────────────────────
     * Vortex derives a mod's id from its archive basename and REUSES it: the
     * id is not a handle to a particular installation, it is a name that a
     * later installation can occupy. `checkModNameExists` only appends a
     * suffix while a mod under that name currently exists, so a user who
     * deletes a mod and re-downloads the same Nexus file gets the SAME id
     * back — which is ordinary Vortex use, not an edge case.
     *
     * `installTime` is what tells the two apart. The receipt's `installedAt`
     * is when that RUN completed, so every mod it created was installed
     * BEFORE it; a live mod stamped later is a different installation
     * occupying the same name.
     */
    const installTimeOf = (modId: string): number | undefined => {
      const raw = liveMods[modId]?.attributes?.installTime;
      const ms =
        typeof raw === "number"
          ? raw
          : typeof raw === "string"
            ? Date.parse(raw)
            : Number.NaN;
      return Number.isFinite(ms) ? ms : undefined;
    };
    /**
     * A minute of slack. Both clocks are this process's, so the real skew is
     * zero — this only exists so a filesystem timestamp rounded up, or a
     * receipt written a moment before the last mod settled, cannot revoke
     * provenance for a mod that genuinely is ours.
     */
    const REINSTALL_GRACE_MS = 60_000;
    const receiptWrittenAt = Date.parse(previousReceipt?.installedAt ?? "");
    /**
     * ─── PROVENANCE OUTLIVES THE JOURNAL ────────────────────────────────
     * The journal is DELETED on a successful install — the receipt takes over
     * as the record of what is installed. But `ownedModIds` was the only
     * source of "did we put this here", so on the NEXT run of the same
     * collection the set came back empty and every mod this tool had
     * installed read as the user's own:
     *
     *   - the mirror pass skips every mirrored mod as "not ours" (NS-2 firing
     *     on our own work), leaving drifted mirrors uncorrected;
     *   - a failed verification takes the `not-ours` arm and installs a THIRD
     *     copy alongside a mod we ourselves created.
     *
     * The receipt can answer it now that it carries `ownership`, so both
     * records feed one set. Journal first (it covers the run in progress),
     * receipt second (it covers every run before this one). Absent ownership
     * on an older receipt contributes NOTHING — unknown is not ours, which is
     * the only safe reading (NS-2).
     */
    const ownedByUs = ownedModIds(journal, liveModIds);
    let ownedFromReceipt = 0;
    const reinstalledSinceReceipt: string[] = [];
    for (const m of previousReceiptMods) {
      if (m.ownership !== "installed") continue;
      if (!liveModIds.has(m.vortexModId)) continue;
      if (ownedByUs.has(m.vortexModId)) continue;
      /**
       * ─── LIVENESS IS NOT IDENTITY (NS-2) ──────────────────────────────
       * `liveModIds.has()` proves the id is OCCUPIED. It never proved the
       * same installation occupies it, and ownership is monotone — once
       * claimed here, `buildReceipt` re-stamps it "installed" on every later
       * run, so a wrong claim is permanent rather than wrong once.
       *
       * What it cost: the user deletes our mod, re-downloads the same Nexus
       * file themselves and answers the FOMOD their own way. Vortex hands
       * back the same id. The next run claims it, verification fails because
       * their choices selected different files, and `tryRecoverFailedMod`
       * sees `weInstalledIt` and UNINSTALLS a mod Event Horizon did not
       * install — the exact thing NS-2 exists to prevent, on the code path
       * written to honour it.
       *
       * Only positive evidence revokes the claim. An absent `installTime`
       * leaves provenance exactly as it was, because losing it re-opens the
       * failures the receipt seeding was added for (the mirror skipping our
       * own work, a third copy installed beside our second) and those are
       * recoverable where a wrong deletion is not.
       */
      const installedMs = installTimeOf(m.vortexModId);
      if (
        Number.isFinite(receiptWrittenAt) &&
        installedMs !== undefined &&
        installedMs > receiptWrittenAt + REINSTALL_GRACE_MS
      ) {
        reinstalledSinceReceipt.push(m.vortexModId);
        continue;
      }
      ownedByUs.add(m.vortexModId);
      ownedFromReceipt += 1;
    }
    if (reinstalledSinceReceipt.length > 0) {
      ehLog("warn", "install.provenance.reinstalled-since-receipt", {
        count: reinstalledSinceReceipt.length,
        examples: reinstalledSinceReceipt.slice(0, 10),
        receiptInstalledAt: previousReceipt?.installedAt,
        why:
          "a mod occupies the id our receipt recorded, but it was installed " +
          "AFTER that receipt was written — so it is a different " +
          "installation under a reused name, not ours",
        consequence:
          "treated as the user's own: it will not be uninstalled by the " +
          "repair path and will not be mirrored over (NS-2)",
      });
    }
    ehLog("info", "install.provenance.resolved", {
      fromJournal: ownedByUs.size - ownedFromReceipt,
      fromReceipt: ownedFromReceipt,
      reinstalledSinceReceipt: reinstalledSinceReceipt.length,
      receiptEntries: previousReceiptMods.length,
      receiptWithoutOwnership: previousReceiptMods.filter(
        (m) => m.ownership === undefined,
      ).length,
      total: ownedByUs.size,
    });
    // The live pool, not `ownedByUs`: the summary counts installed and adopted
    // entries against it separately, and handing it an installed-only set is
    // what made it report every adopted mod as deleted.
    logJournalSummary(plan.manifest.package.id, journal, liveModIds);

    const declaredLevel = plan.manifest.package.verificationLevel ?? "none";
    if (
      installedMods.length > 0 &&
      declaredLevel !== "none"
    ) {
      // A log with no verify lines used to be equally consistent with "1755
      // mods verified clean", "the curator built with verificationLevel none"
      // and "the run died before this phase". Say which.
      ehLog("info", "verify.phase.start", {
        level: declaredLevel,
        modCount: installedMods.length,
      });
      reportProgress(
        "verifying-mods",
        0,
        installedMods.length,
        `Verifying ${installedMods.length} mod${installedMods.length === 1 ? "" : "s"}...`,
      );

      for (let i = 0; i < installedMods.length; i++) {
        const installEntry = installedMods[i];
        const manifestEntry = manifestByCompareKey.get(
          installEntry.compareKey,
        );
        const expectedFiles = manifestEntry?.state.stagingFiles;

        reportProgress(
          "verifying-mods",
          i + 1,
          installedMods.length,
          `[${i + 1}/${installedMods.length}] Checking "${installEntry.name}"...`,
        );

        /**
         * Set when the FILES verify but the installer ANSWERS do not match the
         * collection. Sends the mod to the same recovery a failure would,
         * without pretending a file check failed — `judgeReinstall` asks the
         * archive about differing files, and there are none to ask about.
         */
        let staleInstallerOptions = false;
        let verifyResult: VerifyResult;
        try {
          verifyResult = await verifyModInstall({
            api,
            gameId: plan.manifest.game.id,
            vortexModId: installEntry.vortexModId,
            expectedFiles,
            level: declaredLevel,
            signal: ctx.abortSignal,
          });
        } catch (err) {
          if (
            isAbort(err) ||
            ctx.abortSignal?.aborted
          ) {
            return abortedResult(
              "verifying-mods",
              `Install aborted while verifying "${installEntry.name}".`,
            );
          }
          // Non-fatal: record as a skip-with-error so the user can
          // see SOMETHING happened but the install carries on.
          //
          // `ehLog`, not `console.warn`: this mod is now UNVERIFIED, and the
          // receipt says "skip" without saying why. Devtools output dies with
          // the session, so the reason left no trace in the file a tester sends.
          ehLog("error", "verify.threw", {
            name: installEntry.name,
            compareKey: installEntry.compareKey,
            vortexModId: installEntry.vortexModId,
            consequence: "this mod was not verified",
            err,
          });
          verifications.push({
            kind: "skip",
            vortexModId: installEntry.vortexModId,
            compareKey: installEntry.compareKey,
            name: installEntry.name,
            reason: "errored",
          });
          continue;
        }

        if (verifyResult.kind === "skip") {
          verifications.push({
            kind: "skip",
            vortexModId: installEntry.vortexModId,
            compareKey: installEntry.compareKey,
            name: installEntry.name,
            reason: verifyResult.reason,
          });
          continue;
        }

        /**
         * ─── VERIFIED, AND STILL NOT WHAT THE COLLECTION SAYS ────────────
         * Verification proves every file the curator RECORDED is present with
         * the recorded bytes. It says nothing about files the user has that
         * the curator does not — those are `extraFiles`, deliberately
         * informational, because a user who picked different FOMOD options is
         * entitled to their own choice.
         *
         * That reasoning does not cover the CURATOR narrowing a mod. A tester
         * hit it: the curator re-installed `Val Serano` excluding a patch and
         * shipped v1.0.11, but the Nexus archive is unchanged, so the
         * compareKey is unchanged, the resolver answered
         * `nexus-already-installed` in 0 ms, and the tester kept v1.0.10's
         * wider selection — including `AX ValSerano-RaceCompatibility.esp`,
         * whose master the collection does not ship. Vortex then refused to
         * sort, and the mod verified CLEAN the whole time, because everything
         * the curator recorded really was there.
         *
         * So compare the answers themselves. Both sides carry them and it
         * costs nothing: the manifest records what the curator picked, and
         * Vortex holds what this machine picked. When both are known and they
         * DIFFER, this mod is not the collection's version of it, whatever the
         * file check says.
         *
         * Treated as a verification FAILURE so it flows into the machinery
         * that already exists: `judgeReinstall` decides, and the repair path
         * reinstalls a mod we installed or installs the curator's copy
         * ALONGSIDE one we did not — so a mod the user owns is never
         * destroyed to correct it (NS-2).
         */
        if (verifyResult.kind === "ok") {
          const manifestEntry = manifestByCompareKey.get(
            installEntry.compareKey,
          );
          const curatorPicked = manifestEntry?.install?.fomodSelections ?? [];
          const userPicked = liveFomodSelections(
            api.getState(),
            plan.manifest.game.id,
            installEntry.vortexModId,
          );
          if (
            compareSelections(
              curatorPicked,
              userPicked,
              manifestEntry?.install?.emptySelectionVerified === true,
            ) === "differ"
          ) {
            ehLog("warn", "verify.selections-differ", {
              name: installEntry.name,
              compareKey: installEntry.compareKey,
              consequence:
                "this mod's files verify, but it was installed with different " +
                "installer options than the collection records — the archive " +
                "is the same, so nothing else could have noticed",
            });
            staleInstallerOptions = true;
          }
        }

        if (verifyResult.kind === "ok" && !staleInstallerOptions) {
          // Verification passed, so every file the curator recorded is present
          // with exactly the recorded bytes: the manifest's file list is now a
          // PROVEN description of this disk, and can serve as the drift
          // reference. Recorded here rather than for every installed mod
          // precisely because that proof is what makes it legitimate.
          noteVerifiedOk(installEntry.compareKey, expectedFiles);
          verifications.push({
            kind: "ok",
            vortexModId: installEntry.vortexModId,
            compareKey: installEntry.compareKey,
            name: installEntry.name,
            level: declaredLevel === "thorough" ? "thorough" : "fast",
            verifiedFileCount: verifyResult.verifiedCount,
            extraFileCount: verifyResult.extraFiles.length,
          });
          continue;
        }

        // Everything from here is the recovery path. A stale-options mod
        // reaches it with `verifyResult.kind === "ok"`, so the judgement step
        // — which exists to ask the ARCHIVE about files that differ — is
        // skipped: no file differs, and the answer is already known.
        // verifyResult.kind === "fail".
        //
        // Before spending a reinstall, ask the ARCHIVE — the one reference no
        // one's extraction can corrupt. verifyModInstall compared two disks
        // and cannot distinguish "this install went wrong" from "the CURATOR's
        // staging was modified after extraction", and the second is ~11% of
        // mods on a real profile (BA2 repacking, plugin cleaning). Every one
        // of those was being uninstalled, reinstalled from the archive,
        // compared against the same post-processed reference, failing again,
        // and recorded as broken — twice the work for files that were correct.
        /**
         * ─── A MIRRORED MOD IS ABOUT TO BE CORRECTED ────────────────────
         * Verification runs here; the mirror runs 600 lines below. So a
         * mirrored mod fails HERE by construction — the curator's added
         * files are exactly what the archive cannot produce — and the judge,
         * which has never heard of mirroring, answered "reinstall".
         *
         * What that cost, per affected mod: an uninstall, a re-download, a
         * second identical failure, a "broken mod" in the receipt, and a
         * report telling the user to go and bother the curator — about a mod
         * the curator had already answered for, and which the very next phase
         * makes byte-perfect.
         *
         * That is the ~11%-of-mods waste loop `judgeReinstall` was written to
         * eliminate, reintroduced for the one flag that should be the
         * strongest excuse of the three. The package CARRIES these bytes.
         */
        if (manifestEntry?.state?.mirrored === true) {
          ehLog("info", "verify.pending-mirror", {
            name: installEntry.name,
            compareKey: installEntry.compareKey,
            missing:
              verifyResult.kind === "fail" ? verifyResult.missingFiles.length : 0,
            differing:
              verifyResult.kind === "fail"
                ? verifyResult.sizeMismatches.length +
                  verifyResult.hashMismatches.length
                : 0,
            why: "the curator ships these files; the mirror pass settles this mod",
          });
          verifications.push({
            kind: "skip",
            vortexModId: installEntry.vortexModId,
            compareKey: installEntry.compareKey,
            name: installEntry.name,
            reason: "pending-mirror",
          });
          continue;
        }

        const judgement =
          verifyResult.kind === "fail"
            ? await judgeReinstall({
          missingFiles: verifyResult.missingFiles,
          differingPaths: [
            ...verifyResult.sizeMismatches.map((m) => m.path),
            ...verifyResult.hashMismatches.map((m) => m.path),
          ],
          stagingRoot: verifyResult.stagingRoot,
          archivePath: archivePathForMod(ctx.api, plan.manifest.game.id, installEntry),
          // The curator's declaration travels in the manifest. Without it the
          // judge refuses absent files outright, which is right for every mod
          // that did not opt in.
          ...(manifestEntry?.state?.postProcessed === true
            ? { postProcessed: true }
            : {}),
          ...(ctx.abortSignal !== undefined ? { signal: ctx.abortSignal } : {}),
              })
            : /**
               * Stale installer options: no file differs, so there is nothing
               * to ask the archive about. The verdict is already known — this
               * mod is not the collection's version of itself — and a
               * reinstall is exactly what fixes it.
               */
              {
                kind: "reinstall" as const,
                why:
                  "installed with different installer options than this " +
                  "collection records",
                // No archive was consulted: no file differed to ask about.
                archiveConsulted: false,
              };

        ehLog("info", "verify.judged", {
          name: installEntry.name,
          judgement: judgement.kind,
          why: judgement.why,
        });

        /**
          * ─── A DIFFERENT INSTALLER VARIANT IS NOT A PASS ────────────────
          * Reported, never reinstalled. The bytes ARE in the archive, so a
          * reinstall is not obviously wrong — but it replays the curator's
          * recorded choices, and where those cannot be replayed (NS-8) it
          * lands the same variant again, forever. So the user is told, and
          * decides.
          */
         if (judgement.kind === "variant-ambiguous") {
           curatorReports.push(
             `"${installEntry.name}" may be a different installer option than ` +
               `the curator's: ${judgement.paths.length} file(s) differ at ` +
               `path(s) this mod's archive can fill more than one way ` +
               `(for example ${judgement.paths.slice(0, 3).join(", ")}). ` +
               `Nothing is damaged — reinstalling would replay the curator's ` +
               `recorded answers, which may or may not change it.`,
           );
           verifications.push({
             kind: "ok",
             vortexModId: installEntry.vortexModId,
             compareKey: installEntry.compareKey,
             name: installEntry.name,
             level: declaredLevel === "thorough" ? "thorough" : "fast",
             verifiedFileCount: expectedFiles?.length ?? 0,
             extraFileCount: verifyResult.extraFiles.length,
             okReason: "variant-ambiguous",
           });
           continue;
         }

        if (
          judgement.kind === "curator-diverged" ||
          judgement.kind === "curator-only"
        ) {
          // The user's files ARE the archive's. Reinstalling would reproduce
          // exactly what is on disk, so it is pure cost. Recorded as ok, with
          // the divergence noted rather than hidden — the curator wants to
          // know their staging has drifted from what they ship.
          verifications.push({
            kind: "ok",
            vortexModId: installEntry.vortexModId,
            compareKey: installEntry.compareKey,
            name: installEntry.name,
            level: declaredLevel === "thorough" ? "thorough" : "fast",
            verifiedFileCount: expectedFiles?.length ?? 0,
            extraFileCount: verifyResult.extraFiles.length,
            // The receipt now says WHICH of the three "ok"s this is.
            okReason: judgement.kind,
          });
          continue;
        }

        // Reinstall warranted, or we could not tell — try ONE recovery cycle.
        const failSummary =
          verifyResult.kind === "fail"
            ? summarizeVerifyFail(verifyResult)
            : "installer options differ from the collection";
        ehLog("warn", "verify.failed", {
          name: installEntry.name,
          compareKey: installEntry.compareKey,
          summary: failSummary,
          missing:
            verifyResult.kind === "fail" ? verifyResult.missingFiles.length : 0,
          sizeMismatches:
            verifyResult.kind === "fail"
              ? verifyResult.sizeMismatches.length
              : 0,
          hashMismatches:
            verifyResult.kind === "fail"
              ? verifyResult.hashMismatches.length
              : 0,
          next: "judging whether a reinstall could change anything",
        });
        reportProgress(
          "verifying-mods",
          i + 1,
          installedMods.length,
          `Reinstalling "${installEntry.name}" (${failSummary})...`,
        );

        const retried = await tryRecoverFailedMod({
          ctx,
          installEntry,
          manifestEntry,
          activeProfileId: activeProfileId!,
          expectedFiles,
          level: declaredLevel,
          // Ours by construction if this run installed it, or by the journal
          // if an earlier run of this collection did.
          weInstalledIt:
            !installEntry.fromDecision.endsWith("already-installed") ||
            ownedByUs.has(installEntry.vortexModId),
          onTempArchive: (tempDir) => tempArchivesToCleanup.push(tempDir),
        });

        /**
         * ─── ADOPT THE NEW ID WHENEVER ONE EXISTS ───────────────────────
         * The repair uninstalled the old mod, so `installEntry.vortexModId`
         * now names something that is gone. Only the `recovered` branch used
         * to write the replacement back, which left `retry-failed` and a
         * failed re-verify pointing at a dead id — and EVERY later phase is
         * built from this array: the rules map, ini tweaks, modType restore,
         * the staging mirror, the receipt. Rules got dispatched at a deleted
         * mod and counted as applied, while the mod actually on disk received
         * none of them. Every file verified and the load order was wrong.
         */
        if (
          retried.kind !== "not-eligible" &&
          retried.kind !== "not-ours" &&
          retried.installEntry !== undefined
        ) {
          installedMods[i] = retried.installEntry;
          // The repair created this mod, so it is ours for any later run.
          if (!retried.installEntry.fromDecision.endsWith("already-installed")) {
            await appendJournalEntry(ctx.appDataPath, plan.manifest.package.id, {
              compareKey: retried.installEntry.compareKey,
              vortexModId: retried.installEntry.vortexModId,
              // The repair created this mod, so it is ours for any later run.
              kind: "installed",
              decision: retried.installEntry.fromDecision,
              at: new Date().toISOString(),
            });
          }
        }

        /**
         * ─── THEIR MOD STAYS; OURS GOES IN BESIDE IT ────────────────────
         * The mod is the user's and its files are not the curator's. We will
         * not touch it — but shipping their version as if it were the
         * collection's is the other way to be wrong, and it is silent.
         *
         * So the curator's copy is installed as a SECOND mod, named for this
         * collection and revision, and it is the one enabled in this profile.
         * Theirs is disabled HERE only; every other profile it belongs to is
         * untouched, because enablement is per-profile.
         */
        if (retried.kind === "not-ours") {
          const alongside = await tryInstallAlongside({
            ctx,
            installEntry,
            manifestEntry,
            activeProfileId: activeProfileId!,
            onTempArchive: (tempDir) => tempArchivesToCleanup.push(tempDir),
          });

          if (alongside !== undefined) {
            installedMods[i] = alongside;
            await appendJournalEntry(ctx.appDataPath, plan.manifest.package.id, {
              compareKey: alongside.compareKey,
              vortexModId: alongside.vortexModId,
              kind: "installed",
              decision: alongside.fromDecision,
              at: new Date().toISOString(),
            });
            // Re-verify OUR copy: an alongside install is a normal install and
            // earns no exemption from the check this project exists to run.
            const check = await verifyModInstall({
              api,
              gameId: plan.manifest.game.id,
              vortexModId: alongside.vortexModId,
              expectedFiles,
              level: declaredLevel,
              signal: ctx.abortSignal,
            }).catch(() => undefined);

            if (check?.kind === "ok") {
              noteVerifiedOk(alongside.compareKey, expectedFiles);
              verifications.push({
                kind: "ok",
                vortexModId: alongside.vortexModId,
                compareKey: alongside.compareKey,
                name: alongside.name,
                level: declaredLevel === "thorough" ? "thorough" : "fast",
                verifiedFileCount: check.verifiedCount,
                extraFileCount: check.extraFiles.length,
                retryAttempted: true,
              });
              continue;
            }
          }
          // Could not install a second copy — no archive, or the install
          // failed. Fall through to the honest failure report below; the
          // user's mod is still exactly where it was.
        }

        if (retried.kind === "recovered") {
          // Re-verified and passed, so the same proof holds as on the clean
          // path above.
          noteVerifiedOk(retried.installEntry.compareKey, expectedFiles);
          // installedMods[i] was already updated above, for every outcome
          // that produced a mod rather than only this one.
          verifications.push({
            kind: "ok",
            vortexModId: retried.installEntry.vortexModId,
            compareKey: retried.installEntry.compareKey,
            name: retried.installEntry.name,
            level: declaredLevel === "thorough" ? "thorough" : "fast",
            verifiedFileCount: retried.verifiedCount,
            extraFileCount: retried.extraFileCount,
            retryAttempted: true,
          });
          continue;
        }

        // Retry didn't help (or wasn't possible). This mod has now failed
        // against the curator's staging, failed against its ARCHIVE, and
        // survived a reinstall — so it is a real anomaly rather than one of
        // the ~11% that merely look like one, and it is worth the curator's
        // attention. Write the report they can send, so the user does not
        // have to compose one.
        // Before suggesting a re-download, ask whether one could possibly
        // help. The archive's own hash answers it for the cost of a hash
        // instead of a download: identical bytes mean the same request would
        // fetch the same file, and DIFFERENT bytes mean the mod was
        // re-uploaded under the same file id — which is the finding itself,
        // and which downloading again would not change either.
        const cachedHashes = await archiveHashCache();
        const archiveIdentity = await checkArchiveIdentity({
          archivePath: archivePathForMod(
            ctx.api,
            plan.manifest.game.id,
            installEntry,
          ),
          expectedSha256: manifestEntry?.source.sha256,
          ...(cachedHashes !== undefined ? { cache: cachedHashes } : {}),
          ...(ctx.abortSignal !== undefined ? { signal: ctx.abortSignal } : {}),
        });
        ehLog("warn", "install.archive-identity", {
          name: installEntry.name,
          verdict: archiveIdentity.kind,
          ...(archiveIdentity.kind === "differs"
            ? { expected: archiveIdentity.expected, actual: archiveIdentity.actual }
            : {}),
        });

        if (archiveIdentity.kind === "damaged") {
          // The archive itself is broken on this machine, so nothing about the
          // collection is in question and the curator has nothing to fix.
          // Downloading it again is the actual repair, and it is the user's to
          // make — so say that instead of handing them a report to send.
          damagedArchives.push(
            `"${installEntry.name}" — ${describeArchiveIdentity(archiveIdentity)}`,
          );
          verifications.push(
            buildFailReceipt({
              // The repair may have replaced this mod; name the one that is
              // actually on disk, not the id we deleted.
              installEntry: installedMods[i]!,
              // A stale-options mod reaches the repair with a PASSING file
              // check, so there is no failure object to report; synthesise the
              // empty one rather than claiming files differed.
              verifyResult:
                verifyResult.kind === "fail"
                  ? verifyResult
                  : {
                      kind: "fail",
                      missingFiles: [],
                      sizeMismatches: [],
                      hashMismatches: [],
                      extraFiles: verifyResult.extraFiles,
                      expectedCount: expectedFiles?.length ?? 0,
                      stagingRoot: "",
                    },
              level: declaredLevel === "thorough" ? "thorough" : "fast",
              // `errored` means the repair threw AFTER the uninstall, so an
              // attempt very much was made. Reporting that as "not attempted"
              // understated what happened to the user's disk.
              retryAttempted: retried.kind !== "not-eligible",
              modRemoved: retried.kind === "errored" && retried.modRemoved,
              // The file check PASSED. Without this the row reads
              // "0 missing, 0 truncated, 0 corrupt" under prose telling the
              // user to check their antivirus history.
              ...(verifyResult.kind !== "fail"
                ? { failReason: "stale-installer-options" as const }
                : {}),
            }),
          );
          continue;
        }

        /**
         * ─── A CURATOR REPORT IS FOR A CURATOR TO ACT ON ────────────────
         * Skipped entirely for a stale-options mod, because the report it
         * produced was both useless and self-contradicting.
         *
         * Useless: it is titled "this mod could not be reproduced" and its
         * body carries `missingFiles: []` and `differingFiles: []`, because
         * every file IS correct. There is nothing in the package for the
         * curator to fix — the mod on the user'''s machine was installed with
         * different FOMOD answers, which is a fact about that machine.
         *
         * Self-contradicting: `archiveChecked` reads `judgement.archiveConsulted`,
         * which the hand-written stale-options verdict sets false, so the
         * report said "it was not possible to compare them against the mod'''s
         * own archive" — and then `archiveNote`, two lines later, printed
         * "Checked against the mod'''s own archive: installed with different
         * installer options". Both sentences, same report.
         *
         * The USER is the person who can act on this, and the Done screen now
         * tells them so.
         */
        if (verifyResult.kind !== "fail") {
          ehLog("info", "verify.stale-options.no-curator-report", {
            mod: installEntry.name,
            compareKey: installEntry.compareKey,
            why:
              "every recorded file verified; the difference is the installer " +
              "answers on THIS machine, which the curator cannot change",
          });
          verifications.push(
            buildFailReceipt({
              installEntry: installedMods[i]!,
              verifyResult: {
                kind: "fail",
                missingFiles: [],
                sizeMismatches: [],
                hashMismatches: [],
                extraFiles: verifyResult.extraFiles,
                expectedCount: expectedFiles?.length ?? 0,
                stagingRoot: "",
              },
              level: declaredLevel === "thorough" ? "thorough" : "fast",
              retryAttempted: retried.kind !== "not-eligible",
              modRemoved: retried.kind === "errored" && retried.modRemoved,
              failReason: "stale-installer-options",
            }),
          );
          continue;
        }

        curatorReports.push(
          buildCuratorReport({
            packageName: plan.manifest.package.name,
            packageVersion: plan.manifest.package.version,
            modName: installEntry.name,
            modCompareKey: installEntry.compareKey,
            ...(manifestEntry?.version !== undefined
              ? { modVersion: manifestEntry.version }
              : {}),
            missingFiles:
              verifyResult.kind === "fail" ? verifyResult.missingFiles : [],
            differingFiles:
              verifyResult.kind === "fail"
                ? [
                    ...verifyResult.sizeMismatches.map((m) => m.path),
                    ...verifyResult.hashMismatches.map((m) => m.path),
                  ]
                : [],
            extraFiles: verifyResult.extraFiles,
            // When the user supplied the wrong archive, that IS the finding —
            // and the report says so instead of speculating about re-uploads.
            ...(suppliedArchiveMismatches.has(installEntry.compareKey)
              ? {
                  suppliedArchiveDiffers: suppliedArchiveMismatches.get(
                    installEntry.compareKey,
                  )!,
                }
              : {}),
            // Proves WHICH build produced this. A curator who rebuilt without
            // bumping the version has two different packages both calling
            // themselves v1.0.9, and the answer changes what the report means.
            // Hashed lazily and once: the package is ~150 MB, and reports are
            // rare by construction — a mod reaches here only after failing
            // against the manifest, its archive, AND a reinstall.
            ...(await packageIdentity()),
            archiveChecked:
              judgement.kind === "reinstall" && judgement.archiveConsulted,
            attempts: [
              "Verified against the file list the collection recorded",
              "Reinstalled from the archive and verified again",
              describeArchiveIdentity(archiveIdentity),
            ],
            archiveNote:
              judgement.kind === "reinstall"
                ? `Checked against the mod's own archive: ${judgement.why}`
                : `Could not consult the mod's archive: ${judgement.why}`,
            platform: describeHostForReport(),
          }),
        );

        // Keep the original mod entry and record the failure.
        verifications.push(
          buildFailReceipt({
            installEntry: installedMods[i]!,
            // A real file failure by construction: the stale-options arm
            // returned above, and tsc proves it — this ternary used to
            // synthesise an empty failure here, and its else branch is now
            // uninhabited.
            verifyResult,
            level: declaredLevel === "thorough" ? "thorough" : "fast",
            // Same reasoning as the damaged-archive receipt above: `errored`
            // is an attempt that reached the uninstall and then failed.
            retryAttempted: retried.kind !== "not-eligible",
            modRemoved: retried.kind === "errored" && retried.modRemoved,
          }),
        );
      }

      const failed = verifications.filter((v) => v.kind === "fail").length;
      const recovered = verifications.filter(
        (v) => v.kind === "ok" && v.retryAttempted === true,
      ).length;
      reportProgress(
        "verifying-mods",
        installedMods.length,
        installedMods.length,
        `Integrity check complete` +
          (failed > 0 ? ` — ${failed} mod(s) still failing` : "") +
          (recovered > 0 ? `, ${recovered} recovered via reinstall` : "") +
          ".",
      );

      aborted = checkAbort("verifying-mods");
      if (aborted) return aborted;
    } else if (installedMods.length > 0) {
      // verificationLevel === "none". Record a uniform skip for
      // every installed mod so the receipt's row count matches and
      // the Done card can render "Verification skipped (curator
      // didn't capture file snapshots)."
      for (const installEntry of installedMods) {
        verifications.push({
          kind: "skip",
          vortexModId: installEntry.vortexModId,
          compareKey: installEntry.compareKey,
          name: installEntry.name,
          reason: "verification-level-none",
        });
      }
    }

    // ── 5b. apply mod rules ─────────────────────────────────────────
    // Rules must land BEFORE plugins.txt + deploy: Vortex's
    // gamebryo-plugin-management runs LOOT auto-sort during deploy,
    // and LOOT picks up `state.persistent.mods[gameId][modId].rules`
    // when computing the topological sort. Applying rules later
    // would race the auto-sort and require a second deploy.
    //
    // Build the resolution map from EVERYTHING that ended up on the
    // user's machine for this collection: freshly installed mods
    // (`installedMods`), kept-existing carries (`carriedMods` from
    // the diverged-keep-existing path), already-installed re-uses
    // (the `*-already-installed` decisions surface via
    // `installedMods`), and orphan-keep carries. The map is the
    // single source of truth — `applyModRules` does not look anywhere
    // else.
    /**
     * ─── 5a2. OUR OWN COPY OF A MIRRORED MOD THE USER ALREADY OWNS ──────
     * This has to happen BEFORE `modIdByCompareKey` is built, and that
     * ordering is the whole point of it being a separate pass.
     *
     * It used to live inside the mirror loop (6c), which runs after the mod
     * rules, the INI tweaks, the modType restore and the Vortex LoadOrder
     * dispatch — all four of which resolve their target through the map built
     * on the line below. So for every mirrored mod the user already had, the
     * map still held THEIR mod id when those phases ran, and the swap
     * happened afterwards. The consequences were all silent:
     *
     *  - `applyModRules` attached the collection's conflict rules to their
     *    mod, which 6c then DISABLED — so our enabled copy carried no rules,
     *    the curator's conflict order was not reproduced, and `rules.applied`
     *    counted them as applied (NS-1).
     *  - `applyIniTweaks` enabled the tweak on their mod: a write into a mod
     *    Event Horizon did not install, which then never took effect because
     *    that mod is off.
     *  - `applyModTypeChanges` dispatched the curator's hand-set modType —
     *    `dinput` for SSE Engine Fixes, which deploys to the GAME ROOT — at
     *    their mod. Our copy kept Vortex's derived `""`, so the loose DLLs
     *    went to `Data`, nothing loaded them, and every file check still
     *    passed. And their mod's type stayed permanently changed, in all of
     *    the user's other profiles.
     *
     * The repair path already learned this lesson and writes
     * `installedMods[i] = retried.installEntry` BEFORE those phases; the
     * comment there names the same five consumers. This pass puts the
     * alongside install on the same side of the line.
     *
     * 6c is left with what it is actually for: reconciling the bytes.
     */
    const mirrorLines: string[] = [];
    const mirrorFailures: string[] = [];
    const mirrorSkipped: string[] = [];
    for (const mod of plan.manifest.mods) {
      if (mod.state.mirrored !== true) continue;
      if (ctx.abortSignal?.aborted === true) break;
      const idx = installedMods.findIndex(
        (m) => m.compareKey === mod.compareKey,
      );
      if (idx < 0) continue;
      const theirModId = installedMods[idx]!.vortexModId;
      // Already ours — installed by this run, or by an earlier one and
      // recovered from the journal or the receipt. Nothing to do.
      if (ownedByUs.has(theirModId)) continue;

      const ours = await tryInstallAlongside({
        ctx,
        installEntry: installedMods[idx]!,
        manifestEntry: mod,
        activeProfileId,
        onTempArchive: (dir) => tempArchivesToCleanup.push(dir),
      });
      if (ours === undefined) {
        // 6c will find it still not-ours and report the skip there, so the
        // reason reaches the user exactly once.
        ehLog("warn", "install.alongside.unavailable", {
          mod: mod.name,
          compareKey: mod.compareKey,
          theirModId,
          consequence:
            "the curator's archive could not be obtained, so this mod is " +
            "left exactly as the user had it and is NOT mirrored",
        });
        continue;
      }

      /**
       * ─── ONE VORTEX MOD, ONE COMPAREKEY — CHECKED, NOT ASSUMED ─────────
       * A Vortex mod's id IS its install name, and the alongside name is
       * deterministic. If two manifest mods ever produce the same name, the
       * second adopts the first's Vortex mod and this line quietly points two
       * compareKeys at one id — after which `buildPostInstallModIdMap` maps
       * both to it, modType and rules land on whichever ran last, and the
       * mirror rewrites that single staging folder to the second mod's file
       * list, DELETING the first mod's files behind a receipt row that still
       * says installed and verified.
       *
       * `alongsideInstallName` now carries a digest of (package id,
       * compareKey) inside its marker, so this cannot happen by truncation any
       * more. That is the fix; this is the assertion that the fix holds. The
       * failure mode is silent data loss, which is the kind worth paying a
       * linear scan for — and refusing to mirror one mod costs the user
       * nothing they cannot recover, which is the direction NS-2 points.
       */
      const aliased = installedMods.findIndex(
        (m, i) => i !== idx && m.vortexModId === ours.vortexModId,
      );
      if (aliased >= 0) {
        mirrorSkipped.push(
          `"${mod.name}" — its copy would collide with ` +
            `"${installedMods[aliased]!.name}", so it was left as you had it`,
        );
        ehLog("error", "install.alongside.name-collision", {
          mod: mod.name,
          compareKey: mod.compareKey,
          collidesWith: installedMods[aliased]!.name,
          collidesWithCompareKey: installedMods[aliased]!.compareKey,
          vortexModId: ours.vortexModId,
          consequence:
            "two mods in this collection resolved to ONE Vortex mod id. The " +
            "second is left exactly as the user had it and is NOT mirrored, " +
            "rather than overwriting the first mod's staging folder.",
        });
        continue;
      }

      await appendJournalEntry(ctx.appDataPath, plan.manifest.package.id, {
        compareKey: ours.compareKey,
        vortexModId: ours.vortexModId,
        kind: "installed",
        decision: "mirror-alongside",
        at: new Date().toISOString(),
      });
      ownedByUs.add(ours.vortexModId);
      installedMods[idx] = ours;

      mirrorLines.push(
        `"${mod.name}" — your own copy was left untouched; the collection ` +
          `installed its own copy beside it and uses that one.`,
      );
      ehLog("info", "install.mirror.alongside", {
        mod: mod.name,
        compareKey: mod.compareKey,
        theirModId,
        ourModId: ours.vortexModId,
      });
    }

    const modIdByCompareKey = buildPostInstallModIdMap(
      installedMods,
      carriedMods,
    );

    // Re-enable the curator's INI tweaks.
    //
    // Placed here rather than per-mod because it needs the finished
    // compareKey → local mod id map: a tweak has to be ticked against the mod
    // THIS install produced, and the manifest's own id belongs to the curator.
    //
    // A tweak is the most invisible thing a collection ships — no file in the
    // mod list, no plugin count change — so a missing one is only ever noticed
    // as the game running differently. Additive: nothing is ever un-ticked.
    const iniTweakApplication = applyIniTweaks({
      api,
      gameId: plan.manifest.game.id,
      installed: modIdByCompareKey,
      manifestMods: plan.manifest.mods,
    });

    // ── 6a. the user's own rules go first ───────────────────────────
    // Merging the collection's rules into whatever the user already had
    // produces an ordering that exists on nobody's machine but theirs, and
    // does it silently: every file verifies, and the game still loads
    // differently from the curator's. The collection's rule set has to BE the
    // rule set.
    //
    // Snapshotted to a file beside the receipt first. This removes rules on
    // mods outside the collection and rules belonging to the user's other
    // profiles of this game — Vortex stores neither per-profile — so it must
    // be something we can show them and undo.
    reportProgress("applying-mod-rules", 0, 1, "Clearing existing rules...");
    const ruleSnapshot = captureUserRuleState(api, plan.manifest.game.id);
    // Nothing of theirs to remove: no backup file, no CLEAR dispatch, no
    // notice. A fresh Vortex has no rules at all, and writing an empty JSON
    // on every install would leave a folder of files that restore nothing.
    const hasRulesToClear =
      ruleSnapshot.modRules.length > 0 ||
      (Array.isArray(ruleSnapshot.userlist.plugins) &&
        ruleSnapshot.userlist.plugins.length > 0) ||
      (Array.isArray(ruleSnapshot.userlist.groups) &&
        ruleSnapshot.userlist.groups.length > 0);
    let ruleBackupPath: string | undefined;
    try {
      if (hasRulesToClear) {
        ruleBackupPath = await writeRuleBackup(ctx.appDataPath, ruleSnapshot);
      }
    } catch (err) {
      // A backup we could not write is a reason to keep the user's rules, not
      // a reason to delete them without one.
      ehLog("warn", "rules.backup-failed", {
        why: err instanceof Error ? err.message : String(err),
      });
    }
    if (ruleBackupPath !== undefined) {
      const purge = purgeUserRuleState(api, plan.manifest.game.id, ruleSnapshot);
      ehLog("info", "rules.purged", {
        modRulesRemoved: purge.modRulesRemoved,
        modsTouched: purge.modsTouched,
        userlistCleared: purge.userlistCleared,
        failures: purge.failures.length,
        backup: ruleBackupPath,
      });
      const notice = describePurge(purge, ruleSnapshot, ruleBackupPath);
      if (notice !== undefined) rulesPurgeNotice = notice;
    } else {
      ehLog(hasRulesToClear ? "warn" : "info", "rules.purge-skipped", {
        why: hasRulesToClear
          ? "no backup could be written, so existing rules were left in place"
          : "the user had no rules of their own to clear",
      });
    }

    if (plan.manifest.rules.length > 0) {
      reportProgress(
        "applying-mod-rules",
        0,
        plan.manifest.rules.length,
        `Applying ${plan.manifest.rules.length} mod rule(s)...`,
      );

      const nexusIdIndex = buildNexusModIdMap(
        api,
        plan.manifest.game.id,
        installedMods,
        carriedMods,
      );
      const existingRulesBySourceModId = collectExistingRules(
        api,
        plan.manifest.game.id,
        modIdByCompareKey,
      );

      try {
        const ruleResult = applyModRules({
          api,
          gameId: plan.manifest.game.id,
          rules: plan.manifest.rules,
          modIdByCompareKey,
          modIdByNexusModId: nexusIdIndex.map,
          // Partial pins naming one of these cannot be resolved — several
          // variants of that Nexus mod are installed, and picking one would
          // apply a conflict rule to the wrong variant.
          ambiguousNexusModIds: nexusIdIndex.ambiguous,
          existingRulesBySourceModId,
          signal: ctx.abortSignal,
        });
        rulesApplication = mergeRuleResult(rulesApplication, ruleResult);
        /**
         * A phase that RAN and a phase that was skipped used to look identical
         * in the log — both silent. Tracing whether a curator's rules had
         * actually been applied meant opening the receipt JSON, which is not
         * something a tester sends first.
         */
        ehLog("info", "rules.applied", {
          applied: ruleResult.applied,
          skipped: ruleResult.skipped.length,
          overwrittenUserRules: ruleResult.overwrittenUserRules,
          ofManifest: plan.manifest.rules.length,
        });
        // Advance the bar to N/N so the UI doesn't sit at "0 of 137"
        // for the entire phase. applyModRules is currently a single
        // synchronous pass; if it ever grows incremental progress
        // we'd thread an onProgress callback instead.
        reportProgress(
          "applying-mod-rules",
          plan.manifest.rules.length,
          plan.manifest.rules.length,
          `Applied ${ruleResult.applied} mod rule(s)` +
            (ruleResult.skipped.length > 0
              ? ` (${ruleResult.skipped.length} skipped)`
              : "") +
            ".",
        );
      } catch (err) {
        if (
          isAbort(err) ||
          ctx.abortSignal?.aborted
        ) {
          return abortedResult(
              "applying-mod-rules",
              "Install aborted while applying mod rules.",
            );
        }
        /**
         * Mod-rule failures are non-fatal — they do not block the install.
         * But "continuing without rule application" means the collection's
         * CONFLICT ORDER is not reproduced, which is most of what a
         * collection is. That belongs in the log, not in devtools.
         */
        ehLog("error", "rules.apply.threw", {
          consequence:
            "continuing without rule application — the curator's conflict " +
            "order is NOT reproduced on this machine",
          err,
        });
      }

      aborted = checkAbort("applying-mod-rules");
      if (aborted) return aborted;
    }

    // ── 5c. apply LOOT userlist (slice 6d) ──────────────────────────
    // Plugin-to-plugin rules + group definitions + per-plugin group
    // assignments live in `state.userlist`, NOT in the mod-rules
    // slice we just wrote. They drive LOOT's `plugins.txt` ordering
    // — which is exactly what the curator's "the order I shipped"
    // intent maps to. Mod rules above only affect file-deployment
    // conflicts; without this phase the user gets the curator's
    // mod-conflict resolution but their own LOOT sort, and we'd
    // reproduce the "Vortex says rules applied, LOOT gives slightly
    // different order" report we set out to fix.
    //
    // Why before deploy: Vortex's gamebryo-plugin-management runs
    // `loot.sortPluginsAsync` during deploy. The sort call reads
    // `userlist.yaml` from disk; that file is updated synchronously
    // by `UserlistPersistor` whenever `state.userlist` changes. So
    // dispatch → reducer updates state → persistor writes YAML →
    // LOOT reads YAML at sort time. Running this phase after deploy
    // would either need a second deploy or leave the user with a
    // wrong sort until they deploy again.
    //
    // Why non-fatal: same rationale as `applying-mod-rules`. If
    // Vortex's userlist contract changed, we want to surface the
    // actionable error in `receipt.userlistApplication.skippedUserlistEntries`
    // rather than aborting an otherwise-successful install.
    const ulPlugins = plan.manifest.userlist.plugins.length;
    const ulGroups = plan.manifest.userlist.groups.length;
    if (ulPlugins > 0 || ulGroups > 0) {
      reportProgress(
        "applying-userlist",
        0,
        ulPlugins + ulGroups,
        `Applying LOOT userlist (${ulPlugins} plugin entr${ulPlugins === 1 ? "y" : "ies"}, ${ulGroups} group${ulGroups === 1 ? "" : "s"})...`,
      );

      try {
        const ulResult = applyUserlist({
          api,
          userlist: plan.manifest.userlist,
          signal: ctx.abortSignal,
        });
        userlistApplication = mergeUserlistResult(
          userlistApplication,
          ulResult,
        );
        /**
         * Same reason as `rules.applied`: a phase that ran and one that was
         * skipped looked identical in the log, and this is the phase that
         * decides load order. Diagnosing whether a curator's LOOT rules had
         * been applied meant opening the receipt JSON.
         *
         * The breakdown matters, not just a total: a package with 501 GROUP
         * assignments and zero plugin RULES constrains LOOT only coarsely,
         * which is most of why one install came out 686 plugins adrift.
         */
        ehLog("info", "userlist.applied", {
          rules: ulResult.appliedRuleCount,
          groupAssignments: ulResult.appliedGroupAssignmentCount,
          newGroups: ulResult.appliedNewGroupCount,
          groupRules: ulResult.appliedGroupRuleCount,
          skipped: ulResult.skipped.length,
          ofManifest: {
            plugins: plan.manifest.userlist.plugins.length,
            groups: plan.manifest.userlist.groups.length,
          },
        });
        const ulApplied =
          ulResult.appliedRuleCount +
          ulResult.appliedGroupAssignmentCount +
          ulResult.appliedNewGroupCount +
          ulResult.appliedGroupRuleCount;
        reportProgress(
          "applying-userlist",
          ulPlugins + ulGroups,
          ulPlugins + ulGroups,
          `Applied ${ulApplied} userlist entr${ulApplied === 1 ? "y" : "ies"}` +
            (ulResult.skipped.length > 0
              ? ` (${ulResult.skipped.length} skipped)`
              : "") +
            ".",
        );
      } catch (err) {
        if (
          isAbort(err) ||
          ctx.abortSignal?.aborted
        ) {
          return abortedResult(
              "applying-userlist",
              "Install aborted while applying LOOT userlist.",
            );
        }
        // Non-fatal — but the curator's LOOT rules are then absent, and the
        // user's load order is whatever LOOT decides on its own.
        ehLog("error", "userlist.apply.threw", {
          consequence:
            "continuing without userlist application — the curator's LOOT " +
            "rules are NOT applied",
          err,
        });
      }

      aborted = checkAbort("applying-userlist");
      if (aborted) return aborted;
    }

    // ── 6. plugins.txt (intentionally NOT written) ──────────────────
    // We deliberately do NOT overwrite plugins.txt directly. Locked
    // design choice: applying mod rules + LOOT userlist above lets
    // Vortex's gamebryo-plugin-management + LOOT auto-sort produce
    // the user's plugins.txt during deploy, using OUR rules + the
    // user's local LOOT masterlist + any mods the user has on top.
    //
    // This is the answer to the "LOOT gives a slightly different
    // load order than what the curator baked in" report: that drift
    // is *expected* — LOOT incorporates per-machine masterlist
    // updates and the user's own mods. Hard-pinning plugins.txt
    // would fight Vortex and re-introduce the drift on the next
    // deploy anyway.
    //
    // We still capture the manifest's plugin order into the receipt
    // (`baselinePluginOrder`) so the post-install summary can
    // surface a "your current order differs from collection's by N
    // plugins" hint. Drift detection is informational only — it
    // never blocks the user from making their own changes.
    //
    // The `writing-plugins-txt` driver phase used to live here as a
    // no-op barrier; it's been retired now that the rules-only
    // strategy is the locked design and there's nothing to write.
    // The previous `pluginsTxt.ts` writer module has been deleted.

    // ── 6b. put each mod back into the kind of mod the curator had ──
    //
    // Before the deploy, which is the only moment it is free: automatic
    // deployment is off (the install gate enforces that), so nothing has been
    // linked anywhere yet and the single deploy below puts every file in the
    // right folder first time.
    //
    // Vortex derives modType from the archive, and for most mods that answer
    // is right and this changes nothing. It cannot derive a type a human
    // SET — SSE Engine Fixes Part 2 is loose binaries that belong in the game
    // root and no rule recognises them, so a curator managing it through
    // Vortex has to pick the type by hand. Re-deriving on this machine would
    // answer "default" with total confidence and put the DLLs in Data, where
    // nothing loads them and every file check still passes.
    const modTypeChanges = applyModTypeChanges(
      ctx.api,
      plan.manifest.game.id,
      planModTypeChanges({
        installed: new Map(
          installedMods.map((m) => [m.compareKey, m.vortexModId] as const),
        ),
        currentTypes: readCurrentModTypes(ctx.api, plan.manifest.game.id),
        manifestMods: plan.manifest.mods,
      }),
      actions,
    );
    if (modTypeChanges.length > 0) {
      ehLog("info", "install.mod-types-restored", {
        count: modTypeChanges.length,
        changes: modTypeChanges
          .slice(0, 10)
          .map((c) => ({ mod: c.name, from: c.from, to: c.to })),
      });
    }

    // ── 6c. mirror the curator's staging folder, where they asked for it ──
    //
    // Same slot as the modType restore above, and for the same reason: the
    // deploy has not run, so staging is still the only copy. Correcting it
    // here means the deploy carries the corrected bytes out. After the deploy
    // we would be fixing staging while the game folder kept the version we
    // had just decided was wrong.
    //
    // A mod is mirrored only when its curator answered for it — this never
    // fires on its own.
    const mirroredWanted = plan.manifest.mods.filter(
      (m) => m.state.mirrored === true,
    ).length;
    // A phase that produces no line when it does nothing is a phase you
    // cannot tell from one that never ran. Both are normal; only one is a bug.
    if (mirroredWanted > 0) {
      ehLog("info", "install.mirror.phase.start", { mods: mirroredWanted });
    }
    /**
     * ─── ONE MOD'S MIRROR, CALLED FROM TWO PLACES ────────────────────────
     * Named rather than inlined in the loop below because the RETRY pass has
     * to run it too. A mod recovered after the deploy is installed by the same
     * `executeDecision` as any other, and it needs the same reconciliation —
     * but it did not exist when this loop ran, so it silently received none of
     * it and the receipt recorded a mirrored mod that was never mirrored.
     *
     * The body is unchanged from the loop it came out of; only `continue`
     * became `return`. Everything it touches — `installedMods`, `ownedByUs`,
     * `mirrorLines`, `mirrorSkipped`, `mirrorFailures`, `noteVerifiedOk` — is
     * the driver's own state, which is why this is a closure and not a module.
     */
    const mirrorOneMod = async (
      mod: (typeof plan.manifest.mods)[number],
    ): Promise<void> => {
      const installedIndex = installedMods.findIndex(
        (m) => m.compareKey === mod.compareKey,
      );
      let vortexModId =
        installedIndex >= 0 ? installedMods[installedIndex]!.vortexModId : undefined;
      if (vortexModId === undefined) {
        // Not installed by this run: it failed, or the user chose to keep
        // their own copy at a divergence prompt and it lives in carriedMods.
        // Both are legitimate; neither should be silent.
        mirrorSkipped.push(`"${mod.name}" — not installed by this run`);
        return;
      }

      /**
       * ─── ONLY MIRROR WHAT WE PUT THERE ──────────────────────────────
       * `applyMirrorPlan` overwrites files and DELETES the ones the curator's
       * listing does not mention. Pointed at a mod the user already had, that
       * is not reconciliation, it is destroying their work — and it was
       * reachable: a mod adopted as already-installed keeps the USER's
       * vortexModId in `installedMods`, and this loop looks the target up
       * from exactly there.
       *
       * The path that made it live: their copy fails verification, the repair
       * refuses it because the journal has no record of us installing it,
       * `tryInstallAlongside` cannot obtain the curator's archive, and this
       * loop then rewrites their folder anyway. One log line, no
       * confirmation, no undo. `installPlan.ts` promises the opposite two
       * phases earlier: "Old profile is byte-untouched".
       *
       * The repair already answers this question from the install journal.
       * The mirror asks the same question from the same source.
       */
      if (!ownedByUs.has(vortexModId)) {
        /**
         * Still theirs, so the alongside pass could not obtain the curator's
         * archive for it. Mirroring here would overwrite files and DELETE the
         * ones the curator's listing does not mention, in a mod Event Horizon
         * did not install — not reconciliation, destroying their work (NS-2).
         *
         * The install happens in pass 5a2, well before this loop, because
         * every phase that resolves a mod by compareKey — rules, INI tweaks,
         * modType, Vortex LoadOrder — runs between there and here and must
         * see OUR id, not theirs.
         */
        mirrorSkipped.push(
          `"${mod.name}" — this is your own copy of the mod, and the ` +
            `curator's version of its archive could not be obtained on this ` +
            `machine, so nothing was changed`,
        );
        ehLog("warn", "install.mirror.skipped-not-ours", {
          mod: mod.name,
          compareKey: mod.compareKey,
          vortexModId,
          why: "alongside install could not obtain the curator's archive",
        });
        return;
      }

      const stagingRoot = stagingRootForModId(
        ctx.api.getState(),
        plan.manifest.game.id,
        vortexModId,
      );
      if (stagingRoot === undefined) {
        mirrorSkipped.push(`"${mod.name}" — staging folder could not be resolved`);
        return;
      }

      try {
        const current = await hashStagingFiles(
          stagingRoot,
          await walkStagingFolder(stagingRoot, ctx.abortSignal),
          "thorough",
          undefined,
          ctx.abortSignal,
          () => undefined,
        );
        /**
         * The DETECTED mode, not the default.
         *
         * `planMirror` decides which of the user's files get deleted, and its
         * `caseMode` defaults to `insensitive` so existing callers kept the
         * behaviour they were written against. Leaving this call on that
         * default would have put the one deleting function in the codebase on
         * a hard-coded Windows answer — on a Proton install, merging two files
         * that both really exist and removing the wrong one.
         */
        const mirrorPlan = planMirror({
          target: mod.state.stagingFiles ?? [],
          current,
          caseMode: await detectCaseSensitivity(stagingRoot),
        });
        const outcome = await applyMirrorPlan({
          stagingRoot,
          ehcollPath: ctx.ehcollZipPath,
          plan: mirrorPlan,
          ...(ctx.abortSignal !== undefined
            ? { signal: ctx.abortSignal }
            : {}),
        });
        const line = describeMirrorOutcome(mod.name, outcome);
        if (line !== undefined) mirrorLines.push(line);
        if (outcome.failures.length > 0) mirrorFailures.push(mod.name);

        // A clean mirror is a PROOF, and without recording it the mod gets no
        // drift reference at all.
        //
        // `stagingSetHashFor` only writes one for a mod whose verification
        // passed — and a mirrored mod fails verification by construction,
        // because verification runs before this and compares the archive's
        // output against the curator's files, which is exactly the difference
        // mirroring exists to remove. So without this the receipt would carry
        // no oracle for precisely the mods most likely to be disturbed later,
        // and Doctor could never notice a reinstall had wiped one.
        //
        // The claim is only legitimate when the folder now equals the target
        // EXACTLY: nothing unverifiable (every file had a hash to check),
        // nothing failed (every write landed and was hash-checked on arrival),
        // and no removal withheld (no extra files left behind). Any one of
        // those and the disk is merely closer, not identical, and a drift
        // reference for a disk we did not prove is the fiction the receipt
        // rules already refuse elsewhere.
        if (mirrorProvesTarget(mirrorPlan, outcome)) {
          noteVerifiedOk(mod.compareKey, mod.state.stagingFiles);
        }
        if (mirrorPlan.removalWithheld !== undefined) {
          ehLog("info", "install.mirror-removal-withheld", {
            mod: mod.name,
            extra: mirrorPlan.removalWithheld.count,
          });
        }
      } catch (err) {
        // One mod's mirror failing is not the install's problem: the mod is
        // installed, it simply does not match the curator's copy, and saying
        // so is more use than aborting everything around it.
        mirrorFailures.push(mod.name);
        mirrorLines.push(
          `"${mod.name}": could not be mirrored — ${formatError(err)}`,
        );
      }
    };

    for (const mod of plan.manifest.mods) {
      if (mod.state.mirrored !== true) continue;
      if (ctx.abortSignal?.aborted === true) break;
      await mirrorOneMod(mod);
    }
    /**
     * Unconditional when anything was meant to be mirrored. The old line fired
     * only when something CHANGED, so "50 mods mirrored perfectly", "50 mods
     * skipped", and "the phase never ran" were the same empty log — and the
     * empty case is the failure case.
     */
    if (mirroredWanted > 0) {
      ehLog(
        mirrorFailures.length > 0 || mirrorSkipped.length > 0 ? "warn" : "info",
        "install.mirror.phase.done",
        {
          wanted: mirroredWanted,
          applied: mirrorLines.length,
          failed: mirrorFailures.length,
          skipped: mirrorSkipped.length,
          lines: mirrorLines.slice(0, 10),
          skippedExamples: mirrorSkipped.slice(0, 10),
        },
      );
    }

    /**
     * ─── THE LAST CHANCE TO STOP ────────────────────────────────────────
     * The mirror loop `break`s on a stop, leaving the remaining mods
     * unreconciled — and there was NO abort observation between that break
     * and the deploy below. So a user who pressed Stop during mirroring got
     * the half-mirrored bytes linked into their game folder and a full
     * success receipt claiming all of them were installed, and
     * `finishingSkipped` could not name it because that array does not exist
     * until after the deploy.
     *
     * The last pre-deploy check before this was `applying-userlist`, roughly
     * three hundred lines and two write phases earlier. Here it is safe and
     * correct to unwind: nothing is deployed yet, so returning `aborted`
     * abandons nothing (NS-2).
     */
    aborted = checkAbort("mirroring");
    if (aborted) return aborted;

    // ── 7. deploy ───────────────────────────────────────────────────
    reportProgress("deploying", 0, 1, "Deploying mods...");

    try {
      await deployAndWait(api, activeProfileId);
    } catch (err) {
      return {
        kind: "failed",
        phase: "deploying",
        partialProfileId: ehProfileId,
        error: `Deployment failed: ${formatError(err)}`,
        installedSoFar: installedMods.map((m) => m.vortexModId),
      };
    }

    /**
     * ─── PAST HERE, A STOP CANNOT UNDO ANYTHING ─────────────────────────
     * The deploy has run: the collection is on disk and linked into the game
     * folder. What follows is finishing work — pinning the plugin order,
     * restoring ESL flags, writing the game INI — and the receipt that records
     * the whole install comes last.
     *
     * That made an abort here genuinely awkward, and the code answered it by
     * not asking: FIVE phases ran with no signal check at all, two of them not
     * even taking the signal, so pressing Stop in the last quarter of an
     * install did nothing and said nothing.
     *
     * Unwinding instead would be worse — a fully deployed collection with no
     * receipt is the one state provenance depends on not existing (NS-2). So
     * the answer is the third one: stop WRITING to the user's machine, carry
     * on to the receipt, and name the steps that were skipped.
     *
     * The two remaining post-deploy phases are read-only checks (did the order
     * come out right, did each mod install as the right kind) and are left to
     * run: they cost a file read, they change nothing, and skipping them would
     * only make the receipt less informative.
     */
    const finishingSkipped: string[] = [];
    const stopBeforeWriting = (phase: string): boolean => {
      if (ctx.abortSignal?.aborted !== true) return false;
      finishingSkipped.push(phase);
      ehLog("info", "install.finishing.skipped-after-stop", {
        phase,
        why: "the user stopped the run; the mods are already deployed",
      });
      return true;
    };

    /**
     * NO `checkAbort("deploying")` here, and that is the point.
     *
     * It used to sit exactly here — immediately after `deployAndWait` — and
     * returned `kind: "aborted"` with no receipt. But the deploy has just
     * COMPLETED: every mod is installed, enabled, and linked into the game
     * folder. Abandoning at this line left a fully installed collection that
     * Vortex has no record of, which is the state provenance depends on not
     * existing (NS-2) and the one a user cannot recover from by re-running.
     *
     * So this is the point of no return. A stop from here on stops the
     * remaining WRITES (see `stopBeforeWriting`) and the run finishes its
     * bookkeeping, reporting which steps it skipped.
     *
     * There is deliberately no `if (aborted) return aborted;` here. One
     * survived the removal of its assignment and sat under this very comment,
     * reading as a live guard — an invitation for the next person to add a
     * pre-deploy `aborted =` without an immediate return and resurrect the
     * abandoned-deploy bug one line below the paragraph explaining why it
     * must not exist.
     */

    // ── 7b. apply Vortex per-game LoadOrder ─────────────────────────
    // Distinct from plugins.txt: this is Vortex's generic LoadOrder
    // API for non-plugin payloads (script extenders, ENB binaries,
    // generic-game mods on titles like Starfield). Applied AFTER
    // deploy because Vortex registers loose-archive mods during the
    // deploy pass — we want the LoadOrder dispatch to land on a
    // fully-populated mod table.
    // The hive is keyed by PROFILE, so without one there is nowhere correct
    // to write. Skipping loudly beats writing to a pseudo-profile key that
    // nothing reads and that then lives in the user's state forever.
    if (plan.manifest.loadOrder.length > 0 && activeProfileId === undefined) {
      ehLog("warn", "loadorder.skipped.no-profile", {
        entries: plan.manifest.loadOrder.length,
      });
    }
    /**
     * ─── A WRITER, GATED LIKE THE OTHER WRITERS ─────────────────────────
     * `applyLoadOrder` dispatches into Vortex's per-game LoadOrder hive, so
     * it writes. The point-of-no-return comment above used to describe the
     * two remaining post-deploy phases as read-only, and this one is not —
     * which is why it still carried abort returns of its own long after the
     * deploy's had been removed.
     *
     * Now a stop skips it and NAMES it, like plugin order, ESL flags and game
     * settings, instead of abandoning a deployed collection with no receipt
     * (NS-2).
     */
    if (
      plan.manifest.loadOrder.length > 0 &&
      activeProfileId !== undefined &&
      !stopBeforeWriting("Vortex load order")
    ) {
      reportProgress(
        "applying-load-order",
        0,
        plan.manifest.loadOrder.length,
        `Applying load order (${plan.manifest.loadOrder.length} entries)...`,
      );

      try {
        const loResult = applyLoadOrder({
          api,
          profileId: activeProfileId,
          entries: plan.manifest.loadOrder,
          modIdByCompareKey,
          displayNameByModId: buildDisplayNameByModId(
            installedMods,
            carriedMods,
          ),
          signal: ctx.abortSignal,
        });
        rulesApplication = mergeLoadOrderResult(rulesApplication, loResult);
        reportProgress(
          "applying-load-order",
          plan.manifest.loadOrder.length,
          plan.manifest.loadOrder.length,
          `Applied ${loResult.applied} load order entr${loResult.applied === 1 ? "y" : "ies"}` +
            (loResult.skipped.length > 0
              ? ` (${loResult.skipped.length} skipped)`
              : "") +
            ".",
        );
      } catch (err) {
        /**
         * No `return abortedResult(...)` here either, and this was the more
         * dangerous of the two abort returns in this phase: the condition was
         * `AbortError` OR `ctx.abortSignal?.aborted`, so once the user had
         * pressed Stop, ANY throw out of `applyLoadOrder` — not just a
         * genuine abort — returned `kind: "aborted"` for a collection that
         * was already deployed, with no receipt written.
         *
         * Past the deploy an abort is not an unwind. It is a skipped write,
         * and the run still owes the user a receipt.
         */
        const stopped =
          isAbort(err) ||
          ctx.abortSignal?.aborted === true;
        if (stopped) {
          finishingSkipped.push("Vortex load order");
          ehLog("warn", "loadorder.apply.stopped", {
            consequence:
              "you stopped the install while the load order was being " +
              "applied — the curator's order is NOT reproduced, and running " +
              "the install again applies it",
          });
        } else {
          // Non-fatal — but the load order is then the user's, not the
          // curator's, which for a Bethesda game decides whether it starts.
          ehLog("error", "loadorder.apply.threw", {
            consequence:
              "continuing without load-order application — the curator's " +
              "order is NOT reproduced",
            err,
          });
        }
      }

      /**
       * ─── NO ABORT CHECK HERE ────────────────────────────────────────
       * This ran AFTER `deployAndWait`. Returning `aborted` past the deploy
       * abandons a collection that is installed, enabled and linked into the
       * game folder, with NO receipt — so nothing knows the mods are ours,
       * "Uninstall this collection" cannot find them, and the next run
       * resolves a fresh profile (NS-2).
       *
       * That is the exact hole alpha.116 was written to close, and it closed
       * the one at `checkAbort("deploying")` while leaving this one, one
       * phase later, doing the same thing. The e2e written alongside it could
       * not catch it: its fixture's `loadOrder` is empty, so the test never
       * enters this block.
       *
       * Past the deploy a stop skips the remaining WRITES and the run
       * finishes its bookkeeping — see `stopBeforeWriting`. The load order is
       * a write, so it is gated there, not here.
       */
    }

    // Record the curator's plugin order in the receipt.
    //
    // Always, even when LoadOrder is empty. Nothing reads it back yet — the
    // drift check it was recorded for was never built — but it is the only
    // record of what the order was supposed to be, and it costs one array.
    rulesApplication = {
      ...rulesApplication,
      baselinePluginOrder: plan.manifest.plugins.order.map(
        (p): ReceiptPluginEntry => ({
          name: p.name,
          enabled: p.enabled,
          // Carried, not dropped: Doctor cannot check a flag it was never
          // told about, and this is the boundary where it used to be lost.
          ...(p.light !== undefined ? { light: p.light } : {}),
        }),
      ),
      // And which header bit those values came from, so Doctor can refuse to
      // judge or restore them in a game where that bit is not "light".
      ...(plan.manifest.plugins.lightFlagBit !== undefined
        ? { baselineLightFlagBit: plan.manifest.plugins.lightFlagBit }
        : {}),
    };

    // ── 7b0. put the curator's plugin order on disk ────────────────────
    //
    // This used to be "detect, don't pin", on the premise that plugins.txt
    // cannot be written because Vortex and LOOT regenerate it. The premise was
    // wrong: the old writer wrote the FILE, which Vortex owns, while the
    // supported route is to write the STATE and let Vortex persist it —
    // `PluginPersistor.syncFromState` exists for exactly this and its error
    // string names collection installs.
    //
    // Pin first, then sort. LOOT is fed the current order as its tiebreak, so
    // pinning makes the curator's order the baseline and the sort then lifts
    // the user's own plugins into their correct places instead of leaving them
    // stranded at the end. And if the sort fails — a rule cycle is the
    // expected way — the pinned order still stands and still gets written,
    // which is what makes this safe to attempt at all.
    reportProgress(
      "applying-load-order",
      0,
      1,
      `Applying the collection's plugin order (${plan.manifest.plugins.order.length})...`,
    );
    const pluginOrderApplication = stopBeforeWriting("plugin order")
      ? ({
          pinned: false,
          sorted: false,
          writeRequested: false,
          enabledCorrections: 0,
          notes: ["skipped: you stopped the install"],
        } as PluginOrderApplication)
      : await applyPluginOrder({
      api,
      gameId: plan.manifest.game.id,
      collectionId: plan.manifest.package.id,
      order: plan.manifest.plugins.order,
      ...(ctx.abortSignal !== undefined ? { signal: ctx.abortSignal } : {}),
    });
    ehLog("info", "plugins.order-applied", {
      pinned: pluginOrderApplication.pinned,
      sorted: pluginOrderApplication.sorted,
      writeRequested: pluginOrderApplication.writeRequested,
      enabledCorrections: pluginOrderApplication.enabledCorrections,
      notes: pluginOrderApplication.notes,
    });

    // ── 7b0b. restore the curator's ESL / light flags ──────────────────
    //
    // Load-bearing, not cosmetic: regular plugins are addressed with one byte,
    // so 254 can load, and light ones share the FE index for free. The
    // profile this was built for fits 817 plugins only because 573 are light —
    // 244 regular against a limit of 254. Eleven missing flags and the game
    // does not start.
    //
    // The flag lives inside the plugin file, so a curator who marks one light
    // after installing has a staged file the archive does not contain. Nothing
    // downstream catches that: verification sees different bytes, the archive
    // check finds the user's copy matches the archive exactly, and it is
    // accepted as curator divergence — correct for every other difference, and
    // fatal for this one. Hence carried explicitly.
    //
    // After the order is applied, because both write files the game reads and
    // this one must land on the deployed copy.
    /**
     * Whether the repair actually RAN.
     *
     * The skipped value is a zeroed `PluginFlagRepair`, and a zeroed struct is
     * indistinguishable from "checked, and every flag was already correct" —
     * which is the wrong default for the one step that decides whether the
     * game starts at all. `describePluginFlagRepair` falls through every
     * branch on it and returns no notice, and the log said `corrected: 0` as
     * though it were a finding.
     *
     * The user now learns it from `finishingSkippedNotice`, which names "ESL
     * flags"; this flag keeps the LOG honest about the same thing.
     */
    const pluginFlagRepairRan = !stopBeforeWriting("ESL flags");
    const pluginFlagRepair = !pluginFlagRepairRan
      ? // Typed, NOT cast. An `as unknown as` here hid a shape mismatch —
        // `failures` was missing and `missing` had the wrong type — and the
        // driver threw on the very path this guard exists to make safe.
        ({
          corrected: 0,
          set: 0,
          cleared: 0,
          correctedNames: [],
    changes: [],
          alreadyCorrect: 0,
          unknown: 0,
          missing: 0,
          unreadable: [],
          failures: [],
          regularAfter: 0,
        } satisfies PluginFlagRepair)
      : await applyPluginLightFlags({
      order: plan.manifest.plugins.order,
      dataDir: gameDataDirFor(api, plan.manifest.game.id),
      gameId: plan.manifest.game.id,
      recordedLightFlagBit: plan.manifest.plugins.lightFlagBit,
      ...(ctx.abortSignal !== undefined ? { signal: ctx.abortSignal } : {}),
      onProgress: (done, total) => {
        reportProgress(
          "applying-load-order",
          done,
          total,
          `Checking plugin ESL flags (${done}/${total})...`,
        );
      },
    });
    /**
     * This is the only step in the whole install that modifies bytes inside
     * the user's game folder, and it used to log counts alone — `corrected: 7`
     * and nothing else. A user reporting "a plugin is light and should not be"
     * produced a log that could not name a single file, and the two directions
     * (which have opposite consequences) were one number.
     */
    if (!pluginFlagRepairRan) {
      ehLog("warn", "plugins.light-flags.skipped", {
        consequence:
          "you stopped the install, so the ESL flags were NOT checked. This " +
          "is not the same as finding them all correct: if the game refuses " +
          "to start, run the install again and let it finish.",
      });
    } else
    ehLog(pluginFlagRepair.refused !== undefined ? "warn" : "info", "plugins.light-flags", {
      gameId: plan.manifest.game.id,
      // Which bit the package says its values came from (absent = a build
      // from before flags were per game), which bit was written, and why
      // nothing was, when nothing was.
      recordedLightFlagBit: plan.manifest.plugins.lightFlagBit,
      lightFlagBit: pluginFlagRepair.lightFlagBit,
      refused: pluginFlagRepair.refused,
      regularLimit: pluginFlagRepair.regularLimit,
      corrected: pluginFlagRepair.corrected,
      set: pluginFlagRepair.set,
      cleared: pluginFlagRepair.cleared,
      // Capped: a large run is itself the signal, and 573 names is not a log
      // line anyone reads.
      correctedNames: pluginFlagRepair.correctedNames.slice(0, 50),
      alreadyCorrect: pluginFlagRepair.alreadyCorrect,
      unknown: pluginFlagRepair.unknown,
      missing: pluginFlagRepair.missing,
      unreadable: pluginFlagRepair.unreadable,
      regularAfter: pluginFlagRepair.regularAfter,
      failures: pluginFlagRepair.failures,
    });

    // ── 7b1. did the load order actually come out like the curator's? ──
    //
    // Still measured, and now it means more than it did: with the order pinned
    // and LOOT re-sorted on top, a remaining difference is LOOT actively
    // disagreeing with the curator — a master-order violation, or a masterlist
    // newer than theirs — rather than nobody having tried. Read from disk
    // AFTER the write above, so it reports what the game will actually load.
    let pluginOrderDrift = emptyPluginOrderDrift();
    /**
     * ─── IS THE NUMBER ABOVE A MEASUREMENT, OR THE ONE FROM BEFORE? ──────
     * Set when the re-pin's write was dispatched but plugins.txt never came
     * back matching it. `pluginOrderDrift` then still holds the PRE-re-pin
     * value, and reporting that unqualified tells the user to press Sort in
     * Vortex — the single action the re-pin exists to undo.
     *
     * Declared out here rather than beside the poll because it was block-
     * scoped there, which made it unreadable by the notice and the receipt
     * that need it: assigned in one place, read in none.
     */
    let repinUnconfirmed = false;
    try {
      const actual = await readUserPluginsTxt(
        plan.manifest.game.id,
        discoveredStore(api.getState(), plan.manifest.game.id),
      );
      if (actual !== undefined) {
        pluginOrderDrift = comparePluginOrder(
          plan.manifest.plugins.order,
          actual,
        );

        /**
         * ─── PIN, SORT, THEN GIVE THE CURATOR THEIR ORDER BACK ───────────
         * The sort exists because the user has plugins the curator never had,
         * and LOOT knows where those belong. But it does not know it is
         * finishing someone else's work, so it re-sorts everything — and on a
         * real 1,755-mod install that left 686 of 1,600 plugins in a different
         * relative order from the curator's, after the pin had already run.
         *
         * So the slots LOOT gave to the COLLECTION's plugins are refilled with
         * the curator's sequence, and every other plugin stays exactly where
         * LOOT put it. Neither side loses: LOOT places what the curator never
         * saw, the curator wins on everything they did.
         *
         * Only when it would change something — re-pinning an order that
         * already matches costs a Vortex round trip and a plugins.txt rewrite
         * for nothing.
         */
        if (pluginOrderDrift.misordered.length > 0 && !stopBeforeWriting(
          "plugin order re-pin",
        )) {
          /**
           * ─── THE FULL LISTS, AND THE REAL ENABLED FLAGS ─────────────
           * Both sides were filtered to ENABLED, and the merged result was
           * then handed to `applyPluginOrder` with every entry marked
           * `enabled: true`. Two separate faults came out of that:
           *
           *  1. `set-plugin-list` APPENDS anything the list omits, so every
           *     DISABLED plugin — the curator's and the user's alike — was
           *     swept to the tail of plugins.txt. Invisible, because
           *     `comparePluginOrder` only compares enabled plugins, so the
           *     drift report said the order matched. The user who later ticks
           *     an optional patch the curator shipped disabled gets it loading
           *     last instead of where the curator put it.
           *
           *  2. The fabricated `enabled: true` fed `applyPluginOrder`'s
           *     enabled-corrections step, which dispatches whenever the flag
           *     it is given differs from Vortex's stored one. A plugin the
           *     curator had deliberately switched OFF would be switched back
           *     ON and written to disk — one such plugin is enough to change
           *     what the game does, and that is the exact hazard the pin step
           *     passes `setEnabled: false` to avoid.
           *
           * The re-pin is an ORDERING operation. It has no business asserting
           * enabled state at all, so it now carries each plugin's real flag
           * and its assertion is a no-op by construction.
           */
          const actualNames = actual.map((pl) => pl.name);
          const enabledByName = new Map(
            actual.map((pl) => [pl.name.toLowerCase(), pl.enabled] as const),
          );
          const merged = repinCuratorOrder(
            plan.manifest.plugins.order.map((pl) => pl.name),
            actualNames,
          );
          if (orderDiffers(merged, actualNames)) {
            const repin = await applyPluginOrder({
              api,
              gameId: plan.manifest.game.id,
              collectionId: plan.manifest.package.id,
              // The merged sequence, and NO second sort — sorting again would
              // undo exactly what this step just restored.
              order: merged.map((name) => ({
                name,
                // Vortex's own answer for this plugin, not an assertion of
                // ours. `?? true` covers a name Vortex has no entry for, and
                // the corrections step skips those anyway.
                enabled: enabledByName.get(name.toLowerCase()) ?? true,
              })),
              skipSort: true,
              ...(ctx.abortSignal !== undefined
                ? { signal: ctx.abortSignal }
                : {}),
            });
            ehLog("info", "plugins.order-repinned", {
              misorderedBefore: pluginOrderDrift.misordered.length,
              entries: merged.length,
              pinned: repin.pinned,
              writeRequested: repin.writeRequested,
              notes: repin.notes,
            });

            /**
             * ─── WAIT FOR THE WRITE, THEN MEASURE ───────────────────────
             * Re-measuring against disk is right; doing it immediately was
             * not. `applyPluginOrder` with `skipSort: true` emits
             * `set-plugin-list` and `collection-postprocess-complete` and
             * returns without awaiting anything — the emits are
             * fire-and-forget, and Vortex's persistor flushes to plugins.txt
             * asynchronously. So the read landed a few microtasks later and
             * returned the file LOOT had left.
             *
             * The result was the worst available: `pluginOrderDrift` was
             * overwritten with the BEFORE number, the log recorded the re-pin
             * as having achieved nothing, and the user notice built from it
             * told them to sort their plugins in Vortex — the one action that
             * destroys the order the re-pin had just restored.
             *
             * (The FIRST drift read gets away with an immediate read only by
             * accident: `applyPluginLightFlags` does hundreds of file reads
             * between that emit and it.)
             *
             * So poll until the file on disk matches what we asked for, and
             * if it never does, say the number is UNVERIFIED rather than
             * reporting a measurement of a write that had not happened.
             */
            const repinDeadline = Date.now() + 15_000;
            let after: PluginOrderEntry[] | undefined;
            let repinLanded = false;
            for (;;) {
              after = await readUserPluginsTxt(
                plan.manifest.game.id,
                discoveredStore(api.getState(), plan.manifest.game.id),
              );
              if (
                after !== undefined &&
                !orderDiffers(
                  after.map((pl) => pl.name),
                  merged,
                )
              ) {
                repinLanded = true;
                break;
              }
              if (Date.now() >= repinDeadline) break;
              await delay(250);
            }

            if (repinLanded && after !== undefined) {
              pluginOrderDrift = comparePluginOrder(
                plan.manifest.plugins.order,
                after,
              );
              ehLog("info", "plugins.order-drift.after-repin", {
                compared: pluginOrderDrift.compared,
                misordered: pluginOrderDrift.misordered.length,
              });
            } else {
              repinUnconfirmed = true;
              ehLog("warn", "plugins.order-repin.unconfirmed", {
                waitedMs: 15_000,
                readBack: after === undefined ? "unreadable" : "did-not-match",
                consequence:
                  "the re-pinned order was written to Vortex but plugins.txt " +
                  "did not come back matching it within the wait, so the " +
                  "drift number below is NOT a measurement of the re-pin — " +
                  "it is the number from before it, and may be wrong in " +
                  "either direction",
              });
            }
          }
        }
        /**
         * ─── THE ONE NUMBER THAT SAYS WHETHER REPRODUCTION WORKED ───────
         * This comment used to say the line was "for a support conversation
         * about someone else's machine" — and then called `reportProgress`,
         * which is `ctx.onProgress?.()` and nothing else. Both consumers put
         * it in transient UI, so the next progress event overwrote it and it
         * was gone. The APPLY step logged fine, so the log said the order was
         * pinned, sorted and written, and never said whether it came out
         * right: exactly the "the file has the same lines" versus "the setup
         * reproduced" gap, on the wrong side of the log-alone rule.
         */
        ehLog("info", "plugins.order-drift", {
          compared: pluginOrderDrift.compared,
          misordered: pluginOrderDrift.misordered.length,
          missing: pluginOrderDrift.missing.length,
          extra: pluginOrderDrift.extra.length,
          examples: pluginOrderDrift.misordered.slice(0, 5).map((m) => m.name),
        });
        reportProgress(
          "deploying",
          1,
          1,
          `Load order: ${pluginOrderDrift.misordered.length} of ` +
            `${pluginOrderDrift.compared} plugins differ from the curator's.`,
        );
      } else {
        // Distinct from "0 of 412 drifted". Without this the log cannot tell
        // a clean order from a check that never ran.
        ehLog("info", "plugins.order-drift.not-checked", {
          gameId: plan.manifest.game.id,
          why: "this game has no plugins.txt we can read",
        });
      }
    } catch (err) {
      // A plugins.txt we cannot read is not a reason to fail an install that
      // otherwise succeeded — it only means this one check has no answer. But
      // silence here reads identically to "no drift", so say which it was.
      ehLog("warn", "plugins.order-drift.unreadable", {
        gameId: plan.manifest.game.id,
        err,
      });
    }

    // Final sweep, at the same point Vortex's own collection post-processing
    // does it: plugin enablement has just been set from the manifest, so any
    // surviving "contains multiple plugins" prompt is answering a question
    // that is now decided.
    const cleared = dismissNoisyNotifications(ctx.api);
    if (cleared > 0) {
      ehLog("info", "notifications.dismissed", { count: cleared });
    }

    ehLog("info", "install.phase", { phase: "checking-mod-types" });

    // ── 7b2. did each mod install as the right KIND of mod? ─────────
    // Vortex derives modType from the archive and we do not override it —
    // it owns the concept. But when its answer differs from the curator's,
    // the files deploy to a different folder while every file check passes,
    // and for a script extender that means the game simply launches without
    // it. Noticing is the whole contribution here.
    // Still checked AFTER the deploy, and now it means something different:
    // the corrections above already ran, so anything left is a type this
    // machine would not accept rather than one nobody tried to set.
    const modTypeMismatches = findModTypeMismatches({
      api: ctx.api,
      gameId: plan.manifest.game.id,
      installed: new Map(
        installedMods.map((m) => [m.compareKey, m.vortexModId] as const),
      ),
      manifestMods: plan.manifest.mods,
    });

    // ── 7c. game INI settings ───────────────────────────────────────
    // The collection states a starting configuration ONCE per release. The
    // previous receipt is what remembers that, because after this the file is
    // the user's: re-applying on a later run would silently revert whatever
    // they changed since, and that is the one behaviour they would not
    // forgive.
    let gameIniApplication: GameIniApplicationReceipt | undefined;
    /**
     * ─── A FAILED ATTEMPT IS NOT AN APPLICATION ─────────────────────────
     * Kept OUT of the receipt deliberately, and separate from
     * `gameIniApplication` for one reason: `shouldApplyGameIni` decides
     * whether to run at all by testing `previous.gameIniApplication !==
     * undefined` — presence, not success. So a zeroed record written after a
     * failure satisfies that guard forever, and the curator's settings are
     * never applied again for this release.
     *
     * The stop path a few lines below already records `undefined` for exactly
     * this reason, in a docblock that says so. The catch wrote the stub
     * anyway, and the failure it fires on is the recoverable kind: the game is
     * running, or OneDrive holds a lock on Documents\My Games. The user closes
     * the game, re-runs the same version to fix it — which is the natural
     * remedy — and the phase silently never runs. Only a new release clears it.
     *
     * The notice still reads from this, so the user is told what failed. The
     * receipt simply does not claim the settings were applied.
     */
    let gameIniFailure: GameIniApplicationReceipt | undefined;
    if (
      shouldApplyGameIni({
        gameIni: plan.manifest.gameIni,
        packageVersion: plan.manifest.package.version,
        ...(plan.previousInstall !== undefined
          ? { previous: plan.previousInstall }
          : {}),
      })
    ) {
      reportProgress("writing-receipt", 0, 1, "Applying game settings...");
      try {
        /**
         * A skipped phase records NOTHING, rather than a zeroed receipt.
         *
         * `shouldApplyGameIni` treats a recorded `gameIniApplication` for this
         * version as "already done, do not touch their INI again". A zeroed
         * stub written because the user pressed Stop would satisfy that
         * forever, so the settings this collection needs would never be
         * applied and nothing would ever say why.
         *
         * Leaving it undefined is the honest record: this run did not apply
         * them. `finishingSkippedNotice` is what tells the user, and running
         * the install again picks them up — which is exactly what that notice
         * promises.
         */
        gameIniApplication = stopBeforeWriting("game settings")
          ? undefined
          : await applyGameIni({
          gameIni: plan.manifest.gameIni!,
          gameId: plan.manifest.game.id,
          documentsPath:
            (util as unknown as { getVortexPath?: (id: string) => string })
              .getVortexPath?.("documents") ?? "",
          // Writing to the wrong My Games folder edits a directory the game
          // never reads, and reports success for it.
          ...(discoveredStore(api.getState(), plan.manifest.game.id) !==
          undefined
            ? {
                store: discoveredStore(
                  api.getState(),
                  plan.manifest.game.id,
                )!,
              }
            : {}),
        });
      } catch (err) {
        // Never fatal. A collection whose mods all installed is not a failure
        // because one settings file could not be written.
        //
        // Into the NOTICE, not the receipt — see `gameIniFailure` above.
        // Recording it as an application would tell the next run the settings
        // had already been applied for this version.
        gameIniFailure = {
          appliedCount: 0,
          alreadyMatchedCount: 0,
          changes: [],
          failed: [{ fileName: "(all)", reason: formatError(err) }],
        };
        ehLog("warn", "install.game-ini.failed", {
          err,
          consequence:
            "the curator's game settings were NOT applied. This is not " +
            "recorded as an application, so running this same version again " +
            "will retry them.",
        });
      }
    }

    // ── 8. write receipt ────────────────────────────────────────────
    ehLog("info", "install.phase", { phase: "writing-receipt" });
    reportProgress("writing-receipt", 0, 1, "Writing install receipt...");

    // ── has anything changed since WE installed it? ──────────────────
    //
    // Only meaningful on an UPDATE: it compares against the fingerprint the
    // PREVIOUS install of this collection left behind, so a first install has
    // nothing to compare and costs nothing. Scoped to mods whose identity is
    // unchanged between the two versions — a mod the curator updated is
    // supposed to differ, and reporting drift on it would fire for every
    // upgraded mod in the collection.
    //
    // Placed after installation rather than before it because these mods are
    // resolved as already-installed and are therefore NOT touched by this
    // run: the drift survives it, so telling the user afterwards is telling
    // them about something still true.
    const driftNotice = await detectDrift({
      ctx,
      gameId: plan.manifest.game.id,
      reportProgress,
    });

    // Mods installed, deployed, rules and order applied — but if anything
    // failed we did NOT reproduce the curator's state, so no receipt.
    //
    // A receipt asserts the collection IS installed, and cross-release lineage
    // is built on that claim. Writing one for a partial reproduction would
    // make the next upgrade reason from a state that never existed. The user
    // keeps everything that installed and gets the exact list of what did not,
    // which is the difference between "re-run after you source these" and
    // "start again and hope".
    /**
     * ─── 7e. RETRY THE MODS WHOSE INSTALLER NEEDED THE COLLECTION ───────
     * Some installers refuse until the collection they belong to exists. A
     * real run died on this:
     *
     *     AAF_VanillaKinkyCreatureAnimations_Themes  (mod 801 of 979)
     *     Installer Prerequisits not fulfilled:
     *     File 'aaf.esm' is Active OR File 'aaf.esp' is Active
     *
     * The FOMOD wanted a PLUGIN to be ACTIVE. Plugins become active when
     * plugins.txt is written, and this driver writes it once, after every mod
     * is installed and deployed — forty-two minutes later in that run. So no
     * position in the install loop could have satisfied it: the mod would
     * have failed first, last, or anywhere between, and re-running the whole
     * install fails at the same place forever.
     *
     * The fix is not ordering, it is TIMING. By here the collection is
     * installed, deployed, and its plugin order applied — the world the
     * curator's machine was in when they installed this mod. So try again.
     *
     * Anything that fails a second time here fails for a real reason, and is
     * reported as it was before.
     */
    if (failedMods.length > 0 && !stopBeforeWriting("retrying failed mods")) {
      const carryForward: FailedModReportEntry[] = [];
      /**
       * The compareKeys this pass actually put on disk. Everything downstream
       * is scoped to these: a recovered mod needs the per-mod finishing work
       * the first pass gave every other mod, and the mods that were already
       * installed must not have it done to them twice.
       */
      const recoveredKeys: string[] = [];
      let retriedOk = 0;
      const retryStartedAt = Date.now();
      ehLog("info", "install.retry.start", {
        mods: failedMods.length,
        why:
          "the collection is now installed, deployed and its plugins active " +
          "— an installer that refused for a missing prerequisite may pass now",
      });

      for (const failed of failedMods) {
        if (ctx.abortSignal?.aborted === true) {
          carryForward.push(failed);
          continue;
        }
        const resolution = plan.modResolutions.find(
          (r) => r.compareKey === failed.compareKey,
        );
        const manifestEntry = manifestByCompareKey.get(failed.compareKey);
        if (resolution === undefined || manifestEntry === undefined) {
          carryForward.push(failed);
          continue;
        }
        try {
          const entry = await executeDecision({
            ctx,
            resolution,
            manifestEntry,
            profileId: activeProfileId,
            onTempArchive: (tp) => tempArchivesToCleanup.push(tp),
            onSkip: (e) => skippedMods.push(e),
            onCarry: (e) => carriedMods.push(e),
            onNotice: (line) => externalNotices.push(line),
            onSuppliedArchiveDiffers: (info) =>
              suppliedArchiveMismatches.set(info.compareKey, {
                expected: info.expected,
                actual: info.actual,
              }),
          });
          if (entry === undefined) {
            carryForward.push(failed);
            continue;
          }
          installedMods.push(entry);
          ctx.onModInstalled?.(entry.vortexModId);
          enableModInProfile(api, activeProfileId, entry.vortexModId);
          // Journalled exactly like a first-pass install: this run created it,
          // so the repair path may uninstall it and uninstall must find it
          // (NS-2). Skipping this would make a retried mod invisible to every
          // provenance question.
          await appendJournalEntry(ctx.appDataPath, plan.manifest.package.id, {
            compareKey: entry.compareKey,
            vortexModId: entry.vortexModId,
            kind: entry.fromDecision.endsWith("already-installed")
              ? "adopted"
              : "installed",
            decision: entry.fromDecision,
            at: new Date().toISOString(),
          });
          retriedOk += 1;
          recoveredKeys.push(entry.compareKey);
          /**
           * One row per installed mod, always. The verify pass ran before this
           * mod existed, so there is no verdict to record — but an ABSENT row
           * is indistinguishable from a check that lost one, and the receipt's
           * integrity count is what a support conversation reads first.
           */
          verifications.push({
            kind: "skip",
            vortexModId: entry.vortexModId,
            compareKey: entry.compareKey,
            name: entry.name,
            reason: "recovered-after-verification",
          });
          ehLog("info", "install.retry.mod.ok", {
            name: entry.name,
            compareKey: entry.compareKey,
            firstError: failed.error,
          });
        } catch (err) {
          carryForward.push({ ...failed, error: formatError(err) });
          ehLog("warn", "install.retry.mod.failed", {
            name: failed.name,
            compareKey: failed.compareKey,
            firstError: failed.error,
            secondError: formatError(err),
          });
        }
      }

      // In place: `failedMods` is a const the whole driver reads from.
      failedMods.length = 0;
      failedMods.push(...carryForward);

      ehLog(retriedOk > 0 ? "info" : "warn", "install.retry.done", {
        recovered: retriedOk,
        stillFailing: failedMods.length,
        ms: Date.now() - retryStartedAt,
      });

      if (retriedOk > 0 && !stopBeforeWriting("finishing the retried mods")) {
        /**
         * ─── A RECOVERED MOD IS NOT FINISHED JUST BECAUSE IT INSTALLED ────
         * `buildPostInstallModIdMap` is built ONCE, roughly 1,200 lines above
         * this, and every per-mod phase resolves its target through it: mod
         * rules, the LOOT userlist, INI tweaks, the modType restore, the
         * mirror, the ESL flag repair. All of them ran before this pass
         * existed, so a mod recovered here used to receive NONE of them —
         * installed, enabled, journalled, deployed, and otherwise untouched.
         *
         * The worst of those is silent AND game-breaking. SSE Engine Fixes
         * Part 2 is loose binaries with a curator-set `dinput` modType that
         * deploys to the game ROOT; without the restore its DLLs go to `Data`,
         * nothing loads them, and every file check still passes. It is also
         * exactly the population this pass recovers: installers with
         * prerequisite logic are the ones that ship modType overrides.
         *
         * This is the same defect `alongsideOrdering.test.ts` was written to
         * prevent, arriving from the other end — that test pins the ALONGSIDE
         * install above the map and cannot see a second install site below
         * every consumer.
         *
         * Everything below is SCOPED to `recoveredKeys`. Re-running a phase
         * over every mod would re-plan mirrors for mods already mirrored, and
         * `planMirror`'s delete arm is the one function here that removes a
         * user's files (NS-2).
         */
        const recoveredIds = new Map(
          installedMods
            .filter((m) => recoveredKeys.includes(m.compareKey))
            .map((m) => [m.compareKey, m.vortexModId] as const),
        );
        const recoveredManifestMods = plan.manifest.mods.filter((m) =>
          recoveredIds.has(m.compareKey),
        );

        try {
          /**
           * Deploy FIRST. The modType restore and the mirror both act on
           * staging, but the plugin order below reads what Vortex actually has
           * — and a plugin these mods ship does not exist for it until the
           * deploy has linked it in.
           */
          await deployAndWait(api, activeProfileId);

          // ── modType: the one whose absence is invisible ────────────────
          const retryModTypes = applyModTypeChanges(
            ctx.api,
            plan.manifest.game.id,
            planModTypeChanges({
              installed: recoveredIds,
              currentTypes: readCurrentModTypes(ctx.api, plan.manifest.game.id),
              manifestMods: recoveredManifestMods,
            }),
            actions,
          );

          // ── INI tweaks: the most invisible thing a collection ships ────
          const retryTweaks = applyIniTweaks({
            api,
            gameId: plan.manifest.game.id,
            installed: recoveredIds,
            manifestMods: recoveredManifestMods,
          });

          /**
           * ── mod rules, and ONLY the ones that name a recovered mod ─────
           * A rule is a relation between two mods, so the resolver needs the
           * FULL map — but re-dispatching every rule would re-do work the
           * first pass already did and make the receipt's counts a double
           * count. The user's existing rules were snapshotted and cleared once,
           * long before this; that is deliberately not repeated.
           */
          const fullModIdByCompareKey = buildPostInstallModIdMap(
            installedMods,
            carriedMods,
          );
          const retryRules = plan.manifest.rules.filter(
            (r) =>
              recoveredIds.has(r.source) ||
              // A reference may be PARTIALLY pinned ("nexus:1234" matches any
              // file id of that mod), so the boundary matters: without the
              // colon, "nexus:1234" would also claim "nexus:12345:6".
              [...recoveredIds.keys()].some(
                (k) => k === r.reference || k.startsWith(`${r.reference}:`),
              ),
          );
          let retryRulesApplied = 0;
          if (retryRules.length > 0) {
            const retryNexusIndex = buildNexusModIdMap(
              api,
              plan.manifest.game.id,
              installedMods,
              carriedMods,
            );
            const retryRuleResult = applyModRules({
              api,
              gameId: plan.manifest.game.id,
              rules: retryRules,
              modIdByCompareKey: fullModIdByCompareKey,
              modIdByNexusModId: retryNexusIndex.map,
              ambiguousNexusModIds: retryNexusIndex.ambiguous,
              existingRulesBySourceModId: collectExistingRules(
                api,
                plan.manifest.game.id,
                fullModIdByCompareKey,
              ),
              signal: ctx.abortSignal,
            });
            retryRulesApplied = retryRuleResult.applied;
          }

          // ── mirror: the curator answered for these files ───────────────
          let retryMirrored = 0;
          for (const mod of recoveredManifestMods) {
            if (mod.state.mirrored !== true) continue;
            if (ctx.abortSignal?.aborted === true) break;
            await mirrorOneMod(mod);
            retryMirrored += 1;
          }

          ehLog("info", "install.retry.finished-mods", {
            recovered: retriedOk,
            modTypesRestored: retryModTypes.length,
            iniTweaksApplied: retryTweaks.enabled.length,
            rulesApplied: retryRulesApplied,
            mirrored: retryMirrored,
            why:
              "these mods arrived after every per-mod phase had run, so the " +
              "phases were replayed for exactly them",
          });

          /**
           * ─── AND THE ORDER, THE WAY 7b1 DOES IT ─────────────────────────
           * This used to call `applyPluginOrder` with the raw manifest order
           * and no `skipSort`, which emits `autosort-plugins` — a full LOOT
           * re-sort, i.e. precisely the operation the re-pin above exists to
           * undo. On a real run that re-pin had just taken 686 misordered
           * plugins to zero, and nothing re-measured afterwards, so the
           * receipt reported the clean number for a file that had since been
           * rewritten by LOOT.
           *
           * So: read what Vortex actually has, refill the collection's slots
           * with the curator's sequence, carry each plugin's REAL enabled flag
           * (asserting `true` switched curator-disabled plugins back on), and
           * skip the sort. Then re-measure, because a number nobody re-checked
           * after a write is not a measurement.
           */
          const afterRetry = await readUserPluginsTxt(
            plan.manifest.game.id,
            discoveredStore(api.getState(), plan.manifest.game.id),
          );
          if (afterRetry !== undefined) {
            const afterNames = afterRetry.map((pl) => pl.name);
            const enabledAfter = new Map(
              afterRetry.map((pl) => [pl.name.toLowerCase(), pl.enabled] as const),
            );
            const mergedAfter = repinCuratorOrder(
              plan.manifest.plugins.order.map((pl) => pl.name),
              afterNames,
            );
            if (orderDiffers(mergedAfter, afterNames)) {
              const rePin = await applyPluginOrder({
                api,
                gameId: plan.manifest.game.id,
                collectionId: plan.manifest.package.id,
                order: mergedAfter.map((name) => ({
                  name,
                  enabled: enabledAfter.get(name.toLowerCase()) ?? true,
                })),
                skipSort: true,
                ...(ctx.abortSignal !== undefined
                  ? { signal: ctx.abortSignal }
                  : {}),
              });
              ehLog("info", "install.retry.redeployed", {
                recovered: retriedOk,
                pluginOrderPinned: rePin.pinned,
                writeRequested: rePin.writeRequested,
                entries: mergedAfter.length,
              });
            }
            /**
             * Re-measured from disk either way — including when the merge
             * changed nothing, because that IS the measurement in that case.
             * `repinUnconfirmed` is cleared only by a fresh read that agrees.
             */
            const settled = await readUserPluginsTxt(
              plan.manifest.game.id,
              discoveredStore(api.getState(), plan.manifest.game.id),
            );
            if (settled !== undefined) {
              pluginOrderDrift = comparePluginOrder(
                plan.manifest.plugins.order,
                settled,
              );
              repinUnconfirmed = false;
              ehLog("info", "plugins.order-drift.after-retry", {
                compared: pluginOrderDrift.compared,
                misordered: pluginOrderDrift.misordered.length,
              });
            } else {
              repinUnconfirmed = true;
            }
          } else {
            repinUnconfirmed = true;
            ehLog("warn", "install.retry.order-unverified", {
              why: "plugins.txt could not be read after the retry deploy",
              consequence:
                "the load-order numbers in this receipt describe the state " +
                "BEFORE the retried mods' plugins arrived",
            });
          }
        } catch (err) {
          // Non-fatal: the mods ARE installed, and saying the deploy failed is
          // more useful than losing the retry that succeeded.
          ehLog("error", "install.retry.redeploy.failed", {
            recovered: retriedOk,
            consequence:
              "the retried mods are installed but may not be linked into the " +
              "game folder — deploy in Vortex, or run the install again",
            err,
          });
        }
      } else if (retriedOk > 0) {
        /**
         * A Stop landed mid-retry. The recovered mods are installed, enabled
         * and journalled — which is the state NS-2 cares about — but nothing
         * after them ran, and `stopBeforeWriting` has recorded that so the
         * user is told rather than left to find out.
         */
        ehLog("warn", "install.retry.finishing-skipped", {
          recovered: retriedOk,
          consequence:
            "these mods are installed but were not deployed, typed, tweaked " +
            "or mirrored, and the load order was not re-applied",
        });
      }
    }

    /**
     * ─── A PARTIAL RUN STILL EARNS A RECEIPT ────────────────────────────
     * This block used to RETURN here, before `buildReceipt` — so one failed
     * mod meant no receipt at all. The reasoning was sound (a receipt asserts
     * the collection IS installed) and the consequence was not: a real run
     * installed 978 of 979, deployed them, and re-pinned the plugin order to
     * zero drift, then recorded nothing. Those 978 had no provenance —
     * uninstall could not find them (NS-2), the next run forked another
     * profile, Doctor had nothing to read — and the failure message told the
     * user to "source the missing ones and run this again", which for a mod
     * whose FOMOD demands an ACTIVE plugin can never work.
     *
     * So the receipt is written either way and CARRIES the failures, which
     * makes it a partial claim rather than a false one. The run still reports
     * `failed`, because it is; what changed is that the work it did survives.
     */
    if (failedMods.length > 0) {
      ehLog("warn", "install.partial", {
        installed: installedMods.length,
        failed: failedMods.length,
        total,
      });
    }
    const partialFailure = failedMods.length > 0;
    const failedForReceipt = failedMods.map((f) => ({
      compareKey: f.compareKey,
      name: f.name,
      reason: f.error,
    }));

    const deferredFailure = (receiptPath?: string): InstallResult => {
      const names = failedMods
        .slice(0, 5)
        .map((f) => f.name)
        .join(", ");
      return {
        kind: "failed",
        phase: "writing-receipt",
        partialProfileId: ehProfileId,
        error:
          `${installedMods.length} of ${total} mods installed, but ` +
          `${failedMods.length} could not be: ${names}` +
          `${failedMods.length > 5 ? `, and ${failedMods.length - 5} more` : ""}. ` +
          `Everything that did install is in place and deployed — source the ` +
          `missing ones and run this again to finish.`,
        installedSoFar: installedMods.map((m) => m.vortexModId),
        failedMods,
        /**
         * This return happens AFTER every downstream phase has run — the
         * rules were purged, the mirror applied, the deploy done. All of the
         * notices describing that work were computed and then thrown away
         * here, including the one naming the backup of the mod rules this run
         * deleted. A partial failure is exactly when the user needs them.
         */
        ...(rulesPurgeNotice !== undefined ? { rulesPurgeNotice } : {}),
        ...(curatorReports.length > 0 ? { curatorReports } : {}),
        ...(damagedArchives.length > 0
          ? { damagedArchiveNotice: damagedArchives }
          : {}),
        /**
         * ─── AND THE REST OF WHAT THIS RUN ACTUALLY DID ──────────────────
         * The docblock above says the fix restored "all of the notices
         * describing that work". It restored three of eleven. The eight below
         * were computed by the same phases, on the same run, and dropped at
         * this return.
         *
         * `finishingSkippedNotice` is the one that costs the most. A user who
         * stopped the install after the deploy AND has a failed mod reads
         * "source the missing ones and run this again" and is never told the
         * plugin order was not applied or the ESL flags not restored — and
         * without the flags a profile that fits only because most plugins are
         * light will not start.
         *
         * `mirrorNotice` is the only phase that DELETES files from a mod
         * folder, so its exceptions are not optional reading either.
         */
        ...(finishingSkipped.length > 0
          ? {
              finishingSkippedNotice: [
                describeSkippedFinishing(finishingSkipped),
              ],
            }
          : {}),
        ...(describePluginFlagRepair(pluginFlagRepair) !== undefined
          ? { pluginFlagNotice: describePluginFlagRepair(pluginFlagRepair)! }
          : {}),
        ...(mirrorFailures.length > 0 || mirrorSkipped.length > 0
          ? {
              mirrorNotice: [
                ...mirrorLines.filter((l) => l.includes("could not")),
                ...mirrorSkipped,
              ],
            }
          : {}),
        ...(describePluginOrderDrift(pluginOrderDrift, repinUnconfirmed).length >
        0
          ? {
              pluginOrderNotice: describePluginOrderDrift(
                pluginOrderDrift,
                repinUnconfirmed,
              ),
            }
          : {}),
        ...(describePluginOrderApplication(pluginOrderApplication) !== undefined
          ? {
              pluginOrderNotApplied: describePluginOrderApplication(
                pluginOrderApplication,
              )!,
            }
          : {}),
        ...(describeIniTweaks(iniTweakApplication).length > 0
          ? { iniTweakNotice: describeIniTweaks(iniTweakApplication) }
          : {}),
        ...(driftNotice !== undefined ? { stagingDriftNotice: driftNotice } : {}),
        ...(externalNotices.length > 0
          ? { externalArchiveNotice: externalNotices }
          : {}),
        ...(receiptPath !== undefined ? { receiptPath } : {}),
      };
    };

    const receipt = buildReceipt({
      ctx,
      profileId: activeProfileId,
      profileName: activeProfileName ?? activeProfileId,
      installedMods,
      carriedMods,
      rulesApplication,
      userlistApplication,
      verifications,
      gameIniApplication,
      verifiedOkKeys,
      expectedFilesByCompareKey,
      ownedByUs,
      finishingSkipped,
      pluginFlagChanges: pluginFlagRepair.changes,
      failedMods: failedForReceipt,
    });

    let receiptPath: string;
    try {
      receiptPath = await writeReceiptWithRetry(ctx.appDataPath, receipt);
      // The line whose ABSENCE cost a whole diagnosis.
      //
      // A successful run's last log line used to be `plugins.light-flags`,
      // several steps before the end — so a log that stopped there was equally
      // consistent with "finished perfectly" and "died silently", and there
      // was no way to tell which from the artefact the user sends you. A
      // tester's run ended exactly there and the question could not be
      // answered at all.
      /**
       * The counts that answer "did it work", not only "how much did it do".
       * A successful run used to report how MANY mods it touched and never
       * how many were PROVEN correct — which is the product's actual claim.
       */
      logInstallCallShapes();
      ehLog("info", "install.complete", {
        packageId: plan.manifest.package.id,
        packageVersion: plan.manifest.package.version,
        installed: installedMods.length,
        carried: carriedMods.length,
        skipped: skippedMods.length,
        removed: removedMods.length,
        profileId: activeProfileId,
        installTargetMode: plan.installTarget.kind,
        verified: verifications.filter((v) => v.kind === "ok").length,
        verifyFailed: verifications.filter((v) => v.kind === "fail").length,
        verifySkipped: verifications.filter((v) => v.kind === "skip").length,
        repaired: verifications.filter(
          (v) => v.kind === "ok" && v.retryAttempted === true,
        ).length,
        modsRemovedByFailedRepair: verifications.filter(
          (v) => v.kind === "fail" && v.modRemoved === true,
        ).length,
        durationMs: Date.now() - runStartedAtMs,
        receiptPath,
      });
    } catch (err) {
      const errMsg =
        err instanceof InstallLedgerError
          ? err.message
          : formatError(err);
      return {
        kind: "failed",
        phase: "writing-receipt",
        partialProfileId: ehProfileId,
        error: `Failed writing install receipt: ${errMsg}`,
        installedSoFar: installedMods.map((m) => m.vortexModId),
      };
    }

    /**
     * Now — with the receipt on disk, so the retry has something to resume
     * from and the 978 that DID install are recorded as ours.
     */
    if (partialFailure) {
      reportProgress("complete", 1, 1, "Install finished with failures.");
      return deferredFailure(receiptPath);
    }

    // ── 9. done ─────────────────────────────────────────────────────
    reportProgress("complete", 1, 1, "Install complete.");

    return {
      kind: "success",
      profileId: activeProfileId,
      profileName: activeProfileName ?? activeProfileId,
      installTargetMode: plan.installTarget.kind,
      durationMs: Date.now() - runStartedAtMs,
      receiptPath,
      installedModIds: installedMods.map((m) => m.vortexModId),
      installedMods,
      skippedMods,
      removedMods,
      carriedMods,
      rulesApplication,
      userlistApplication,
      verifications,
      // The notice reports the ATTEMPT, so a failure the receipt
      // deliberately does not record is still told to the user.
      ...((gameIniApplication ?? gameIniFailure) !== undefined
        ? {
            gameIniNotice: describeGameIniApplication(
              (gameIniApplication ?? gameIniFailure)!,
            ),
          }
        : {}),
      // Both halves of the same story: what was corrected, and what could not
      // be. A user seeing a mod outside Data deserves the first, and the
      // second is the one that still needs them to do something.
      ...(modTypeChanges.length > 0 || modTypeMismatches.length > 0
        ? {
            modTypeNotice: [
              ...describeModTypeChanges(modTypeChanges),
              ...describeModTypeMismatches(modTypeMismatches),
            ],
          }
        : {}),
      ...(describeIniTweaks(iniTweakApplication).length > 0
        ? { iniTweakNotice: describeIniTweaks(iniTweakApplication) }
        : {}),
      ...(describePluginOrderDrift(pluginOrderDrift, repinUnconfirmed).length >
      0
        ? {
            pluginOrderNotice: describePluginOrderDrift(
              pluginOrderDrift,
              repinUnconfirmed,
            ),
          }
        : {}),
      ...(driftNotice !== undefined ? { stagingDriftNotice: driftNotice } : {}),
      ...(curatorReports.length > 0 ? { curatorReports } : {}),
      ...(finishingSkipped.length > 0
        ? {
            finishingSkippedNotice: [
              describeSkippedFinishing(finishingSkipped),
            ],
          }
        : {}),
      ...(externalNotices.length > 0
        ? { externalArchiveNotice: externalNotices }
        : {}),
      ...(damagedArchives.length > 0
        ? { damagedArchiveNotice: damagedArchives }
        : {}),
      // Only the exceptions. A mirror that reconciled everything it was asked
      // to needs no sentence; one that skipped a mod, or left it half done,
      // is the thing the user has to know.
      ...(mirrorFailures.length > 0 || mirrorSkipped.length > 0
        ? {
            mirrorNotice: [
              ...mirrorLines.filter((l) => l.includes("could not")),
              ...mirrorSkipped,
            ],
          }
        : {}),
      ...(rulesPurgeNotice !== undefined
        ? { rulesPurgeNotice }
        : {}),
      ...(describePluginFlagRepair(pluginFlagRepair) !== undefined
        ? { pluginFlagNotice: describePluginFlagRepair(pluginFlagRepair)! }
        : {}),
      // Only present when something about setting the order did NOT work.
      // Success here is the expected outcome and says nothing.
      ...(describePluginOrderApplication(pluginOrderApplication) !== undefined
        ? {
            pluginOrderNotApplied: describePluginOrderApplication(
              pluginOrderApplication,
            )!,
          }
        : {}),
    };
  } finally {
    // The run ENDED — success, failure or abort alike — so the in-flight
    // marker must go. It exists to say "Vortex died mid-install"; one that
    // outlives a run which finished would warn about an interruption that
    // never happened, and a false warning teaches people to ignore the true
    // one.
    //
    // In the `finally` deliberately: runInstall has THIRTEEN return paths,
    // and clearing at each of them is a guarantee that lasts exactly until
    // someone adds a fourteenth.
    /**
     * Only if THIS run wrote one.
     *
     * The marker is keyed by packageId, not by run, so an unconditional clear
     * here deleted the marker left by a previously KILLED run — which is the
     * only record that run leaves, because no `finally` executes on a power
     * cut and no attempt is written.
     *
     * The path: power cut at mod 700, marker survives holding the profile
     * with 700 mods. The user reopens Vortex, starts the install again, and
     * cancels during "Validating install plan…" — which returns BEFORE
     * `writeInstallMarker`. This `finally` then deleted the only pointer to
     * their 700 mods, and the attempt written alongside it names no profile
     * either, so the next run forks a fresh one and orphans all of it.
     */
    if (markerWritten) {
      await clearInstallMarker(ctx.appDataPath, plan.manifest.package.id);
    }

    // Cleanup of bundled-extract temp dirs is fire-and-forget. Each
    // entry is the **directory** returned by extractBundledFromEhcoll
    // (one per successful bundled install). Failures here don't
    // reach the user — the OS temp GC reclaims leftovers eventually.
    for (const tempDir of tempArchivesToCleanup) {
      void safeRmTempDir(tempDir);
    }
    // Discard any prefetched-but-untaken bundles. If the install
    // aborted partway through, the pool still owns extracted dirs
    // for entries the install loop never reached; dispose() releases
    // them. For a fully-consumed pool this is a no-op.
    void bundledPool.dispose();
  }
}

/**
 * Walk the resolved plan and emit the bundled zip entries the
 * install loop is *guaranteed* to extract. Conflict-choice paths
 * (`*-diverged`, `external-prompt-user`) are intentionally excluded:
 * their resolution depends on a user choice that may select
 * "keep-existing"/"skip", in which case no bundled extraction
 * happens. Those paths fall through to the cold path inside
 * `pool.take` if they do extract, which is correct (just not as fast).
 *
 * Order matters: we prime the pool in plan order so the install
 * loop's first bundled mod is also the pool's first to start.
 */
function collectBundledZipEntriesForPrefetch(
  plan: DriverContext["plan"],
  _ctx: DriverContext,
): PrefetchRequest[] {
  const out: PrefetchRequest[] = [];
  const seen = new Set<string>();
  for (const res of plan.modResolutions) {
    const dec = res.decision;
    if (dec.kind !== "external-use-bundled") continue;
    if (seen.has(dec.zipPath)) continue;
    seen.add(dec.zipPath);
    // The resolution's name is the curator's mod name, which is what the
    // extracted archive — and so the user's staging folder — gets called.
    out.push({ zipEntry: dec.zipPath, preferredName: res.name });
  }
  return out;
}

// ===========================================================================
// Per-decision execution
// ===========================================================================

async function executeDecision(args: {
  ctx: DriverContext;
  resolution: ModResolution;
  manifestEntry: EhcollMod;
  profileId: string;
  onTempArchive: (p: string) => void;
  onSkip: (entry: SkippedModReportEntry) => void;
  onCarry: (entry: CarriedModReportEntry) => void;
  /** Something the user should read, that is not a failure. */
  onNotice: (line: string) => void;
  /**
   * A hand-supplied archive that is NOT the one the collection was built
   * from, with both hashes. Verification is about to find every file this
   * explains and has no way to know why, so the cause travels with it.
   */
  onSuppliedArchiveDiffers?: (info: {
    compareKey: string;
    expected: string;
    actual: string;
  }) => void;
  /**
   * Optional bundled prefetch pool. When supplied, bundled-archive
   * decisions will consume pre-extracted results from the pool
   * instead of running 7z inline. Recovery paths and out-of-band
   * call sites can omit it — bundled extraction will fall back to
   * the cold path (synchronous extract).
   */
  bundledPool?: BundledPrefetchPool;
}): Promise<InstalledModReportEntry | undefined> {
  const {
    ctx,
    resolution,
    manifestEntry,
    profileId,
    onTempArchive,
    onSkip,
    onCarry,
    onNotice,
    onSuppliedArchiveDiffers,
    bundledPool,
  } = args;
  const { manifest } = ctx.plan;
  const decision = resolution.decision;
  const compareKey = resolution.compareKey;

  switch (decision.kind) {
    case "nexus-already-installed":
    case "external-already-installed": {
      // Re-use the existing Vortex mod entry; just enable it.
      return {
        compareKey,
        name: resolution.name,
        vortexModId: decision.existingModId,
        source: resolution.sourceKind,
        fromDecision: decision.kind,
      };
    }

    case "nexus-download": {
      const result = await installNexusViaApi(ctx.api, {
        gameId: manifest.game.id,
        nexusModId: decision.modId,
        nexusFileId: decision.fileId,
        fileName: decision.archiveName,
        signal: ctx.abortSignal,
        // The curator's FOMOD answers, when this mod had any. Undefined
        // leaves the install exactly as it was before replay existed.
        ...replayArgs(manifestEntry, ctx.decisions.fomodReplayMode),
      });
      return {
        compareKey,
        name: resolution.name,
        vortexModId: result.vortexModId,
        source: "nexus",
        fromDecision: decision.kind,
      };
    }

    case "nexus-use-local-download":
    case "external-use-local-download": {
      const result = await installFromExistingDownload(ctx.api, {
        gameId: manifest.game.id,
        archiveId: decision.archiveId,
        signal: ctx.abortSignal,
        ...replayArgs(manifestEntry, ctx.decisions.fomodReplayMode),
      });
      return {
        compareKey,
        name: resolution.name,
        vortexModId: result.vortexModId,
        source: resolution.sourceKind,
        fromDecision: decision.kind,
      };
    }

    case "external-use-bundled": {
      const preExtracted = bundledPool
        ? await bundledPool.take(decision.zipPath, resolution.name)
        : undefined;
      const result = await installFromBundledArchive(ctx.api, {
        gameId: manifest.game.id,
        ehcollZipPath: ctx.ehcollZipPath,
        bundledZipEntry: decision.zipPath,
        signal: ctx.abortSignal,
        preExtracted,
        preferredName: resolution.name,
        // Bundling a mod must not cost it the curator's installer answers.
        ...replayArgs(manifestEntry, ctx.decisions.fomodReplayMode),
      });
      // Track the temp **directory**, not the file: cherry-picked
      // entries can have nested paths inside the dir.
      onTempArchive(result.tempDir);
      return {
        compareKey,
        name: resolution.name,
        vortexModId: result.vortexModId,
        source: "external",
        fromDecision: decision.kind,
      };
    }

    // ── Slice 6b: divergence + prompt-user with user choices ────────
    case "nexus-version-diverged":
    case "nexus-bytes-diverged":
    case "external-bytes-diverged": {
      const choice = ctx.decisions.conflictChoices?.[compareKey];
      if (!choice) {
        // Preflight should have caught this; defensive fallback.
        throw new Error(
          `No conflictChoice for diverged mod "${resolution.name}" ` +
            `(compareKey=${compareKey}, decision=${decision.kind}).`,
        );
      }
      return executeDivergedChoice({
        ctx,
        resolution,
        manifestEntry,
        choice,
        profileId,
        onTempArchive,
        onSkip,
        onCarry,
        bundledPool,
      });
    }

    case "external-prompt-user": {
      const choice = ctx.decisions.conflictChoices?.[compareKey];
      if (!choice) {
        throw new Error(
          `No conflictChoice for external-prompt-user mod "${resolution.name}" ` +
            `(compareKey=${compareKey}).`,
        );
      }
      return executePromptUserChoice({
        ctx,
        resolution,
        manifestEntry,
        choice,
        onSkip,
        onNotice,
        ...(onSuppliedArchiveDiffers !== undefined
          ? { onSuppliedArchiveDiffers }
          : {}),
      });
    }

    case "nexus-unreachable":
    case "external-missing": {
      // Hard-blocking — preflight should have refused. Defensive throw.
      throw new Error(
        `Decision "${decision.kind}" has no user-resolution path; preflight should have rejected the plan.`,
      );
    }

    default:
      assertNever(decision);
  }
}

/**
 * Execute the user's choice for a `*-diverged` decision.
 * `replace-existing` ⇒ uninstall already happened in `removing-mods`
 *   phase; we now install the manifest's version using the appropriate
 *   primitive based on the manifest source kind.
 * `keep-existing` ⇒ enable the existing mod in the active profile,
 *   then carry it forward into the new receipt with its previous-
 *   release lineage preserved (H1 fix). Without enabling we'd silently
 *   ship a collection with the mod missing if the user had it
 *   disabled in the active profile (H6 fix).
 * `use-local-file` ⇒ NOT valid for diverged; treated as a programmer
 *   bug at the action layer.
 * `skip` ⇒ NOT valid for diverged either; the explicit "do nothing"
 *   choice for a conflict is `keep-existing`.
 */
async function executeDivergedChoice(args: {
  ctx: DriverContext;
  resolution: ModResolution;
  manifestEntry: EhcollMod;
  choice: ConflictChoice;
  profileId: string;
  onTempArchive: (p: string) => void;
  onSkip: (entry: SkippedModReportEntry) => void;
  onCarry: (entry: CarriedModReportEntry) => void;
  bundledPool?: BundledPrefetchPool;
}): Promise<InstalledModReportEntry | undefined> {
  const {
    ctx,
    resolution,
    manifestEntry,
    choice,
    profileId,
    onTempArchive,
    onSkip,
    onCarry,
    bundledPool,
  } = args;
  const compareKey = resolution.compareKey;
  const decision = resolution.decision;

  if (choice.kind === "keep-existing") {
    if (
      decision.kind !== "nexus-version-diverged" &&
      decision.kind !== "nexus-bytes-diverged" &&
      decision.kind !== "external-bytes-diverged"
    ) {
      throw new Error(
        `keep-existing choice arrived for non-diverged decision ` +
          `"${decision.kind}" (programmer error).`,
      );
    }

    // H6: ensure the user's existing mod is enabled in the active
    // profile so the collection actually gets the mod. In current-
    // profile mode the mod might be globally installed but disabled
    // in this profile.
    enableModInProfile(ctx.api, profileId, decision.existingModId);

    // H1: record into carriedMods so the receipt preserves the
    // mod's lineage. Future releases that drop this compareKey will
    // detect it as an orphan.
    onCarry({
      vortexModId: decision.existingModId,
      name: resolution.name,
      source: resolution.sourceKind,
      reason: "diverged-keep-existing",
      compareKey,
      installedFromVersion: ctx.plan.previousInstall?.packageVersion,
      enabledInProfile: true,
    });

    // Surface in skippedMods too — the user-facing summary still
    // wants to say "we did not install the manifest's version of X."
    onSkip({
      compareKey,
      name: resolution.name,
      reason:
        `User chose keep-existing for ${decision.kind}; manifest version ` +
        `was not installed (existing version enabled and carried forward).`,
    });
    return undefined;
  }

  if (choice.kind === "skip") {
    onSkip({
      compareKey,
      name: resolution.name,
      reason: `User chose skip for ${decision.kind}.`,
    });
    return undefined;
  }

  if (choice.kind === "use-local-file") {
    throw new Error(
      `'use-local-file' choice is not valid for diverged decision "${decision.kind}" ` +
        `("${resolution.name}"). Use it only for external-prompt-user.`,
    );
  }

  // choice.kind === "replace-existing": install the manifest's version.
  // The user's old mod was already uninstalled in the removing-mods phase.
  return installManifestEntry({
    ctx,
    resolution,
    manifestEntry,
    onTempArchive,
    bundledPool,
    fromDecisionLabel: `${decision.kind}/replace-existing`,
  });
}

/**
 * Execute the user's choice for an `external-prompt-user` decision.
 * `use-local-file` ⇒ install from the user's picked archive path.
 * `skip` ⇒ record as skipped.
 * `keep-existing` / `replace-existing` ⇒ NOT valid (no "existing" to
 *   keep or replace; the mod is missing entirely).
 */
async function executePromptUserChoice(args: {
  ctx: DriverContext;
  resolution: ModResolution;
  /** Needed for the curator's installer answers — see the local-archive call. */
  manifestEntry: EhcollMod;
  choice: ConflictChoice;
  onSkip: (entry: SkippedModReportEntry) => void;
  /** Something the user should read, that is not a failure. */
  onNotice: (line: string) => void;
  /**
   * A hand-supplied archive that is NOT the one the collection was built
   * from, with both hashes. Verification is about to find every file this
   * explains and has no way to know why, so the cause travels with it.
   */
  onSuppliedArchiveDiffers?: (info: {
    compareKey: string;
    expected: string;
    actual: string;
  }) => void;
}): Promise<InstalledModReportEntry | undefined> {
  const {
    ctx,
    resolution,
    manifestEntry,
    choice,
    onSkip,
    onNotice,
    onSuppliedArchiveDiffers,
  } = args;
  const compareKey = resolution.compareKey;

  if (choice.kind === "skip") {
    onSkip({
      compareKey,
      name: resolution.name,
      reason: "User chose skip for external-prompt-user.",
    });
    return undefined;
  }

  if (choice.kind !== "use-local-file") {
    throw new Error(
      `Choice "${choice.kind}" is not valid for external-prompt-user ` +
        `("${resolution.name}"). Expected use-local-file or skip.`,
    );
  }

  // Is this the file the curator had?
  //
  // This is the ONE path where the bytes arrive by hand: the user browsed to
  // a website, downloaded something, and pointed us at it. Until now it was
  // installed unexamined — wrong version, wrong mod, half-finished download,
  // all indistinguishable from the right file, and all recorded afterwards as
  // the collection's mod.
  //
  // The build hard-blocks any external mod lacking `sha256` or
  // `stagingSetHash`, so a manifest always carries an oracle for these; where
  // it is the sha256 we can simply ask.
  //
  // Warned, never blocked. A browse-mode dependency legitimately resolves to
  // a different-but-equivalent file — a mirror, a repack, a newer build the
  // author replaced the page with — and the user made a deliberate choice we
  // have no standing to overrule. What they should not do is make it
  // UNKNOWINGLY.
  const picked = await checkArchiveIdentity({
    archivePath: choice.localPath,
    expectedSha256: manifestEntry.source.sha256,
    ...(ctx.abortSignal !== undefined ? { signal: ctx.abortSignal } : {}),
  });
  const pickedIsNotable = picked.kind === "differs" || picked.kind === "damaged";
  ehLog(pickedIsNotable ? "warn" : "info", "install.picked-archive", {
    name: resolution.name,
    verdict: picked.kind,
    ...(pickedIsNotable
      ? { expected: picked.expected, actual: picked.actual }
      : {}),
  });
  // Exhaustive on purpose. The first version tested only for "differs", so
  // when `damaged` was added the corrupt-file case silently stopped warning
  // anyone — it typechecked, and the notice simply stopped appearing. A
  // switch with a `never` arm turns the next added variant into a build error
  // instead of a missing sentence.
  switch (picked.kind) {
    case "differs":
      onNotice(
        `"${resolution.name}": the file you picked is not the one the ` +
          `collection was built from. ${describeArchiveIdentity(picked)} It was ` +
          `installed as you chose — this is a note, not a refusal.`,
      );
      /**
       * Also reported OUT, because verification is about to find every file
       * this explains and has no way to know why. A curator report that lists
       * 11 differing and 248 extra files and then asks whether the mod was
       * re-uploaded is sending them to look for something this run already
       * measured.
       */
      onSuppliedArchiveDiffers?.({
        compareKey: resolution.compareKey,
        expected: picked.expected,
        actual: picked.actual,
      });
      break;
    case "damaged":
      onNotice(
        `"${resolution.name}": the file you picked appears to be damaged — ` +
          `${describeArchiveIdentity(picked)} It was installed as you chose, ` +
          `but downloading it again is very likely what fixes it.`,
      );
      break;
    case "matches":
    case "unknown":
      // Nothing to say: either it is exactly right, or we had no oracle and
      // inventing a warning from an absent check would be noise.
      break;
    default: {
      const exhaustive: never = picked;
      void exhaustive;
    }
  }

  // The curator's installer answers apply here exactly as they do to a mod
  // we downloaded ourselves. This was the one install path that dropped them:
  // a user who supplied a FOMOD by hand got the default options while the
  // collection claimed to be reproducing the curator's build.
  const result = await installFromLocalArchive(ctx.api, {
    gameId: ctx.plan.manifest.game.id,
    archivePath: choice.localPath,
    signal: ctx.abortSignal,
    ...replayArgs(manifestEntry, ctx.decisions.fomodReplayMode),
  });

  return {
    compareKey,
    name: resolution.name,
    vortexModId: result.vortexModId,
    source: "external",
    fromDecision: "external-prompt-user/use-local-file",
  };
}

/**
 * Install the manifest's version of a mod, picking the right
 * primitive based on the manifest's source kind. Used for
 * `replace-existing` choices (the existing mod is already gone).
 *
 * Decision waterfall for the manifest entry:
 *  - Nexus mod ⇒ download from Nexus (canonical path; we don't trust
 *    that the user has a local download for an unrelated reason).
 *  - External mod with `bundled: true` ⇒ extract from the .ehcoll.
 *  - External mod with `bundled: false` ⇒ throw — the user should
 *    not have been offered "replace" if there was nowhere to get
 *    the new bytes. (The action handler is responsible for not
 *    surfacing the replace option in that scenario.)
 */
async function installManifestEntry(args: {
  ctx: DriverContext;
  resolution: ModResolution;
  manifestEntry: EhcollMod;
  onTempArchive: (p: string) => void;
  fromDecisionLabel: string;
  bundledPool?: BundledPrefetchPool;
}): Promise<InstalledModReportEntry> {
  const {
    ctx,
    resolution,
    manifestEntry,
    onTempArchive,
    fromDecisionLabel,
    bundledPool,
  } = args;
  const compareKey = resolution.compareKey;
  const gameId = ctx.plan.manifest.game.id;

  if (manifestEntry.source.kind === "nexus") {
    const nx = manifestEntry as NexusEhcollMod;
    const result = await installNexusViaApi(ctx.api, {
      gameId,
      nexusModId: nx.source.modId,
      nexusFileId: nx.source.fileId,
      fileName: nx.source.archiveName,
      signal: ctx.abortSignal,
      ...replayArgs(manifestEntry, ctx.decisions.fomodReplayMode),
    });
    return {
      compareKey,
      name: resolution.name,
      vortexModId: result.vortexModId,
      source: "nexus",
      fromDecision: fromDecisionLabel,
    };
  }

  // External mod.
  const ex = manifestEntry as ExternalEhcollMod;
  if (!ex.source.bundled) {
    throw new Error(
      `Cannot replace external mod "${resolution.name}" (compareKey=${compareKey}): ` +
        `manifest does not bundle the archive. Use 'use-local-file' instead.`,
    );
  }

  const bundledEntry = findBundledZipEntry(ctx, ex);
  const preExtracted = bundledPool
    ? await bundledPool.take(bundledEntry, resolution.name)
    : undefined;
  const result = await installFromBundledArchive(ctx.api, {
    gameId,
    ehcollZipPath: ctx.ehcollZipPath,
    bundledZipEntry: bundledEntry,
    signal: ctx.abortSignal,
    preExtracted,
    preferredName: resolution.name,
    // The Nexus branch of this same function already did this; the bundled
    // branch did not, and a "replace existing" choice therefore reinstalled
    // the mod with default installer options.
    ...replayArgs(manifestEntry, ctx.decisions.fomodReplayMode),
  });
  onTempArchive(result.tempDir);

  return {
    compareKey,
    name: resolution.name,
    vortexModId: result.vortexModId,
    source: "external",
    fromDecision: fromDecisionLabel,
  };
}

function findBundledZipEntry(ctx: DriverContext, mod: ExternalEhcollMod): string {
  // Invariant (parser-enforced): bundled === true ⇒ source.sha256 set.
  // Callers gate on `mod.source.bundled` before reaching us, so the
  // `!` is a static guarantee, not a hope.
  const sha = mod.source.sha256!;
  const match = ctx.ehcoll.bundledArchives.find((b) => b.sha256 === sha);
  if (!match) {
    throw new Error(
      `Bundled archive for sha=${sha} not found in .ehcoll. ` +
        `Re-build the package or report a manifest/bundled mismatch.`,
    );
  }
  return match.zipPath;
}

// ===========================================================================
// Removal plan (slice 6b)
// ===========================================================================

type RemovalItem = {
  modId: string;
  name: string;
  reason: "replace-existing" | "orphan-uninstall";
  compareKey?: string;
};

/**
 * Walk the plan and the user's confirmed decisions to build the list
 * of mods we'll uninstall in the `removing-mods` phase. Two sources:
 *
 *  - Every `ModResolution` whose decision is `*-diverged` and whose
 *    user choice is `replace-existing` contributes the
 *    `decision.existingModId` (with the new manifest's compareKey
 *    for provenance).
 *  - Every `OrphanedModDecision` whose user choice is `uninstall`
 *    contributes its `existingModId`.
 *
 * Empty result ⇒ skip the `removing-mods` phase entirely.
 */
function collectRemovalPlan(
  plan: DriverContext["plan"],
  decisions: UserConfirmedDecisions,
): RemovalItem[] {
  const items: RemovalItem[] = [];

  for (const r of plan.modResolutions) {
    const choice = decisions.conflictChoices?.[r.compareKey];
    if (!choice || choice.kind !== "replace-existing") continue;

    const decision = r.decision;
    if (
      decision.kind === "nexus-version-diverged" ||
      decision.kind === "nexus-bytes-diverged" ||
      decision.kind === "external-bytes-diverged"
    ) {
      items.push({
        modId: decision.existingModId,
        name: r.name,
        reason: "replace-existing",
        compareKey: r.compareKey,
      });
    }
  }

  for (const orphan of plan.orphanedMods) {
    const choice = decisions.orphanChoices?.[orphan.existingModId] ?? {
      kind: "keep" as const,
    };
    if (choice.kind === "uninstall") {
      items.push({
        modId: orphan.existingModId,
        name: orphan.name,
        reason: "orphan-uninstall",
        compareKey: orphan.originalCompareKey,
      });
    }
  }

  return items;
}

// ===========================================================================
// Preflight (slice 6b)
// ===========================================================================

/**
 * Exported for tests. It is a pure function of the plan and the user's
 * answers, and it is the gate that refused a tester's entire 979-mod retry —
 * so it is worth driving directly rather than only through the whole driver.
 */
export function preflight(
  plan: DriverContext["plan"],
  decisions: UserConfirmedDecisions,
): string | undefined {
  if (!plan.summary.canProceed) {
    return (
      "Plan summary reports canProceed=false. " +
      "Refusing to install — fix the issues flagged in the preview first."
    );
  }
  if (plan.compatibility.gameMatches !== true) {
    return "Plan's game id does not match the active Vortex game. Switch games and try again.";
  }

  // Hard-blocking decisions: nothing the user can pick fixes these.
  const hardBlockers = collectHardBlockers(plan.modResolutions);
  if (hardBlockers.length > 0) {
    return (
      `Plan contains ${hardBlockers.length} mod(s) that cannot be installed ` +
      `under any user choice: ` +
      hardBlockers.map((b) => `${b.name} [${b.kind}]`).join(", ") +
      `. Resolve at the resolver level (re-build the package or fix the manifest).`
    );
  }

  // For every conflict-needing decision, the action handler must have
  // supplied a matching ConflictChoice. Missing entries fail preflight.
  const missingChoices = collectMissingConflictChoices(
    plan.modResolutions,
    decisions,
  );
  if (missingChoices.length > 0) {
    return (
      `Plan contains ${missingChoices.length} mod(s) needing user input ` +
      `but no conflictChoice was supplied: ` +
      missingChoices.map((m) => `${m.name} [${m.kind}]`).join(", ") +
      `. The action handler must collect a ConflictChoice for each before running the driver.`
    );
  }

  // Every supplied choice must be valid for the decision it covers.
  const { invalid: invalidChoices, obsolete: obsoleteChoices } =
    collectInvalidConflictChoices(plan.modResolutions, decisions);
  if (obsoleteChoices.length > 0) {
    // Not a problem — evidence that a previous run's answers took effect.
    ehLog("info", "preflight.choices.obsolete", {
      count: obsoleteChoices.length,
      examples: obsoleteChoices.slice(0, 8),
      why:
        "these mods were answered on an earlier run and are now resolved " +
        "without a question, so their stored answers are ignored",
    });
  }
  if (invalidChoices.length > 0) {
    return (
      `Plan contains ${invalidChoices.length} invalid conflictChoice(s): ` +
      invalidChoices.join("; ")
    );
  }

  // Orphan choices that no longer name an orphan: satisfied, not invalid.
  const staleOrphans = collectInvalidOrphanChoices(
    plan.orphanedMods,
    decisions,
  );
  if (staleOrphans.length > 0) {
    ehLog("info", "preflight.orphan-choices.stale", {
      count: staleOrphans.length,
      examples: staleOrphans.slice(0, 8),
      why:
        "these mods are no longer orphans — most often because an earlier " +
        "run already acted on them — so their stored answers are ignored",
    });
  }

  // Defensive: in fresh-profile mode we should not see any orphans.
  if (
    plan.installTarget.kind === "fresh-profile" &&
    plan.orphanedMods.length > 0
  ) {
    return (
      `Plan reports ${plan.orphanedMods.length} orphaned mod(s) but fresh-profile ` +
      `installs should never produce orphans. Refusing to proceed.`
    );
  }

  return undefined;
}

function collectHardBlockers(
  resolutions: ModResolution[],
): Array<{ name: string; kind: ModDecision["kind"] }> {
  const out: Array<{ name: string; kind: ModDecision["kind"] }> = [];
  for (const r of resolutions) {
    if (
      r.decision.kind === "nexus-unreachable" ||
      r.decision.kind === "external-missing"
    ) {
      out.push({ name: r.name, kind: r.decision.kind });
    }
  }
  return out;
}

function collectMissingConflictChoices(
  resolutions: ModResolution[],
  decisions: UserConfirmedDecisions,
): Array<{ name: string; kind: ModDecision["kind"] }> {
  const out: Array<{ name: string; kind: ModDecision["kind"] }> = [];
  for (const r of resolutions) {
    if (!needsConflictChoice(r.decision)) continue;
    if (decisions.conflictChoices?.[r.compareKey] === undefined) {
      out.push({ name: r.name, kind: r.decision.kind });
    }
  }
  return out;
}

function needsConflictChoice(decision: ModDecision): boolean {
  return (
    decision.kind === "nexus-version-diverged" ||
    decision.kind === "nexus-bytes-diverged" ||
    decision.kind === "external-bytes-diverged" ||
    decision.kind === "external-prompt-user"
  );
}

/**
 * An answer that has been SATISFIED is not an error.
 *
 * ─── THE RUN THIS COMES FROM ────────────────────────────────────────────────
 * A tester's first install answered ten `external-prompt-user` mods by
 * pointing at local files, and one mod failed. On the retry, preflight
 * refused the entire 979-mod plan:
 *
 *   Plan contains 7 invalid conflictChoice(s): Render Tattoos
 *   [external-already-installed]: decision kind "external-already-installed"
 *   does not accept user choices; ...
 *
 * Every one of those seven was answered on the first run, and the answer
 * WORKED — the mod is installed, which is exactly why the resolver now says
 * `external-already-installed`. The stored answer had done its job and became
 * obsolete, and obsolete was being read as invalid.
 *
 * The distinction that matters is whether the decision still NEEDS an answer:
 *
 *   needs one, and the answer is the wrong shape  → INVALID, refuse
 *   needs none, and an answer is present          → OBSOLETE, ignore and log
 *
 * A run that cannot start because a previous run succeeded is the worst shape
 * a validation can take, and it made the retry button unusable for exactly the
 * case it was built for.
 */
function collectInvalidConflictChoices(
  resolutions: ModResolution[],
  decisions: UserConfirmedDecisions,
): { invalid: string[]; obsolete: string[] } {
  const invalid: string[] = [];
  const obsolete: string[] = [];
  for (const r of resolutions) {
    const choice = decisions.conflictChoices?.[r.compareKey];
    if (!choice) continue;
    if (!needsConflictChoice(r.decision)) {
      // Answered before, and the answer took effect. Nothing to validate.
      obsolete.push(`${r.name} [${r.decision.kind}]`);
      continue;
    }
    const reason = validateConflictChoice(r.decision, choice);
    if (reason) invalid.push(`${r.name} [${r.decision.kind}]: ${reason}`);
  }
  // Surface stray keys not referenced by any mod. Still an error: the plan
  // holds every manifest mod, so a key matching none of them is a real bug
  // rather than a decision that moved on.
  const validKeys = new Set(resolutions.map((r) => r.compareKey));
  for (const key of Object.keys(decisions.conflictChoices ?? {})) {
    if (!validKeys.has(key)) {
      invalid.push(`stray conflictChoice key "${key}" matches no mod in the plan`);
    }
  }
  return { invalid, obsolete };
}

function validateConflictChoice(
  decision: ModDecision,
  choice: ConflictChoice,
): string | undefined {
  if (
    decision.kind === "nexus-version-diverged" ||
    decision.kind === "nexus-bytes-diverged" ||
    decision.kind === "external-bytes-diverged"
  ) {
    if (choice.kind !== "keep-existing" && choice.kind !== "replace-existing") {
      return `expected keep-existing or replace-existing, got ${choice.kind}`;
    }
    return undefined;
  }
  if (decision.kind === "external-prompt-user") {
    if (choice.kind === "use-local-file") {
      if (typeof choice.localPath !== "string" || choice.localPath.length === 0) {
        return `use-local-file requires a non-empty localPath`;
      }
      return undefined;
    }
    if (choice.kind === "skip") return undefined;
    return `expected use-local-file or skip, got ${choice.kind}`;
  }
  return `decision kind "${decision.kind}" does not accept user choices`;
}

/**
 * The same rule for orphans, and it fails the same way.
 *
 * An orphan the previous run UNINSTALLED is no longer an orphan, so its stored
 * answer now names an id the plan has never heard of — and refusing on that
 * blocks a retry because the earlier retry worked.
 *
 * A genuinely bogus id and a satisfied one are indistinguishable from here, so
 * this weighs the two costs: ignoring a bad id costs a choice that does
 * nothing, while refusing costs the user a 979-mod install they cannot start.
 * Ignore, and say so in the log.
 */
function collectInvalidOrphanChoices(
  orphans: OrphanedModDecision[],
  decisions: UserConfirmedDecisions,
): string[] {
  const validIds = new Set(orphans.map((o) => o.existingModId));
  const out: string[] = [];
  for (const id of Object.keys(decisions.orphanChoices ?? {})) {
    if (!validIds.has(id)) out.push(id);
  }
  return out;
}

// ===========================================================================
// Deploy
// ===========================================================================

/**
 * Trigger Vortex's deployment pipeline and wait for it to finish.
 * Vortex emits `did-deploy` when activation completes (either after a
 * `deploy-mods` call or after a profile switch's auto-deploy).
 */
export async function deployAndWait(
  api: types.IExtensionApi,
  /** The profile this run has been filling. */
  expectedProfileId: string,
): Promise<void> {
  const state = api.getState();
  const profileId =
    state.settings?.profiles?.activeProfileId ??
    state.settings?.profiles?.nextProfileId;

  if (!profileId) {
    throw new Error("No active profile to deploy.");
  }

  /**
   * ─── DEPLOY THE PROFILE WE FILLED, OR NOTHING ───────────────────────────
   * This used to deploy whatever profile Vortex happened to have active,
   * read fresh from state. Every `enableModInProfile` in the run targets the
   * profile the plan named, so if the user switches profiles in Vortex during
   * a multi-hour install the two diverge: the deploy "succeeds" against the
   * OTHER profile, the receipt is written, and the run reports success for a
   * collection whose files were never linked into the game folder.
   *
   * It is also the wrong profile to touch — re-linking a profile this run has
   * nothing to do with is exactly what NS-2 is about.
   *
   * Fail loudly instead. The mods are installed and enabled in the right
   * profile; the user can switch back and deploy.
   */
  if (profileId !== expectedProfileId) {
    ehLog("error", "deploy.profile-mismatch", {
      expected: expectedProfileId,
      activeNow: profileId,
      consequence:
        "refusing to deploy — this run filled a different profile than the " +
        "one Vortex now has active",
    });
    throw new Error(
      `Vortex's active profile changed during the install (this run filled ` +
        `"${expectedProfileId}", Vortex now has "${profileId}"). The mods are ` +
        `installed and enabled; switch back to the collection's profile and ` +
        `deploy to finish.`,
    );
  }

  // Deployment links or copies every file of every mod, so a flat five
  // minutes was a 954-mod collection's problem — and it fires at the very END
  // of the install, turning a slow-but-working deploy into a failed one after
  // everything else succeeded.
  //
  // Raising this costs nothing when deployment is fast: the timer loses the
  // race to `did-deploy` and is cleared. It only ever changes how long a
  // genuinely stuck deploy takes to give up.
  const budgetMs = deployBudgetMs(countMods(state), {
    wine: looksLikeWine(),
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      api.events.removeListener("did-deploy", onDidDeploy);
      reject(
        new Error(
          `Deployment did not complete within ${Math.round(budgetMs / 1000)}s.`,
        ),
      );
    }, budgetMs);

    const onDidDeploy = (deployedProfileId: string): void => {
      if (settled) return;
      if (deployedProfileId !== profileId) return;
      settled = true;
      clearTimeout(timeout);
      api.events.removeListener("did-deploy", onDidDeploy);
      resolve();
    };

    api.events.on("did-deploy", onDidDeploy);

    /**
     * ─── CALLBACK FIRST. THIS ORDER IS NOT A STYLE CHOICE. ──────────────────
     * Vortex registers the handler as
     *
     *     events.on("deploy-mods", (callback, profileId, progressCB, opts) =>
     *       callback.called || deploymentTimer.runNow(callback, …))
     *
     * — verified in `app.asar`, and every one of Vortex's own call sites
     * passes the callback first (`emit("deploy-mods", cb)`).
     *
     * We passed `(profileId, callback)`. Vortex therefore took our profile-id
     * STRING as its callback and pushed it into the deployment debouncer's
     * callback list — `Debouncer.schedule` rejects `undefined` and `null` but
     * not a string. When the deployment settled, `invokeCallbacks` ran
     * `localCallbacks.forEach((cb) => cb(err))` against it and threw
     *
     *     TypeError: cb is not a function
     *
     * which Vortex reports as "An unrecoverable error occurred". Two testers
     * on two machines hit it, both roughly thirty seconds after a SUCCESSFUL
     * install — because the deploy really did run, and the crash is what
     * happens when it finishes. Our own callback, meanwhile, sat unused in
     * the `profileId` slot, so a genuine deploy failure could only ever
     * surface as the timeout below.
     */
    api.events.emit(
      "deploy-mods",
      (err: Error | null | undefined) => {
        if (settled) return;
        if (err) {
          settled = true;
          clearTimeout(timeout);
          api.events.removeListener("did-deploy", onDidDeploy);
          reject(err);
          return;
        }
        // Vortex calls this with `null` when the deployment completed, which
        // is a second, independent completion signal. `did-deploy` stays the
        // primary one; this stops a missed event costing the full budget.
        settled = true;
        clearTimeout(timeout);
        api.events.removeListener("did-deploy", onDidDeploy);
        resolve();
      },
      profileId,
    );
  });
}

// ===========================================================================
// Receipt
// ===========================================================================

/**
 * Build the install receipt. The receipt covers BOTH freshly-installed
 * mods AND mods carried forward from the previous release (H1 fix):
 * orphan-keep choices and diverged-keep-existing choices both produce
 * `CarriedModReportEntry`s that we fold into `receipt.mods`.
 *
 * Without this, the next release's resolver would lose lineage tags
 * for kept mods and miss them in orphan detection.
 *
 * Ordering: installed mods first (in install order), carried mods
 * after. Both buckets share the same on-disk shape; the receipt does
 * not distinguish them — it only describes "what this collection
 * currently controls on this machine."
 */
function buildReceipt(args: {
  ctx: DriverContext;
  profileId: string;
  profileName: string;
  installedMods: InstalledModReportEntry[];
  carriedMods: CarriedModReportEntry[];
  rulesApplication: RulesApplicationReceipt;
  userlistApplication: UserlistApplicationReceipt;
  verifications: ModVerificationReceipt[];
  /** Absent when this release had already stated its settings. */
  gameIniApplication?: GameIniApplicationReceipt;
  /**
   * Mods whose verification PASSED, and the file list that was proven.
   * Only these earn a drift reference — see {@link stagingSetHashFor}.
   */
  verifiedOkKeys: ReadonlySet<string>;
  expectedFilesByCompareKey: ReadonlyMap<string, EhcollStagingFile[]>;
  /**
   * Every mod id this run knows to be ours — the journal for this run, plus
   * the previous receipt for every run before it.
   *
   * The receipt used to derive ownership from `fromDecision` alone, which
   * describes only THIS run's decision. On a second run of the same release
   * every mod we installed resolves as `nexus-already-installed`, so a run
   * that changed nothing rewrote all of them as `adopted` and destroyed the
   * provenance the first run recorded. The journal is cleared on success, so
   * the receipt was the last copy.
   */
  ownedByUs: ReadonlySet<string>;
  /**
   * Finishing steps this run did NOT perform, because the user stopped it
   * after the deploy. Empty on an ordinary run.
   */
  finishingSkipped: readonly string[];
  /**
   * Light-flag rewrites this run made inside the user's game folder, with the
   * value each plugin had before — so the change is reversible.
   */
  pluginFlagChanges: readonly { plugin: string; wasLight: boolean }[];
  /**
   * Mods this run could NOT install. Empty on a complete reproduction.
   *
   * Their presence makes the receipt a PARTIAL claim — "installed except
   * these" — which is true, where writing nothing at all left 978 deployed
   * mods with no provenance and no way to resume.
   */
  failedMods: readonly { compareKey: string; name: string; reason: string }[];
}): InstallReceipt {
  const {
    ctx,
    profileId,
    profileName,
    installedMods,
    carriedMods,
    rulesApplication,
    userlistApplication,
    verifications,
    verifiedOkKeys,
    expectedFilesByCompareKey,
    ownedByUs,
    finishingSkipped,
    pluginFlagChanges,
    failedMods,
  } = args;
  const { manifest } = ctx.plan;
  const now = new Date().toISOString();

  const modEntries: InstallReceiptMod[] = [];

  for (const m of installedMods) {
    modEntries.push({
      vortexModId: m.vortexModId,
      compareKey: m.compareKey,
      source: m.source,
      name: m.name,
      installedAt: now,
      /**
       * The same test the journal uses (NS-2). An `*-already-installed`
       * decision hands back the USER'S mod id, so `installedMods` is not
       * all ours despite its name — and the receipt is what "Uninstall this
       * collection" reads.
       */
      /**
       * Ours if we know it is ours, whoever installed it and whenever.
       *
       * `ownedByUs` is consulted FIRST and it is monotone: a mod recorded as
       * ours by any earlier run stays ours here, because ownership is a fact
       * about the past that this run cannot revoke. Only when no record
       * claims it does the decision decide, and an `*-already-installed`
       * decision hands back the USER'S mod id — so `installedMods` is not all
       * ours despite its name (NS-2).
       */
      ownership: ownedByUs.has(m.vortexModId)
        ? ("installed" as const)
        : m.fromDecision.endsWith("already-installed")
          ? ("adopted" as const)
          : ("installed" as const),
      // Fingerprint of what we left on disk, for drift detection on a later
      // update.
      //
      // Recorded ONLY for a mod that verified OK, and that is what makes it
      // honest rather than convenient: verification passing means every file
      // the curator recorded is present with exactly the recorded bytes, so
      // the manifest's own file list IS a description of this machine's disk
      // — proven, not assumed, and free, because the verification just did
      // the reading.
      //
      // A mod that failed verification gets NO hash. Its files are not what
      // the manifest says, so a hash derived from the manifest would be a
      // fiction, and one derived from disk would enshrine a broken install as
      // the reference. Absent means unknown; see InstallReceiptMod.
      ...stagingSetHashFor(m, verifiedOkKeys, expectedFilesByCompareKey),
      // The user's own copy, which the alongside install switched off in this
      // profile. Uninstall reads it to switch that copy back on — without it
      // removing our copy leaves the user with NEITHER active.
      ...(m.displacedModId !== undefined
        ? { displacedModId: m.displacedModId }
        : {}),
    });
  }

  for (const c of carriedMods) {
    modEntries.push({
      vortexModId: c.vortexModId,
      compareKey: c.compareKey,
      source: c.source,
      name: c.name,
      /**
       * Conservative by design (NS-2). A carry is either a keep-existing
       * choice — the USER'S copy, definitively not ours — or an orphan we
       * installed under an earlier release. This run cannot tell them apart,
       * and the only safe reading of "cannot tell" is "not ours": the cost of
       * being wrong here is that uninstall leaves one of our own mods behind,
       * against deleting one of theirs.
       */
      ownership: "adopted" as const,
      // Carried mods were installed by a previous release; we keep the
      // current release's `installedAt` for simplicity (the receipt's
      // own `installedAt` is "when this receipt was written," not "when
      // each mod was installed"). A future schema bump may add a real
      // per-mod history field — for v1 this is good enough for orphan
      // detection, which only cares about compareKey membership.
      installedAt: now,
    });
  }

  return {
    schemaVersion: INSTALL_LEDGER_SCHEMA_VERSION,
    packageId: manifest.package.id,
    packageVersion: manifest.package.version,
    packageName: manifest.package.name,
    gameId: manifest.game.id as SupportedGameId,
    installedAt: now,
    vortexProfileId: profileId,
    vortexProfileName: profileName,
    installTargetMode: ctx.plan.installTarget.kind,
    // Only when the user was actually asked. Absent means "not recorded",
    // which is a weaker and truer claim than defaulting it to silent.
    ...(ctx.decisions.fomodReplayMode !== undefined
      ? { fomodReplayMode: ctx.decisions.fomodReplayMode }
      : {}),
    mods: modEntries,
    rulesApplication,
    userlistApplication,
    verifications,
    ...(args.gameIniApplication !== undefined
      ? { gameIniApplication: args.gameIniApplication }
      : {}),
    /**
     * Absent on an ordinary run, so its presence IS the signal.
     *
     * The receipt is the claim "this collection is installed at this version",
     * and the Doctor, the Collections page and every later upgrade read it as
     * a complete healthy install. A run the user stopped after the deploy is
     * installed but unfinished, and the only place that said so was a notice
     * on a screen they have since closed.
     */
    ...(finishingSkipped.length > 0
      ? { finishingSkipped: [...finishingSkipped] }
      : {}),
    ...(pluginFlagChanges.length > 0
      ? { pluginFlagChanges: [...pluginFlagChanges] }
      : {}),
    // Absent on a complete run, so its presence IS the partial signal.
    ...(failedMods.length > 0 ? { failedMods: [...failedMods] } : {}),
  };
}

/**
 * Atomic write the receipt with one transient retry. Real failure
 * modes we've observed in Vortex extensions:
 *   - antivirus briefly locks the temp file (clears in <100ms)
 *   - filesystem stutters during heavy parallel I/O
 *
 * Both clear on a quick second attempt. Two attempts is the right
 * number: it covers the transient window without masking real
 * permanent failures behind a long retry loop.
 *
 * Permanent failures (ENOENT for missing parent dir, ENOSPC, EROFS,
 * EACCES on a perm-mismatched path) will not improve on retry — we
 * surface them immediately so the user gets a fast, actionable
 * error instead of a 250ms-delayed copy of the same one.
 *
 * {@link InstallLedgerError} is also non-retryable: it's our own
 * structured error type, raised when the receipt itself is invalid
 * (schema mismatch, programmer bug). Retrying would just hit the
 * same validation code path.
 */
async function writeReceiptWithRetry(
  appDataPath: string,
  receipt: InstallReceipt,
): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RECEIPT_WRITE_ATTEMPTS; attempt++) {
    try {
      const { path: writtenPath } = await writeReceipt(appDataPath, receipt);
      return writtenPath;
    } catch (err) {
      lastErr = err;
      if (attempt < RECEIPT_WRITE_ATTEMPTS && isTransientReceiptError(err)) {
        await delay(RECEIPT_WRITE_RETRY_DELAY_MS);
      } else {
        // Either the last attempt or a non-transient error — fail fast.
        throw lastErr;
      }
    }
  }
  throw lastErr;
}

/**
 * Decide whether a receipt-write error is worth retrying. We only
 * retry codes that have a track record of being caused by transient
 * external interference (AV scanners, parallel I/O, briefly-held
 * locks). Everything else (missing dir, permission denied on the
 * actual target, disk full, ledger validation failure) won't improve
 * by waiting and is surfaced immediately.
 */
function isTransientReceiptError(err: unknown): boolean {
  if (err instanceof InstallLedgerError) return false;

  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code !== "string") return false;

  // EBUSY    — Windows file lock (AV / explorer.exe / OneDrive)
  // EPERM    — Windows "operation not permitted" while another
  //            process has a handle (often AV-related)
  // EAGAIN   — POSIX "try again", file system busy
  // EMFILE / ENFILE — too many open file descriptors transiently
  // ENOTEMPTY — lingering tmp dir contents from a prior write that
  //             the OS hasn't fully GC'd yet
  return (
    code === "EBUSY" ||
    code === "EPERM" ||
    code === "EAGAIN" ||
    code === "EMFILE" ||
    code === "ENFILE" ||
    code === "ENOTEMPTY"
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a Map<compareKey, EhcollMod> for fast lookup. The resolver
 * enforces unique compareKeys per manifest, so collisions cannot
 * happen in valid manifests; we trust that and last-write wins on
 * the rare bad input (parseManifest would have rejected it earlier).
 */
function buildManifestIndex(mods: EhcollMod[]): Map<string, EhcollMod> {
  const map = new Map<string, EhcollMod>();
  for (const m of mods) map.set(m.compareKey, m);
  return map;
}

/**
 * Build a CarriedModReportEntry for an orphaned mod the user chose
 * to keep. The orphan retains its previous-release lineage; we do
 * NOT enable it (the user said "keep" meaning "leave alone").
 *
 * Source kind is inferred from Vortex state — Nexus mods carry
 * `attributes.modId`, others are treated as external. The receipt's
 * `source` field is UI-only, so a mis-classification here is
 * cosmetic.
 */
function buildOrphanCarriedEntry(
  api: types.IExtensionApi,
  plan: DriverContext["plan"],
  orphan: OrphanedModDecision,
): CarriedModReportEntry {
  return {
    vortexModId: orphan.existingModId,
    name: orphan.name,
    source: inferModSource(api, plan.manifest.game.id, orphan.existingModId),
    reason: "orphan-keep",
    compareKey: orphan.originalCompareKey,
    installedFromVersion: orphan.installedFromVersion,
    enabledInProfile: false,
  };
}

function inferModSource(
  api: types.IExtensionApi,
  gameId: string,
  modId: string,
): "nexus" | "external" {
  const state = api.getState();
  const mod = (state as unknown as {
    persistent?: { mods?: Record<string, Record<string, {
      attributes?: { modId?: unknown; source?: unknown };
    }>> };
  }).persistent?.mods?.[gameId]?.[modId];
  if (!mod) return "external";
  const attrs = mod.attributes ?? {};
  if (attrs.modId !== undefined && attrs.modId !== null) return "nexus";
  if (typeof attrs.source === "string" && attrs.source.toLowerCase() === "nexus") {
    return "nexus";
  }
  return "external";
}

// ===========================================================================
// Misc
// ===========================================================================

function describeDecision(
  decision: ModDecision,
  decisions: UserConfirmedDecisions,
): string {
  switch (decision.kind) {
    case "nexus-download":
      return "downloading from Nexus";
    case "nexus-use-local-download":
      return "installing from local download";
    case "nexus-already-installed":
      return "re-using existing installed mod";
    case "external-use-bundled":
      return "extracting + installing bundled archive";
    case "external-use-local-download":
      return "installing from local download";
    case "external-already-installed":
      return "re-using existing installed mod";
    case "nexus-version-diverged":
    case "nexus-bytes-diverged":
    case "external-bytes-diverged": {
      // We don't have the compareKey here, so the caller surfaces a
      // generic label. For prettier UX the action layer can re-render
      // its own message.
      return decision.kind;
    }
    case "external-prompt-user":
      return "external-prompt-user (using user-supplied file)";
    default:
      return decision.kind;
  }
  // `decisions` is here for forward extensibility (slice 6c may
  // surface choice details in the progress message); consumed via
  // unused parameter.
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  decisions;
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return JSON.stringify(err);
}

function assertNever(value: never): never {
  throw new Error(`Unexpected decision kind: ${JSON.stringify(value)}`);
}

/**
 * Check whether a manifest entry is a Nexus mod (narrowing helper
 * for callers; kept here so we don't import the discriminator
 * helper from elsewhere).
 *
 * Currently unused publicly; reserved for slice 6c.
 */
export function isNexusEhcollMod(mod: EhcollMod): mod is NexusEhcollMod {
  return mod.source.kind === "nexus";
}

// Used to preserve the EhcollManifest import for type tooling.
export type _EhcollManifestRef = EhcollManifest;

// ===========================================================================
// Slice 6c helpers — modId resolution maps + rules-application bookkeeping
// ===========================================================================

/**
 * Build the compareKey → vortex modId map used by both `applyModRules`
 * and `applyLoadOrder`. Sources, last-write-wins:
 *  1. `installedMods` — freshly-installed AND already-installed re-uses
 *     (the `*-already-installed` decision arms produce entries here).
 *  2. `carriedMods` — diverged-keep-existing (existing user mod kept)
 *     and orphan-keep (previous-release mod kept).
 *
 * Last-write-wins is fine: a single compareKey can appear at most once
 * across both lists by construction (the resolver enforces unique
 * compareKeys per plan).
 */
function buildPostInstallModIdMap(
  installedMods: InstalledModReportEntry[],
  carriedMods: CarriedModReportEntry[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of installedMods) map.set(m.compareKey, m.vortexModId);
  for (const c of carriedMods) map.set(c.compareKey, c.vortexModId);
  return map;
}

/**
 * Build vortex modId → display name. Used by `applyLoadOrder` to
 * populate `ILoadOrderEntry_2.name` (Vortex's array shape requires a
 * display name). We pull from the same install + carry buckets the
 * compareKey map uses so the display matches what the install
 * summary will show.
 */
function buildDisplayNameByModId(
  installedMods: InstalledModReportEntry[],
  carriedMods: CarriedModReportEntry[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of installedMods) map.set(m.vortexModId, m.name);
  for (const c of carriedMods) map.set(c.vortexModId, c.name);
  return map;
}

/**
 * Build the partial-Nexus-pin resolution map. For every Nexus-source
 * mod in the install/carry buckets, look up the underlying Vortex mod
 * record and index by `attributes.modId` (the Nexus mod id).
 *
 * Multiple installed files for the same Nexus modId would collide
 * here; last-write-wins matches what `applyModRules` documents
 * (curator intent is fuzzy by construction when they only pinned the
 * modId without a fileId).
 */
function buildNexusModIdMap(
  api: types.IExtensionApi,
  gameId: string,
  installedMods: InstalledModReportEntry[],
  carriedMods: CarriedModReportEntry[],
): { map: Map<string, string>; ambiguous: Set<string> } {
  const map = new Map<string, string>();
  const ambiguous = new Set<string>();
  const state = api.getState();
  const modsForGame = (
    state as unknown as {
      persistent?: {
        mods?: Record<
          string,
          Record<string, { attributes?: { modId?: unknown } }>
        >;
      };
    }
  ).persistent?.mods?.[gameId];
  if (!modsForGame) return { map, ambiguous };

  const collect = (vortexModId: string, source: "nexus" | "external"): void => {
    if (source !== "nexus") return;
    const record = modsForGame[vortexModId];
    const raw = record?.attributes?.modId;
    const nexusModId =
      typeof raw === "number"
        ? String(raw)
        : typeof raw === "string" && raw.length > 0
          ? raw
          : undefined;
    if (nexusModId === undefined) return;
    // A second mod for the same Nexus modId is NOT a data error — installing
    // two variants of one mod is ordinary practice, and this profile has 104
    // of them. It only means a partial pin naming this modId cannot be
    // resolved, so record the collision instead of letting the last writer
    // win silently.
    if (map.has(nexusModId) && map.get(nexusModId) !== vortexModId) {
      ambiguous.add(nexusModId);
    }
    map.set(nexusModId, vortexModId);
  };

  for (const m of installedMods) collect(m.vortexModId, m.source);
  for (const c of carriedMods) collect(c.vortexModId, c.source);

  return { map, ambiguous };
}

/**
 * Walk Vortex's mod-rules state for every source mod in the rule
 * targets and return an `ExistingRule[]` projection keyed by source
 * vortex modId. This is what `applyModRules` consumes for the
 * collection-wins conflict pass.
 *
 * We only collect rules for mods we're *about* to add a rule on
 * (i.e. mods present in `modIdByCompareKey`). Pulling the entire
 * mod table would be wasteful for large profiles.
 */
function collectExistingRules(
  api: types.IExtensionApi,
  gameId: string,
  modIdByCompareKey: ReadonlyMap<string, string>,
): Map<string, ExistingRule[]> {
  const out = new Map<string, ExistingRule[]>();
  const state = api.getState();
  const modsForGame = (
    state as unknown as {
      persistent?: {
        mods?: Record<
          string,
          Record<
            string,
            {
              rules?: Array<{
                type?: unknown;
                reference?: {
                  id?: unknown;
                  repo?: { modId?: unknown; fileId?: unknown };
                  archiveId?: unknown;
                };
              }>;
            }
          >
        >;
      };
    }
  ).persistent?.mods?.[gameId];
  if (!modsForGame) return out;

  const sourceModIds = new Set(modIdByCompareKey.values());
  for (const sourceModId of sourceModIds) {
    const record = modsForGame[sourceModId];
    const rawRules = record?.rules ?? [];
    if (rawRules.length === 0) continue;

    const projected: ExistingRule[] = [];
    for (const r of rawRules) {
      if (typeof r.type !== "string") continue;
      const ref = r.reference ?? {};
      projected.push({
        type: r.type,
        reference: {
          id: typeof ref.id === "string" ? ref.id : undefined,
          repo:
            ref.repo &&
            typeof ref.repo === "object" &&
            ref.repo !== null
              ? {
                  modId:
                    typeof ref.repo.modId === "string"
                      ? ref.repo.modId
                      : undefined,
                  fileId:
                    typeof ref.repo.fileId === "string"
                      ? ref.repo.fileId
                      : undefined,
                }
              : undefined,
          archiveId:
            typeof ref.archiveId === "string" ? ref.archiveId : undefined,
        },
      });
    }
    if (projected.length > 0) {
      out.set(sourceModId, projected);
    }
  }

  return out;
}

/**
 * Initial empty value for the rules-application receipt. The driver
 * mutates this incrementally as each phase completes; the final
 * value lands in the receipt.
 */
function emptyRulesApplication(): RulesApplicationReceipt {
  return {
    appliedRuleCount: 0,
    overwrittenUserRuleCount: 0,
    skippedRules: [],
    appliedLoadOrderCount: 0,
    skippedLoadOrderEntries: [],
    baselinePluginOrder: [],
  };
}

function mergeRuleResult(
  base: RulesApplicationReceipt,
  ruleResult: ApplyModRulesResult,
): RulesApplicationReceipt {
  return {
    ...base,
    appliedRuleCount: base.appliedRuleCount + ruleResult.applied,
    overwrittenUserRuleCount:
      base.overwrittenUserRuleCount + ruleResult.overwrittenUserRules,
    skippedRules: [
      ...base.skippedRules,
      ...ruleResult.skipped.map((s) => ({
        ruleType: s.type,
        source: s.source,
        reference: s.reference,
        reason: s.reason,
      })),
    ],
  };
}

function mergeLoadOrderResult(
  base: RulesApplicationReceipt,
  loResult: ApplyLoadOrderResult,
): RulesApplicationReceipt {
  return {
    ...base,
    appliedLoadOrderCount: base.appliedLoadOrderCount + loResult.applied,
    skippedLoadOrderEntries: [
      ...base.skippedLoadOrderEntries,
      ...loResult.skipped.map((s) => ({
        compareKey: s.compareKey,
        pos: s.pos,
        reason: s.reason,
      })),
    ],
  };
}

// ===========================================================================
// Slice 6d — userlist-application bookkeeping
// ===========================================================================

/**
 * Initial empty value for the userlist-application receipt. Merged
 * incrementally as `applyUserlist` returns.
 */
function emptyUserlistApplication(): UserlistApplicationReceipt {
  return {
    appliedRuleCount: 0,
    appliedGroupAssignmentCount: 0,
    overwrittenGroupAssignmentCount: 0,
    appliedNewGroupCount: 0,
    appliedGroupRuleCount: 0,
    skippedUserlistEntries: [],
  };
}

// ===========================================================================
// Slice 7 — file integrity verification helpers
// ===========================================================================

/**
 * Attempt one recovery cycle for a mod whose post-install
 * verification reported missing / truncated / corrupt files.
 *
 * Strategy: uninstall the failing mod, re-execute the original
 * decision, re-enable in the active profile, re-verify. The
 * recovery succeeds when the second verify reports `kind === "ok"`.
 *
 * ─── ALREADY-INSTALLED MODS ARE REPAIRED TOO ──────────────────────────
 * They used not to be. The rule was that `*-already-installed` re-used a mod
 * the user had on disk, so a mismatch might be their own edit from two months
 * ago rather than a bad extraction, and reinstalling would overwrite it.
 *
 * That reasoning was written when "already installed" could only mean "the
 * user had this before Event Horizon ran". On a RESUME it mostly means "we
 * installed this ourselves twenty minutes ago and the run was interrupted" —
 * which is precisely the population most likely to be half-extracted. The
 * guard was protecting the wrong mods, and leaving broken ones broken after
 * detecting them, which is the one outcome this tool exists to prevent.
 *
 * Two things make it safe to reinstall now, and both are checks that did not
 * exist when the rule was written. `judgeReinstall` has already excused the
 * mods whose files differ because the CURATOR's staging diverged, and the
 * ones whose files match the archive exactly; what reaches here differs from
 * the curator's copy AND from the archive it came from. And the repair
 * uninstalls first, so Vortex never shows its "already installed — replace or
 * install as a variant?" dialog for it.
 *
 * The decision arm carries nothing to re-execute — it points at the very mod
 * being repaired — so the install decision is rebuilt from the manifest by
 * {@link repairDecisionFor}. A mod it cannot rebuild one for (an external mod
 * with no bundled archive) stays `not-eligible`: there is nothing on this
 * machine to reinstall from.
 *
 * The retry runs inline in the verifying-mods phase. There is no
 * progress sub-bar — typical recovery completes in seconds (Vortex
 * re-extracts from the same cached archive). For nexus-download
 * decisions where the archive is no longer cached, Vortex will
 * re-download; that's slow but still correct, and the user sees
 * the existing phase progress message advance.
 *
 * Returns:
 *  - `recovered`     — verify came back ok the second time.
 *  - `retry-failed`  — retry ran but verify still failed.
 *  - `not-eligible`  — decision arm wasn't a fresh install (skip).
 *  - `errored`       — uninstall or reinstall threw; the original
 *                      mod entry is left untouched. We treat this
 *                      as a non-fatal soft failure to keep the
 *                      driver moving toward the rules phase.
 */
type RecoverResult =
  | {
      kind: "recovered";
      installEntry: InstalledModReportEntry;
      verifiedCount: number;
      extraFileCount: number;
    }
  /**
   * The reinstall ran and the mod is on disk under a NEW id, but it still
   * does not match the manifest.
   *
   * `installEntry` is why this is not just a status. The old id was deleted by
   * the uninstall, so a caller that keeps it leaves every later phase — mod
   * rules, ini tweaks, modType restore, the staging mirror, the receipt —
   * pointing at a mod that no longer exists, while the real one gets none of
   * them. Files verify; the load order silently does not reproduce.
   */
  | { kind: "retry-failed"; installEntry: InstalledModReportEntry }
  | { kind: "not-eligible" }
  /**
   * The mod is the USER's, not ours. Distinct from `not-eligible` because the
   * caller acts on it: it installs the curator's copy alongside theirs rather
   * than giving up. Collapsing the two would silently ship a collection that
   * differs from the curator's.
   */
  | { kind: "not-ours" }
  /**
   * The repair threw. `installEntry` is present only when the reinstall had
   * already produced a mod; `modRemoved` says whether the uninstall took the
   * user's copy with it, which is the difference between "nothing happened"
   * and "the mod is gone".
   */
  | {
      kind: "errored";
      installEntry?: InstalledModReportEntry;
      modRemoved: boolean;
    };

async function tryRecoverFailedMod(args: {
  ctx: DriverContext;
  installEntry: InstalledModReportEntry;
  manifestEntry: EhcollMod | undefined;
  activeProfileId: string;
  expectedFiles: import("../../types/ehcoll").EhcollStagingFile[] | undefined;
  level: import("../../types/ehcoll").VerificationLevel;
  /**
   * Did THIS TOOL put this mod on the disk? The repair uninstalls before it
   * reinstalls, so this is the difference between repairing our own work and
   * destroying the user's.
   */
  weInstalledIt: boolean;
  /**
   * Where to register a temp directory the repair created, so the driver
   * removes it at the end of the run like every other one.
   */
  onTempArchive?: (p: string) => void;
}): Promise<RecoverResult> {
  const {
    ctx,
    installEntry,
    manifestEntry,
    activeProfileId,
    expectedFiles,
    level,
    weInstalledIt,
    onTempArchive,
  } = args;

  // Find the resolution so we can re-execute the original decision.
  // Resolutions are keyed by compareKey; we already validated all
  // installed entries have a matching resolution at the install
  // loop site.
  const resolution = ctx.plan.modResolutions.find(
    (r) => r.compareKey === installEntry.compareKey,
  );
  if (resolution === undefined || manifestEntry === undefined) {
    return { kind: "not-eligible" };
  }

  // An already-installed arm has no install to re-execute — re-running it
  // would return the id of the mod we are about to uninstall, and we would
  // "recover" onto a mod that no longer exists. Rebuild a real one, or stop
  // BEFORE the uninstall rather than after it.
  let retryResolution = resolution;
  if (installEntry.fromDecision.endsWith("already-installed")) {
    /**
     * ─── NEVER UNINSTALL A MOD WE DID NOT INSTALL ───────────────────────
     * Removing the guard entirely was too far. The argument for it —
     * "on a resume, already-installed mostly means we installed it" — is a
     * statement about base rates, and the code applied it universally.
     *
     * What that reached: a mod the user installed themselves with their OWN
     * FOMOD answers, whose archive hash Vortex never kept. The resolver
     * matches it on Nexus ids, adopts it WITHOUT replaying the curator's
     * choices, verification fails because the curator's choices selected
     * files this copy does not have, and `judgeReinstall` returns `reinstall`
     * for missing files before it even opens the archive. Then this function
     * called `util.removeMods` — a global delete, staging folder and all — on
     * a mod the user brought. `installPlan.ts` promises the opposite:
     * "Old profile is byte-untouched… Zero collision risk by construction."
     *
     * So the question is answered by evidence now, not by likelihood: the
     * install journal records what we created, confirmed against live Vortex
     * state.
     *
     * The caller does not merely report the rest. It installs the curator's
     * copy ALONGSIDE the user's — see `installAlongside` — so the collection
     * is reproduced exactly and their work survives untouched. This function
     * only refuses to be the thing that destroys it.
     */
    if (!weInstalledIt) {
      ehLog("info", "verify.repair.not-ours", {
        name: installEntry.name,
        compareKey: installEntry.compareKey,
        vortexModId: installEntry.vortexModId,
        why: "no journal record that this tool installed this mod",
        next: "install the curator's copy alongside it",
      });
      return { kind: "not-ours" };
    }

    /**
     * ─── CAN WE ACTUALLY FETCH IT BACK? ─────────────────────────────────
     * `repairDecisionFor` returns `nexus-download` for every Nexus mod, and
     * the account preflight cannot warn about it: `checkNexusAccount` counts
     * eligibility from `nexus-download` decisions IN THE PLAN, and a resume
     * plan is almost entirely `already-installed`. So the run tells the user
     * no downloads are needed, then the repair manufactures some.
     *
     * On a signed-out or free account `nexusDownload` is absent or sends the
     * user to a browser, `installNexusViaApi` burns its retries and throws —
     * AFTER the uninstall. The mod is then gone with no way to get it back,
     * which is exactly the outcome the pre-uninstall refusal exists to avoid.
     * It just was not applied to this arm.
     */
    const repair = repairDecisionFor(manifestEntry);
    if (
      repair?.kind === "nexus-download" &&
      typeof (ctx.api as { ext?: { nexusDownload?: unknown } }).ext
        ?.nexusDownload !== "function"
    ) {
      ehLog("warn", "verify.repair.not-possible", {
        name: installEntry.name,
        compareKey: installEntry.compareKey,
        why: "Nexus downloading is unavailable — signed out, or the Nexus extension is disabled",
      });
      return { kind: "not-eligible" };
    }
    if (repair === undefined) {
      ehLog("info", "verify.repair.not-possible", {
        name: installEntry.name,
        fromDecision: installEntry.fromDecision,
        why: "no archive to reinstall from",
      });
      return { kind: "not-eligible" };
    }
    retryResolution = { ...resolution, decision: repair };
    ehLog("info", "verify.repair.rebuilt-decision", {
      name: installEntry.name,
      fromDecision: installEntry.fromDecision,
      repairDecision: repair.kind,
    });
  }

  try {
    // Step 1: uninstall the failing mod. Vortex's uninstaller
    // cleans both the staging folder and the mod state slice; we
    // start from a known-empty baseline before the second extract.
    await uninstallMod(ctx.api, {
      gameId: ctx.plan.manifest.game.id,
      modId: installEntry.vortexModId,
    });
  } catch (err) {
    // The mod is untouched: the removal is what failed. This is the benign
    // arm of `errored`, and saying so is the whole reason `modRemoved` exists.
    ehLog("error", "verify.repair.done", {
      name: installEntry.name,
      compareKey: installEntry.compareKey,
      outcome: "errored",
      stage: "uninstall",
      modRemoved: false,
      vortexModId: installEntry.vortexModId,
      err,
    });
    return { kind: "errored", modRemoved: false };
  }

  // Step 2: re-execute the decision. We reuse the executeDecision
  // path so divergence + prompt-user choices (which Plan-A includes
  // in installedMods if their conflict choice was "replace-existing"
  // or "use-local-file") get re-resolved through the same code
  // that did the original install. Side-effects we DON'T want:
  //  - onSkip / onCarry callbacks: retry is for the install path,
  //    if the decision arm produced a skip the first time we'd
  //    have never landed in installedMods. So pass no-op callbacks.
  //  - tempArchive accumulation: bundled retries produce a fresh
  //    temp dir; we re-thread it into the same cleanup list.
  let newEntry: InstalledModReportEntry | undefined;
  try {
    newEntry = await executeDecision({
      ctx,
      resolution: retryResolution,
      manifestEntry,
      profileId: activeProfileId,
      // A notice from a RETRY would duplicate the one the first attempt
      // already produced — same mod, same picked file, same mismatch — and a
      // user told twice about one thing reasonably assumes it happened twice.
      onNotice: () => undefined,
      /**
       * A bundled repair extracts the mod's whole archive into a fresh temp
       * dir. This used to discard the path with "the OS temp GC handles it",
       * which is not true on Windows — Storage Sense is opt-in and age-gated.
       * Each bundled repair leaked one archive-sized directory, hundreds of MB
       * for a mesh or voice pack, on machines already at risk of running out
       * of space mid-install.
       */
      onTempArchive: onTempArchive ?? ((p) => void p),
      onSkip: () => {
        /* should not happen on a retry — install arm only */
      },
      onCarry: () => {
        /* should not happen on a retry — install arm only */
      },
    });
  } catch (err) {
    if (
      isAbort(err) ||
      ctx.abortSignal?.aborted
    ) {
      throw err;
    }
    /**
     * The uninstall SUCCEEDED and the reinstall did not, so the mod is gone
     * from this machine. This is the most destructive outcome the driver has
     * and it used to reach `console.warn` only — Electron devtools, which dies
     * with the session and never appears in the file a tester sends.
     */
    ehLog("error", "verify.repair.done", {
      name: installEntry.name,
      compareKey: installEntry.compareKey,
      outcome: "errored",
      stage: "reinstall",
      modRemoved: true,
      removedVortexModId: installEntry.vortexModId,
      err,
    });
    return { kind: "errored", modRemoved: true };
  }

  if (newEntry === undefined) {
    // executeDecision returned undefined → the arm now wants to
    // skip / carry. Defensive: original decision must've changed
    // between attempts (impossible by construction, but the type
    // system can't enforce that). Treat as a hard recovery failure.
    //
    // The uninstall already happened, so the mod is gone. This branch logged
    // nothing at all before — not even to devtools.
    ehLog("error", "verify.repair.done", {
      name: installEntry.name,
      compareKey: installEntry.compareKey,
      outcome: "errored",
      stage: "reinstall",
      modRemoved: true,
      removedVortexModId: installEntry.vortexModId,
      why: "the decision arm produced no mod",
    });
    return { kind: "errored", modRemoved: true };
  }

  enableModInProfile(ctx.api, activeProfileId, newEntry.vortexModId);

  // Step 3: re-verify. Same level, same expected file set.
  let secondResult: VerifyResult;
  try {
    secondResult = await verifyModInstall({
      api: ctx.api,
      gameId: ctx.plan.manifest.game.id,
      vortexModId: newEntry.vortexModId,
      expectedFiles,
      level,
      signal: ctx.abortSignal,
    });
  } catch (err) {
    if (
      isAbort(err) ||
      ctx.abortSignal?.aborted
    ) {
      throw err;
    }
    // The reinstall SUCCEEDED; only the re-check failed. The mod exists under
    // `newEntry` and the caller must adopt that id, or every later phase aims
    // at the one we deleted.
    ehLog("error", "verify.repair.done", {
      name: installEntry.name,
      compareKey: installEntry.compareKey,
      outcome: "errored",
      stage: "reverify",
      modRemoved: false,
      oldVortexModId: installEntry.vortexModId,
      newVortexModId: newEntry.vortexModId,
      err,
    });
    return { kind: "errored", installEntry: newEntry, modRemoved: false };
  }

  if (secondResult.kind === "ok") {
    ehLog("info", "verify.repair.done", {
      name: installEntry.name,
      compareKey: installEntry.compareKey,
      outcome: "recovered",
      oldVortexModId: installEntry.vortexModId,
      newVortexModId: newEntry.vortexModId,
      verifiedCount: secondResult.verifiedCount,
    });
    return {
      kind: "recovered",
      installEntry: newEntry,
      verifiedCount: secondResult.verifiedCount,
      extraFileCount: secondResult.extraFiles.length,
    };
  }

  // skip on retry shouldn't happen (we passed the same expectedFiles
  // and level), but defensively treat it as a retry failure rather
  // than masking it as a recovery.
  //
  // The entry travels with it: the mod EXISTS, under this new id, and the
  // only open question is whether its files match.
  ehLog("warn", "verify.repair.done", {
    name: installEntry.name,
    compareKey: installEntry.compareKey,
    outcome: "retry-failed",
    oldVortexModId: installEntry.vortexModId,
    newVortexModId: newEntry.vortexModId,
  });
  return { kind: "retry-failed", installEntry: newEntry };
}

/**
 * Build a `kind: "fail"` verification receipt from a `VerifyFail`.
 * Caps the example list at ~30 entries (10 per bucket) — receipts
 * are inspected by hand and pasted into bug reports, so a few
 * representative paths beat a 5MB JSON of every missing file.
 */
function buildFailReceipt(args: {
  installEntry: InstalledModReportEntry;
  verifyResult: Extract<VerifyResult, { kind: "fail" }>;
  level: "fast" | "thorough";
  retryAttempted: boolean;
  /**
   * The repair removed the mod and could not put it back.
   *
   * Without this, "reinstalled and still mismatching" and "deleted from your
   * machine" were the same receipt row — and they are opposite situations for
   * the person reading it.
   */
  modRemoved?: boolean;
  /**
   * Set when the files are NOT the reason. See
   * `ModVerificationFailReceipt.failReason` — without it a mod whose only
   * defect is its FOMOD answers is rendered as "0 missing, 0 truncated,
   * 0 corrupt" under prose blaming antivirus.
   */
  failReason?: "stale-installer-options";
}): ModVerificationReceipt {
  const { installEntry, verifyResult, level, retryAttempted } = args;
  const modRemoved = args.modRemoved === true;
  const examples: ModVerificationFailExample[] = [];

  for (const p of verifyResult.missingFiles.slice(0, 10)) {
    examples.push({ bucket: "missing", path: p });
  }
  for (const m of verifyResult.sizeMismatches.slice(0, 10)) {
    examples.push({
      bucket: "size",
      path: m.path,
      expected: String(m.expected),
      actual: String(m.actual),
    });
  }
  for (const h of verifyResult.hashMismatches.slice(0, 10)) {
    examples.push({
      bucket: "hash",
      path: h.path,
      expected: h.expected,
      actual: h.actual,
    });
  }

  return {
    kind: "fail",
    vortexModId: installEntry.vortexModId,
    compareKey: installEntry.compareKey,
    name: installEntry.name,
    level,
    expectedFileCount: verifyResult.expectedCount,
    missingFileCount: verifyResult.missingFiles.length,
    sizeMismatchCount: verifyResult.sizeMismatches.length,
    hashMismatchCount: verifyResult.hashMismatches.length,
    examples,
    retryAttempted,
    ...(modRemoved ? { modRemoved: true } : {}),
    ...(args.failReason !== undefined ? { failReason: args.failReason } : {}),
  };
}

function mergeUserlistResult(
  base: UserlistApplicationReceipt,
  ulResult: ApplyUserlistResult,
): UserlistApplicationReceipt {
  return {
    appliedRuleCount: base.appliedRuleCount + ulResult.appliedRuleCount,
    appliedGroupAssignmentCount:
      base.appliedGroupAssignmentCount + ulResult.appliedGroupAssignmentCount,
    overwrittenGroupAssignmentCount:
      base.overwrittenGroupAssignmentCount +
      ulResult.overwrittenGroupAssignmentCount,
    appliedNewGroupCount:
      base.appliedNewGroupCount + ulResult.appliedNewGroupCount,
    appliedGroupRuleCount:
      base.appliedGroupRuleCount + ulResult.appliedGroupRuleCount,
    skippedUserlistEntries: [
      ...base.skippedUserlistEntries,
      ...ulResult.skipped.map((s) => ({
        kind: s.kind,
        subject: s.subject,
        ruleKind: s.ruleKind,
        reference: s.reference,
        reason: s.reason,
      })),
    ],
  };
}

/**
 * ──────────────────────────────────────────────────────────────────────
 * Install the curator's copy of a mod the user already has, beside theirs.
 *
 * Reached only when the user's copy is verifiably NOT the curator's and the
 * journal says we did not install it. The alternative to this function is a
 * collection that quietly ships the user's build of a mod, which every file
 * check then passes.
 *
 * Where the bytes come from, in order of what costs the user least:
 *
 *   1. the archive Vortex already has for THEIR mod, but only once its sha256
 *      is confirmed to be the curator's. A Nexus file id names one uploaded
 *      file forever, so this is usually the same archive — and when it is, we
 *      re-extract it locally with the curator's installer answers instead of
 *      downloading a byte-identical copy.
 *   2. the archive bundled in the `.ehcoll`, for external mods.
 *   3. a fresh Nexus download, without installing it, so we control the file
 *      name and therefore the install name.
 *
 * Returns `undefined` when none of those can produce the bytes. That is not a
 * failure to hide: the caller reports the mismatch, and the user's mod is
 * still untouched — nothing here uninstalls anything, ever.
 * ──────────────────────────────────────────────────────────────────────
 */
async function tryInstallAlongside(args: {
  ctx: DriverContext;
  installEntry: InstalledModReportEntry;
  manifestEntry: EhcollMod | undefined;
  activeProfileId: string;
  onTempArchive: (p: string) => void;
}): Promise<InstalledModReportEntry | undefined> {
  const { ctx, installEntry, manifestEntry, activeProfileId, onTempArchive } =
    args;
  if (manifestEntry === undefined) return undefined;

  const pkg = ctx.plan.manifest.package;
  const gameId = ctx.plan.manifest.game.id;

  try {
    const archivePath = await resolveCuratorArchive({
      ctx,
      installEntry,
      manifestEntry,
      onTempArchive,
    });
    if (archivePath === undefined) {
      ehLog("warn", "install.alongside.no-archive", {
        name: installEntry.name,
        compareKey: installEntry.compareKey,
        why: "the curator's bytes are not obtainable on this machine",
      });
      return undefined;
    }

    const result = await installAlongside(ctx.api, {
      gameId,
      archivePath,
      modName: installEntry.name,
      collectionName: pkg.name,
      collectionVersion: pkg.version,
      packageId: pkg.id,
      compareKey: installEntry.compareKey,
      ...replayArgs(manifestEntry, ctx.decisions.fomodReplayMode),
      ...(ctx.abortSignal !== undefined ? { signal: ctx.abortSignal } : {}),
    });
    onTempArchive(result.tempDir);

    /**
     * Ours on, theirs off — in THIS profile only. `setModEnabled` is
     * profile-scoped, so the user's other profiles keep their mod enabled
     * exactly as before. Both are still installed; only this collection's
     * profile expresses a preference between them.
     */
    enableModInProfile(ctx.api, activeProfileId, result.vortexModId);
    disableModInProfile(ctx.api, activeProfileId, installEntry.vortexModId);

    ehLog("info", "install.alongside.swapped", {
      name: installEntry.name,
      compareKey: installEntry.compareKey,
      theirModId: installEntry.vortexModId,
      ourModId: result.vortexModId,
      installName: result.installName,
      profileId: activeProfileId,
    });

    return {
      compareKey: installEntry.compareKey,
      name: result.installName,
      vortexModId: result.vortexModId,
      source: installEntry.source,
      /**
       * ─── WHOSE MOD WE SWITCHED OFF ────────────────────────────────────
       * The line above disables the user's copy in this profile, and until
       * now that pairing was recorded NOWHERE. Pass 5a2 overwrites
       * `installedMods[idx]` with this entry, so `installEntry.vortexModId`
       * — the user's mod — survived only in a log line.
       *
       * Uninstall then correctly removed OUR copy and left theirs disabled:
       * a mod that is installed, visible, and switched off in the profile
       * they play, with the receipt that could have explained it deleted at
       * the same moment.
       */
      displacedModId: installEntry.vortexModId,
      /**
       * OUR decision, not the one belonging to the mod we installed beside.
       *
       * `installEntry` describes the USER's copy, and for a mirrored mod it
       * came from the `*-already-installed` arm. Passing that through made
       * `buildReceipt` record a mod Event Horizon had just created as
       * `ownership: "adopted"` — so the next run rebuilt `ownedByUs` without
       * it, took the not-ours arm again, and called this function a second
       * time with the same deterministic install name: Vortex's
       * replace-or-variant dialog, per mod, in an unattended install. And
       * "adopted" means "MUST NOT be removed", so our own copies were
       * stranded, enabled and unremovable by the tool that made them.
       *
       * This string is the one already journalled at the call site, and it
       * does not end in `already-installed`, which is the test the receipt
       * uses.
       */
      fromDecision: "mirror-alongside",
    };
  } catch (err) {
    if (isAbort(err) || ctx.abortSignal?.aborted) {
      throw err;
    }
    // Their mod is untouched — this path never uninstalls. Report and move on.
    ehLog("error", "install.alongside.failed", {
      name: installEntry.name,
      compareKey: installEntry.compareKey,
      theirModRemoved: false,
      err,
    });
    return undefined;
  }
}

/**
 * A path to the curator's archive bytes for this mod, or `undefined`.
 *
 * The first rung is the interesting one: the user's OWN archive, accepted only
 * when its hash equals the manifest's. That is a genuine byte proof rather than
 * an assumption that a Nexus file id means what it says, and when it holds it
 * saves a download of a file already on the disk.
 */
async function resolveCuratorArchive(args: {
  ctx: DriverContext;
  installEntry: InstalledModReportEntry;
  manifestEntry: EhcollMod;
  onTempArchive: (p: string) => void;
}): Promise<string | undefined> {
  const { ctx, installEntry, manifestEntry, onTempArchive } = args;
  const gameId = ctx.plan.manifest.game.id;
  const expectedSha = manifestEntry.source.sha256;

  // 1. Their archive, if it IS the curator's file.
  const theirArchive = archivePathForMod(ctx.api, gameId, installEntry);
  if (theirArchive !== undefined && expectedSha !== undefined) {
    const identity = await checkArchiveIdentity({
      archivePath: theirArchive,
      expectedSha256: expectedSha,
      ...(ctx.abortSignal !== undefined ? { signal: ctx.abortSignal } : {}),
    });
    if (identity.kind === "matches") return theirArchive;
  }

  // 2. Bundled in the package.
  if (
    manifestEntry.source.kind === "external" &&
    manifestEntry.source.bundled === true &&
    expectedSha !== undefined
  ) {
    const extracted = await extractBundledFromEhcoll(
      ctx.ehcollZipPath,
      findBundledZipEntry(ctx, manifestEntry as ExternalEhcollMod),
      installEntry.name,
    );
    onTempArchive(extracted.tempDir);
    return extracted.extractedPath;
  }

  // 3. Download it without installing, so the file name stays ours to choose.
  if (manifestEntry.source.kind === "nexus") {
    const downloaded = await downloadNexusArchiveOnly(ctx.api, {
      gameId,
      nexusModId: manifestEntry.source.modId,
      nexusFileId: manifestEntry.source.fileId,
      fileName: manifestEntry.source.archiveName,
      ...(ctx.abortSignal !== undefined ? { signal: ctx.abortSignal } : {}),
    });
    return downloaded;
  }

  return undefined;
}
