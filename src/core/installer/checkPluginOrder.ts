/**
 * ──────────────────────────────────────────────────────────────────────
 * Did the collection actually reproduce the curator's load order?
 *
 * Nothing checked. The collection ships the curator's exact plugin order and
 * applies their LOOT userlist rules, then leaves Vortex + LOOT to compute the
 * user's order at deploy — and MANY orders satisfy the same set of rules. The
 * one LOOT picks depends on the user's masterlist version, which plugins they
 * have, and whatever rules they already had. So "the rules were applied"
 * and "the load order matches" are different claims, and only the first was
 * ever established.
 *
 * For a Bethesda game that difference is not cosmetic. Load order decides
 * which plugin's records win, so two orders that both satisfy the rules can
 * still produce different gameplay — or a crash, if a patch loads before the
 * thing it patches.
 *
 * This does not CHANGE the order. It reads what the user actually ended up
 * with and says how it differs from the curator's, which is the difference
 * between "your collection installed" and "your collection installed and your
 * load order matches mine".
 *
 * ── What counts as a difference ──
 * Three kinds, deliberately separated, because they have different fixes:
 *
 *   missing    — the curator has it, the user does not. Usually a mod that
 *                failed to install, and the load order is the symptom.
 *   extra      — the user has it, the curator does not. Their own mods, which
 *                is fine and expected; reported quietly.
 *   misordered — both have it, in a different RELATIVE position. This is the
 *                one that changes what the game does.
 *
 * Comparison is on the plugins BOTH sides have, in sequence. Comparing raw
 * indices would report every plugin after the first extra one as misordered,
 * which is noise: inserting one of your own mods near the top does not move
 * anything relative to anything else.
 * ──────────────────────────────────────────────────────────────────────
 */

export type PluginOrderEntry = { name: string; enabled: boolean };

export type PluginOrderDrift = {
  /** In the curator's order, absent from the user's. */
  missing: string[];
  /** In the user's order, absent from the curator's. */
  extra: string[];
  /**
   * Plugins both sides have, whose relative order differs. Each entry names
   * the plugin and what it should come after.
   */
  misordered: { name: string; expectedAfter: string }[];
  /** How many plugins were compared — the denominator for everything above. */
  compared: number;
};

export function emptyPluginOrderDrift(): PluginOrderDrift {
  return { missing: [], extra: [], misordered: [], compared: 0 };
}

const key = (name: string): string => name.trim().toLowerCase();

/**
 * Compare the user's resulting order against the curator's.
 *
 * Only ENABLED plugins are compared. A disabled plugin is not loaded, so its
 * position changes nothing about the game — reporting it would be noise in a
 * report whose whole value is that every line matters.
 */
export function comparePluginOrder(
  curator: readonly PluginOrderEntry[],
  user: readonly PluginOrderEntry[],
): PluginOrderDrift {
  const curatorEnabled = curator.filter((p) => p.enabled).map((p) => p.name);
  const userEnabled = user.filter((p) => p.enabled).map((p) => p.name);

  const curatorSet = new Set(curatorEnabled.map(key));
  const userSet = new Set(userEnabled.map(key));

  const missing = curatorEnabled.filter((n) => !userSet.has(key(n)));
  const extra = userEnabled.filter((n) => !curatorSet.has(key(n)));

  // The shared plugins, each side in its own sequence. Comparing these two
  // sequences is the only comparison that means anything: it ignores what one
  // side simply does not have.
  const sharedCurator = curatorEnabled.filter((n) => userSet.has(key(n)));
  const sharedUser = userEnabled.filter((n) => curatorSet.has(key(n)));

  const misordered: { name: string; expectedAfter: string }[] = [];
  const userPos = new Map(sharedUser.map((n, i) => [key(n), i]));

  // A plugin is misordered when it sits before something the curator put
  // BEFORE it. Reported against its immediate predecessor, because that is
  // the actionable statement — "X must come after Y" is a rule someone can
  // add, where "the order differs" is not.
  for (let i = 1; i < sharedCurator.length; i++) {
    const current = sharedCurator[i]!;
    const predecessor = sharedCurator[i - 1]!;
    const a = userPos.get(key(current));
    const b = userPos.get(key(predecessor));
    if (a === undefined || b === undefined) continue;
    if (a < b) misordered.push({ name: current, expectedAfter: predecessor });
  }

  return { missing, extra, misordered, compared: sharedCurator.length };
}

