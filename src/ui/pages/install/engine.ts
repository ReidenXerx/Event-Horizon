/**
 * Install wizard engine — pure async helpers that mirror the
 * call sequence in `installCollectionAction.ts`, but rewritten to
 * report progress via callbacks instead of `showDialog`.
 *
 * Each helper here is a leaf — it calls into `core/` and returns a
 * value (or throws). The `InstallPage` orchestrates them by chaining
 * the helpers together and dispatching wizard reducer actions in
 * between.
 *
 * Why duplicate the call sequence rather than refactor the action?
 *   - The action's flow is dialog-coupled in subtle ways (e.g. the
 *     stale-receipt prompt loop). Pulling that out of the action
 *     means the legacy toolbar entry point breaks until the same
 *     refactor touches it.
 *   - The action stays as a known-good fallback while we exercise
 *     the new UI in E2E. Once the UI is the canonical path, the
 *     action can be deleted or trimmed to a thin shim.
 */

import { selectors, util } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";

import {
  AbortError,
  enrichModsWithArchiveHashes,
} from "../../../core/archiveHashing";
import {
  getActiveGameId,
  getActiveProfileIdFromState,
  getModsForGame,
} from "../../../core/getModsListForProfile";
import { readReceipt } from "../../../core/installLedger";
import type { AvailableDownload } from "../../../types/installPlan";
import {
  type ReadEhcollResult,
  readEhcoll,
} from "../../../core/manifest/readEhcoll";
import { enrichInstalledModsWithStagingSetHashes } from "../../../core/resolver/enrichStagingSetHashes";
import { listInstallAttempts } from "../../../core/installer/attemptRecord";
import { logInstallPlan } from "../../../core/resolver/logInstallPlan";
import { resolveInstallPlan } from "../../../core/resolver/resolveInstallPlan";
// Shared with the Vortex action pipeline in src/actions. It used to live here
// as a private helper, and the other pipeline kept passing `undefined` — see
// the module docblock for why one copy is the only fix that cannot be half
// applied.
import { scanAvailableDownloads } from "../../../core/resolver/scanAvailableDownloads";
import {
  buildUserSideState,
  pickInstallTarget,
  resumableProfileFromAttempts,
  resolveDeploymentMethod,
  resolveEnabledExtensions,
  resolveGameVersion,
  resolveProfileName,
  resolveVortexVersion,
} from "../../../core/resolver/userState";
import type { SupportedGameId } from "../../../types/ehcoll";
import type { InstallReceipt } from "../../../types/installLedger";
import type { InstallPlan } from "../../../types/installPlan";
import { getVortexUserDataPath } from "../../../core/paths";
import { ehLog } from "../../../core/logging/ehLog";
import type { RuntimeFinding } from "../../../core/runtime/detectRuntimes";

const SUPPORTED_GAME_IDS: ReadonlySet<string> = new Set<SupportedGameId>([
  "skyrimse",
  "fallout3",
  "falloutnv",
  "fallout4",
  "starfield",
]);

export interface LoadProgressEvents {
  onPhase: (phase: import("./state").LoadingPhase, hashCount?: number) => void;
  /**
   * Live "X / Y" hashing counter. Called once per mod as its archive
   * hash completes (or is skipped). Always paired with phase ===
   * "hashing-mods".
   */
  onHashProgress?: (
    done: number,
    total: number,
    currentItem: string,
  ) => void;
}

/**
 * A FATAL 7-Zip verdict, carried out of the loading pipeline so the install
 * can be refused later without re-checking. See PreviewBundle.extractorBlocked.
 */
export interface ExtractorBlocked {
  message: string;
  steps: string[];
  /** Mods that still need unpacking — zero means the block does not apply. */
  toUnpack: number;
}

