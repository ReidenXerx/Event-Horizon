/**
 * Install wizard state machine — single source of truth for what
 * the InstallPage is showing and which async work is in flight.
 *
 * State transitions form a strict graph:
 *
 *   pick → loading → (stale-receipt) → planning → preview
 *                                                  ↓
 *                                          decisions ↔ preview
 *                                                  ↓
 *                                              confirm
 *                                                  ↓
 *                                            installing
 *                                                  ↓
 *                                                done
 *
 * Any state can transition to `pick` via "Start over" (resets) or
 * `error` via a thrown error caught by the wizard's effect runner.
 *
 * Data carried in each state is exactly what the next step needs to
 * render — we never reach into "what was the previous state's data?"
 * which keeps the reducer pure and the steps pure-presentational.
 */

import type { EnvironmentReport } from "../../../core/environment/preflight";
import type { types } from "@nexusmods/vortex-api";
import type { ReadEhcollResult } from "../../../core/manifest/readEhcoll";
import type { RuntimeFinding } from "../../../core/runtime/detectRuntimes";
import type { InstallReceipt } from "../../../types/installLedger";
import type {
  ConflictChoice,
  DriverProgress,
  InstallResult,
  OrphanChoice,
  UserConfirmedDecisions,
} from "../../../types/installDriver";
import type { FomodReplayMode } from "../../../core/installer/fomodReplayMode";
import { DEFAULT_FOMOD_REPLAY_MODE } from "../../../core/installer/fomodReplayMode";
import type { InstallPlan } from "../../../types/installPlan";
import type { FormattedError } from "../../errors";

// ===========================================================================
// State
// ===========================================================================

export type LoadingPhase =
  | "reading-package"
  | "reading-receipt"
  | "checking-game"
  | "hashing-mods"
  | "hashing-staging"
  | "scanning-downloads"
  | "resolving-plan"
  | "checking-environment";

export interface PreviewBundle {
  zipPath: string;
  ehcoll: ReadEhcollResult;
  /**
   * The receipt that came in (if any). When this is `undefined` the
   * resolver picked fresh-profile mode automatically. When set, the
   * user MAY have explicitly chosen to keep the stale receipt.
   */
  receipt: InstallReceipt | undefined;
  plan: InstallPlan;
  /**
   * Same `appData` value used to resolve receipts; carried so the
   * driver call site doesn't have to re-derive it.
   */
  appDataPath: string;
  /**
   * Set only when the 7-Zip preflight found a FATAL problem — extraction is
   * broken, so Vortex cannot unpack a single mod archive.
   *
   * Carried rather than re-checked so the gate is synchronous: the check
   * already runs during the loading pipeline, and its result used to be
   * thrown away after a notification the user could dismiss. A collection
   * whose mods are all already installed can still proceed, which is why the
   * block names the number of mods that would have to be unpacked.
   */
  extractorBlocked?: { message: string; steps: string[]; toUnpack: number };
  /**
   * Microsoft runtimes the machine is missing, or that could not be checked.
   *
   * Advisory, never blocking — unlike the extractor above, which stops every
   * unpack. A missing VC++ redistributable installs the collection perfectly
   * and then breaks xEdit, ENB and every script-extender plugin afterwards,
   * with nothing naming the cause. Carried so the preview can say it BEFORE
   * the install rather than leaving it to be discovered after.
   */
  runtimeFindings?: RuntimeFinding[];
  /**
   * The environment preflight taken while loading: game managed, launcher run,
   * DLL imports, Program Files, clean game folder. Blocked checks refuse the
   * install; the Install click re-runs them, because the machine can change
   * between the preview and the click.
   */
  environment?: EnvironmentReport;
}

/** What "fetching a link" is doing right now. */
export type LinkPhase =
  /** Reading the mod page's file list. */
  | "resolving"
  /** Event Horizon is downloading the bytes itself. */
  | "downloading"
  /** Vortex's download manager has the file; waiting for it to land. */
  | "waiting-for-vortex";

