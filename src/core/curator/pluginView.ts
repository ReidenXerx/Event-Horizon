/**
 * The Plugins view's model: every plugin Vortex lists, with who ships it,
 * what it declares as masters, whether those masters are present and
 * enabled, and what its header flags say.
 *
 * Vortex's own Plugins tab shows a load order and a "missing masters"
 * warning per row. What it does not show, and what a curator has to know:
 * how many REGULAR slots are used (the 254 limit that decides whether the
 * game starts — see pluginFlags.ts), which mod each plugin belongs to, and
 * whether a master is missing or merely disabled — different fixes.
 *
 * Pure. The headers are read elsewhere and handed in; a header that could
 * not be read is a fact of its own, never an empty list (GP-4 / the
 * pluginMasters.ts rule).
 */

import { REGULAR_PLUGIN_LIMIT, type PluginFlags } from "../manifest/pluginFlags";
import type { PluginEntry } from "./pluginPool";
import type { CuratorMod } from "./profileActions";

/** What was read from one plugin file's header. */
export type PluginHeader = {
  masters?: readonly string[];
  flags?: PluginFlags;
  /** Why the header could not be read, when it could not. */
  unreadable?: string;
};

export type MasterState = "ok" | "disabled" | "missing";

export type PluginRow = {
  plugin: PluginEntry;
  owner?: CuratorMod;
  /** Declared masters, in header order, each with its state. */
  masters: Array<{ name: string; state: MasterState; baseGame: boolean }>;
  missing: string[];
  disabled: string[];
  /** From the header flags; undefined when the header was not read. */
  isLight?: boolean;
  isMaster?: boolean;
  unreadable?: string;
  /** Whether it takes one of the 254 regular slots: enabled and not light. */
  takesSlot: boolean;
};

export function buildPluginRows(args: {
  plugins: readonly PluginEntry[];
  headers: ReadonlyMap<string, PluginHeader>;
  mods: readonly CuratorMod[];
  isBaseGame: (master: string) => boolean;
}): PluginRow[] {
  const modById = new Map(args.mods.map((m) => [m.id, m]));
  const byLower = new Map<string, PluginEntry>();
  for (const p of args.plugins) byLower.set(p.name.toLowerCase(), p);
  const headerByLower = new Map<string, PluginHeader>();
  for (const [name, h] of args.headers) headerByLower.set(name.toLowerCase(), h);

  return args.plugins.map((plugin) => {
    const header = headerByLower.get(plugin.name.toLowerCase());
    const masters = (header?.masters ?? []).map((name) => {
      const baseGame = args.isBaseGame(name);
      const provider = byLower.get(name.toLowerCase());
      const state: MasterState =
        provider === undefined
          ? baseGame
            ? "ok"
            : "missing"
          : provider.enabled
            ? "ok"
            : "disabled";
      return { name, state, baseGame };
    });
    const owner = plugin.modId === undefined ? undefined : modById.get(plugin.modId);
    // The .esl EXTENSION forces light + master in SSE/FO4 whatever the header
    // says; the flag alone is what pluginFlags reads.
    const eslExt = /\.esl$/i.test(plugin.name);
    const isLight = eslExt ? true : header?.flags?.isLight;
    const isMaster = eslExt ? true : header?.flags?.isMaster;
    const row: PluginRow = {
      plugin,
      masters,
      missing: masters.filter((m) => m.state === "missing").map((m) => m.name),
      disabled: masters.filter((m) => m.state === "disabled").map((m) => m.name),
      takesSlot: plugin.enabled && isLight !== true,
    };
    if (owner !== undefined) row.owner = owner;
    if (isLight !== undefined) row.isLight = isLight;
    if (isMaster !== undefined) row.isMaster = isMaster;
    if (header?.unreadable !== undefined) row.unreadable = header.unreadable;
    return row;
  });
}

export type PluginViewId = "all" | "problems" | "regular" | "light" | "disabled";

export const PLUGIN_VIEWS: ReadonlyArray<{ id: PluginViewId; label: string; description: string }> = [
  { id: "all", label: "All plugins", description: "Every plugin Vortex lists for this game, in load order." },
  {
    id: "problems",
    label: "Master problems",
    description:
      "Plugins whose header names a master that is not in the list, or is there but disabled. The game refuses to start on a missing master; a disabled one is a click away.",
  },
  {
    id: "regular",
    label: "Regular slots",
    description: `Enabled plugins that take one of the ${REGULAR_PLUGIN_LIMIT} regular slots. Light-flagged plugins share the FE slot and are not counted.`,
  },
  { id: "light", label: "Light", description: "Plugins with the ESL flag set in their header, or an .esl extension." },
  { id: "disabled", label: "Disabled", description: "Listed but not enabled in the active profile's load order." },
];

export function pluginRowsForView(rows: readonly PluginRow[], view: PluginViewId): PluginRow[] {
  switch (view) {
    case "all":
      return [...rows];
    case "problems":
      return rows.filter((r) => r.missing.length > 0 || r.disabled.length > 0);
    case "regular":
      return rows.filter((r) => r.takesSlot);
    case "light":
      return rows.filter((r) => r.isLight === true);
    case "disabled":
      return rows.filter((r) => !r.plugin.enabled);
    default: {
      const exhaustive: never = view;
      void exhaustive;
      return [...rows];
    }
  }
}

export function pluginViewCounts(rows: readonly PluginRow[]): Record<PluginViewId, number> {
  const out = {} as Record<PluginViewId, number>;
  for (const v of PLUGIN_VIEWS) out[v.id] = pluginRowsForView(rows, v.id).length;
  return out;
}

export type PluginSummary = {
  total: number;
  enabled: number;
  /** Enabled, regular (non-light) plugins: the number that must stay under the limit. */
  slotsUsed: number;
  slotLimit: number;
  light: number;
  withMissing: number;
  withDisabled: number;
  unreadable: number;
  /** Headers were not read at all (no requirements pass yet). */
  headersRead: boolean;
};

export function summarizePlugins(rows: readonly PluginRow[], headersRead: boolean): PluginSummary {
  return {
    total: rows.length,
    enabled: rows.filter((r) => r.plugin.enabled).length,
    slotsUsed: rows.filter((r) => r.takesSlot).length,
    slotLimit: REGULAR_PLUGIN_LIMIT,
    light: rows.filter((r) => r.isLight === true).length,
    withMissing: rows.filter((r) => r.missing.length > 0).length,
    withDisabled: rows.filter((r) => r.disabled.length > 0).length,
    unreadable: rows.filter((r) => r.unreadable !== undefined).length,
    headersRead,
  };
}

/** The masters cell: "3 ok" | "1 missing · 1 disabled" | "unreadable" | "—". */
export function describeMastersCell(r: PluginRow): string {
  if (r.unreadable !== undefined) return "unreadable";
  if (r.masters.length === 0) return "";
  const parts: string[] = [];
  if (r.missing.length > 0) parts.push(`${r.missing.length} missing`);
  if (r.disabled.length > 0) parts.push(`${r.disabled.length} disabled`);
  return parts.length > 0 ? parts.join(" · ") : `${r.masters.length} ok`;
}

/** The kind cell: what the header says the plugin is. */
export function describePluginKind(r: PluginRow): string {
  if (r.plugin.isNative) return "base game";
  if (r.isLight === undefined && r.isMaster === undefined) return "";
  const parts: string[] = [];
  if (r.isMaster === true) parts.push("master");
  if (r.isLight === true) parts.push("light");
  return parts.length > 0 ? parts.join(", ") : "regular";
}
