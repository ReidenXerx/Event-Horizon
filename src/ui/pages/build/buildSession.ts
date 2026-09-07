/**
 * BuildSession — per-draft state machine for the curator build flow.
 *
 * Vortex's main pages mount/unmount whenever the user clicks between
 * sidebar tabs. Holding the in-flight `loadBuildContext` /
 * `runBuildPipeline` promises and their AbortControllers in React
 * component state means a tab switch silently aborts and restarts the
 * pipeline — the bug we hit in 0.0.1. Hoisting them to module-level
 * objects keeps the work alive in the background and lets the UI
 * just subscribe to the current snapshot whenever it (re)mounts.
 *
 * Track 1 (parallel drafts): a curator can have many drafts in flight
 * — one for each collection they're working on. Each draft owns its
 * own `BuildSession` instance, keyed by `draftId` (UUIDv4). Sessions
 * live in {@link BuildSessionRegistry} (see `buildSessionRegistry.ts`)
 * which also owns the global build queue: only one session can be
 * actively *building* at any time; the rest park in `queued` until
 * the slot frees.
 *
 * The session is intentionally NOT in Redux:
 *   • the payload (mods, hashes, draft) is large and ephemeral;
 *     we don't want it serialised into the app-wide store;
 *   • Vortex's reducers run synchronously on the main thread and
 *     this state ticks every ~50ms during hashing — easy way to
 *     starve the rest of the app;
 *   • only one component (BuildPage) ever cares about it. A custom
 *     pub/sub keeps the contract explicit and the dependencies small.
 *
 * Lifecycle (per session):
 *   idle ──begin──► loading ──hashed──► form ──build──► queued / building
 *                                              ──ok────────►── done
 *      ▲                │                  │                │
 *      └──reset/cancel──┴───errors─────────┴────────────────┘
 *
 * `queued` collapses to `building` automatically when the registry's
 * global build slot frees up. Users see "Waiting for current build to
 * finish" with a cancel button that bails out cleanly without
 * disturbing whoever holds the slot.
 *
 * Cancellation:
 *   • cancelLoading() and cancelBuilding() both flip the same
 *     AbortController owned by the session. The engine's AbortError
 *     is caught here and lowered into the appropriate "previous"
 *     state (loading → idle, building → form).
 *   • cancelQueued() asks the registry to drop us from the queue
 *     and rewinds to form.
 *
 * Error reporting:
 *   • On failure, state becomes { kind: "error", error, errorId }.
 *     `errorId` is a fresh per-failure number so the React layer
 *     can de-duplicate "I already opened the modal for this exact
 *     failure" without leaking the raw error around.
 *
 * Drafts:
 *   • Each session is bound to a single `draftId` for its lifetime.
 *     `loadDraft`, `saveDraft`, and `deleteDraft` are all keyed on
 *     that id so two sessions never clobber each other's autosave.
 *   • Draft restore happens once inside `begin`, after the heavy
 *     hashing pass. It's part of the session (not the React tree)
 *     so the form lights up with the restored values even if the
 *     user is on another tab when loading finishes.
 *   • Draft DELETE happens on transition to `done` — the build
 *     succeeded so the in-flight form is no longer interesting.
 *   • Draft AUTOSAVE stays in the React component (it only matters
 *     while the user is typing, which means they're on the page).
 *
 * Vortex restart behaviour:
 *   • Sessions live only for the JS heap's lifetime — any in-flight
 *     build dies on a Vortex restart. That's fine: the on-disk
 *     draft (`core/draftStorage`) covers cold restarts via the
 *     dashboard repopulating the registry on next open.
 */

import type { types } from "@nexusmods/vortex-api";

import { AbortError } from "../../../core/archiveHashing";
import { getVortexUserDataPath } from "../../../core/paths";
import {
  applyRecovery,
  findRecoverableMods,
  recoverMissingArchives,
} from "../../../core/archiveRecovery";
import {
  loadArchiveHashCache,
  rememberArchiveHash,
  saveArchiveHashCache,
} from "../../../core/archiveHashCache";
import { shipsAsExternal } from "../../../core/manifest/shipsAsExternal";
import { isNexusMod } from "./engine";
import { describeMissingArchives, isMissingArchiveWarning } from "./engine";
import {
  checkNexusAvailability,
  summarizeAvailability,
  type AvailabilityEntry,
  type AvailabilityFinding,
  type AvailabilitySummary,
} from "../../../core/build/nexusAvailability";
import {
  deleteDraft,
  getAppDataPath,
  loadDraft,
} from "../../../core/draftStorage";
import type { ExternalModConfigEntry } from "../../../core/manifest/collectionConfig";
import type { VerificationLevel } from "../../../types/ehcoll";
import { ehLog } from "../../../core/logging/ehLog";
import {
  loadBuildContext,
  BuildRefusedError,
  runBuildPipeline,
  type BuildContext,
  type BuildPipelineResult,
  type BuildProgress,
  type CuratorInput,
} from "./engine";
import { nexusCompareKey } from "../../../core/identity/compareKey";
import { isNexusSourced } from "../../../core/identity/nexusSourced";

// ───────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────

/**
 * Persisted shape of an in-flight build form. Lives on disk via
 * `core/draftStorage`; restored on transition into `form`.
 *
 * Deliberately a flat snapshot of the user-editable fields — NEVER
 * the whole BuildContext (mods, configPath, hashes, …). That data is
 * freshly re-derived from Vortex state on every session anyway, and
 * bundling hashes into the draft would let it go stale against an
 * evolving profile and silently restore wrong archive refs.
 *
 * Identity (Track 1 — parallel drafts):
 *  - Each draft has its own {@link draftId} (UUIDv4) so the curator
 *    can have many in-flight builds simultaneously without them
 *    clobbering each other on disk.
 *  - {@link gameId} pins the draft to a game — switching games in
 *    Vortex doesn't reuse a draft from a different game's profile;
 *    the dashboard surfaces drafts for the currently active game first.
 *  - {@link linkedSlug} / {@link linkedPackageId} are populated when
 *    the curator opens "Update" from an already-published collection.
 *    Otherwise undefined (a fresh draft / duplicate).
 */