export type WizardState =
  | { kind: "pick" }
  /**
   * A pasted link is being turned into a file on disk. `nexus` goes through
   * Vortex's Nexus integration (Premium), `direct` is fetched by Event
   * Horizon itself; both end in `pickFile` with the path, so everything
   * after this state is the ordinary flow.
   */
  | {
      kind: "link-fetching";
      link: string;
      source: "nexus" | "direct";
      phase: LinkPhase;
      fileName?: string;
      received?: number;
      total?: number;
    }
  /**
   * Nexus will not hand this account a download link (no Premium, or not
   * signed in), so the file page was opened in the browser and the user
   * brings the file back by hand. The ordinary picker, with the file named.
   */
  | {
      kind: "link-manual";
      link: string;
      pageUrl: string;
      fileName: string;
      size?: number;
      version?: string;
      why: string;
    }
  | {
      kind: "loading";
      zipPath: string;
      phase: LoadingPhase;
      /** Total mods that will be hashed in the hashing-mods phase. */
      hashCount?: number;
      /** Live counter — number of archives that have completed hashing. */
      hashDone?: number;
      /** Name of the mod whose archive is being hashed right now. */
      hashCurrent?: string;
    }
  | {
      kind: "stale-receipt";
      zipPath: string;
      ehcoll: ReadEhcollResult;
      receipt: InstallReceipt;
      appDataPath: string;
    }
  | {
      kind: "preview";
      bundle: PreviewBundle;
    }
  | {
      kind: "decisions";
      bundle: PreviewBundle;
      conflictChoices: Record<string, ConflictChoice>;
      orphanChoices: Record<string, OrphanChoice>;
      /**
       * Carried here as well as on `confirm` so stepping back and forward
       * does not silently reset a choice the user made.
       */
      fomodReplayMode: FomodReplayMode;
    }
  | {
      kind: "confirm";
      bundle: PreviewBundle;
      decisions: UserConfirmedDecisions;
    }
  | {
      kind: "installing";
      bundle: PreviewBundle;
      decisions: UserConfirmedDecisions;
      progress: DriverProgress | undefined;
    }
  | {
      kind: "done";
      result: InstallResult;
      bundle: PreviewBundle;
    }
  | {
      kind: "error";
      error: FormattedError;
      previous: WizardState;
    };

export const initialWizardState: WizardState = { kind: "pick" };

// ===========================================================================
// Actions
// ===========================================================================

export type WizardAction =
  | { type: "pick-file"; zipPath: string }
  | { type: "loading-phase"; phase: LoadingPhase; hashCount?: number }
  | {
      type: "hash-progress";
      done: number;
      total: number;
      currentItem: string;
    }
  | {
      type: "needs-stale-resolution";
      zipPath: string;
      ehcoll: ReadEhcollResult;
      receipt: InstallReceipt;
      appDataPath: string;
    }
  | {
      type: "plan-ready";
      bundle: PreviewBundle;
    }
  /**
   * The extractor repair worked, so the reason the gate was closed is gone.
   *
   * `extractorBlocked` is a SNAPSHOT taken during loading. Nothing cleared it
   * and the repair never re-ran the preflight, so a successful repair left
   * the gate firing off stale evidence forever — the dialog said the
   * extractor works now, Install re-fired the same error, and repeating the
   * repair reported already-current and said the same encouraging thing
   * again. Only re-picking the file escaped it, and nothing said so.
   */
  | { type: "extractor-unblocked" }
  | {
      type: "open-decisions";
      bundle: PreviewBundle;
      conflictChoices: Record<string, ConflictChoice>;
      orphanChoices: Record<string, OrphanChoice>;
    }
  | {
      type: "set-conflict-choice";
      compareKey: string;
      choice: ConflictChoice;
    }
  | {
      type: "set-orphan-choice";
      modId: string;
      choice: OrphanChoice;
    }
  | { type: "back-to-preview" }
  | {
      type: "open-confirm";
      decisions: UserConfirmedDecisions;
    }
  | { type: "set-fomod-mode"; mode: FomodReplayMode }
  | { type: "back-from-confirm" }
  | { type: "start-install" }
  | { type: "install-progress"; progress: DriverProgress }
  | { type: "install-result"; result: InstallResult }
  | { type: "set-error"; error: FormattedError }
  | { type: "reset" }
  | { type: "link-start"; link: string; source: "nexus" | "direct" }
  | {
      type: "link-progress";
      phase: LinkPhase;
      fileName?: string;
      received?: number;
      total?: number;
    }
  | {
      type: "link-manual";
      link: string;
      pageUrl: string;
      fileName: string;
      size?: number;
      version?: string;
      why: string;
    };

// ===========================================================================
// Reducer
// ===========================================================================