export type LoadOutcome =
  | {
      kind: "stale-receipt";
      ehcoll: ReadEhcollResult;
      receipt: InstallReceipt;
      appDataPath: string;
    }
  | {
      kind: "ready";
      ehcoll: ReadEhcollResult;
      receipt: InstallReceipt | undefined;
      plan: InstallPlan;
      appDataPath: string;
      extractorBlocked?: ExtractorBlocked;
      /**
       * System runtimes the machine is missing, or that could not be checked.
       *
       * Reported, never blocking. A missing VC++ redistributable does not stop
       * a single mod installing — it stops xEdit, ENB and the script-extender
       * plugins from working afterwards, with no message naming the cause. So
       * the right moment to say it is BEFORE the install, and the right shape
       * is a warning the player can act on, not a refusal.
       */
      runtimeFindings?: RuntimeFinding[];
    };

/**
 * Run everything from "user picked a file" through to "we have a
 * plan ready for preview", emitting phase events along the way.
 *
 * Throws on any error — the caller (InstallPage) catches and routes
 * the error into the wizard's `set-error` action so the global
 * ErrorReportModal opens.
 */
export async function runLoadingPipeline(args: {
  api: types.IExtensionApi;
  zipPath: string;
  events: LoadProgressEvents;
  signal?: AbortSignal;
}): Promise<LoadOutcome> {
  const { api, zipPath, events, signal } = args;
  const checkAbort = (): void => {
    if (signal?.aborted) {
      throw new AbortError("Loading cancelled by user");
    }
  };

  // ── 1. read .ehcoll ───────────────────────────────────────────────
  checkAbort();
  events.onPhase("reading-package");
  const ehcoll = await readEhcoll(zipPath);
  const { manifest } = ehcoll;

  // ── 2. early game-id gate ────────────────────────────────────────
  checkAbort();
  events.onPhase("checking-game");
  const state = api.getState();
  const activeGameId = getActiveGameId(state);
  if (!activeGameId) {
    throw new Error(
      "No active game in Vortex. Switch to the game this collection targets, then retry.",
    );
  }
  if (!SUPPORTED_GAME_IDS.has(activeGameId)) {
    throw new Error(
      `Active game "${activeGameId}" is not supported by Event Horizon. ` +
        `Supported: ${Array.from(SUPPORTED_GAME_IDS).join(", ")}.`,
    );
  }
  if (manifest.game.id !== activeGameId) {
    throw new Error(
      `This collection is for "${manifest.game.id}" but the active game is "${activeGameId}". ` +
        `Switch to "${manifest.game.id}" in Vortex's game selector and retry.`,
    );
  }
  const activeProfileId = getActiveProfileIdFromState(state, activeGameId);
  if (!activeProfileId) {
    throw new Error(`No profile found for game "${activeGameId}".`);
  }

  // ── 2b. preflight: can VORTEX unpack archives? ───────────────────
  // Event Horizon no longer needs 7z to read the package, but Vortex needs it
  // to install every mod inside it, and on a Wine/Proton prefix that is the
  // component most likely to be broken. Discovering it forty minutes into a
  // 954-mod install reads as "this collection is broken" rather than "this
  // prefix is missing a runtime", and sends the curator chasing a package
  // that was never at fault.
  //
  // Placed after the game gate deliberately: by here the package is known to
  // be real and for the right game, so the warning is worth the interruption.
  // Warns on anything survivable; a FATAL verdict (extraction itself broken)
  // comes back here and rides along in the bundle so startInstall can refuse.
  const extractorFatal = await warnIfSevenZipBroken(api);

  // ── 3. read receipt ──────────────────────────────────────────────
  checkAbort();
  events.onPhase("reading-receipt");
  const appDataPath = getVortexUserDataPath();
  const receipt = await readReceipt(appDataPath, manifest.package.id);

  // Stale-receipt detection (mirror H2 in installCollectionAction).
  if (receipt !== undefined) {
    if (!profileExistsInState(state, receipt.vortexProfileId)) {
      return { kind: "stale-receipt", ehcoll, receipt, appDataPath };
    }
  }

  // ── 4. snapshot pipeline (hash archive bytes) ────────────────────
  checkAbort();
  /**
   * ─── THE POOL, NOT THE ACTIVE PROFILE ─────────────────────────────
   * "Do you already have this mod?" is a question about Vortex's per-game
   * mod pool. Reading it through the active profile answered "is it enabled
   * where you happen to be standing", and on a resume that profile is often
   * new or someone else's — so the candidate list was empty and everything
   * was reinstalled. See getModsForGame.
   */
  const rawMods = getModsForGame(state, activeGameId, activeProfileId);
  events.onPhase("hashing-mods", rawMods.length);
  const archiveHashed = await enrichModsWithArchiveHashes(
    state,
    activeGameId,
    rawMods,
    {
      signal,
      onProgress: (done, total, mod) => {
        events.onHashProgress?.(done, total, mod.name);
      },
    },
  );

  // ── 4b. staging-set-hash enrichment ──────────────────────────────
  // Cheap no-op when the manifest has no archive-less external mods.
  // For mods Vortex didn't retain the archive of (manual installs,
  // sideloads, archives the user purged), this is the only identity
  // oracle the resolver can match on.
  checkAbort();
  events.onPhase("hashing-staging");
  const installedMods = await enrichInstalledModsWithStagingSetHashes(
    state,
    activeGameId,
    manifest,
    archiveHashed,
    {
      signal,
      onProgress: (done, total, mod) => {
        events.onHashProgress?.(done, total, mod.name);
      },
    },
  );

  // ── 4c. what is already in the download folder ───────────────────
  checkAbort();
  events.onPhase("scanning-downloads");
  const availableDownloads = await scanAvailableDownloads({
    api,
    gameId: activeGameId,
    appDataPath,
    ...(signal !== undefined ? { signal } : {}),
    onProgress: (done, total, name) => {
      events.onHashProgress?.(done, total, name);
    },
  });

  // ── 5. resolve plan ──────────────────────────────────────────────
  checkAbort();
  events.onPhase("resolving-plan");
  const activeProfileName =
    resolveProfileName(state, activeProfileId) ?? activeProfileId;

  const userState = buildUserSideState({
    gameId: activeGameId,
    gameVersion: resolveGameVersion(state, activeGameId),
    vortexVersion: resolveVortexVersion(state),
    deploymentMethod: resolveDeploymentMethod(state, activeGameId),
    enabledExtensions: resolveEnabledExtensions(state),
    activeProfileId,
    activeProfileName,
    installedMods,
    receipt,
    availableDownloads,
    externalDependencyState: undefined,
  });

  const installTarget = pickInstallTarget(
    manifest,
    receipt,
    activeProfileId,
    activeProfileName,
    // Continue the profile an interrupted attempt was filling, rather than
    // forking a new one on every restart.
    resumableProfileFromAttempts(
      state,
      activeGameId,
      manifest.package.id,
      manifest.package.version,
      await listInstallAttempts(appDataPath),
    ),
  );

  const plan = resolveInstallPlan(manifest, userState, installTarget);
  logInstallPlan(plan, userState, "wizard-preview");

  const runtimeFindings = await checkSystemRuntimes();

  return {
    kind: "ready",
    ehcoll,
    receipt,
    plan,
    appDataPath,
    ...(runtimeFindings.length > 0 ? { runtimeFindings } : {}),
    ...(extractorFatal !== undefined
      ? {
          extractorBlocked: {
            ...extractorFatal,
            // Mods already installed do not need unpacking, so a collection
            // that is entirely already-installed is still legitimately
            // installable with a dead extractor. Name the real number.
            toUnpack: plan.modResolutions.filter(
              (r) => !r.decision.kind.endsWith("already-installed"),
            ).length,
          },
        }
      : {}),
  };
}

