/**
 * The plugins Vortex knows about for the active game, with who ships each.
 *
 * Vortex's plugin management (a bundled extension, so nothing here is
 * typed by `@nexusmods/vortex-api`) keeps two pieces of state:
 *
 *   `session.plugins.pluginList[name]` — every plugin file it found, with
 *       the Vortex mod that deploys it (`modId`), where the file lives
 *       (`filePath`, the STAGING copy) and whether the game itself ships it
 *       (`isNative`).
 *   `loadOrder[name]` — `{ enabled, loadOrder }` for the active profile.
 *
 * Both are read defensively: the shapes were confirmed against the
 * deployed app.asar, not a typings file, and an entry missing a field is
 * reported as such rather than dropped.
 */

export type PluginEntry = {
  /**
   * File name as the game sees it. Vortex keys `pluginList` by the
   * LOWERCASED name; the original case survives only in `loadOrder[id].name`,
   * so that is used when present.
   */
  name: string;
  /** Vortex mod id that deploys it; absent for a base-game or loose plugin. */
  modId?: string;
  /**
   * Where Vortex found the file. For a deployed plugin this is the copy in
   * the game's Data folder (same bytes under hardlink deployment); staging
   * only after a purge.
   */
  filePath?: string;
  /** The game's own plugin (Skyrim.esm …). */
  isNative: boolean;
  /**
   * Enabled as the game will see it. Vortex's rule (its own `isPluginEnabled`):
   * a native plugin is always enabled and is never written to `loadOrder`; any
   * other plugin is enabled only when `loadOrder` says so — absent means off.
   */
  enabled: boolean;
  /** Position in the load order, when Vortex has one. */
  loadOrder?: number;
  /** The plugin came from a DISABLED mod's staging folder, not from Vortex's list. */
  fromDisabledMod?: boolean;
};

type VortexShape = {
  session?: { plugins?: { pluginList?: Record<string, unknown> } };
  loadOrder?: Record<string, { enabled?: unknown; loadOrder?: unknown; name?: unknown }>;
};

export function readPluginList(state: unknown): PluginEntry[] {
  const s = state as VortexShape;
  const list = s?.session?.plugins?.pluginList;
  if (list === undefined || typeof list !== "object") return [];
  const order = s?.loadOrder ?? {};
  const orderByLower = new Map<string, { enabled?: unknown; loadOrder?: unknown; name?: unknown }>();
  for (const [k, v] of Object.entries(order)) orderByLower.set(k.toLowerCase(), v);

  const out: PluginEntry[] = [];
  for (const [key, raw] of Object.entries(list)) {
    const e = raw as { modId?: unknown; filePath?: unknown; isNative?: unknown } | undefined;
    const lo = orderByLower.get(key.toLowerCase());
    const isNative = e?.isNative === true;
    const entry: PluginEntry = {
      name: typeof lo?.name === "string" && lo.name !== "" ? lo.name : key,
      isNative,
      enabled: isNative || lo?.enabled === true,
    };
    if (typeof e?.modId === "string" && e.modId !== "") entry.modId = e.modId;
    if (typeof e?.filePath === "string" && e.filePath !== "") entry.filePath = e.filePath;
    if (typeof lo?.loadOrder === "number") entry.loadOrder = lo.loadOrder;
    out.push(entry);
  }
  return out.sort((a, b) => {
    const ao = a.loadOrder ?? Number.MAX_SAFE_INTEGER;
    const bo = b.loadOrder ?? Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    return a.name.localeCompare(b.name);
  });
}

/** The owners map the requirements engine wants: plugin → mod, and whether the game ships it. */
export function pluginOwners(
  plugins: readonly PluginEntry[],
): Array<{ plugin: string; modId?: string; native?: boolean }> {
  return plugins.map((p) => ({
    plugin: p.name,
    ...(p.modId === undefined ? {} : { modId: p.modId }),
    ...(p.isNative ? { native: true } : {}),
  }));
}