export function wizardReducer(
  state: WizardState,
  action: WizardAction,
): WizardState {
  switch (action.type) {
    case "pick-file":
      return {
        kind: "loading",
        zipPath: action.zipPath,
        phase: "reading-package",
      };
    case "loading-phase": {
      if (state.kind !== "loading") return state;
      const isHashingPhase =
        action.phase === "hashing-mods" ||
    action.phase === "hashing-staging" ||
    // Scanning the download folder is hashing too, and it is the slowest of
    // the three on a first run — it reads every archive Vortex has kept.
    // Leaving it out means the counter freezes exactly where the wait is
    // longest, which reads as a hang.
    action.phase === "scanning-downloads";
      // The two hashing phases share a UI card with a live counter.
      // Reset progress on every phase transition (incl. mods → staging)
      // so the counter doesn't show stale numbers from the previous
      // phase. Non-hashing phases drop the counter entirely.
      return {
        ...state,
        phase: action.phase,
        hashCount: action.hashCount ?? (isHashingPhase ? 0 : state.hashCount),
        hashDone: isHashingPhase ? 0 : undefined,
        hashCurrent: isHashingPhase ? undefined : undefined,
      };
    }
    case "hash-progress":
      if (state.kind !== "loading") return state;
      // Don't override the current phase — the engine can be in
      // either "hashing-mods" or "hashing-staging" and both fire
      // hash-progress events.
      return {
        ...state,
        hashCount: action.total,
        hashDone: action.done,
        hashCurrent: action.currentItem,
      };
    case "needs-stale-resolution":
      return {
        kind: "stale-receipt",
        zipPath: action.zipPath,
        ehcoll: action.ehcoll,
        receipt: action.receipt,
        appDataPath: action.appDataPath,
      };
    case "extractor-unblocked": {
      // Only meaningful where a bundle exists; every other state has no gate.
      if (!("bundle" in state)) return state;
      if (state.bundle.extractorBlocked === undefined) return state;
      const { extractorBlocked: _cleared, ...rest } = state.bundle;
      return { ...state, bundle: rest } as WizardState;
    }
    case "plan-ready":
      return { kind: "preview", bundle: action.bundle };
    case "open-decisions":
      return {
        kind: "decisions",
        bundle: action.bundle,
        conflictChoices: action.conflictChoices,
        orphanChoices: action.orphanChoices,
        fomodReplayMode: DEFAULT_FOMOD_REPLAY_MODE,
      };
    case "set-conflict-choice": {
      if (state.kind !== "decisions") return state;
      return {
        ...state,
        conflictChoices: {
          ...state.conflictChoices,
          [action.compareKey]: action.choice,
        },
      };
    }
    case "set-orphan-choice": {
      if (state.kind !== "decisions") return state;
      return {
        ...state,
        orphanChoices: {
          ...state.orphanChoices,
          [action.modId]: action.choice,
        },
      };
    }
    case "set-fomod-mode": {
      if (state.kind === "decisions") {
        return { ...state, fomodReplayMode: action.mode };
      }
      if (state.kind === "confirm") {
        return {
          ...state,
          decisions: { ...state.decisions, fomodReplayMode: action.mode },
        };
      }
      return state;
    }
    case "back-to-preview": {
      if (state.kind === "decisions" || state.kind === "confirm") {
        return { kind: "preview", bundle: state.bundle };
      }
      return state;
    }
    case "open-confirm": {
      if (state.kind !== "decisions" && state.kind !== "preview") return state;
      return {
        kind: "confirm",
        bundle: state.bundle,
        decisions: action.decisions,
      };
    }
    case "back-from-confirm": {
      if (state.kind !== "confirm") return state;
      return {
        kind: "decisions",
        bundle: state.bundle,
        conflictChoices: state.decisions.conflictChoices ?? {},
        orphanChoices: state.decisions.orphanChoices ?? {},
        fomodReplayMode:
          state.decisions.fomodReplayMode ?? DEFAULT_FOMOD_REPLAY_MODE,
      };
    }
    case "start-install": {
      if (state.kind !== "confirm") return state;
      return {
        kind: "installing",
        bundle: state.bundle,
        decisions: state.decisions,
        progress: undefined,
      };
    }
    case "install-progress": {
      if (state.kind !== "installing") return state;
      return { ...state, progress: action.progress };
    }
    case "install-result": {
      if (state.kind !== "installing") return state;
      return {
        kind: "done",
        result: action.result,
        bundle: state.bundle,
      };
    }
    case "link-start":
      return { kind: "link-fetching", link: action.link, source: action.source, phase: "resolving" };
    case "link-progress": {
      if (state.kind !== "link-fetching") return state;
      return {
        ...state,
        phase: action.phase,
        ...(action.fileName !== undefined ? { fileName: action.fileName } : {}),
        ...(action.received !== undefined ? { received: action.received } : {}),
        ...(action.total !== undefined ? { total: action.total } : {}),
      };
    }
    case "link-manual":
      return {
        kind: "link-manual",
        link: action.link,
        pageUrl: action.pageUrl,
        fileName: action.fileName,
        ...(action.size !== undefined ? { size: action.size } : {}),
        ...(action.version !== undefined ? { version: action.version } : {}),
        why: action.why,
      };
    case "set-error":
      return { kind: "error", error: action.error, previous: state };
    case "reset":
      return { kind: "pick" };
    default: {
      const exhaustive: never = action;
      void exhaustive;
      return state;
    }
  }
}

// ===========================================================================
// Helpers used by the steps to derive sub-lists from a plan
// ===========================================================================

