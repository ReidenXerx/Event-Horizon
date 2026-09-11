/**
 * ──────────────────────────────────────────────────────────────────────
 * Ask Vortex to update ONE mod, and know when it has actually finished.
 *
 * `runBulkUpdate` is sequential, and sequential means nothing unless "this mod
 * is done" is true when it resolves. Resolving when the REQUEST was accepted
 * would start the next install on top of the running one and reproduce exactly
 * the concurrency that makes Vortex's own bulk update lose files.
 *
 * ─── WHY THIS DOES NOT REUSE waitForInstallCompletion's acceptAny MODE ──
 * That waiter has a mode for "the first `did-install-mod` for this game after
 * we start listening", which is what a caller without an archiveId needs — and
 * `nexusModUpdate` hands back no archiveId. Its own doc marks the mode sound
 * only while at most one install pipeline runs for the game, and says that
 * invariant is held by `EHRuntime`.
 *
 * EHRuntime does not hold it. It is two booleans and a listener set — no lock,
 * no queue — and its own header says outright that concurrent operations are
 * not forbidden, only discouraged with a banner and a disabled button the user
 * can dismiss. So "the first install that finishes" can be a mod Vortex was
 * installing for some other reason, and a bulk update built on it would verify
 * the wrong mod and move on while the real one was still writing.
 *
 * ─── SO IT MATCHES ON IDENTITY INSTEAD ─────────────────────────────────
 * Every `did-install-mod` is checked against Vortex's own record of the mod it
 * just installed: the Nexus mod id and file id have to be the pair we asked
 * for. Anything else is somebody else's install and is ignored, which needs no
 * global invariant to be correct — only that Vortex records what it installed,
 * which it does because every other feature here already depends on it.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { types } from "@nexusmods/vortex-api";

import { ehLog } from "../logging/ehLog";

/** Minimal event surface, so the waiter is testable without Vortex. */
export type InstallEvents = {
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener: (
    event: string,
    handler: (...args: unknown[]) => void,
  ) => void;
};

export type UpdateOneInput = {
  events: InstallEvents;
  /** Ask Vortex to start the update. Fire-and-forget by Vortex's design. */
  start: () => void;
  /** Read what Vortex now records for a mod id it just installed. */
  readInstalled: (
    vortexModId: string,
  ) => { nexusModId?: number; nexusFileId?: number } | undefined;
  gameId: string;
  /** The mod we asked for — both halves must match to accept an event. */
  nexusModId: number;
  toFileId: number;
  /**
   * How long to wait before giving up.
   *
   * A mod that never arrives must not hang the whole run: forty mods behind a
   * silent failure is worse than one reported failure. Generous by default —
   * a large archive on a slow connection is not a fault.
   */
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Accept any file of the page, not only `toFileId`. For the guided install
   * where the USER picks the file on the Nexus page: the plan knows the mod,
   * not which of its files the user will click.
   */
  anyFile?: boolean;
};

export class UpdateTimeout extends Error {}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Start the update and resolve with the new Vortex mod id once it lands.
 *
 * Rejects on timeout or abort. Always removes its listener — a bulk run over
 * nine hundred mods would otherwise leak nine hundred of them.
 */
export function updateOneAndWait(input: UpdateOneInput): Promise<string> {
  const {
    events,
    start,
    readInstalled,
    gameId,
    nexusModId,
    toFileId,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    anyFile = false,
  } = input;

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      events.removeListener("did-install-mod", onInstalled);
      signal?.removeEventListener?.("abort", onAbort);
      if (timer !== undefined) clearTimeout(timer);
      fn();
    };

    function onInstalled(...args: unknown[]): void {
      const [eventGameId, , vortexModId] = args as [string, string, string];
      if (eventGameId !== gameId || typeof vortexModId !== "string") return;

      // The identity check. Vortex may be installing something else entirely;
      // accepting it would hand the caller a mod it never asked to update.
      const installed = readInstalled(vortexModId);
      if (
        installed?.nexusModId !== nexusModId ||
        (!anyFile && installed?.nexusFileId !== toFileId)
      ) {
        // Logged, because a REJECTED event is the whole failure mode here and
        // it used to look identical to no event at all. When the reader was
        // handed a stale snapshot this fired for the right mod every time,
        // with both ids undefined, and nothing anywhere said so.
        ehLog("debug", "update.install-event.ignored", {
          vortexModId,
          want: { nexusModId, fileId: toFileId },
          saw: installed ?? null,
        });
        return;
      }
      ehLog("info", "update.install-event.matched", { vortexModId });
      finish(() => resolve(vortexModId));
    }

    function onAbort(): void {
      finish(() => reject(new Error("cancelled")));
    }

    if (signal?.aborted === true) {
      reject(new Error("cancelled"));
      return;
    }

    // Listen BEFORE starting. Vortex can finish a small mod from cache before
    // the call that requested it has returned, and a listener attached after
    // would wait fifteen minutes for an event that already fired.
    events.on("did-install-mod", onInstalled);
    signal?.addEventListener?.("abort", onAbort);
    timer = setTimeout(() => {
      finish(() =>
        reject(
          new UpdateTimeout(
            `Vortex did not report finishing this update within ` +
              `${Math.round(timeoutMs / 60000)} minutes. It may still be ` +
              `downloading — the rest of the run was left alone.`,
          ),
        ),
      );
    }, timeoutMs);
    ehLog("debug", "update.waiting", { nexusModId, toFileId, timeoutMs });

    try {
      start();
    } catch (err) {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    }
  });
}

/**
 * ──────────────────────────────────────────────────────────────────────
 * Read the Nexus identity Vortex recorded for a mod it just installed.
 *
 * ─── IT TAKES A GETTER, NOT A STATE, AND THAT IS THE POINT ─────────────
 * This used to take `types.IState`, and the caller passed `api.getState()`
 * while building the run — one snapshot, captured BEFORE the first update
 * started. Redux state is immutable, so every later lookup searched a state
 * in which the newly installed mod did not exist yet. The identity check
 * failed on a mod Vortex had genuinely just installed, `did-install-mod` was
 * discarded as somebody else's, and the waiter sat out its full fifteen
 * minutes with one mod updated and the run stopped dead behind it.
 *
 * A getter cannot be stale. Passing a snapshot is now a compile error rather
 * than a bulk update that silently does one mod.
 * ──────────────────────────────────────────────────────────────────────
 */
export function installedIdentityReader(
  getState: () => types.IState,
  gameId: string,
): (vortexModId: string) => { nexusModId?: number; nexusFileId?: number } | undefined {
  return (vortexModId) => {
    const mod = (
      getState() as unknown as {
        persistent?: {
          mods?: Record<string, Record<string, { attributes?: Record<string, unknown> }>>;
        };
      }
    )?.persistent?.mods?.[gameId]?.[vortexModId];
    if (mod === undefined) return undefined;
    const attributes = mod.attributes ?? {};
    const asNum = (raw: unknown): number | undefined => {
      const n = typeof raw === "string" ? Number(raw) : raw;
      return typeof n === "number" && Number.isFinite(n) ? n : undefined;
    };
    return {
      ...(asNum(attributes.modId) !== undefined
        ? { nexusModId: asNum(attributes.modId)! }
        : {}),
      ...(asNum(attributes.fileId) !== undefined
        ? { nexusFileId: asNum(attributes.fileId)! }
        : {}),
    };
  };
}
