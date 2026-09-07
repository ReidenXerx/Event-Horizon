/**
 * BuildSessionRegistry — Track 1 (parallel drafts).
 *
 * Owns every live {@link BuildSession} keyed by `draftId` plus the
 * global build queue that serialises actual builds to one at a time.
 *
 * Why a registry instead of independent module singletons:
 *   1. The dashboard view ("My drafts") needs to enumerate all live
 *      sessions and re-render whenever any of them changes. Without
 *      a single owner, the dashboard would have to subscribe to
 *      sessions piecemeal as they're created, which races badly with
 *      sessions created from disk on dashboard open.
 *   2. The build slot is a true global: Vortex's API is not safe to
 *      call from two builds in parallel (manifests stomp on the
 *      same temp dir, plugins.txt reads race, etc.). One owner that
 *      gates `_runBuild` keeps the contract explicit.
 *   3. Tab-switch resilience: per-session state is module-scoped,
 *      so React remounts of BuildPage just re-subscribe. Same
 *      property the legacy single-session design had — just times N.
 *
 * Lifecycle:
 *   - {@link ensure} creates a session for a draftId (or returns the
 *     existing one). Used both when the user opens an existing draft
 *     from the dashboard and when "New draft" mints a fresh one.
 *   - {@link remove} drops a session — used when a draft is fully
 *     done (success card → "Build another" → user navigates away),
 *     or when the user discards a draft permanently. Doesn't touch
 *     the on-disk draft file; the caller is responsible for that.
 *   - The registry never garbage-collects sessions on its own. A
 *     session in `idle`/`form`/`error` is cheap (a few KB of mods
 *     metadata) and keeping it around lets tab-switches stay snappy.
 *
 * Build queue invariant:
 *   - At most one session is in state `kind: "building"` at any
 *     moment. The session that holds the slot owns
 *     {@link currentBuilder}; sessions waiting for the slot live in
 *     {@link queue} (FIFO). Promotion is automatic: when the current
 *     builder calls `releaseBuild` we shift the next session out and
 *     invoke its `onSlotAcquired` callback, which transitions it from
 *     `queued` → `building`.
 *   - `cancelQueued` removes a session from the queue and updates the
 *     `queuePosition` displayed by everyone behind it.
 */

import { ehLog } from "../../../core/logging/ehLog";
import { getEHRuntime } from "../../runtime/ehRuntime";
import { BuildSession, type BuildSessionRegistryHooks } from "./buildSession";

// ───────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────

export type BuildRegistryListener = () => void;

interface QueueEntry {
  session: BuildSession;
  /** Called when this session's slot is acquired. */
  onSlotAcquired: () => void;
}

// ───────────────────────────────────────────────────────────────────────
// Implementation
// ───────────────────────────────────────────────────────────────────────

class BuildSessionRegistry {
  private readonly sessions = new Map<string, BuildSession>();
  private readonly registryListeners = new Set<BuildRegistryListener>();

  /** Session currently holding the build slot. `undefined` if idle. */
  private currentBuilder: BuildSession | undefined;
  /** FIFO queue of sessions waiting for the slot. */
  private readonly queue: QueueEntry[] = [];

  /**
   * Get or create a session for the given draftId. Repeated calls
   * with the same draftId return the same instance — important
   * because callers (BuildPage, dashboard) subscribe to its state.
   *
   * `gameId` is required only the first time a session is created;
   * for subsequent `ensure` calls it's ignored (the existing session
   * keeps its original gameId, which was pinned at draft creation).
   */
  ensure(args: { draftId: string; gameId: string }): BuildSession {
    const existing = this.sessions.get(args.draftId);
    if (existing !== undefined) return existing;
    const session = new BuildSession({
      draftId: args.draftId,
      gameId: args.gameId,
      hooks: this.makeHooks(),
    });
    this.sessions.set(args.draftId, session);
    this.emit();
    return session;
  }

  /** Get an existing session without creating one. */
  get(draftId: string): BuildSession | undefined {
    return this.sessions.get(draftId);
  }

  /** Snapshot of every live session. Order is insertion order. */
  list(): BuildSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Remove a session from the registry. If the session is currently
   * building, we DON'T cancel here — caller is expected to coordinate
   * (e.g. the user clicked "Discard draft" from the success card,
   * which is only reachable from `done` state).
   *
   * The on-disk draft file is NOT touched here; the caller decides
   * whether to keep or delete it.
   */
  remove(draftId: string): void {
    const removed = this.sessions.delete(draftId);
    if (removed) this.emit();
  }

  /**
   * Subscribe to "any session changed / appeared / disappeared".
   * Used by the dashboard view. Per-session listeners (form
   * keystrokes etc.) should subscribe to that session directly.
   */
  subscribe(listener: BuildRegistryListener): () => void {
    this.registryListeners.add(listener);
    return (): void => {
      this.registryListeners.delete(listener);
    };
  }

  /**
   * True when any session is in loading/queued/building. Used by the
   * runtime busy flag and the BuildPage's "concurrent op" banner.
   */
  isAnyBusy(): boolean {
    for (const session of this.sessions.values()) {
      const k = session.getState().kind;
      // "awaiting-decisions" is a build IN FLIGHT that happens to be waiting
      // on the curator — it still holds the global build slot and will resume
      // into deployment and plugins.txt reads. Omitting it cleared the
      // concurrent-operation banner mid-build, so an install could be started
      // against the same Vortex state the paused pipeline is about to read.
      if (
        k === "loading" ||
        k === "queued" ||
        k === "building" ||
        k === "awaiting-decisions"
      ) {
        return true;
      }
    }
    return false;
  }