/**
 * Ask the machine which Microsoft runtimes it has.
 *
 * Never throws and never blocks: this is advisory, and a preflight that can
 * fail an install over its own inability to read a registry key would be
 * worse than not having it. A probe that cannot answer produces `unknown`
 * findings, which the report keeps separate from "missing".
 */
async function checkSystemRuntimes(): Promise<RuntimeFinding[]> {
  try {
    const [{ detectRuntimes }, { readRegistryValue, fileExists }] =
      await Promise.all([
        import("../../../core/runtime/detectRuntimes"),
        import("../../../core/runtime/nodePrereqDeps"),
      ]);
    const findings = await detectRuntimes({
      readRegistryValue,
      fileExists,
      systemDir: `${process.env.SystemRoot ?? "C:\\Windows"}\\System32`,
    });
    ehLog("info", "preflight.runtimes", {
      findings: findings.map((f) => `${f.id}=${f.status}`),
    });
    return findings;
  } catch (err) {
    ehLog("warn", "preflight.runtimes.failed", { err });
    return [];
  }
}

/**
 * Re-resolve a plan after the user explicitly accepted a stale
 * receipt. We rebuild the `userState` and `installTarget` exactly
 * like `runLoadingPipeline`, but skip the stale-receipt detection
 * branch and use whatever the user told us to use.
 */
