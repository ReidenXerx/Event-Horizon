/**
 * The parts of a toast that are decisions rather than markup: when it goes
 * away, and whether a new one is the same as one already on screen. They
 * live here, without React, so they can be tested with fake timers.
 *
 * ─── A TOAST HELD OPEN MUST STILL CLOSE ────────────────────────────────
 * Hovering a toast pauses its clock; leaving it resumes. Resuming used to go
 * through the same `arm` that a re-shown toast uses, and `arm` treats a
 * paused clock as "extend what resumes and return" — so resuming a paused
 * clock extended it and returned, and no timer was ever set again. Every
 * toast anyone had moused over stayed until closed by hand, and under the
 * five-toast cap it was later evicted by newer ones, taking an unread sticky
 * error with it. Resuming now starts the clock directly.
 *
 * ─── HOVER AND FOCUS ARE SEPARATE REASONS ──────────────────────────────
 * The pointer leaving a toast whose button has keyboard focus is not a
 * reason to close it under that focus, and a second pause (focus arriving
 * while hovered) must not recompute the time left from a clock that is
 * already stopped — it used to, and 3 s left became 0.5 s. A clock runs
 * only when nothing is holding the toast open.
 */

import type { ReactNode } from "react";

export type ToastHold = "hover" | "focus";

/** A resumed toast gets at least this long; otherwise it vanishes as the pointer leaves. */
export const MIN_RESUME_MS = 500;

export interface ToastTimers {
  /**
   * Start (or restart) the auto-dismiss clock. `ms <= 0` is sticky. While the
   * toast is held open, nothing starts: the time that resumes is extended
   * instead, so a re-shown toast does not restart the clock under the cursor.
   */
  arm(id: number, ms: number): void;
  hold(id: number, why: ToastHold): void;
  release(id: number, why: ToastHold): void;
  /** The toast is gone: drop its clock and anything holding it. */
  forget(id: number): void;
  dispose(): void;
}

interface Clock {
  /** Undefined while held open. */
  handle: ReturnType<typeof setTimeout> | undefined;
  /** When a running clock fires, so a hold can compute what is left. */
  due: number;
  /** What resumes when the last hold is released. */
  remaining: number;
}

export function createToastTimers(onExpire: (id: number) => void): ToastTimers {
  const clocks = new Map<number, Clock>();
  const holds = new Map<number, Set<ToastHold>>();

  const start = (id: number, ms: number): void => {
    const handle = setTimeout(() => {
      clocks.delete(id);
      holds.delete(id);
      onExpire(id);
    }, ms);
    clocks.set(id, { handle, due: Date.now() + ms, remaining: ms });
  };

  const stop = (id: number): void => {
    const clock = clocks.get(id);
    if (clock?.handle !== undefined) clearTimeout(clock.handle);
    clocks.delete(id);
  };

  const held = (id: number): boolean => (holds.get(id)?.size ?? 0) > 0;

  return {
    arm(id, ms) {
      if (held(id)) {
        if (ms <= 0) return;
        const clock = clocks.get(id);
        clocks.set(id, {
          handle: undefined,
          due: 0,
          remaining: Math.max(clock?.remaining ?? 0, ms),
        });
        return;
      }
      stop(id);
      if (ms > 0) start(id, ms);
    },

    hold(id, why) {
      let reasons = holds.get(id);
      if (reasons === undefined) {
        reasons = new Set();
        holds.set(id, reasons);
      }
      reasons.add(why);
      const clock = clocks.get(id);
      // Only a RUNNING clock has time to compute; a stopped one already knows.
      if (clock?.handle !== undefined) {
        clearTimeout(clock.handle);
        clock.handle = undefined;
        clock.remaining = Math.max(MIN_RESUME_MS, clock.due - Date.now());
      }
    },

    release(id, why) {
      const reasons = holds.get(id);
      if (reasons === undefined) return;
      reasons.delete(why);
      if (reasons.size > 0) return;
      holds.delete(id);
      const clock = clocks.get(id);
      if (clock !== undefined && clock.handle === undefined) start(id, clock.remaining);
    },

    forget(id) {
      stop(id);
      holds.delete(id);
    },

    dispose() {
      for (const clock of clocks.values()) {
        if (clock.handle !== undefined) clearTimeout(clock.handle);
      }
      clocks.clear();
      holds.clear();
    },
  };
}

// ===========================================================================
// Dedup
// ===========================================================================

/**
 * The key two toasts must share to be the same toast, or `undefined` when
 * this one must never be merged with another.
 *
 * Only text can be compared. An element — `<>Saved <code>{path}</code></>` —
 * used to hash to "[node]", so two different element messages with the same
 * intent and no title were "identical" and the second was silently dropped.
 * Rendering an element to text is not ours to do (a component can render
 * anything), so a toast carrying one is simply never a duplicate.
 */
export function toastDedupKey(input: {
  intent?: string;
  title?: ReactNode;
  message: ReactNode;
}): string | undefined {
  const title = nodeToText(input.title);
  const message = nodeToText(input.message);
  if (title === undefined || message === undefined) return undefined;
  // A separator, so ("a","bc") and ("ab","c") do not collide.
  return [input.intent ?? "info", title, message].join("\u0001");
}

/** The toast already on screen that `key` duplicates, if any. */
export function findDuplicateToast<T extends { key: string | undefined }>(
  shown: readonly T[],
  key: string | undefined,
): T | undefined {
  return key === undefined ? undefined : shown.find((t) => t.key === key);
}

/** Text for text-only nodes; `undefined` for anything containing an element. */
function nodeToText(node: ReactNode): string | undefined {
  if (node === undefined || node === null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) {
    let text = "";
    for (const child of node as readonly ReactNode[]) {
      const part = nodeToText(child);
      if (part === undefined) return undefined;
      text += part;
    }
    return text;
  }
  return undefined;
}