export interface BuildDraftPayload {
  /**
   * Unique identifier for this draft. Stable across saves; never
   * reused. Generated when the user creates a new draft (or via
   * duplicate-as-fresh on the dashboard).
   *
   * Optional in the type so loaders can tolerate legacy gameId-keyed
   * drafts during migration; `loadDraft` always emits a `draftId`
   * (back-filling on the fly when needed) so consumers don't have to.
   */
  draftId?: string;
  /**
   * Game this draft is for. Pinned at creation so a draft started
   * for Skyrim doesn't suddenly "load mods from Fallout" when the
   * curator switches games in Vortex.
   *
   * Optional for legacy drafts; back-filled from the on-disk file
   * key during migration.
   */
  gameId?: string;
  /**
   * Curator-facing label shown in the dashboard ("My big mage build",
   * "Survival 1.4 candidate"). Falls back to `curator.name` when the
   * curator hasn't bothered with a separate dashboard label yet.
   */
  title?: string;
  /**
   * Slug of the published collection this draft updates, when the
   * curator opened it via "Update" on the dashboard. Used to:
   *  - resolve a stable {@link linkedPackageId},
   *  - show "Editing v1.2.0 → ..." in the dashboard,
   *  - feed the existing `collectionConfig` lookup so the build reuses
   *    the same packageId on success (preserving release lineage).
   */
  linkedSlug?: string;
  /**
   * UUIDv4 of the published collection this draft updates. Read from
   * the per-collection config file at link time so a rename of the
   * source collection doesn't unlink it — slug can drift, packageId
   * is stable.
   */
  linkedPackageId?: string;
  curator: CuratorInput;
  overrides: Record<string, ExternalModConfigEntry>;
  readme: string;
  changelog: string;
  /**
   * Optional — older drafts (pre-Tier-1) won't have it. Loaders
   * back-fill `"fast"` to keep restored sessions consistent with
   * the new default.
   */
  verificationLevel?: VerificationLevel;
  reverifyEverything?: boolean;
}

export interface BuildErrorRecord {
  /** Unique id per failure — enables "already reported?" dedup in the UI. */
  errorId: number;
  error: unknown;
  /** Human-readable hint about which phase blew up. */
  phase: "load" | "build";
}

import type { PostProcessingCandidate } from "../../../core/manifest/runSelfChecks";

export type BuildSessionState =
  | {
      /**
       * No work in flight, no completed build to show. The page
       * lands here on first ever open and after the user clicks
       * "Build another" / "Done" → home.
       */
      kind: "idle";
    }
  | {
      kind: "loading";
      phase?: BuildProgress;
    }
  | {
      kind: "form";
      ctx: BuildContext;
      curator: CuratorInput;
      overrides: Record<string, ExternalModConfigEntry>;
      readme: string;
      changelog: string;
      verificationLevel: VerificationLevel;
      reverifyEverything: boolean;
      validationError?: string;
      /** A re-read of the machine is in flight. */
      refreshing?: boolean;
      /** ISO time of the last successful re-read, so the form can say so. */
      refreshedAt?: string;
      /**
       * ISO timestamp of the autosaved draft we restored from.
       * `undefined` after the user dismisses the banner or chooses
       * "Discard draft". Autosave keeps running independently.
       */
      restoredAt?: string;
      /**
       * Progress of a Nexus availability sweep, while one is running.
       *
       * Kept on the form rather than as its own state kind: the sweep is
       * read-only, changes nothing the curator has typed, and taking over the
       * screen for it would stop them working on the collection for the eight
       * hundred lookups it takes.
       */
      availabilityProgress?: { done: number; total: number };
      /** Result of the last sweep, if one has been run this session. */
      availability?: {
        summary: AvailabilitySummary;
        findings: readonly AvailabilityFinding[];
        checkedAt: string;
      };
    }
  | {
      /**
       * Build was requested but the registry's global build slot is
       * occupied by another draft. We park here, the registry
       * promotes us to `building` automatically when the slot
       * frees up. Until then the user can cancel cleanly without
       * touching whoever's currently holding the slot.
       */
      kind: "queued";
      ctx: BuildContext;
      curator: CuratorInput;
      overrides: Record<string, ExternalModConfigEntry>;
      readme: string;
      changelog: string;
      verificationLevel: VerificationLevel;
      reverifyEverything: boolean;
      /**
       * 1-based queue position at the moment we entered the state.
       * Updated by the registry whenever someone ahead of us
       * finishes / drops out. Purely informational.
       */
      queuePosition: number;
    }
  | {
      /**
       * Re-downloading source archives Vortex lost, so their hash can be
       * computed. Distinct from `building` because nothing is being packaged
       * and the form is coming straight back afterwards — the curator is
       * repairing an input, not producing an output.
       */
      kind: "recovering";
      form: Extract<BuildSessionState, { kind: "form" }>;
      done: number;
      total: number;
      currentMod?: string;
      /** Populated as it goes, so a cancel still shows what was achieved. */
      recovered: number;
      failed: number;
    }
  | {
      kind: "building";
      ctx: BuildContext;
      curator: CuratorInput;
      progress: BuildProgress;
    }
  | {
      /**
       * Packing is held, waiting on the curator.
       *
       * The question about diverged files used to be asked on the Done card,
       * after the package was sealed — so every answer applied to the NEXT
       * build. Asked here, the answers land in the package being built.
       *
       * A real state rather than a modal for the same reason every other
       * phase is one: Vortex unmounts a page on a tab switch, and a promise
       * parked in component state dies with it. The build is still running,
       * awaiting a resolver held on the session.
       */
      kind: "awaiting-decisions";
      ctx: BuildContext;
      curator: CuratorInput;
      candidates: PostProcessingCandidate[];
      /** What the build was doing when it stopped, for the header. */
      progress: BuildProgress;
    }
  | {
      kind: "done";
      result: BuildPipelineResult;
      ctx: BuildContext;
      curator: CuratorInput;
      /**
       * When the build finished, so the dashboard can offer it back.
       *
       * A finished session used to be unreachable: it stays in the registry
       * with its result intact, and the dashboard skipped it deliberately
       * (synthesising a draft card for one produced a phantom "Untitled
       * draft"). The consequence was that leaving the done screen threw away
       * minutes of hashing with no way back short of building again.
       */
      builtAt: number;
    }
  | {
      kind: "error";
      record: BuildErrorRecord;
      /**
       * Best-effort form snapshot from before the failure. Lets the
       * UI offer "Retry" without forcing the user to retype.
       */
      formSnapshot?: Extract<BuildSessionState, { kind: "form" }>;
    };

