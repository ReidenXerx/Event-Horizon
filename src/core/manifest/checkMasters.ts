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
  /**
   * Plugin filenames the PACKAGE ships, lowercased — from every mod's
   * `stagingFiles`. See the note below for why this is not optional in
   * spirit, only in signature.
   */
  providedByPackage?: ReadonlySet<string>,
): MasterCheck {
  const enabled = plugins.filter((p) => p.enabled);
  /**
   * Present means present in the collection's plugin list AND enabled.
   *
   * A master that ships but is switched off is exactly as absent as one that
   * does not ship at all — which is precisely what Vortex's dialog says.
   *
   * ─── AND "IN THE COLLECTION'S PLUGIN LIST" IS NOT WHAT IT WAS READING ──
   * The caller passes the CURATOR'S WHOLE PROFILE — `parsePluginsTxt` over
   * plugins.txt — so a master that is deployed and enabled on their machine
   * satisfied this check whether or not any mod in the collection ships it.
   * The gate's whole purpose is to catch "it works here because you have the
   * master installed outside this collection", and that is the one case it
   * could not see. Its own closing sentence already says so.
   *
   * This is not hypothetical: Meridia 1.0.23 ships a load order naming
   * `synthesis.esp`, `dynamiccontainerloot.esp` and
   * `meridia_addn_index_fixes.esp`, provided by zero mods — the curator's own
   * output, distributed by hand. Any shipped plugin mastered on one of those
   * is a game that refuses to load, and this gate reported 0 missing.
   *
   * So the intersection: enabled in the order AND actually shipped. The
   * parameter is optional only so the older caller keeps compiling; every
   * caller that can answer must, and a caller that cannot is answering the
   * weaker question knowingly.
   */
  const enabledNames = enabled.map((p) => p.name.trim().toLowerCase());
  const available = new Set(
    providedByPackage === undefined
      ? enabledNames
      : enabledNames.filter((n) => providedByPackage.has(n)),
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

/**
 * The files behind `userOwned`, one per file, for the manifest.
 *
 * The game ignores letter case in a plugin name, so two plugins spelling one
 * master two ways need one file, named the way the first plugin spells it.
 * Sorted, so the same collection always writes the same manifest.
 */
export function userOwnedMasterFiles(check: MasterCheck): string[] {
  const byFile = new Map<string, string>();
  for (const { master } of check.userOwned) {
    const name = master.trim();
    if (!byFile.has(name.toLowerCase())) byFile.set(name.toLowerCase(), name);
  }
  return [...byFile.keys()].sort().map((key) => byFile.get(key)!);
}

/** The non-fatal note about content the user has to own themselves. */
export function describeUserOwnedMasters(check: MasterCheck): string[] {
  if (check.userOwned.length === 0) return [];
  // One entry per FILE. The game does not care about letter case in a plugin
  // name, so two plugins spelling one master two ways still need one file —
  // counted once, and named the way the first plugin spells it.
  const byFile = new Map<string, string>();
  for (const { master } of check.userOwned) {
    if (!byFile.has(master.toLowerCase())) byFile.set(master.toLowerCase(), master);
  }
  const masters = [...byFile.values()];
  return [
    `This collection depends on ${masters.length} Creation Club file(s) that ` +
      `cannot be shipped: ${masters.slice(0, 6).join(", ")}` +
      `${masters.length > 6 ? `, and ${masters.length - 6} more` : ""}. ` +
      `Anyone installing it needs to own them.`,
  ];
}