export async function runLoadingPipelineWithReceipt(args: {
  api: types.IExtensionApi;
  zipPath: string;
  ehcoll: ReadEhcollResult;
  receipt: InstallReceipt | undefined;
  appDataPath: string;
  events: LoadProgressEvents;
  signal?: AbortSignal;
}): Promise<{
  ehcoll: ReadEhcollResult;
  receipt: InstallReceipt | undefined;
  plan: InstallPlan;
  appDataPath: string;
  extractorBlocked?: ExtractorBlocked;
  /** Same advisory findings as the first pass — see PreviewBundle. */
  runtimeFindings?: RuntimeFinding[];
}> {
  const { api, ehcoll, receipt, appDataPath, events, signal } = args;
  const { manifest } = ehcoll;
  // Re-checked here rather than carried from the first pass: this is the
  // stale-receipt re-run, and skipping it would leave one route into the
  // confirm step with no extractor verdict at all — an ungated back door.
  const extractorFatal = await warnIfSevenZipBroken(api);
  const checkAbort = (): void => {
    if (signal?.aborted) {
      throw new AbortError("Loading cancelled by user");
    }
  };

  checkAbort();
  events.onPhase("checking-game");
  const state = api.getState();
  const activeGameId = getActiveGameId(state);
  if (!activeGameId || manifest.game.id !== activeGameId) {
    throw new Error(
      `Active game must be "${manifest.game.id}" but is "${activeGameId}".`,
    );
  }
  const activeProfileId = getActiveProfileIdFromState(state, activeGameId);
  if (!activeProfileId) {
    throw new Error(`No profile found for game "${activeGameId}".`);
  }

  checkAbort();
  /**
   * ─── THE POOL, NOT THE ACTIVE PROFILE ─────────────────────────────
   * "Do you already have this mod?" is a question about Vortex's per-game
   * mod pool. Reading it through the active profile answered "is it enabled
   * where you happen to be standing", and on a resume that profile is often
   * new or someone else's — so the candidate list was empty and everything
   * was reinstalled. See getModsForGame.
   */
  const rawMods = getModsForGame(state, activeGameId, activeProfileId);
  events.onPhase("hashing-mods", rawMods.length);
  const archiveHashed = await enrichModsWithArchiveHashes(
    state,
    activeGameId,
    rawMods,
    {
      signal,
      onProgress: (done, total, mod) => {
        events.onHashProgress?.(done, total, mod.name);
      },
    },
  );

  checkAbort();
  events.onPhase("hashing-staging");
  const installedMods = await enrichInstalledModsWithStagingSetHashes(
    state,
    activeGameId,
    manifest,
    archiveHashed,
    {
      signal,
      onProgress: (done, total, mod) => {
        events.onHashProgress?.(done, total, mod.name);
      },
    },
  );

  // Same scan as the first-run path. Both pipelines need it: this one is the
  // RESUME after a kept stale receipt, which is exactly the case where the
  // download folder is most likely to already hold what we are about to ask
  // Nexus for.
  checkAbort();
  events.onPhase("scanning-downloads");
  const availableDownloads = await scanAvailableDownloads({
    api,
    gameId: activeGameId,
    appDataPath,
    ...(signal !== undefined ? { signal } : {}),
    onProgress: (done, total, name) => {
      events.onHashProgress?.(done, total, name);
    },
  });

  checkAbort();
  events.onPhase("resolving-plan");
  const activeProfileName =
    resolveProfileName(state, activeProfileId) ?? activeProfileId;

  const userState = buildUserSideState({
    gameId: activeGameId,
    gameVersion: resolveGameVersion(state, activeGameId),
    vortexVersion: resolveVortexVersion(state),
    deploymentMethod: resolveDeploymentMethod(state, activeGameId),
    enabledExtensions: resolveEnabledExtensions(state),
    activeProfileId,
    activeProfileName,
    installedMods,
    receipt,
    availableDownloads,
    externalDependencyState: undefined,
  });

  const installTarget = pickInstallTarget(
    manifest,
    receipt,
    activeProfileId,
    activeProfileName,
    // Continue the profile an interrupted attempt was filling, rather than
    // forking a new one on every restart.
    resumableProfileFromAttempts(
      state,
      activeGameId,
      manifest.package.id,
      manifest.package.version,
      await listInstallAttempts(appDataPath),
    ),
  );

  const plan = resolveInstallPlan(manifest, userState, installTarget);
  logInstallPlan(plan, userState, "wizard-stale-receipt-rerun");

  // Re-checked, not carried: this is the stale-receipt re-run and it is a
  // separate route into the confirm step. Skipping it would leave one path
  // with no runtime verdict at all — the same ungated back door the extractor
  // check above exists to close.
  const runtimeFindings = await checkSystemRuntimes();

  return {
    ehcoll,
    receipt,
    plan,
    appDataPath,
    ...(runtimeFindings.length > 0 ? { runtimeFindings } : {}),
    ...(extractorFatal !== undefined
      ? {
          extractorBlocked: {
            ...extractorFatal,
            toUnpack: plan.modResolutions.filter(
              (r) => !r.decision.kind.endsWith("already-installed"),
            ).length,
          },
        }
      : {}),
  };
}