export type BuildSessionListener = (state: BuildSessionState) => void;

export interface BuildAttemptInput {
  /**
   * Snapshot of the form state at click time. Hoisted into the
   * session so a remount mid-build doesn't lose it.
   */
  ctx: BuildContext;
  curator: CuratorInput;
  overrides: Record<string, ExternalModConfigEntry>;
  readme: string;
  changelog: string;
  /**
   * Curator's chosen integrity verification depth. Defaults to
   * `"fast"` if omitted (form persistence layer migrates older
   * drafts to fast on load).
   */
  verificationLevel?: VerificationLevel;
  /** Force a full re-read, ignoring cached file hashes. */
  reverifyEverything?: boolean;
}

// ───────────────────────────────────────────────────────────────────────
// Implementation
// ───────────────────────────────────────────────────────────────────────

/**
 * Internal contract the registry implements. Hoisted to a type alias
 * so {@link BuildSession} can hold a reference without a circular
 * import on the registry module. The registry sets this back-pointer
 * on construction; tests can pass a stub.
 */
export interface BuildSessionRegistryHooks {
  /**
   * Ask the registry to schedule a build for this session.
   *  - Returns 0 if the build started immediately (caller should
   *    transition to `building`).
   *  - Returns 1+ if the build is queued at that 1-based position
   *    (caller should transition to `queued`). The registry will
   *    invoke `onSlotAcquired` when it's our turn.
   */
  enqueueBuild(
    session: BuildSession,
    onSlotAcquired: () => void,
  ): number;
  /**
   * Tell the registry our current build is finished (success, error,
   * or cancellation) so it can pick the next queued session.
   */
  releaseBuild(session: BuildSession): void;
  /**
   * Drop us from the queue (we cancelled before the slot opened).
   * No-op if we've already been promoted out of the queue.
   */
  cancelQueued(session: BuildSession): void;
  /**
   * Notify the registry our state has changed so it can re-emit to
   * dashboard subscribers. Per-session listeners are dispatched by
   * `BuildSession` itself; this is for the registry-level "any
   * session changed" stream.
   */
  notifyStateChanged(session: BuildSession): void;
}

class BuildSession {
  /**
   * Stable on-disk identity for this draft. Survives Vortex restarts
   * via `core/draftStorage`; survives sidebar tab switches via the
   * registry. Never reused across drafts.
   */
  readonly draftId: string;
  /**
   * Vortex game this draft is pinned to. Set at session creation
   * (typically the active game when "New draft" was clicked) and
   * never changes. The dashboard uses this to gate "open" — drafts
   * for non-active games show as read-only with a "Switch to <X>"
   * affordance instead of entering the wizard.
   */
  readonly gameId: string;

  private readonly hooks: BuildSessionRegistryHooks;

  private state: BuildSessionState = { kind: "idle" };
  private readonly listeners = new Set<BuildSessionListener>();
  /** Active AbortController for whichever async pass is in flight. */
  private controller: AbortController | undefined;
  /** Monotonic counter so each error gets a fresh `errorId`. */
  private errorSeq = 0;
  /**
   * Snapshot of the form at build-request time. Held across the
   * `queued` → `building` transition so the registry can promote us
   * without us having to re-snapshot. Cleared in setState() when we
   * leave the queued+building region.
   */
  private pendingBuildInput: BuildAttemptInput | undefined;

  constructor(args: {
    draftId: string;
    gameId: string;
    hooks: BuildSessionRegistryHooks;
  }) {
    this.draftId = args.draftId;
    this.gameId = args.gameId;
    this.hooks = args.hooks;
  }

  getState(): BuildSessionState {
    return this.state;
  }

  /**
   * Subscribe to state changes. Returns the unsubscribe function so
   * React effects can clean up trivially:
   *
   *   useEffect(() => session.subscribe(setLocal), [session]);
   */
  subscribe(listener: BuildSessionListener): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  // ── Form mutations (called by the React layer while on the page) ─

  /**
   * Patch the current form state. Cheap: no AbortController flip,
   * no async work. Used by every keystroke / checkbox / textarea in
   * BuildPage so the session always reflects what the user sees.
   */
  patchForm(
    next: Partial<Extract<BuildSessionState, { kind: "form" }>>,
  ): void {
    if (this.state.kind !== "form") return;
    this.setState({
      ...this.state,
      ...next,
      // any user change clears any stale validation error
      validationError: undefined,
    });
  }

  dismissDraftBanner(): void {
    if (this.state.kind !== "form") return;
    if (this.state.restoredAt === undefined) return;
    this.setState({ ...this.state, restoredAt: undefined });
  }

  /**
   * Drop any restored values, wipe the on-disk draft for THIS
   * draftId, and reset the form to the values derived from the
   * active collection config (everything still loaded in `ctx`).
   *
   * Note: only this draft's file is deleted — other parallel drafts
   * are untouched. This is the load-bearing reason `BuildSession`
   * holds `draftId` rather than re-deriving it from `ctx.gameId`.
   */
  async discardDraft(): Promise<void> {
    if (this.state.kind !== "form") return;
    const { ctx } = this.state;
    void deleteDraft(getAppDataPath(), "build", this.draftId);
    this.setState({
      kind: "form",
      ctx,
      curator: {
        name: ctx.defaultName,
        version: ctx.defaultVersion,
        author: ctx.defaultAuthor,
        description: "",
        gameVersion: ctx.gameVersion === "unknown" ? "" : ctx.gameVersion,
        gameVersionPolicy: "exact",
      },
      overrides: { ...ctx.collectionConfig.externalMods },
      readme: ctx.collectionConfig.readme ?? "",
      changelog: ctx.collectionConfig.changelog ?? "",
      verificationLevel: "thorough",
      reverifyEverything: false,
      restoredAt: undefined,
    });
  }

