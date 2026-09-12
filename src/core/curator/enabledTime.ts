/**
 * When a mod was enabled, as the curator reads it.
 *
 * Vortex stamps `persistent.profiles[id].modState[modId].enabledTime` with
 * `Date.now()` every time a mod is enabled in that profile (and
 * `disabledTime` when it is disabled; the enabled time stays). Its own Mods
 * tab has the column, hidden by default. A curator working on a collection
 * wants the list freshest first: "what did I just turn on" is the question.
 *
 * 0 means Vortex never recorded one (a mod added by a collection install
 * starts at 0), which is unknown, not 1970.
 */

/** A usable timestamp, or undefined for "never recorded". */
export function enabledTimeOf(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

/** "2026-09-12 14:03", local time; empty for an unknown time. */
export function formatEnabledTime(ts: number | undefined): string {
  if (ts === undefined || !Number.isFinite(ts) || ts <= 0) return "";
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