export function selectConflictResolutions(
  bundle: PreviewBundle,
): InstallPlan["modResolutions"] {
  return bundle.plan.modResolutions.filter((r) => {
    const k = r.decision.kind;
    return (
      k === "nexus-version-diverged" ||
      k === "nexus-bytes-diverged" ||
      k === "external-bytes-diverged" ||
      k === "external-prompt-user"
    );
  });
}

export function defaultConflictChoice(
  resolution: InstallPlan["modResolutions"][number],
): ConflictChoice | undefined {
  // Sensible defaults: keep existing for divergences (least
  // destructive) and "no choice yet" for prompt-user (we want them
  // to actively pick).
  switch (resolution.decision.kind) {
    case "nexus-version-diverged":
    case "nexus-bytes-diverged":
    case "external-bytes-diverged":
      return { kind: "keep-existing" };
    case "external-prompt-user":
      return undefined;
    default:
      return undefined;
  }
}

export function defaultOrphanChoice(): OrphanChoice {
  return { kind: "keep" };
}

/**
 * Resolves the user's choice for a single conflict. Returns
 * `undefined` if the user hasn't picked one yet AND the resolution
 * doesn't have a sensible default — we use this to gate the
 * "Continue" button.
 */
export function buildUserConfirmedDecisions(
  conflictChoices: Record<string, ConflictChoice>,
  orphanChoices: Record<string, OrphanChoice>,
  fomodReplayMode: FomodReplayMode = DEFAULT_FOMOD_REPLAY_MODE,
): UserConfirmedDecisions {
  return { conflictChoices, orphanChoices, fomodReplayMode };
}

/**
 * Helper that the InstallPage uses to figure out whether the
 * "Continue" button is enabled. A decision is "complete" when:
 *   - every conflict has either a stored choice or a sensible default;
 *   - every orphan has a choice (default: keep).
 */
export function canProceedFromDecisions(
  bundle: PreviewBundle,
  conflictChoices: Record<string, ConflictChoice>,
): boolean {
  for (const r of selectConflictResolutions(bundle)) {
    const supplied = conflictChoices[r.compareKey];
    if (supplied !== undefined) continue;
    const fallback = defaultConflictChoice(r);
    if (fallback === undefined) return false;
  }
  return true;
}

/**
 * How many conflicts still need an explicit choice from the user.
 *
 * The same rule `canProceedFromDecisions` applies, counted instead of
 * collapsed to a boolean. A disabled Continue button explained only by a
 * `title` tooltip is explained to nobody — browsers frequently do not render
 * tooltips on disabled elements at all, so the reason a person cannot go
 * forward was, in practice, invisible. A number they can see is the fix.
 *
 * Only blocking conflicts count. One with a safe default is already resolved
 * whether or not the user looked at it, and including those would report work
 * outstanding that nothing requires — which on a large collection is the
 * difference between "three things need you" and a list of two hundred.
 */
export function countUndecidedConflicts(
  bundle: PreviewBundle,
  conflictChoices: Record<string, ConflictChoice>,
): number {
  let n = 0;
  for (const r of selectConflictResolutions(bundle)) {
    if (conflictChoices[r.compareKey] !== undefined) continue;
    if (defaultConflictChoice(r) === undefined) n += 1;
  }
  return n;
}

/**
 * Apply defaults for any conflict the user didn't explicitly resolve.
 * Used when transitioning from `decisions` to `confirm`.
 */
export function fillDefaultConflictChoices(
  bundle: PreviewBundle,
  conflictChoices: Record<string, ConflictChoice>,
): Record<string, ConflictChoice> {
  const out: Record<string, ConflictChoice> = { ...conflictChoices };
  for (const r of selectConflictResolutions(bundle)) {
    if (out[r.compareKey] !== undefined) continue;
    const fallback = defaultConflictChoice(r);
    if (fallback !== undefined) out[r.compareKey] = fallback;
  }
  return out;
}

/**
 * Apply defaults for any orphan the user didn't explicitly resolve.
 */
export function fillDefaultOrphanChoices(
  bundle: PreviewBundle,
  orphanChoices: Record<string, OrphanChoice>,
): Record<string, OrphanChoice> {
  const out: Record<string, OrphanChoice> = { ...orphanChoices };
  for (const o of bundle.plan.orphanedMods) {
    if (out[o.existingModId] !== undefined) continue;
    out[o.existingModId] = defaultOrphanChoice();
  }
  return out;
}

/**
 * Read-only sanity assertion. The "Install" button on the confirm
 * step must run this and refuse to start if it returns false — keeps
 * the driver's preflight assertion from blowing up midway.
 */
export function planHasHardBlockers(
  api: types.IExtensionApi | undefined,
  plan: InstallPlan,
): boolean {
  void api;
  for (const r of plan.modResolutions) {
    if (
      r.decision.kind === "nexus-unreachable" ||
      r.decision.kind === "external-missing"
    ) {
      return true;
    }
  }
  return false;
}