  /**
   * Surface a synchronous validation error in the form. UI uses this
   * when the user clicks Build but the curator input is invalid.
   */
  setValidationError(message: string): void {
    if (this.state.kind !== "form") return;
    this.setState({ ...this.state, validationError: message });
  }

  // ── Phase transitions (called by user actions) ───────────────────

  /**
   * idle/error → loading. Kicks off `loadBuildContext`, restores any
   * autosaved draft once it returns, and parks in `form` state ready
   * for editing.
   *
   * Safe to call repeatedly: a second call while already loading is
   * a no-op (we don't restart the pipeline). Callers should disable
   * their "Begin" button while not in idle/error.
   */
/**
   * Re-read the machine, keeping everything the curator has typed.
   *
   * The form is a SNAPSHOT taken when it opened, and acting on what it says
   * usually means leaving it: the form reports a missing prerequisite, the
   * curator goes to Vortex and installs it, comes back — and is looking at
   * the scan from before they fixed it. There was no way to re-run it short of
   * discarding the draft, which throws away the typing too.
   *
   * `ctx` is everything read from disk and Vortex; `curator`, `overrides`,
   * `readme`, `changelog` and the verification settings are what the human
   * entered. Only the first is replaced. `overrides` deliberately keeps the
   * in-memory value rather than re-reading the config, because a decision made
   * on this form and not yet persisted must survive a refresh — losing it
   * would make the button feel like it undid their work.
   */
  refreshContext(api: types.IExtensionApi): void {
    if (this.state.kind !== "form") return;
    const form = this.state;
    if (form.refreshing === true) return;

    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.setState({ ...form, refreshing: true });

    void (async (): Promise<void> => {
      const startedAt = Date.now();
      try {
        // The FULL pass, deliberately: identical to opening the form.
        //
        // Carrying the previous hashes over was built and then rejected. The
        // archive fingerprint cache (path|size|mtime) already skips reading an
        // archive that has not changed, so the honest cost of a re-read is one
        // stat per mod plus whatever genuinely moved. What reuse would ALSO
        // skip is noticing that an archive was REPLACED — and re-downloading
        // archives is a normal thing to do between opening this form and
        // pressing Refresh, which is exactly when a carried-over hash would be
        // wrong. A refresh that can return a stale identity is not a refresh.
        const ctx = await loadBuildContext(api, { signal: controller.signal });
        if (this.controller !== controller) return;
        this.controller = undefined;
        ehLog("info", "build.form-refreshed", {
          ms: Date.now() - startedAt,
          mods: ctx.mods.length,
          externalDependencies: ctx.detectedDependencies.length,
          warnings: ctx.scopeWarnings.length,
        });
        // Read the CURRENT state, not the captured `form`: the curator may
        // have kept typing while this ran, and reinstating a snapshot from
        // before their keystrokes is a worse bug than a stale scan.
        const now = this.state;
        if (now.kind !== "form") return;
        this.setState({ ...now, ctx, refreshing: false, refreshedAt: new Date().toISOString() });
      } catch (err) {
        if (this.controller !== controller) return;
        this.controller = undefined;
        if (isAbortError(err)) {
          const now = this.state;
          if (now.kind === "form") this.setState({ ...now, refreshing: false });
          return;
        }
        ehLog("warn", "build.form-refresh-failed", { err: String(err) });
        const now = this.state;
        if (now.kind !== "form") return;
        // Keep the old ctx. A failed re-read is a stale form, which is what
        // they already had; blanking it would be strictly worse.
        this.setState({
          ...now,
          refreshing: false,
          validationError:
            `Could not re-read your mods: ` +
            `${err instanceof Error ? err.message : String(err)}. The form still ` +
            `shows the previous scan.`,
        });
      }
    })();
  }

  begin(api: types.IExtensionApi): void {
    if (this.state.kind !== "idle" && this.state.kind !== "error") return;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.setState({ kind: "loading" });

    void (async (): Promise<void> => {
      try {
        const ctx = await loadBuildContext(api, {
          signal: controller.signal,
          onProgress: (progress) => {
            // Drop late progress events from a controller that's
            // already been replaced (e.g. user cancelled and clicked
            // Begin again before the previous run ack'd the abort).
            if (this.controller !== controller) return;
            if (this.state.kind !== "loading") return;
            this.setState({ kind: "loading", phase: progress });
          },
        });
        if (this.controller !== controller) return;

        // Defaults derived from the freshly-read Vortex state +
        // per-collection config on disk. These are the "blank slate"
        // values the curator would see on first open.
        const baseForm: Extract<BuildSessionState, { kind: "form" }> = {
          kind: "form",
          ctx,
          curator: {
            name: ctx.defaultName,
            version: ctx.defaultVersion,
            author: ctx.defaultAuthor,
            description: "",
            gameVersion: ctx.gameVersion === "unknown" ? "" : ctx.gameVersion,
            gameVersionPolicy: "exact",
          },
          overrides: { ...ctx.collectionConfig.externalMods },
          readme: ctx.collectionConfig.readme ?? "",
          changelog: ctx.collectionConfig.changelog ?? "",
          verificationLevel: "thorough",
      reverifyEverything: false,
        };

        let envelope: Awaited<
          ReturnType<typeof loadDraft<BuildDraftPayload>>
        > = undefined;
        try {
          envelope = await loadDraft<BuildDraftPayload>(
            getAppDataPath(),
            "build",
            this.draftId,
          );
        } catch {
          /* swallow — best-effort restore */
        }
        if (this.controller !== controller) return;

        if (envelope !== undefined) {
          this.setState({
            ...baseForm,
            curator: {
              ...baseForm.curator,
              ...envelope.payload.curator,
              // A draft seeded by "Update from published" has no game version
              // in it — the dashboard cannot detect one. Letting its empty
              // string win would throw away what we just detected and ship a
              // requirement of "".
              gameVersion:
                (envelope.payload.curator?.gameVersion ?? "").length > 0
                  ? envelope.payload.curator.gameVersion
                  : baseForm.curator.gameVersion,
            },
            overrides: {
              ...baseForm.overrides,
              ...envelope.payload.overrides,
            },
            readme: envelope.payload.readme,
            changelog: envelope.payload.changelog,
            verificationLevel:
              envelope.payload.verificationLevel ?? baseForm.verificationLevel,
            restoredAt: envelope.savedAt,
          });
        } else {
          this.setState(baseForm);
        }
        this.controller = undefined;
      } catch (err) {
        if (this.controller !== controller) return;
        this.controller = undefined;
        if (isAbortError(err)) {
          ehLog("info", "build.load-context.aborted");
          this.setState({ kind: "idle" });
          return;
        }
        // engine.loadBuildContext logs its own .ok; a throw unwinds past that,
        // so the failure has to be recorded here or the log just stops.
        ehLog("error", "build.load-context.fail", { err });
        this.setState({
          kind: "error",
          record: {
            errorId: ++this.errorSeq,
            error: err,
            phase: "load",
          },
          formSnapshot: undefined,
        });
      }
    })();
  }

