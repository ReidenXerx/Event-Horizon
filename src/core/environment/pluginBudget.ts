/**
 * ──────────────────────────────────────────────────────────────────────
 * Will the player's setup fit the game's regular-plugin limit?
 *
 * A collection is built to fit on the CURATOR's setup. The player's own full
 * plugins sit on top of it: the game's masters, Creations that ship full
 * (seven of Fallout 4's Anniversary Creations are full .esm files and load
 * from Fallout4.ccc, not from Vortex's list), and their own mods. Ivy uses 224
 * regular slots of its own; with the seven Creations a player had a handful
 * left, went over, and the install ran to 100% before anything said so
 * (sunnyd0539, 11-09). Asked before install, with the player's own full
 * plugins named, because those are the ones they can switch off.
 * ──────────────────────────────────────────────────────────────────────
 */

export type BudgetPlugin = {
  name: string;
  enabled: boolean;
  /** Shipped by the game (masters, Creations listed in the .ccc). */
  isNative: boolean;
  /** Read from the file's header; undefined when it could not be read. */
  isLight: boolean | undefined;
};

export type PluginBudget = {
  limit: number;
  /** Regular plugins the collection switches on. */
  collection: number;
  /** The game's own regular plugins outside the collection. */
  native: string[];
  /** The player's own enabled regular plugins outside the collection. */
  own: string[];
  /** Enabled plugins outside the collection whose header could not be read. */
  unknown: number;
  total: number;
  /** How many over the limit; 0 when it fits. */
  over: number;
};

const isEsl = (name: string): boolean => name.toLowerCase().endsWith(".esl");

export function computePluginBudget(args: {
  collectionOrder: ReadonlyArray<{ name: string; enabled?: boolean; light?: boolean }>;
  players: readonly BudgetPlugin[];
  limit: number;
}): PluginBudget {
  const inCollection = new Set(args.collectionOrder.map((p) => p.name.toLowerCase()));
  const collection = args.collectionOrder.filter(
    (p) => p.enabled !== false && p.light !== true && !isEsl(p.name),
  ).length;
  const native: string[] = [];
  const own: string[] = [];
  let unknown = 0;
  for (const p of args.players) {
    if (!p.enabled || inCollection.has(p.name.toLowerCase()) || isEsl(p.name)) continue;
    if (p.isLight === undefined) {
      unknown += 1;
      continue;
    }
    if (p.isLight) continue;
    (p.isNative ? native : own).push(p.name);
  }
  own.sort((a, b) => a.localeCompare(b));
  const total = collection + native.length + own.length;
  return { limit: args.limit, collection, native, own, unknown, total, over: Math.max(0, total - args.limit) };
}

/**
 * The budget for the active profile, reading each enabled plugin outside the
 * collection from the game's Data folder (the copy the game loads). Undefined
 * for a game Event Horizon has no plugin rules for.
 */
export async function measurePluginBudget(args: {
  state: unknown;
  gameId: string;
  dataDir: string;
  collectionOrder: ReadonlyArray<{ name: string; enabled?: boolean; light?: boolean }>;
  /** A fresh profile starts with the game's own plugins only. */
  freshProfile: boolean;
}): Promise<PluginBudget | undefined> {
  const [{ readPluginList }, { pluginCapabilityFor }, { readPluginFlagsDetailed }, path] = await Promise.all([
    import("../curator/pluginPool"),
    import("../manifest/pluginCapability"),
    import("../manifest/pluginFlags"),
    import("path"),
  ]);
  const capability = pluginCapabilityFor(args.gameId);
  if (capability === undefined) return undefined;
  const inCollection = new Set(args.collectionOrder.map((p) => p.name.toLowerCase()));
  const players: BudgetPlugin[] = [];
  for (const p of readPluginList(args.state)) {
    if (!p.enabled || inCollection.has(p.name.toLowerCase())) continue;
    if (args.freshProfile && !p.isNative) continue;
    const read = await readPluginFlagsDetailed(path.join(args.dataDir, p.name), capability);
    players.push({
      name: p.name,
      enabled: true,
      isNative: p.isNative,
      isLight: read.kind === "ok" ? read.flags.isLight || read.flags.isMedium : undefined,
    });
  }
  return computePluginBudget({ collectionOrder: args.collectionOrder, players, limit: capability.regularSlots });
}

/**
 * The collection's plugin order without the plugins only left-out optional
 * mods or versions provide (versions share plugins: a name a kept mod also
 * ships stays).
 */
export function orderWithoutLeftOut<T extends { name: string }>(
  order: readonly T[],
  mods: ReadonlyArray<{ compareKey: string; state?: { stagingFiles?: ReadonlyArray<{ path: string }> } }>,
  leftOut: ReadonlySet<string>,
): T[] {
  if (leftOut.size === 0) return [...order];
  const pluginsOf = (m: (typeof mods)[number]): string[] =>
    (m.state?.stagingFiles ?? [])
      .map((f) => f.path.split(/[\\/]/).pop()!.toLowerCase())
      .filter((n) => /\.(esp|esm|esl)$/.test(n));
  const kept = new Set(mods.filter((m) => !leftOut.has(m.compareKey)).flatMap(pluginsOf));
  const gone = new Set(mods.filter((m) => leftOut.has(m.compareKey)).flatMap(pluginsOf).filter((n) => !kept.has(n)));
  return order.filter((p) => !gone.has(p.name.toLowerCase()));
}

/** The question shown before install when the setup does not fit. */
export function describePluginBudget(
  budget: PluginBudget,
  names: { game: string; collection: string },
): { title: string; text: string; message: string } {
  const shown = budget.own.slice(0, 40);
  return {
    title: `This would go over ${names.game}'s plugin limit`,
    text:
      `${names.game} loads at most ${budget.limit} full (non-light) plugins. ${names.collection} switches on ` +
      `${budget.collection}, the game and its Creations bring ${budget.native.length}, and ${budget.own.length} ` +
      `are your own: ${budget.total}, ${budget.over} over. Untick at least ${budget.over} of your own full plugins ` +
      `in Vortex → Plugins (untick, no need to uninstall), then click Install again. Installing anyway leaves the ` +
      `last plugins unable to load.`,
    message: [
      "Your own full plugins:",
      ...shown.map((n) => `  ${n}`),
      ...(budget.own.length > shown.length ? [`  … and ${budget.own.length - shown.length} more`] : []),
      ...(budget.native.length > 0 ? ["", `From the game and its Creations (these always load): ${budget.native.join(", ")}`] : []),
    ].join("\n"),
  };
}