/**
 * What to tell the user, in the order they can act on it.
 *
 * Silent when the order matches. A report that says "0 differences" on every
 * successful install is a line people learn to skip, and this one has to be
 * read on the occasions it is not zero.
 */
export function describePluginOrderDrift(
  drift: PluginOrderDrift,
  /**
   * ─── IS THIS NUMBER A MEASUREMENT? ────────────────────────────────────
   * The install re-pins the curator's order and then polls plugins.txt to
   * confirm the write landed. When that poll times out, `drift` still holds
   * the PRE-re-pin count — and the advice below ("sort your plugins in
   * Vortex") is the one action that undoes the re-pin, so giving it on the
   * strength of a stale number is worse than saying nothing.
   *
   * The flag existed in the driver, was assigned, and was read by nothing —
   * so this caveat has never reached a user. That is the same
   * written-but-never-read shape the receipt has now shipped several times.
   */
  repinUnconfirmed = false,
): string[] {
  const problems = drift.misordered.length + drift.missing.length;
  if (problems === 0) return [];

  const lines: string[] = [];

  if (drift.misordered.length > 0) {
    lines.push(
      `${drift.misordered.length} of ${drift.compared} plugins load in a ` +
        `different order than on the curator's machine. Load order decides ` +
        `which mod's changes win, so this can change how the game behaves ` +
        `even though every file installed correctly:`,
    );
    for (const m of drift.misordered.slice(0, 5)) {
      lines.push(`  • "${m.name}" should load after "${m.expectedAfter}"`);
    }
    if (drift.misordered.length > 5) {
      lines.push(`  • and ${drift.misordered.length - 5} more.`);
    }
    lines.push(
      repinUnconfirmed
        ? `The collection re-applied the curator's order, but Windows did ` +
          `not report the change back in time to confirm it — so the count ` +
          `above is from BEFORE that step and may already be resolved. ` +
          `Restart Vortex and check the load order there. Do NOT press Sort ` +
          `yet: if the re-pin did land, sorting would undo it.`
        : `Sorting your plugins in Vortex usually resolves this. If it does ` +
          `not, the curator's order relied on something LOOT does not know ` +
          `about.`,
    );
  }

  if (drift.missing.length > 0) {
    lines.push(
      `${drift.missing.length} plugin(s) the curator has are not present ` +
        `here — usually a mod that did not install. Check the install summary ` +
        `above before chasing the load order.`,
    );
    for (const n of drift.missing.slice(0, 5)) lines.push(`  • ${n}`);
    if (drift.missing.length > 5) {
      lines.push(`  • and ${drift.missing.length - 5} more.`);
    }
  }

  // `extra` is deliberately not reported as a problem. The user's own mods
  // being present is the normal state of any real profile, and calling it
  // drift would make this notice fire on every healthy install.
  return lines;
}

/**
 * The user's CURRENT plugin order, as Vortex and LOOT left it.
 *
 * Read from disk rather than from Redux, because plugins.txt is what the game
 * actually loads — and the point of this check is to compare against reality,
 * not against what state believes reality to be.
 */
export async function readUserPluginsTxt(
  gameId: string,
  /**
   * Vortex's discovered store. plugins.txt lives in a store-specific folder
   * — a GOG Skyrim SE writes to "Skyrim Special Edition GOG" — and without
   * this the resolver has to guess from what exists on disk.
   */
  store?: string,
): Promise<PluginOrderEntry[] | undefined> {
  const [{ getCurrentPluginsTxtPath, parsePluginsTxt }, fsp] =
    await Promise.all([import("../comparePlugins"), import("fs/promises")]);

  let pluginsPath: string;
  try {
    pluginsPath = getCurrentPluginsTxtPath(gameId, store);
  } catch {
    return undefined;
  }

  let content: string;
  try {
    // latin1, matching what Vortex writes — see parsePluginsTxt's note.
    // utf8 here mangles every non-ASCII plugin name into U+FFFD, and because
    // the manifest was mangled the same way the comparison still "matches".
    content = await fsp.readFile(pluginsPath, "latin1");
  } catch {
    // No plugins.txt is normal for a game that does not use one, and for a
    // profile Vortex has not deployed yet. Neither is an error here.
    return undefined;
  }

  return parsePluginsTxt(content).map((e) => ({
    name: e.name,
    enabled: e.enabled,
  }));
}