  /**
   * Re-download the source archives Vortex has lost, and hash them.
   *
   * DOWNLOAD ONLY — `recoverMissingArchives` passes `allowInstall: false`, so
   * the mods themselves are never touched. They are already installed with
   * FOMOD choices the curator made once; re-running the installer to obtain a
   * hash would risk the very thing the hash describes.
   *
   * The result is folded into the form's context in memory AND written to the
   * hash cache, so a later build costs nothing even though Vortex's own records
   * still point at the dead downloads.
   */
  /**
   * Ask Nexus whether the USER will be able to download what we are about to
   * pack.
   *
   * The curator cannot answer this from their own machine: every mod is
   * already on their disk, so a collection referencing a file Nexus deleted
   * builds and ships perfectly and fails only for somebody else. Two such mods
   * sat in a real collection for days, failing on a tester's machine every
   * time, with nothing on the build side ever mentioning them.
   *
   * Explicit rather than automatic. It is one lookup per unique mod — 780 of
   * them for a 955-mod collection — which is a real slice of a daily API
   * budget and not something every build should silently spend.
   */
  checkNexusAvailability(api: types.IExtensionApi): void {
    if (this.state.kind !== "form") return;
    const form = this.state;

    const getModFiles = api.ext.nexusGetModFiles;
    if (getModFiles === undefined) {
      // Vortex's Nexus integration is optional and its ext functions are all
      // declared `?`. Say so rather than reporting every mod unknown, which
      // would look like Nexus was down.
      this.setState({
        ...form,
        availability: {
          summary: {
            available: 0,
            oldVersion: 0,
            fileMissing: 0,
            modMissing: 0,
            unknown: 0,
            clean: true,
            lines: [
              "Vortex's Nexus integration is not available, so this could " +
                "not be checked. Is the Nexus extension enabled and are you " +
                "logged in?",
            ],
          },
          findings: [],
          checkedAt: new Date().toISOString(),
        },
      });
      return;
    }

    const entries: AvailabilityEntry[] = [];
    for (const mod of form.ctx.mods) {
      // Was a fourth spelling of "is this from Nexus" (Number() + isFinite +
      // > 0) AND the only site that coerced the ids before building the key,
      // so a non-canonical numeric id would have produced `nexus:7:...` where
      // the manifest wrote `nexus:007:...`.
      if (!isNexusSourced(mod)) continue;
      const modId = mod.nexusModId as number;
      const fileId = mod.nexusFileId as number;
      entries.push({
        compareKey: nexusCompareKey(modId, fileId),
        name: mod.name,
        modId,
        fileId,
      });
    }
    if (entries.length === 0) return;

    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.setState({ ...form, availabilityProgress: { done: 0, total: 0 } });

    void (async (): Promise<void> => {
      ehLog("info", "availability.start", { files: entries.length });
      try {
        const report = await checkNexusAvailability(entries, {
          getModFiles: async (modId) =>
            (await getModFiles(form.ctx.gameId, modId)) as never,
          signal: controller.signal,
          onProgress: (done, total) => {
            if (this.controller !== controller) return;
            if (this.state.kind !== "form") return;
            this.setState({
              ...this.state,
              availabilityProgress: { done, total },
            });
          },
        });
        if (this.controller !== controller) return;
        const summary = summarizeAvailability(report.findings);
        ehLog("info", "availability.done", {
          modsChecked: report.modsChecked,
          gaveUpEarly: report.gaveUpEarly,
          fileMissing: summary.fileMissing,
          modMissing: summary.modMissing,
          oldVersion: summary.oldVersion,
          unknown: summary.unknown,
        });
        // The counts alone cannot answer "which mod was it?" a day later, and
        // that is the question that actually gets asked — a user reports a
        // download failure and the only way to tell whether this check had
        // already seen that mod is to have written the ids down. Availables
        // are skipped; they are the vast majority and carry no news.
        for (const f of report.findings) {
          if (f.status === "available") continue;
          ehLog("debug", "availability.finding", {
            status: f.status,
            modId: f.modId,
            fileId: f.fileId,
            name: f.name,
            ...(f.replacement !== undefined
              ? { replacementFileId: f.replacement.fileId }
              : {}),
          });
        }
        if (this.state.kind !== "form") return;
        const { availabilityProgress: _drop, ...rest } = this.state;
        this.setState({
          ...rest,
          availability: {
            summary,
            findings: report.findings,
            checkedAt: new Date().toISOString(),
          },
        });
      } catch (err) {
        if (this.controller !== controller) return;
        ehLog("warn", "availability.failed", { error: String(err) });
        if (this.state.kind !== "form") return;
        const { availabilityProgress: _drop, ...rest } = this.state;
        this.setState(rest);
      } finally {
        if (this.controller === controller) this.controller = undefined;
      }
    })();
  }

