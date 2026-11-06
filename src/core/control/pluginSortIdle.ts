/**
 * Vortex's LOOT sort, seen from outside: is one running, and wait until none is.
 *
 * Fallout-collection + Skyrim-collection, 2026-11-06: a Skyrim deploy's
 * autosort started half a second into a switch to the Fallout 4 profile and
 * ran 6 s. By the time it finished Vortex was on fallout4, so the Skyrim sort
 * result was applied to FO4's load order: every FO4 plugin fell to Vortex's
 * fallback order and plugins.txt was rewritten with 619 masters after their
 * dependants. Earlier switches survived only because their sort finished
 * first. A sort marks itself with the activity ("plugins", "sorting") from
 * startActivity in gamebryo-plugin-management.
 */

type ActivityShape = { session?: { base?: { activity?: Record<string, unknown> } } };

/** Whether Vortex shows a plugin sort in progress. */
export function pluginsSorting(state: unknown): boolean {
  const list = (state as ActivityShape)?.session?.base?.activity?.["plugins"];
  return Array.isArray(list) && list.includes("sorting");
}

export type SortIdleResult = { waitedMs: number; sawSort: boolean; timedOut: boolean };

/**
 * Waits until no sort runs AND the load order has not changed for `quietMs`.
 * Both, because a sort can start a moment after the change that triggers it,
 * and its result lands a moment after its activity ends.
 */
export async function waitForPluginSortIdle(
  getState: () => unknown,
  opts: { quietMs: number; capMs: number; stepMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<SortIdleResult> {
  const step = opts.stepMs ?? 250;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const slice = (): unknown => (getState() as { loadOrder?: unknown })?.loadOrder;
  let last = slice();
  let quietFor = 0;
  let sawSort = false;
  let waited = 0;
  while (quietFor < opts.quietMs) {
    if (waited >= opts.capMs) return { waitedMs: waited, sawSort, timedOut: true };
    await sleep(step);
    waited += step;
    const sorting = pluginsSorting(getState());
    if (sorting) sawSort = true;
    const now = slice();
    quietFor = !sorting && now === last ? quietFor + step : 0;
    last = now;
  }
  return { waitedMs: waited, sawSort, timedOut: false };
}

/** Pure: how many of `expected` (in order) appear out of order in `actual`; names compared lowercased. */
export function countOutOfOrder(expected: readonly string[], actual: readonly string[]): number {
  const pos = new Map(actual.map((n, i) => [n.toLowerCase(), i]));
  let last = -1;
  let out = 0;
  for (const n of expected) {
    const p = pos.get(n.toLowerCase());
    if (p === undefined) continue;
    if (p < last) out += 1;
    else last = p;
  }
  return out;
}
