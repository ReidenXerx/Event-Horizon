/**
 * Is Vortex settled, seen from outside?
 *
 * Fallout-collection, 2026-11-13: test swaps (remove, deploy, install, rules)
 * reported "back" to Fo4-mcp as soon as the last verb answered, Fo4-mcp
 * launched the game, and Vortex surfaced its window over it a moment later,
 * twice, costing recording clips. A verb's answer says that verb is done, not
 * that Vortex is: its activities (deployment, plugin sort), the debounced
 * health checks after a mod change and its "activity" notifications run on.
 * `state` answers with what is still going on, and how long Vortex has been
 * quiet, so a caller can wait for both.
 */

export type BusyInput = {
  /** Vortex `session.base.activity`: group → running activity ids. */
  activity: Record<string, unknown> | undefined;
  /** Titles or messages of notifications of type "activity". */
  activityNotices: string[];
  /** A dialog, installer, External Changes or plugin-list question is waiting. */
  waitingFor: string[];
  /** When the last mutating control verb ended (ms epoch); undefined when none ran. */
  lastChangeAt: number | undefined;
  now: number;
};

export type VortexBusy = {
  /** Nothing running, nothing waiting, and quiet for at least `quietMs`. */
  settled: boolean;
  /** What is still going on, in words. Empty when nothing is. */
  reasons: string[];
  /** Milliseconds since the last mutating verb ended; null when none ran this session. */
  quietForMs: number | null;
  quietMs: number;
};

/** Vortex debounces its health checks after a mod change; this outlasts them. */
export const SETTLE_QUIET_MS = 15_000;

export function vortexBusy(input: BusyInput, quietMs = SETTLE_QUIET_MS): VortexBusy {
  const reasons: string[] = [];
  for (const [group, ids] of Object.entries(input.activity ?? {})) {
    if (Array.isArray(ids) && ids.length > 0) reasons.push(`${group}: ${ids.map(String).join(", ")}`);
  }
  for (const n of input.activityNotices) reasons.push(`notice: ${n}`);
  for (const w of input.waitingFor) reasons.push(`waiting: ${w}`);
  const quietForMs = input.lastChangeAt === undefined ? null : Math.max(0, input.now - input.lastChangeAt);
  const quiet = quietForMs === null || quietForMs >= quietMs;
  if (!quiet) reasons.push(`last change ${Math.round(quietForMs! / 1000)} s ago (wait ${Math.round(quietMs / 1000)} s)`);
  return { settled: reasons.length === 0, reasons, quietForMs, quietMs };
}
