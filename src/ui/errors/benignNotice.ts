/**
 * ──────────────────────────────────────────────────────────────────────
 * Some things arrive through `window.onerror` and are not errors.
 *
 * `ErrorProvider` listens on the whole renderer's error events, which is
 * right — a silent unhandled failure is worse than a noisy one. But Chromium
 * also uses that same channel to deliver a NOTIFICATION about its own
 * scheduling, and nothing is wrong when it does.
 *
 * ─── THE ONE THIS WAS WRITTEN FOR ──────────────────────────────────────
 * A user sent this from Discord on 2026-09-22:
 *
 *     Title:    Something went wrong
 *     Severity: error
 *     Class:    string
 *     Message:  ResizeObserver loop completed with undelivered notifications.
 *     Hints:    This kind of error usually points to a non-Error value being
 *               thrown — please copy the report and tell us.
 *     filename: file:///F:/Vortex/resources/app.asar/index.html  line 0 col 0
 *
 * That is not a fault. When a ResizeObserver callback changes layout in a way
 * that triggers further observations, the browser delivers what it can in the
 * current frame and defers the rest to the next one — then announces the
 * deferral through the error channel. The observations still arrive. It is
 * common enough that error-reporting services ship a default rule ignoring
 * this exact string.
 *
 * The reporter added that it fires on EVERY DEPLOYMENT and has never caused a
 * problem they could point at. That fits: a deploy rewrites Vortex's mod list
 * and progress UI continuously, which is exactly the layout churn that makes
 * an observer fall behind by a frame.
 *
 * Two details of that report say it is not a fault. The class is `string`, so
 * nothing was thrown — Chromium raises this with no error object at all. The
 * filename is VORTEX'S OWN `index.html` at line 0, column 0, which is what the
 * browser reports when it has no source to name.
 *
 * ─── WHOSE IT IS, STATED NO MORE STRONGLY THAN IT CAN BE ───────────────
 * Event Horizon owns no ResizeObserver: the string appears nowhere in this
 * codebase, the extension has no runtime dependencies, and its charts are
 * hand-drawn SVG. So the observer that fell behind belongs to Vortex or to
 * another extension.
 *
 * That is not the same as proving our rendering had no part in it. An observer
 * we do not own can be watching an element we do re-render, and this page does
 * re-render while a deploy runs. Which of the two it is cannot be told from
 * here, and does not change the answer: the notice is benign either way, and
 * the defect is presenting it as a failure — so this drops it without claiming
 * innocence it cannot demonstrate.
 *
 * It was still reported as ours, because `isForeignError` needs a STACK to
 * disown something and this event has none — and that policy ("anything
 * ambiguous stays ours") is deliberate and correct for real errors. The bug is
 * not the attribution. It is that a benign notice was dressed as a failure at
 * all: severity "error", a title reading "Something went wrong", and a hint
 * inviting the reader to copy the report and tell us. They did exactly that.
 *
 * ─── WHY A LIST AND NOT A HEURISTIC ────────────────────────────────────
 * Swallowing an error is the expensive direction — the same reasoning that
 * makes `isForeignError` err towards "ours". So this is a closed list of exact
 * messages known to be notifications rather than faults, not a rule about
 * shapes. A genuine failure whose message merely resembles one of these is a
 * message nobody writes.
 * ──────────────────────────────────────────────────────────────────────
 */

/**
 * Chromium has used two wordings for the same notice. The older
 * "limit exceeded" form still appears on older Electron builds, and Vortex
 * ships whichever its Electron carries.
 */
const BENIGN_NOTICES: readonly RegExp[] = [
  /^ResizeObserver loop completed with undelivered notifications/i,
  /^ResizeObserver loop limit exceeded/i,
];

/**
 * The message this value carries, for matching. Only a string or an Error is
 * considered: anything richer is a real thrown value and not a browser notice.
 */
function messageOf(err: unknown): string {
  if (typeof err === "string") return err.trim();
  if (err instanceof Error && typeof err.message === "string") {
    return err.message.trim();
  }
  return "";
}

/**
 * Is this the browser telling us about its own scheduling rather than a
 * failure?
 *
 * Used only on the `window.error` path. These notices are never delivered as
 * promise rejections, so the rejection handler does not consult it and cannot
 * start silently dropping real ones.
 */
export function isBenignBrowserNotice(err: unknown): boolean {
  const message = messageOf(err);
  if (message.length === 0) return false;
  return BENIGN_NOTICES.some((re) => re.test(message));
}