/**
 * Tell the user if Vortex's own extractor is broken, then carry on.
 *
 * Every failure here is swallowed on purpose. This runs before an install and
 * is not a gate: a preflight that throws would turn "your prefix is missing a
 * runtime" — a warning the user can act on later — into a hard stop with no
 * way past it. The install can still legitimately succeed for a collection
 * whose mods are all already downloaded.
 */
export async function warnIfSevenZipBroken(
  api: types.IExtensionApi,
): Promise<{ message: string; steps: string[] } | undefined> {
  try {
    const { checkSevenZipHealth, describeSevenZipHealth, looksLikeWine } =
      await import("../../../core/installer/checkSevenZipHealth");
    const health = await checkSevenZipHealth();
    const advice = describeSevenZipHealth(health);
    if (advice === undefined) return undefined;

    // Logged as well as shown: the tester's log is what we get to read when a
    // remote install goes wrong, and a notification the user dismissed leaves
    // no trace at all.
    const { ehLog } = await import("../../../core/logging/ehLog");
    ehLog("warn", "sevenzip.preflight", {
      kind: health.kind,
      why: health.kind === "ok" ? undefined : health.why,
      wine: looksLikeWine(),
    });

    api.sendNotification?.({
      id: "eh-sevenzip-health",
      type: health.kind === "indeterminate" ? "info" : "warning",
      title: "Vortex's archive extractor",
      message: advice.message,
      actions: [
        {
          title: "What to do",
          action: () => {
            api.showDialog?.(
              "info",
              "Vortex cannot unpack mod archives",
              {
                text: [advice.message, "", ...advice.steps].join("\n"),
              },
              [{ label: "Close" }],
            );
          },
        },
      ],
    });
    // Only a FATAL verdict is returned, and only that one blocks. A broken
    // `list` with working extraction is survivable — every listing path here
    // is native-first — and blocking on it would stop users who can install
    // perfectly well.
    return health.kind === "broken" && health.fatal
      ? { message: advice.message, steps: advice.steps }
      : undefined;
  } catch {
    // A preflight that fails must not become the failure.
    return undefined;
  }
}

function profileExistsInState(state: unknown, profileId: string): boolean {
  const profiles = (state as {
    persistent?: { profiles?: Record<string, unknown> };
  }).persistent?.profiles;
  if (!profiles) return false;
  return Object.prototype.hasOwnProperty.call(profiles, profileId);
}
