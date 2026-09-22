/**
 * ──────────────────────────────────────────────────────────────────────
 * Two things a Bethesda collection cannot be built without, checked BEFORE
 * the build spends twenty minutes producing something broken.
 *
 * Both exist because of the same week. A curator's Skyrim SE is from GOG, so
 * the game writes plugins.txt to a store-specific folder; Event Horizon read
 * the Steam one, found nothing, and shipped `plugins.order: []`. Ten packages,
 * every one missing the plugin order, the ESL flags and every LOOT rule — and
 * nothing failed, because an empty list is also what a game with no
 * plugins.txt legitimately produces. The store bug is fixed; this is the guard
 * that makes the NEXT cause of an empty order impossible to ship silently,
 * whatever it turns out to be.
 *
 * ─── WHY REFUSING IS THE KIND ANSWER ───────────────────────────────────
 * A package with no plugin order is not a degraded collection, it is a broken
 * one: the player installs 10 GB, the load order is whatever LOOT invents, and
 * the ESL flags that let it load at all were never recorded. Refusing costs a
 * retry. Shipping costs someone else's evening, and they cannot tell what went
 * wrong because from their side nothing did.
 *
 * ─── THE 254 LIMIT IS THE GAME'S, NOT OURS ─────────────────────────────
 * A regular plugin is addressed with one byte, so 254 can load; light (ESL)
 * plugins share the `FE` index and cost nothing. A curator over the limit has
 * a profile their OWN game will not start — so the collection was broken
 * before it was packed, and every player would inherit it. Checking it here
 * catches it where it can actually be fixed.
 * ──────────────────────────────────────────────────────────────────────
 */

import { REGULAR_PLUGIN_LIMIT } from "./pluginFlags";

/** One plugin as the build sees it, before anything is written. */
export type PreflightPlugin = {
  name: string;
  enabled: boolean;
  /** Absent when the header could not be read — an unknown, never "regular". */
  light?: boolean;
};

export type PreflightRefusal = {
  /** Which rule refused, for the log and for a test to name. */
  code: "no-plugin-order" | "over-plugin-limit";
  /** What the curator reads. Written to be actionable, not diagnostic. */
  message: string;
};

/**
 * Games whose plugin budget we can judge.
 *
 * Deliberately NOT every supported game. Starfield uses a different header bit
 * for "light" — `pluginFlags.ts` says so where the constant is defined — so a
 * heavy-plugin count there would be computed from the wrong bit and could
 * refuse a perfectly good build. An unknown answer must not become a refusal.
 */
const KNOWN_FLAG_GAMES = new Set([
  "skyrimse",
  "skyrimvr",
  "fallout4",
  "fallout4vr",
  "enderalspecialedition",
]);

/**
 * May this build proceed?
 *
 * `undefined` means yes. Pure, so the rules are testable without a Vortex.
 *
 * @param usesPluginsTxt whether this game keeps its load order in plugins.txt
 *        at all — a game that does not is not expected to produce an order.
 */
export function preflightRefusal(args: {
  gameId: string;
  usesPluginsTxt: boolean;
  plugins: readonly PreflightPlugin[];
  /**
   * Whether plugins.txt was actually FOUND and read.
   *
   * ─── THE REFUSAL NAMED A CAUSE IT HAD NOT MEASURED ──────────────────
   * The caller collapses both outcomes into `[]` — `pluginsTxtContent ===
   * undefined ? [] : parsePluginsTxt(...)` — so this could not tell "the file
   * was not found" from "the file was found and lists nothing", and stated
   * the first as fact: "an empty result means the file could not be found or
   * read", followed by "Launch the game once so it writes the file".
   *
   * A Bethesda plugins.txt does not list the base masters, so a legitimate
   * texture/mesh/ENB-only collection produces a found, readable, EMPTY file.
   * That curator was refused with an instruction that fixes nothing and
   * pointed at a `plugins-txt.not-found` log line that does not exist.
   *
   * The refusal itself is right — it is the guard that makes the next cause
   * of an empty order impossible to ship quietly — and this repo's own
   * standard is that an absence meaning two things gets its own field rather
   * than one sentence covering both.
   *
   * Optional so older callers compile; absent keeps the original wording,
   * which is the one that was always correct for the store-path bug.
   */
  pluginsTxtFound?: boolean;
}): PreflightRefusal | undefined {
  const { gameId, usesPluginsTxt, plugins } = args;

  if (usesPluginsTxt && plugins.length === 0) {
    if (args.pluginsTxtFound === true) {
      return {
        code: "no-plugin-order",
        message:
          `${gameId}'s plugins.txt was read and lists no plugins, so the ` +
          `package would ship without a load order, without ESL flags and ` +
          `without LOOT rules — and nothing on the player's side could tell.` +
          ` If this collection genuinely ships no plugins (textures, meshes ` +
          `or an ENB preset only), there is nothing here to record and ` +
          `nothing to fix. Otherwise your plugins are not reaching Vortex's ` +
          `list: check that the right install of ${gameId} is the one Vortex ` +
          `has discovered, and that the mods are deployed.`,
      };
    }
    return {
      code: "no-plugin-order",
      message:
        `No plugin order could be read for this game, so the package would ` +
        `ship without one.` +
        ` This is not "you have no plugins" — ${gameId} keeps its load order ` +
        `in plugins.txt, and an empty result means the file could not be ` +
        `found or read. A package built now would be missing the plugin ` +
        `order, every ESL flag and every LOOT rule, and nothing on the ` +
        `player's side could tell.` +
        ` Launch the game once so it writes the file, check Vortex has the ` +
        `right install of ${gameId} discovered, then build again. The log ` +
        `line "plugins-txt.not-found" lists the folders that were tried.`,
    };
  }

  if (!KNOWN_FLAG_GAMES.has(gameId)) return undefined;

  /**
   * Only ENABLED plugins occupy an index, and only plugins we could actually
   * read a flag for are counted as regular. A plugin whose header was
   * unreadable is an unknown: counting it as heavy could refuse a build that
   * is fine, which is the one direction this gate must never fail in.
   */
  const heavy = plugins.filter((p) => p.enabled && p.light === false);
  if (heavy.length > REGULAR_PLUGIN_LIMIT) {
    return {
      code: "over-plugin-limit",
      message:
        `This profile has ${heavy.length} enabled regular (non-light) ` +
        `plugins, and a Bethesda game can load ${REGULAR_PLUGIN_LIMIT}. ` +
        `Your own game will not start with this profile, so the collection ` +
        `is already broken and every player would inherit it.` +
        ` Light (ESL) plugins share a single index and do not count toward ` +
        `the limit — flagging ${heavy.length - REGULAR_PLUGIN_LIMIT} more of ` +
        `them as light, merging some, or disabling what you do not need will ` +
        `bring it under.`,
    };
  }

  return undefined;
}
