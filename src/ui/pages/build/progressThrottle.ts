/**
 * ─── ONE SCREEN UPDATE PER TICK, NOT ONE PER FILE ─────────────────────────
 * A build reports progress for every file in its long phases — each bundled
 * and mirrored file is checked for archives, staged, and read back out of the
 * package — and every report became its own state change, so the screen was
 * asked to re-render once per file on a collection with hundreds of thousands
 * of them.
 *
 * At most one report per interval now reaches the screen. The newest one
 * always arrives, at most one interval late, and a report that starts a new
 * phase is never held back.
 */

/** How often, at most, a build's progress reaches the screen. */
export const PROGRESS_INTERVAL_MS = 100;

export type ProgressThrottle<T> = {
  /** Report progress: it goes through now, or as the newest report when the interval ends. */
  push: (progress: T) => void;
  /** Stop for good: a held report is dropped and nothing more goes through. */
  cancel: () => void;
};

export function throttleProgress<T>(
  emit: (progress: T) => void,
  options: {
    intervalMs?: number;
    /** Reports with different keys belong to different phases; a new phase is sent at once. */
    keyOf?: (progress: T) => unknown;
  } = {},
): ProgressThrottle<T> {
  const intervalMs = options.intervalMs ?? PROGRESS_INTERVAL_MS;
  const keyOf = options.keyOf ?? ((progress: T): unknown => (progress as { phase?: unknown }).phase);
  let sentAt: number | undefined;
  let sentKey: unknown;
  let held: { progress: T } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;

  const send = (progress: T): void => {
    sentAt = Date.now();
    sentKey = keyOf(progress);
    held = undefined;
    emit(progress);
  };
  const stopTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  return {
    push(progress) {
      if (cancelled) return;
      const elapsed = sentAt === undefined ? Number.POSITIVE_INFINITY : Date.now() - sentAt;
      if (elapsed >= intervalMs || keyOf(progress) !== sentKey) {
        stopTimer();
        send(progress);
        return;
      }
      held = { progress };
      if (timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined;
          if (!cancelled && held !== undefined) send(held.progress);
        }, intervalMs - elapsed);
      }
    },
    cancel() {
      cancelled = true;
      held = undefined;
      stopTimer();
    },
  };
}
