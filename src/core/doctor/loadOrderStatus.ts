/**
 * ──────────────────────────────────────────────────────────────────────
 * Is the curator's load order still what this machine loads?
 *
 * The install answers this once, at the end of the run. Nothing answered it
 * afterwards, and afterwards is when it changes: Vortex's auto-sort runs
 * LOOT on every deploy, a Sort click runs it by hand, a profile switch
 * loads another order entirely. Every file still verifies and the game
 * still starts — it just loads a different order than the curator tested,
 * silently, until the user opens Doctor and happens to read one card.
 *
 * ─── THE HYBRID, STATED ONCE ───────────────────────────────────────────
 * The collection PINS the curator's relative order for the plugins it
 * ships. The user's own plugins are not appended and not overwritten: LOOT
 * places them, and the re-pin keeps every one of those placements while
 * refilling the collection's slots with the curator's sequence (see
 * repinPluginOrder.ts). So "matches" here means the collection's plugins
 * load in the curator's order among themselves; extra plugins are expected
 * and never a fault.
 *
 * Pure. The current order is read from Vortex's plugin state by the caller
 * (or from plugins.txt, which is what the game reads); natives are excluded
 * because Vortex fixes their place and never writes them to loadOrder.
 * ──────────────────────────────────────────────────────────────────────
 */

import { readPluginList } from "../curator/pluginPool";
import { comparePluginOrder, type PluginOrderDrift, type PluginOrderEntry } from "../installer/checkPluginOrder";
import { repinCuratorOrder } from "../installer/repinPluginOrder";

const key = (name: string): string => name.trim().toLowerCase();

export type LoadOrderStatus =
  /** The receipt recorded no order (an old receipt, or a stopped install). */
  | { kind: "no-baseline" }
  /** This game has no plugin list. */
  | { kind: "not-applicable" }
  | { kind: "matches"; owned: number; extra: number }
  | { kind: "drifted"; owned: number; extra: number; drift: PluginOrderDrift };

/**
 * The order Vortex holds right now, natives excluded, as the persistor will
 * write it: by `loadOrder`, entries Vortex has not placed last. Undefined
 * when the plugin extension has listed nothing for this game.
 */
export function currentOrderFromState(state: unknown): PluginOrderEntry[] | undefined {
  const plugins = readPluginList(state);
  if (plugins.length === 0) return undefined;
  return plugins.filter((p) => !p.isNative).map((p) => ({ name: p.name, enabled: p.enabled }));
}

/** Names of the game's own plugins, from the same list. */
export function nativeNamesFromState(state: unknown): Set<string> {
  return new Set(
    readPluginList(state)
      .filter((p) => p.isNative)
      .map((p) => key(p.name)),
  );
}

export function assessLoadOrder(args: {
  baseline: readonly PluginOrderEntry[] | undefined;
  current: readonly PluginOrderEntry[] | undefined;
  /** Lowercased native plugin names; excluded from both sides. */
  natives?: ReadonlySet<string>;
}): LoadOrderStatus {
  const { baseline, current } = args;
  if (baseline === undefined || baseline.length === 0) return { kind: "no-baseline" };
  if (current === undefined) return { kind: "not-applicable" };
  const natives = args.natives ?? new Set<string>();
  const curator = baseline.filter((p) => !natives.has(key(p.name)));
  const user = current.filter((p) => !natives.has(key(p.name)));
  const drift = comparePluginOrder(curator, user);
  const owned = drift.compared;
  const extra = drift.extra.length;
  if (drift.misordered.length === 0 && drift.missing.length === 0) return { kind: "matches", owned, extra };
  return { kind: "drifted", owned, extra, drift };
}

/**
 * A stable fingerprint of a drift, so a watcher notifies on a CHANGE of
 * drift and not on every state tick while the same drift persists. Empty
 * when nothing is wrong.
 */
export function driftSignature(status: LoadOrderStatus): string {
  if (status.kind !== "drifted") return "";
  const m = status.drift.misordered.map((x) => key(x.name)).sort();
  const g = status.drift.missing.map(key).sort();
  return `m:${m.join("|")};g:${g.join("|")}`;
}

/** One headline and the lines under it, for a card or a notification. */
export function describeLoadOrder(status: LoadOrderStatus): {
  tone: "success" | "warning" | "danger" | "neutral";
  headline: string;
  detail: string[];
} {
  switch (status.kind) {
    case "no-baseline":
      return {
        tone: "neutral",
        headline: "This install recorded no plugin order, so there is nothing to compare against.",
        detail: [],
      };
    case "not-applicable":
      return { tone: "neutral", headline: "This game has no plugin list to order.", detail: [] };
    case "matches":
      return {
        tone: "success",
        headline: `Matches the curator: ${status.owned.toLocaleString()} collection plugin(s) load in their order`,
        detail:
          status.extra > 0
            ? [`${status.extra.toLocaleString()} plugin(s) of your own sit between them where LOOT placed them.`]
            : [],
      };
    case "drifted": {
      const d = status.drift;
      const detail: string[] = [];
      for (const m of d.misordered.slice(0, 6)) detail.push(`"${m.name}" should load after "${m.expectedAfter}"`);
      if (d.misordered.length > 6) detail.push(`and ${d.misordered.length - 6} more out of place.`);
      if (d.missing.length > 0) {
        detail.push(
          `Not present or not enabled here: ${d.missing.slice(0, 5).join(", ")}` +
            (d.missing.length > 5 ? ` and ${d.missing.length - 5} more` : "") +
            `.`,
        );
      }
      const moved = d.misordered.length;
      return {
        tone: moved > 0 ? "danger" : "warning",
        headline:
          moved > 0
            ? `${moved.toLocaleString()} of ${status.owned.toLocaleString()} collection plugins no longer load in the curator's order`
            : `${d.missing.length.toLocaleString()} plugin(s) the curator enabled are not enabled here`,
        detail,
      };
    }
    default: {
      const exhaustive: never = status;
      void exhaustive;
      return { tone: "neutral", headline: "", detail: [] };
    }
  }
}

/**
 * What re-applying would do to the CURRENT order, before it does it: which
 * plugins move, and where. The same merge the re-apply runs, so the
 * preview cannot disagree with the act.
 */
export function previewRepin(
  baseline: readonly PluginOrderEntry[],
  current: readonly PluginOrderEntry[],
): { moves: Array<{ name: string; from: number; to: number }>; total: number } {
  const curatorNames = baseline.filter((p) => p.enabled).map((p) => p.name);
  const currentNames = current.map((p) => p.name);
  const merged = repinCuratorOrder(curatorNames, currentNames);
  const before = new Map(currentNames.map((n, i) => [key(n), i]));
  const moves: Array<{ name: string; from: number; to: number }> = [];
  merged.forEach((name, to) => {
    const from = before.get(key(name));
    if (from !== undefined && from !== to) moves.push({ name, from, to });
  });
  return { moves, total: merged.length };
}
