/**
 * ──────────────────────────────────────────────────────────────────────
 * No enabled plugin is left without its masters (owner poll, 2026-10-02).
 *
 * The curator's build refuses a plugin with a missing master, so a collection
 * never ships one. A PLAYER's machine can still end up with one, and the build
 * cannot see it: some installers make patches that depend on what is active
 * at install time. Regional Merchants made "Regional Merchants - COTN
 * Dawnstar.esp" on players who had COTN active, never on the curator's. When
 * Meridia 1.0.25 dropped COTN, that leftover patch stayed enabled with its
 * master gone, and a game with an enabled plugin missing a master does not
 * start.
 *
 * So after an install or update: every enabled plugin whose masters are not
 * all active is found. One that came from THIS collection's mods is disabled
 * (never deleted) and named; the player's own are only reported (NS-2). It
 * repeats until nothing changes, because disabling one patch can orphan
 * another that depended on it.
 *
 * Pure: the caller reads the headers and dispatches the disables.
 * ──────────────────────────────────────────────────────────────────────
 */

export type PluginForMasterCheck = {
  name: string;
  enabled: boolean;
  /** Undefined when the header could not be read: never judged. */
  masters: readonly string[] | undefined;
  /** The game's own plugins are active without being listed as enabled. */
  isNative?: boolean;
  /** This collection installed the mod the plugin came from. */
  fromCollection: boolean;
};

export type OrphanedPlugin = {
  name: string;
  missing: string[];
  /** Disabled by Event Horizon; false = the player's own, reported only. */
  disabled: boolean;
};

export function findOrphanedPlugins(plugins: readonly PluginForMasterCheck[]): OrphanedPlugin[] {
  const lc = (s: string): string => s.toLowerCase();
  const active = new Set(plugins.filter((p) => p.enabled || p.isNative === true).map((p) => lc(p.name)));
  const found = new Map<string, OrphanedPlugin>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of plugins) {
      if (!active.has(lc(p.name)) || p.isNative === true || p.masters === undefined) continue;
      const missing = p.masters.filter((m) => !active.has(lc(m)));
      if (missing.length === 0) continue;
      const prev = found.get(lc(p.name));
      if (prev !== undefined && prev.missing.length === missing.length) continue;
      found.set(lc(p.name), { name: p.name, missing, disabled: p.fromCollection });
      if (p.fromCollection) {
        // Disabled now, so anything that needs IT is checked again.
        active.delete(lc(p.name));
        changed = true;
      }
    }
  }
  return [...found.values()];
}

/** One line per plugin, for the Done screen and the log. */
export function describeOrphanedPlugins(found: readonly OrphanedPlugin[]): string[] {
  return found.map((o) =>
    o.disabled
      ? `${o.name} was switched off: it needs ${o.missing.join(", ")}, which ${o.missing.length === 1 ? "is" : "are"} not active. With it on, the game would not start.`
      : `${o.name} (one of your own mods) needs ${o.missing.join(", ")}, which ${o.missing.length === 1 ? "is" : "are"} not active. The game will not start until you switch it off or add ${o.missing.length === 1 ? "that master" : "those masters"}.`,
  );
}
