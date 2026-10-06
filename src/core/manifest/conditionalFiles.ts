/**
 * Files a FOMOD installer creates only when certain plugins are present.
 *
 * `conditionalFileInstalls` can hang a file on plugin files: Reapers' RobCo
 * Munitions patches install a 5.45mm leveled-list file only when one of 26
 * 5.45mm weapon plugins is active. Ivy 1.0.36 ships none of them, so a correct
 * install never creates that file, but the curator's staging had it from an
 * older install. The player's check then reported the mod "could not be
 * reproduced" (alasdairn, 2026-09-28).
 *
 * Owner poll, 2026-09-28: warn the curator at build time, explain it to the
 * player, and keep the file in the record (nothing is silently dropped).
 */

import type { FomodCondition } from "./fomodReplay";

/** A plugin's state as FOMOD asks it: active, installed but off, or not there. */
export type PluginState = "Active" | "Inactive" | "Missing";

/** Whether a condition holds for these flags and plugins. */
export function evaluateCondition(
  c: FomodCondition,
  flags: Readonly<Record<string, string>>,
  pluginState: (file: string) => PluginState,
): boolean {
  switch (c.kind) {
    case "file":
      return pluginState(c.file).toLowerCase() === c.state.trim().toLowerCase();
    case "flag":
      return (flags[c.flag] ?? "").trim().toLowerCase() === c.value.trim().toLowerCase();
    case "all":
      return c.terms.every((t) => evaluateCondition(t, flags, pluginState));
    case "any":
      return c.terms.some((t) => evaluateCondition(t, flags, pluginState));
  }
}

/** The plugins a condition wants active, for the sentence a person reads. */
export function pluginsWanted(c: FomodCondition): string[] {
  const out = new Set<string>();
  const walk = (x: FomodCondition): void => {
    if (x.kind === "file" && x.state.trim().toLowerCase() === "active") out.add(x.file);
    if (x.kind === "all" || x.kind === "any") x.terms.forEach(walk);
  };
  walk(c);
  return [...out].sort();
}

/**
 * The file's recorded condition, checked against the player's plugins:
 * true when NONE of the plugins it needs is active, so the installer could not
 * have created it. `needs` is the curator-side list (any one of them, since the
 * patterns that caused this are Or lists).
 */
export function installerConditionUnmet(
  needs: readonly string[],
  isActive: (plugin: string) => boolean,
  /** Every plugin must be active (an And pattern), not any one. */
  all?: boolean,
): boolean {
  if (needs.length === 0) return false;
  return all === true
    ? !needs.every((p) => isActive(p.toLowerCase()))
    : !needs.some((p) => isActive(p.toLowerCase()));
}

/** Whether a condition is an And over two or more plugins, which `all` records. */
export function conditionNeedsAll(c: FomodCondition): boolean {
  return c.kind === "all" && c.terms.filter((t) => t.kind === "file").length >= 2;
}

/** The plugins Vortex has enabled, from its `loadOrder` state, lowercased. */
export function activePluginsFromState(state: unknown): (plugin: string) => boolean {
  const order = (state as { loadOrder?: Record<string, { enabled?: boolean }> } | undefined)?.loadOrder ?? {};
  const on = new Set(
    Object.entries(order)
      .filter(([, v]) => v?.enabled === true)
      .map(([k]) => k.toLowerCase()),
  );
  return (plugin) => on.has(plugin.toLowerCase());
}

type ConditionMod = {
  source?: unknown;
  state: {
    mirrored?: boolean;
    optional?: true;
    stagingFiles?: ReadonlyArray<{ path: string; installerCondition?: { needs: string[]; all?: true } }>;
  };
};

/** Every plugin Vortex knows here, enabled or not, lowercased. */
export function knownPluginsFromState(state: unknown): (plugin: string) => boolean {
  const order = (state as { loadOrder?: Record<string, unknown> } | undefined)?.loadOrder ?? {};
  const known = new Set(Object.keys(order).map((k) => k.toLowerCase()));
  return (plugin) => known.has(plugin.toLowerCase());
}