  recoverArchives(api: types.IExtensionApi): void {
    if (this.state.kind !== "form") return;
    const form = this.state;

    // The LIVE overrides, not the saved config. A curator who has just ticked
    // "ships as external" and not yet triggered a persist would otherwise
    // still be offered a re-download of the mod they just excused.
    const { recoverable } = findRecoverableMods(form.ctx.mods, {
      shipsAsExternal: (m) =>
        shipsAsExternal(isNexusMod(m), form.overrides[m.id]),
    });
    if (recoverable.length === 0) return;

    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.setState({
      kind: "recovering",
      form,
      done: 0,
      total: recoverable.length,
      recovered: 0,
      failed: 0,
    });

    void (async (): Promise<void> => {
      ehLog("info", "recover-archives.start", { mods: recoverable.length });
      const startedAt = Date.now();
      try {
        const report = await recoverMissingArchives(
          api,
          form.ctx.gameId,
          recoverable,
          {
            signal: controller.signal,
            onProgress: (done, total, mod) => {
              if (this.controller !== controller) return;
              if (this.state.kind !== "recovering") return;
              this.setState({ ...this.state, done, total, currentMod: mod.name });
            },
            // Written one at a time, not in a batch at the end. A run is
            // hundreds of downloads over hours; a crash or a cancel that
            // discarded them would also discard the archives, because the mod
            // still points at its dead download record and nothing would find
            // what was just fetched.
            onRecovered: async (outcome) => {
              await this.persistRecoveredHash(outcome);
              if (this.controller !== controller) return;
              if (this.state.kind !== "recovering") return;
              this.setState({
                ...this.state,
                recovered: this.state.recovered + 1,
              });
            },
          },
        );
        if (this.controller !== controller) return;

        const mods = applyRecovery(form.ctx.mods, report);
        const stillMissing = mods.filter((m) => m.archiveSha256 === undefined);

        ehLog("info", report.aborted ? "recover-archives.stopped" : "recover-archives.ok", {
          ms: Date.now() - startedAt,
          aborted: report.aborted,
          recovered: report.recovered.length,
          failed: report.failed.length,
          stillMissing: stillMissing.length,
          ...(report.failed.length > 0
            ? {
                failures: report.failed.slice(0, 15).map((f) => ({
                  mod: f.mod.name,
                  reason: (f as { reason: string }).reason,
                })),
              }
            : {}),
        });

        this.controller = undefined;
        this.setState({
          ...form,
          ctx: {
            ...form.ctx,
            mods,
            // The warning has to shrink, or the curator cannot tell it worked.
            //
            // Both halves are dropped and both are regenerated below, because
            // `stillMissing` covers Nexus and external mods alike. Recognising
            // them is `isMissingArchiveWarning`'s job, next to the strings it
            // matches — the substring that used to live here had drifted out of
            // sync with the message and silently matched nothing at all.
            scopeWarnings: [
              ...form.ctx.scopeWarnings.filter((w) => !isMissingArchiveWarning(w)),
              ...describeMissingArchives(stillMissing),
              ...(report.failed.length > 0
                ? [
                    `${report.failed.length} archive(s) could not be re-downloaded ` +
                      `(e.g. "${report.failed[0]!.mod.name}": ` +
                      `${(report.failed[0] as { reason: string }).reason}). ` +
                      `See the event-horizon log for the full list.`,
                  ]
                : []),
            ],
          },
        });
      } catch (err) {
        if (this.controller !== controller) return;
        this.controller = undefined;
        if (isAbortError(err)) {
          ehLog("info", "recover-archives.aborted");
          this.setState(form);
          return;
        }
        ehLog("error", "recover-archives.fail", { err });
        this.setState({
          kind: "error",
          record: { errorId: ++this.errorSeq, error: err, phase: "load" },
          formSnapshot: form,
        });
      }
    })();
  }

  /**
   * Store ONE recovered hash against `(modId, fileId)`.
   *
   * Re-read and re-written per archive rather than held in memory: the file is
   * a few KB against downloads measured in hundreds of megabytes, and it means
   * the work survives whatever happens next.
   */
  private async persistRecoveredHash(
    outcome: Awaited<ReturnType<typeof recoverMissingArchives>>["recovered"][number],
  ): Promise<void> {
    if (outcome.kind !== "recovered") return;
    const dir = `${getVortexUserDataPath()}/event-horizon`;
    try {
      const cache = await loadArchiveHashCache(dir);
      await saveArchiveHashCache(
        dir,
        rememberArchiveHash(cache, {
          nexusModId: outcome.nexusModId,
          nexusFileId: outcome.nexusFileId,
          sha256: outcome.archiveSha256,
          ...(outcome.size !== undefined ? { size: outcome.size } : {}),
          at: new Date().toISOString(),
          // Where it landed, not just what it hashes to. A later build reads
          // this to open the archive the mod's own record can no longer name.
          downloadId: outcome.downloadId,
        }),
      );
    } catch (err) {
      // A cache is an optimisation. Failing to write it costs a repeat download
      // next time; failing the whole recovery over it would cost this one too.
      ehLog("warn", "recover-archives.cache-write-failed", { err });
    }
  }

  /** Stop starting new downloads. One already in flight cannot be aborted. */
  cancelRecovering(): void {
    if (this.state.kind !== "recovering") return;
    this.controller?.abort();
  }

