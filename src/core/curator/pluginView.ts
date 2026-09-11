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

import * as path from "path";

import type { PluginCapability, PluginFlags } from "../manifest/pluginCapability";
import type { PluginEntry } from "./pluginPool";
import type { CuratorMod } from "./profileActions";

// ── What each game's plugin system allows ──────────────────────────────
//
// The table lives in manifest/pluginCapability.ts, beside the readers and
// writers that have to agree with it. It was here, and the header reader used
// its own 0x200 for every game — so this view could only mark Starfield's
// light state unknown, while the installer wrote the wrong bit regardless.
export { canWriteLightFlag, pluginCapabilityFor, type PluginCapability } from "../manifest/pluginCapability";

/**
 * The files a light-flag change is written to: the copy Vortex lists and the
 * staging copy, once each.
 *
 * Under hardlink deployment they are one file, and the two paths must then
 * compare equal — a separator doubled by a trailing slash on the staging
 * folder made one file look like two.
 */
export function lightFlagTargets(listedPath: string | undefined, stagingDir: string | undefined, pluginName: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const key = (p: string): string => {
    const n = path.normalize(p);
    return process.platform === "win32" ? n.toLowerCase() : n;
  };
  for (const p of [listedPath, stagingDir === undefined ? undefined : path.join(stagingDir, pluginName)]) {
    if (p === undefined || seen.has(key(p))) continue;
    seen.add(key(p));
    out.push(p);
  }
  return out;
}

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
  /** Starfield's medium (FD-slot) plugins; set only when the header says so. */
  isMedium?: boolean;
  unreadable?: string;
  /** Whether it takes one of the game's regular slots: enabled, neither light nor medium. */
  takesSlot: boolean;
};

export function buildPluginRows(args: {
  plugins: readonly PluginEntry[];
  headers: ReadonlyMap<string, PluginHeader>;
  mods: readonly CuratorMod[];
  isBaseGame: (master: string) => boolean;
  /** The game's plugin rules; undefined when the game is not one Vortex's plugin management knows. */
  capability?: PluginCapability;
}): PluginRow[] {
  const cap = args.capability;
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
    // The .esl EXTENSION forces light + master in a game with light plugins
    // whatever the header says. The header flags arrive decoded for this
    // game (pluginCapability.ts), so Starfield's light is its own 0x100 bit.
    // A game without light (or medium) plugins has none, whatever a bit says.
    const eslExt = /\.esl$/i.test(plugin.name) && cap?.lightPlugins !== false;
    const flags = header?.flags;
    const headerLight = cap?.lightPlugins === false ? (flags === undefined ? undefined : false) : flags?.isLight;
    const isMedium = cap?.mediumPlugins === false ? false : flags?.isMedium;
    const isLight = eslExt ? true : headerLight;
    const isMaster = eslExt ? true : flags?.isMaster;
    const row: PluginRow = {
      plugin,
      masters,
      missing: masters.filter((m) => m.state === "missing").map((m) => m.name),
      disabled: masters.filter((m) => m.state === "disabled").map((m) => m.name),
      // Vortex's own counter: regular is neither light nor medium. A light
      // plugin that is also medium-flagged loads light.
      takesSlot: plugin.enabled && isLight !== true && isMedium !== true,
    };
    if (owner !== undefined) row.owner = owner;
    if (isLight !== undefined) row.isLight = isLight;
    if (isMaster !== undefined) row.isMaster = isMaster;
    if (isMedium === true && isLight !== true) row.isMedium = true;
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
    description: "Enabled plugins that take one of the game's regular slots. Light-flagged plugins share the FE slot and are not counted.",
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
  /** The game's regular-plugin limit; undefined when the game is not one Vortex's plugin management knows. */
  slotLimit?: number;
  /**
   * Whether `slotsUsed` and `light` can be believed: headers read, and a game
   * whose header bits Event Horizon knows.
   */
  lightKnown: boolean;
  light: number;
  /** Medium (FD-slot) plugins — Starfield; 0 elsewhere. */
  medium: number;
  withMissing: number;
  withDisabled: number;
  unreadable: number;
  /** Headers were not read at all (no requirements pass yet). */
  headersRead: boolean;
};

export function summarizePlugins(rows: readonly PluginRow[], headersRead: boolean, capability?: PluginCapability): PluginSummary {
  return {
    total: rows.length,
    enabled: rows.filter((r) => r.plugin.enabled).length,
    slotsUsed: rows.filter((r) => r.takesSlot).length,
    ...(capability === undefined ? {} : { slotLimit: capability.regularSlots }),
    lightKnown: headersRead && capability !== undefined,
    light: rows.filter((r) => r.isLight === true).length,
    medium: rows.filter((r) => r.isMedium === true).length,
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
  if (r.isMedium === true) parts.push("medium");
  return parts.length > 0 ? parts.join(", ") : "regular";
}