/**
 * Plugins the collection lists that this player's installers correctly did
 * not create: the plugin file carries a condition none of whose plugins is
 * active here. Bundled and mirrored mods carry the curator's files, so their
 * plugins are always there and never listed. Lowercased names.
 */
export function pluginsGatedOff(
  mods: readonly ConditionMod[],
  isActive: (plugin: string) => boolean,
  /**
   * Plugins Vortex knows here at all. With it, an OPTIONAL mod's plugin that
   * is not here (unticked, not downloadable, or left out by its installer) is
   * off too: a normal optional outcome (owner, 2026-10-05).
   */
  isKnown?: (plugin: string) => boolean,
): Set<string> {
  const out = new Set<string>();
  for (const m of mods) {
    // A mirrored mod carries the curator's files. A BUNDLED one no longer
    // does for condition-gated files: the install drops the ones this
    // player's conditions rule out (2026-10-06).
    const carriesCuratorFiles = m.state.mirrored === true;
    for (const f of m.state.stagingFiles ?? []) {
      if (!/\.(esp|esm|esl)$/i.test(f.path)) continue;
      const name = f.path.split(/[\\/]/).pop()!.toLowerCase();
      if (m.state.optional === true && isKnown !== undefined && !isKnown(name)) {
        out.add(name);
        continue;
      }
      if (carriesCuratorFiles || f.installerCondition === undefined) continue;
      if (!installerConditionUnmet(f.installerCondition.needs, isActive, f.installerCondition.all === true)) continue;
      out.add(name);
    }
  }
  return out;
}

/**
 * The curator's order with those plugins switched off, for comparing against
 * the player's: a patch that is correctly absent is not a plugin "the curator
 * has that is not present". Positions are kept, so a re-pin still has them.
 */
export function withGatedPluginsOff<T extends { name: string; enabled: boolean }>(
  order: readonly T[],
  gated: ReadonlySet<string>,
): T[] {
  if (gated.size === 0) return [...order];
  return order.map((p) => (p.enabled && gated.has(p.name.toLowerCase()) ? { ...p, enabled: false } : p));
}

/**
 * Will this plugin be active once the collection is installed? The
 * collection's own answer, not Vortex's live list (which, mid-install, has
 * not enabled plugins of mods installed later yet): the curator had it
 * enabled, and either a collection mod this run installs ships it, or the
 * player has the file (a Creation they own, switched on before the mods).
 */
export function pluginWillBeActive(args: {
  order: ReadonlyArray<{ name: string; enabled: boolean }>;
  mods: ReadonlyArray<{ compareKey: string; state: { stagingFiles?: ReadonlyArray<{ path: string }> } }>;
  /** compareKeys this run does not install (unticked or failed optional mods); read on every call. */
  notInstalled: () => ReadonlySet<string>;
  inData: (plugin: string) => boolean;
}): (plugin: string) => boolean {
  const enabled = new Set(args.order.filter((p) => p.enabled).map((p) => p.name.toLowerCase()));
  const providers = new Map<string, string[]>();
  for (const m of args.mods) {
    for (const f of m.state.stagingFiles ?? []) {
      if (!/\.(esp|esm|esl)$/i.test(f.path)) continue;
      const name = f.path.split(/[\\/]/).pop()!.toLowerCase();
      providers.set(name, [...(providers.get(name) ?? []), m.compareKey]);
    }
  }
  return (plugin) => {
    const key = plugin.toLowerCase();
    if (!enabled.has(key)) return false;
    const by = providers.get(key);
    if (by !== undefined) {
      const out = args.notInstalled();
      return by.some((k) => !out.has(k));
    }
    return args.inData(key);
  };
}

/** "needs A.esp" / "needs one of A.esp, B.esp and 24 more". */
export function describeNeeds(needs: readonly string[]): string {
  if (needs.length === 1) return `needs ${needs[0]}`;
  const shown = needs.slice(0, 3).join(", ");
  return needs.length > 3 ? `needs one of ${shown} and ${needs.length - 3} more` : `needs one of ${shown}`;
}