  /**
   * Resume automatically when the curator already has a draft for this build.
   *
   * Restarting Vortex dropped you back on the intro card with a Begin button,
   * even though the page promises "restart Vortex — your form will be there
   * when you come back". The form values did survive; the CONTEXT did not, and
   * rebuilding it meant re-hashing every archive — seventeen minutes, which is
   * why it was ever a button.
   *
   * With the hash cache that pass is seconds (measured: 945 of 945 archives
   * reused on a real profile), so the reason for asking is gone. A saved draft
   * is explicit prior intent for this collection; a first-time user with no
   * draft still gets the card and chooses.
   *
   * The load remains cancellable and shows progress, so even a cold cache — a
   * new machine, a moved download folder — is interruptible rather than a
   * seventeen-minute ambush.
   */
  resumeIfDraftExists(api: types.IExtensionApi): void {
    if (this.state.kind !== "idle") return;
    void (async (): Promise<void> => {
      let envelope: Awaited<ReturnType<typeof loadDraft<BuildDraftPayload>>>;
      try {
        envelope = await loadDraft<BuildDraftPayload>(
          getAppDataPath(),
          "build",
          this.draftId,
        );
      } catch {
        return; // best-effort: a Begin button is a fine fallback
      }
      if (envelope === undefined) return;
      // Re-check: the curator may have pressed Begin themselves while the
      // draft was being read.
      if (this.state.kind !== "idle") return;
      ehLog("info", "build.auto-resume", { draftId: this.draftId });
      this.begin(api);
    })();
  }

  cancelLoading(): void {
    if (this.state.kind !== "loading") return;
    this.controller?.abort();
    // The controller-owning task observes the abort and resets to idle.
  }

  /**
   * form → queued/building. Snapshots the form, hands the request to
   * the registry's build queue, and parks in `queued` if the global
   * build slot is busy. The registry calls back into `_runBuild` when
   * our turn comes.
   *
   * Caller is responsible for validating `input.curator` first (so
   * the page can show validation errors inline) — the session only
   * runs the engine.
   */
  build(api: types.IExtensionApi, input: BuildAttemptInput): void {
    if (this.state.kind !== "form") return;
    this.controller?.abort();
    this.controller = undefined;
    this.pendingBuildInput = input;

    const queuePosition = this.hooks.enqueueBuild(this, () => {
      this._runBuild(api);
    });

    if (queuePosition > 0) {
      // Slot busy — park in `queued` until promoted.
      this.setState({
        kind: "queued",
        ctx: input.ctx,
        curator: input.curator,
        overrides: input.overrides,
        readme: input.readme,
        changelog: input.changelog,
        verificationLevel: "thorough",
        reverifyEverything: input.reverifyEverything ?? false,
        queuePosition,
      });
      return;
    }

    // Slot acquired immediately. The registry's contract is to call
    // our onSlotAcquired synchronously when it returns 0, so we're
    // already in `building` here — nothing else to do.
  }

  /**
   * Update the queue position the user sees. Called by the registry
   * when sessions ahead of us drop out (cancel / finish) without us
   * being promoted yet.
   */
  _updateQueuePosition(position: number): void {
    if (this.state.kind !== "queued") return;
    if (this.state.queuePosition === position) return;
    this.setState({ ...this.state, queuePosition: position });
  }

  /**
   * Internal: run the build pipeline now that we own the slot. Split
   * out from `build()` so the registry can defer execution while
   * other sessions hold the slot. Always call `releaseBuild` on the
   * way out so the next queued session is promoted.
   */
  /**
   * Resolves the promise the pipeline is parked on.
   *
   * Held here rather than in the state: the state is broadcast to every
   * subscriber and copied into React on each tick, and a function in it would
   * be both meaningless to a renderer and easy to lose in a spread.
   */
  private resumeDecisions?: () => void;

  /**
   * Let a parked pipeline go, without answering.
   *
   * Called on cancel: the abort signal is only checked between steps, and a
   * pipeline suspended on this promise never reaches one. Resolving lets it
   * run to the next check and abort there.
   */
  private releaseDecisions(): void {
    const resume = this.resumeDecisions;
    this.resumeDecisions = undefined;
    resume?.();
  }

  /**
   * The curator is done answering — let the build finish.
   *
   * Safe to call when nothing is waiting: a stray click after the build has
   * already moved on must not throw.
   */
  continueAfterDecisions(): void {
    const resume = this.resumeDecisions;
    if (resume === undefined) return;
    this.resumeDecisions = undefined;
    if (this.state.kind === "awaiting-decisions") {
      this.setState({
        kind: "building",
        ctx: this.state.ctx,
        curator: this.state.curator,
        progress: this.state.progress,
      });
    }
    resume();
  }

