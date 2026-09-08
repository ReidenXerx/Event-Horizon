/**
 * Can this collection's plugins actually load?
 *
 * ─── WHAT IT ANSWERS ────────────────────────────────────────────────────────
 * A Bethesda plugin declares the masters it is built against, and the game
 * refuses to load one whose masters are absent. Vortex checks this on the
 * user's machine and shows "Some of the enabled plugins depend on others that
 * are not enabled" — which is the first the curator hears about it, secondhand,
 * from a tester whose game will not start.
 *
 * Measured on the real 1,755-mod manifest that produced that report:
 * `RaceCompatibility.esm` is provided by zero mods, appears nowhere in the
 * 1,607-entry plugin order, and two plugins requiring it ship enabled. The
 * package was internally inconsistent from the moment it was built.
 *
 * ─── WHY IT REFUSES RATHER THAN WARNS ───────────────────────────────────────
 * The curator is the only person who can fix it, and a warning in a long build
 * log is how this shipped in the first place. A package whose own plugins
 * cannot load is not a package.
 *
 * ─── WHAT IT DELIBERATELY DOES NOT REFUSE ───────────────────────────────────
 * Creation Club content is bought per account. A collection depending on one
 * is a genuine prerequisite the USER must own, and there is nothing the
 * curator can do about it — so it is reported separately and never blocks.
 */

import {
  isBaseGameMaster,
  isUserOwnedMaster,
} from "./pluginMasters";

/** One plugin and the masters it declares. */
export type PluginWithMasters = {
  /** Plugin filename, as it appears in the load order. */
  name: string;
  enabled: boolean;
  /** Masters this plugin declares, or `undefined` when it could not be read. */
  masters: readonly string[] | undefined;
};

export type MasterProblem = {
  /** The plugin that cannot load. */
  plugin: string;
  /** The master it needs and the collection does not have. */
  master: string;
};

export type MasterCheck = {
  /**
   * Plugins whose masters the collection does not ship. Each entry is one
   * (plugin, master) pair — a plugin missing two masters appears twice, so the
   * message can name every one rather than only the first.
   */
  missing: MasterProblem[];
  /**
   * Masters the USER must own: Creation Club content. Reported, never fatal.
   */
  userOwned: MasterProblem[];
  /**
   * Plugins whose header could not be read, so their masters are UNKNOWN.
   *
   * Not "no masters". A locked or unreadable plugin is a gap in the check,
   * and reporting it as a pass would be the check quietly not running.
   */
  unreadable: string[];
  /** Enabled plugins actually examined. */
  checked: number;
};

/**
 * Compare every enabled plugin's masters against what the collection ships.
 *
 * Pure: the caller reads the headers and the plugin list. Comparison is
 * case-insensitive because plugin names are, on every platform this runs on —
 * the engine itself does not distinguish them.
 */
export function checkMasters(
  plugins: readonly PluginWithMasters[],
  gameId: string,
): MasterCheck {
  const enabled = plugins.filter((p) => p.enabled);
  /**
   * Present means present in the collection's plugin list AND enabled.
   *
   * A master that ships but is switched off is exactly as absent as one that
   * does not ship at all — which is precisely what Vortex's dialog says.
   */
  const available = new Set(
    enabled.map((p) => p.name.trim().toLowerCase()),
  );

  const missing: MasterProblem[] = [];
  const userOwned: MasterProblem[] = [];
  const unreadable: string[] = [];

  for (const plugin of enabled) {
    if (plugin.masters === undefined) {
      unreadable.push(plugin.name);
      continue;
    }
    for (const master of plugin.masters) {
      const key = master.trim().toLowerCase();
      if (key.length === 0) continue;

      /**
       * ─── CLASSIFY BEFORE ASKING WHETHER WE SHIP IT ────────────────────
       * `available.has(key)` used to come FIRST, which quietly absorbed a
       * whole class of prerequisite: a Creation Club master the CURATOR
       * happens to own and have enabled is present in their plugin list, so
       * the check found it and said nothing — and the installing user, who
       * has not bought that Creation Club content, gets a game that will not
       * load and a collection that reported itself healthy.
       *
       * The question "does the collection ship this" and the question "can
       * the user be expected to have this" are different, and the second one
       * has to be answered first. Base-game masters are the exception that
       * proves it: every user has them, so they need no report either way.
       */
      if (isBaseGameMaster(master, gameId)) continue;
      if (isUserOwnedMaster(master, gameId)) {
        userOwned.push({ plugin: plugin.name, master });
        continue;
      }

      // Shipped and enabled by this collection: nothing to say.
      if (available.has(key)) continue;

      missing.push({ plugin: plugin.name, master });
    }
  }

  return { missing, userOwned, unreadable, checked: enabled.length };
}

/**
 * The refusal a curator reads.
 *
 * Grouped by MASTER rather than by plugin: one absent master usually breaks
 * several plugins, and "these six plugins all need RaceCompatibility.esm" is
 * one thing to fix where six separate lines look like six problems.
 */
export function describeMissingMasters(check: MasterCheck): string {
  const byMaster = new Map<string, string[]>();
  for (const { plugin, master } of check.missing) {
    const list = byMaster.get(master) ?? [];
    list.push(plugin);
    byMaster.set(master, list);
  }

  const lines: string[] = [
    `${byMaster.size} master file(s) this collection's plugins need are not ` +
      `in the collection. The game will refuse to load the plugins that ` +
      `depend on them, so this would not work on anyone's machine:`,
  ];
  for (const [master, plugins] of byMaster) {
    const shown = plugins.slice(0, 4).join(", ");
    const more = plugins.length > 4 ? `, and ${plugins.length - 4} more` : "";
    lines.push(`  • ${master} — needed by ${shown}${more}`);
  }
  lines.push(
    `Either add the mod that provides each master to this profile, or turn ` +
      `off the plugins that depend on it. It most likely works on your machine ` +
      `because you have the master installed outside this collection.`,
  );
  return lines.join("\n");
}

/** The non-fatal note about content the user has to own themselves. */
export function describeUserOwnedMasters(check: MasterCheck): string[] {
  if (check.userOwned.length === 0) return [];
  const masters = [...new Set(check.userOwned.map((p) => p.master))];
  return [
    `This collection depends on ${masters.length} Creation Club file(s) that ` +
      `cannot be shipped: ${masters.slice(0, 6).join(", ")}` +
      `${masters.length > 6 ? `, and ${masters.length - 6} more` : ""}. ` +
      `Anyone installing it needs to own them.`,
  ];
}