  // ── Build slot ───────────────────────────────────────────────────

  /**
   * Try to acquire the build slot for `session`.
   *  • Returns `true` only on a *fresh* acquisition (slot was free).
   *  • Returns `false` on re-entry (this session already holds the
   *    slot). This is critical: re-entry must not re-fire the
   *    `onSlotAcquired` callback, which would re-invoke `_runBuild`
   *    on a session already inside `_runBuild` and produce two
   *    parallel build pipelines for the same draft.
   *  • Returns `false` when another session holds the slot.
   *
   * `BuildSession.build` already gates on `state.kind === "form"`, so
   * a re-entry here would be a programming bug — but defending in
   * depth is cheap and prevents a particularly nasty class of races
   * if the gate ever weakens.
   */
  private acquireSlot(session: BuildSession): boolean {
    if (this.currentBuilder === undefined) {
      this.currentBuilder = session;
      return true;
    }
    return false;
  }

  private enqueueBuild(
    session: BuildSession,
    onSlotAcquired: () => void,
  ): number {
    // Re-entry: this session already holds the slot. Treat as a no-op
    // (the build is already running; don't re-fire onSlotAcquired).
    if (this.currentBuilder === session) return 0;

    if (this.acquireSlot(session)) {
      // Slot was free — start immediately. Callback runs synchronously
      // so the caller transitions straight to `building` without a
      // `queued` flicker.
      onSlotAcquired();
      return 0;
    }
    // Slot busy — enqueue. Skip duplicate enqueues (defence in depth
    // — `BuildSession.build` already gates on state, but a stray call
    // shouldn't double-queue).
    if (this.queue.some((e) => e.session === session)) {
      return this.queuePositionOf(session);
    }
    this.queue.push({ session, onSlotAcquired });
    return this.queue.length;
  }

  private releaseBuild(session: BuildSession): void {
    if (this.currentBuilder !== session) return;
    this.currentBuilder = undefined;
    // Promote the next queued session, if any.
    const next = this.queue.shift();
    if (next !== undefined) {
      this.currentBuilder = next.session;
      try {
        next.onSlotAcquired();
      } catch (err) {
        // The session's own _runBuild handles errors via its state
        // machine. Anything thrown here would be a programming bug
        // — log it and free the slot so we don't deadlock.
        //
        // The user-visible symptom is a queued build that never starts, with
        // no error anywhere: the session was promoted, threw, and got dropped.
        // Without this line that is indistinguishable from "nothing happened".
        ehLog("error", "build.queue.promotion.failed", {
          queueRemaining: this.queue.length,
          consequence:
            "the promoted build never started and its slot was released",
          err,
        });
        this.currentBuilder = undefined;
      }
    }
    this.notifyQueuePositions();
    this.emit();
  }

  private cancelQueued(session: BuildSession): void {
    const idx = this.queue.findIndex((e) => e.session === session);
    if (idx === -1) return;
    this.queue.splice(idx, 1);
    this.notifyQueuePositions();
  }

  private queuePositionOf(session: BuildSession): number {
    const idx = this.queue.findIndex((e) => e.session === session);
    return idx === -1 ? 0 : idx + 1;
  }

  /**
   * Re-emit queuePosition changes to every still-queued session so
   * the UI counter matches reality after a queue mutation.
   */
  private notifyQueuePositions(): void {
    this.queue.forEach((entry, i) => {
      // Internal-only method on BuildSession — exposes queuePosition
      // updates without making the whole registry interface public.
      (entry.session as unknown as {
        _updateQueuePosition: (n: number) => void;
      })._updateQueuePosition(i + 1);
    });
  }

  // ── Hooks (handed to each BuildSession at construction) ──────────

  private makeHooks(): BuildSessionRegistryHooks {
    return {
      enqueueBuild: (session, onSlotAcquired) =>
        this.enqueueBuild(session, onSlotAcquired),
      releaseBuild: (session) => {
        this.releaseBuild(session);
      },
      cancelQueued: (session) => {
        this.cancelQueued(session);
      },
      notifyStateChanged: (_session) => {
        this.emit();
      },
    };
  }

  private emit(): void {
    // Recompute the runtime's global `buildBusy` flag as the OR
    // across every live session. Owned by the registry because no
    // single session knows whether its siblings are still busy —
    // if session A goes form/idle/done while session B is queued
    // or building, the flag must stay true.
    //
    // Cheap (one Map iteration); fires only on real session-state
    // changes plus appear/disappear, never on per-keystroke patch.
    getEHRuntime().setBuildBusy(this.isAnyBusy());

    for (const listener of this.registryListeners) {
      try {
        listener();
      } catch {
        /* one bad subscriber must not poison the others */
      }
    }
  }
}

// ───────────────────────────────────────────────────────────────────────
// Module singleton
// ───────────────────────────────────────────────────────────────────────

let singleton: BuildSessionRegistry | undefined;

/**
 * Lazily-instantiated registry. Same lifetime semantics as the
 * legacy `getBuildSession` had:
 *   • survives sidebar tab switches (sessions stay alive);
 *   • DOES NOT survive a Vortex restart — disk drafts cover that
 *     via the dashboard's `listDrafts` pass on next open.
 */
export function getBuildSessionRegistry(): BuildSessionRegistry {
  if (singleton === undefined) singleton = new BuildSessionRegistry();
  return singleton;
}

export type { BuildSessionRegistry };