  private _runBuild(api: types.IExtensionApi): void {
    const input = this.pendingBuildInput;
    if (input === undefined) {
      // We were cancelled between enqueueBuild() and the slot opening.
      this.hooks.releaseBuild(this);
      return;
    }
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const formSnapshot: Extract<BuildSessionState, { kind: "form" }> = {
      kind: "form",
      ctx: input.ctx,
      curator: input.curator,
      overrides: input.overrides,
      readme: input.readme,
      changelog: input.changelog,
      verificationLevel: "thorough",
      reverifyEverything: input.reverifyEverything ?? false,
    };
    this.setState({
      kind: "building",
      ctx: input.ctx,
      curator: input.curator,
      progress: { phase: "writing-config" },
    });

    void (async (): Promise<void> => {
      try {
        const result = await runBuildPipeline(
          api,
          input.ctx,
          input.curator,
          {
            externalMods: input.overrides,
            readme: input.readme,
            changelog: input.changelog,
            verificationLevel: "thorough",
        reverifyEverything: input.reverifyEverything ?? false,
          },
          {
            signal: controller.signal,
            onProgress: (progress) => {
              if (this.controller !== controller) return;
              // While paused, progress from a background step must not
              // silently return the UI to "building" and swallow the
              // question the curator is looking at.
              if (this.state.kind !== "building") return;
              this.setState({
                kind: "building",
                ctx: input.ctx,
                curator: input.curator,
                progress,
              });
            },
            onDecisions: async (candidates): Promise<void> => {
              if (this.controller !== controller) return;
              const progress =
                this.state.kind === "building"
                  ? this.state.progress
                  : { phase: "inspecting-mods" as const };
              await new Promise<void>((resolve) => {
                this.resumeDecisions = resolve;
                this.setState({
                  kind: "awaiting-decisions",
                  ctx: input.ctx,
                  curator: input.curator,
                  candidates,
                  progress,
                });
              });
            },
          },
        );
        if (this.controller !== controller) {
          // A newer build superseded this one. The package it produced is real
          // and on disk, but this session will never show it — so say so,
          // rather than leaving a finished build with no visible outcome.
          ehLog("warn", "build.result.discarded", {
            reason: "session superseded by a newer build",
            outputPath: result.outputPath,
          });
          return;
        }
        this.controller = undefined;
        this.pendingBuildInput = undefined;
        this.setState({
          kind: "done",
          result,
          ctx: input.ctx,
          curator: input.curator,
          builtAt: Date.now(),
        });
        // Successful build → wipe the in-flight draft. Best-effort.
        void deleteDraft(getAppDataPath(), "build", this.draftId);
      } catch (err) {
        if (this.controller !== controller) {
          // Superseded AND failed. Without this the log holds a
          // `build.pipeline.start` with no end of any kind — the one shape
          // that reads as "it is still running".
          ehLog("error", "build.failure.discarded", {
            reason: "session superseded by a newer build",
            err,
          });
          return;
        }
        this.controller = undefined;
        this.pendingBuildInput = undefined;
        if (isAbortError(err)) {
          ehLog("info", "build.pipeline.aborted", { reason: "user-cancelled" });
          // Cancellation rewinds to the form so the curator can
          // tweak and try again — the autosaved draft is untouched.
          this.setState(formSnapshot);
          return;
        }
        /**
         * ─── A REFUSAL IS NOT A CRASH ───────────────────────────────────
         * The pipeline declines to build a package that would not work — no
         * plugin order, or a profile already over the game's plugin limit.
         * Routing that into the error state would render a stack trace and a
         * "report this" button for something the curator can simply fix, and
         * the report we would get is "Event Horizon crashed on build".
         *
         * So it rewinds to the form, like a cancellation does, and the reason
         * goes in the same place every other "fix this and try again" message
         * does. Checked by NAME as well as instance: the pipeline is reached
         * through a dynamic import in places, and a class loaded twice fails
         * instanceof while still being the same error.
         */
        const refused =
          err instanceof BuildRefusedError ||
          (err instanceof Error && err.name === "BuildRefusedError");
        if (refused) {
          ehLog("info", "build.refused.to-form", {
            code: (err as { code?: string }).code,
            // The code alone does not say WHICH plugin limit, or which mod had
            // no order. The message the curator is about to read is the only
            // place that detail exists.
            message: (err as Error).message,
          });
          this.setState({
            ...formSnapshot,
            validationError: (err as Error).message,
          });
          return;
        }
        ehLog("error", "build.pipeline.fail", { err });
        this.setState({
          kind: "error",
          record: {
            errorId: ++this.errorSeq,
            error: err,
            phase: "build",
          },
          formSnapshot,
        });
      } finally {
        // Always free the build slot so queued sessions can be
        // promoted. Safe to call multiple times — the registry
        // ignores releases from sessions that don't own the slot.
        this.hooks.releaseBuild(this);
      }
    })();
  }

  cancelBuilding(): void {
    if (this.state.kind === "queued") {
      // Bail out before we ever acquired the slot. Rewinds to form
      // and leaves the active builder undisturbed.
      this.hooks.cancelQueued(this);
      const input = this.pendingBuildInput;
      this.pendingBuildInput = undefined;
      this.setState({
        kind: "form",
        ctx: this.state.ctx,
        curator: this.state.curator,
        overrides: this.state.overrides,
        readme: this.state.readme,
        changelog: this.state.changelog,
        verificationLevel: this.state.verificationLevel,
      reverifyEverything: this.state.reverifyEverything,
      });
      void input; // silence unused
      return;
    }
    if (this.state.kind === "awaiting-decisions") {
      // Abort alone would not free it: the signal is only observed between
      // steps, and a pipeline parked on the decisions promise never reaches
      // one. Release it first, then abort, and it stops at the next check.
      this.controller?.abort();
      this.releaseDecisions();
      return;
    }
    if (this.state.kind !== "building") return;
    this.controller?.abort();
  }

  /**
   * Move out of `done` / `error` back to `idle`. Called by:
   *   • "Build another" on the success card
   *   • "Go home" / "Retry" on the error card (retry then calls begin())
   */
  reset(): void {
    this.controller?.abort();
    this.releaseDecisions();
    this.controller = undefined;
    this.setState({ kind: "idle" });
  }

  // ── Internals ────────────────────────────────────────────────────

  private setState(next: BuildSessionState): void {
    this.state = next;
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch {
        /* one bad subscriber must not poison the others */
      }
    }
    // Fan out to the registry so dashboard subscribers re-render
    // AND so the registry can recompute the global `buildBusy`
    // runtime flag as the OR across every live session.
    //
    // The flag is owned by the registry (not this session) because
    // it's a true global: with parallel drafts, session A going
    // idle/form/done must not clear `buildBusy` while session B is
    // still loading/queued/building. Letting the registry compute
    // it is the only place with the full picture.
    this.hooks.notifyStateChanged(this);
  }
}

/**
 * Class export — the registry constructs instances directly. There
 * is no module-scope singleton anymore (Track 1: parallel drafts);
 * use {@link getBuildSessionRegistry} from `buildSessionRegistry.ts`
 * to get or create per-draft sessions.
 */
export { BuildSession };

// ───────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────

/**
 * True when an error came from an AbortController.abort() chain —
 * either via our own AbortError (see core/archiveHashing) or a
 * DOMException thrown by the underlying browser/Electron APIs.
 *
 * Mirrored from the BuildPage component because the session needs
 * the same predicate without importing UI code.
 */
function isAbortError(err: unknown): boolean {
  if (err instanceof AbortError) return true;
  if (err instanceof Error) {
    if (err.name === "AbortError") return true;
    const message = err.message ?? "";
    if (message.toLowerCase().includes("cancelled")) return true;
  }
  return false;
}

export { isAbortError };
