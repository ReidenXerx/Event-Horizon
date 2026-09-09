/**
 * Shared `AbortError` class for cooperative cancellation across the
 * codebase.
 *
 * Why a custom class instead of `DOMException("AbortError")` or the
 * native `AbortSignal.reason`:
 *
 *  - Vortex extensions run in Electron's renderer where DOMException
 *    exists, but on Node-only entry points (Jest tests, headless
 *    scripts) it isn't always available with the constructor we
 *    want. A plain `Error` subclass works everywhere.
 *  - We rely on `(err as Error).name === "AbortError"` checks at
 *    abort-handling sites; that contract is independent of the
 *    Web standard's `DOMException.name === "AbortError"` shape but
 *    looks identical to consumers, so existing checks keep working.
 *
 * Module-level history: this class used to be redefined privately
 * inside `archiveHashing.ts`, `applyModRules.ts`, `applyLoadOrder.ts`,
 * and `applyUserlist.ts`. Centralizing avoids drift (one of the four
 * had a different default message) and gives a single import path
 * for new abort-aware modules.
 */
export class AbortError extends Error {
  constructor(message = "Aborted") {
    super(message);
    this.name = "AbortError";
  }
}

/**
 * ─── ASKING "WAS THIS AN ABORT?" IN ONE PLACE ───────────────────────────────
 * The docblock above says the codebase "relies on `(err as Error).name ===
 * 'AbortError'` checks at abort-handling sites" and then, deliberately,
 * exported no way to perform one. So the predicate was hand-written at 27
 * sites, in three different shapes:
 *
 *   (err as Error)?.name === "AbortError"
 *   err instanceof AbortError
 *   (err as Error).name === "AbortError" || ctx.abortSignal?.aborted === true
 *
 * Those are not equivalent. `instanceof` misses a DOMException from a real
 * `AbortSignal` — which is what `fs.promises` throws when a signal fires, and
 * the reason this class documents accepting both shapes. The compound form
 * catches a DIFFERENT case: an error thrown while unwinding after the signal
 * fired, which carries its own name and is still an abort in every sense the
 * caller cares about.
 *
 * That last distinction is real and worth keeping, so this takes the signal:
 * with one, "the run was aborted" is part of the answer; without one, only the
 * error is. Getting it wrong in either direction is expensive — treating an
 * abort as a failure writes a scary receipt for something the user did on
 * purpose, and treating a failure as an abort hides a real fault behind
 * "cancelled".
 */
export function isAbort(err: unknown, signal?: AbortSignal): boolean {
  if (err instanceof AbortError) return true;
  // A DOMException from a native AbortSignal, or anything else that adopts the
  // same name — the shape this class exists to be interchangeable with.
  if ((err as { name?: unknown } | null | undefined)?.name === "AbortError") {
    return true;
  }
  /**
   * Thrown WHILE unwinding after the signal fired. The error carries whatever
   * name the failing call gave it — `ENOENT` from a half-deleted temp dir, a
   * Vortex rejection from a cancelled install — and reporting that as the
   * cause sends the reader after a fault that only exists because they pressed
   * Stop.
   */
  return signal?.aborted === true;
}
