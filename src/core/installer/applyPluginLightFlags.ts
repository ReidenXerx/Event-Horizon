/**
 * ──────────────────────────────────────────────────────────────────────
 * Restore the curator's ESL / "light" flags on the user's plugins.
 *
 * ─── THE FAILURE THIS PREVENTS ─────────────────────────────────────────
 * Regular plugins are addressed with one byte, so 254 can load; light plugins
 * share the `FE` index and cost nothing. On the profile this was built for,
 * 817 plugins fit only because 573 are light — 244 regular against a limit of
 * 254. Eleven missing flags and the game does not start.
 *
 * The flag lives inside the plugin file, so a curator who marks a plugin light
 * after installing it has a staged file the archive does not contain. The user
 * installs from that archive and gets the unflagged copy. Nothing downstream
 * catches it: verification sees different bytes, `judgeReinstall` consults the
 * archive, finds the user's copy matches it exactly, and concludes the
 * curator's staging diverged — which is true, and which for every other kind
 * of difference is the right answer. This is the one where accepting it breaks
 * the game, and it is why the flag is carried explicitly instead of being left
 * to file comparison.
 *
 * ─── WRITING TO THE DEPLOYED FILE IS THE POINT ─────────────────────────
 * This edits the plugin the game will load. With hardlink deployment that IS
 * the staged file, so the change persists across a re-deploy; with copy
 * deployment a purge could revert it, which is why the result is reported
 * rather than assumed permanent.
 *
 * Only four bytes change, and only the one bit inside them.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as path from "path";

import {
  readPluginFlagsDetailed,
  setPluginLightFlag,
  REGULAR_PLUGIN_LIMIT,
} from "../manifest/pluginFlags";
import type { EhcollPluginEntry } from "../../types/ehcoll";

export type PluginFlagRepair = {
  /** Files whose flag was actually rewritten. `set + cleared`. */
  corrected: number;
  /**
   * ─── THE TWO DIRECTIONS ARE NOT THE SAME EVENT ──────────────────────
   * Setting the flag frees a load-order slot; clearing it consumes one, and
   * clearing is the direction that can push a working profile over the 254
   * limit. They were one counter, and the notice asserted the set-direction
   * meaning for both — telling a curator whose flags were CLEARED that the
   * plugins "do not use a regular load-order slot", which is false in exactly
   * the case that matters.
   */
  set: number;
  cleared: number;
  /**
   * Which plugins were touched, so the log can answer the first question
   * anyone asks after a game stops starting. This is the only step in the
   * whole install that modifies bytes in the user's game folder, and it used
   * to record a count and nothing else.
   */
  correctedNames: string[];
  /**
   * The same corrections, with the flag each plugin had BEFORE.
   *
   * `correctedNames` says which files were rewritten; this says how to put
   * them back. Recorded into the receipt so the change this step makes inside
   * the user's game folder is reversible rather than merely logged.
   */
  changes: { plugin: string; wasLight: boolean }[];
  /** Already correct — the common case when the mod author shipped it light. */
  alreadyCorrect: number;
  /** The manifest did not record a flag: older package, or unreadable at build. */
  unknown: number;
  /**
   * Not on disk. ENOENT and nothing else.
   *
   * This used to also mean "locked", "permission denied" and "not a plugin",
   * because the reader collapsed every failure to `undefined`. An install run
   * while the game or xEdit holds the plugins open reported them as absent —
   * sending the user to look for files that were right there.
   */
  missing: number;
  /**
   * There, but unreadable: locked by another process, permissions, an I/O
   * error. Named, because it is the one the user can act on (close the game
   * and re-run) and the one a support log needs.
   */
  unreadable: string[];
  /** Writes that failed, named — each one is a plugin closer to not loading. */
  failures: string[];
  /**
   * Regular (non-light) ENABLED plugins after the repair, for the limit check.
   *
   * Counted from what is actually ON DISK, including plugins whose flag the
   * manifest did not record. It used to skip those — so the more flags were
   * missing, the further this fell below the truth, and it was permanently 0
   * in the case the alarm exists for. `overLimit` could not fire precisely
   * when the flags had been lost.
   *
   * Disabled plugins are excluded: plugins.txt lists them, but one loads
   * nothing and consumes no index, so counting them produced a "the game will
   * not start" warning for profiles that start fine.
   */
  regularAfter: number;
};

export async function applyPluginLightFlags(args: {
  order: readonly EhcollPluginEntry[];
  /** The game's Data folder — where the plugins the game loads actually live. */
  dataDir: string | undefined;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}): Promise<PluginFlagRepair> {
  const result: PluginFlagRepair = {
    corrected: 0,
    unreadable: [],
    set: 0,
    cleared: 0,
    correctedNames: [],
    changes: [],
    alreadyCorrect: 0,
    unknown: 0,
    missing: 0,
    failures: [],
    regularAfter: 0,
  };
  if (args.dataDir === undefined) {
    result.failures.push("the game's Data folder could not be located");
    return result;
  }

  let done = 0;
  for (const plugin of args.order) {
    if (args.signal?.aborted === true) break;
    done += 1;
    args.onProgress?.(done, args.order.length);

    const file = path.join(args.dataDir, plugin.name);
    const read = await readPluginFlagsDetailed(file);
    const current = read.kind === "ok" ? read.flags : undefined;
    // "Not there" and "there but we could not open it" ask for different
    // things from the user, so they are counted apart.
    const noteUnreadable = (): void => {
      if (read.kind === "unreadable" || read.kind === "not-a-plugin") {
        result.unreadable.push(`${plugin.name}: ${read.why}`);
      } else {
        result.missing += 1;
      }
    };

    /**
     * Counted from the FILE, not from the manifest, and only when enabled.
     * A plugin whose flag we could not record still sits on disk and still
     * takes an index — excluding it is what made the limit alarm deaf.
     */
    const countsAsRegular = (isLight: boolean): void => {
      if (plugin.enabled && !isLight) result.regularAfter += 1;
    };

    // Absent means the build could not read it. Leave the user's file alone
    // rather than clearing a flag on a guess — but still count what it IS.
    if (plugin.light === undefined) {
      result.unknown += 1;
      if (current !== undefined) countsAsRegular(current.isLight);
      else noteUnreadable();
      continue;
    }

    if (current === undefined) {
      noteUnreadable();
      continue;
    }

    if (current.isLight === plugin.light) {
      result.alreadyCorrect += 1;
      countsAsRegular(plugin.light);
      continue;
    }

    try {
      const changed = await setPluginLightFlag(file, plugin.light);
      if (changed) {
        result.corrected += 1;
        result.correctedNames.push(plugin.name);
        // `changed` is true only when the flag DIFFERED, so the prior value is
        // the opposite of what we just wrote.
        result.changes.push({ plugin: plugin.name, wasLight: !plugin.light });
        if (plugin.light) result.set += 1;
        else result.cleared += 1;
      } else {
        result.alreadyCorrect += 1;
      }
      countsAsRegular(plugin.light);
    } catch (err) {
      result.failures.push(
        `${plugin.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // It kept whatever it had, so count it as it currently stands.
      countsAsRegular(current.isLight);
    }
  }
  return result;
}

/**
 * What to tell the user, or `undefined` when there is nothing worth saying.
 *
 * Silent on the happy path — restoring flags that were already right is not an
 * event. Loud when the plugin limit is actually breached, because that is the
 * difference between "a mod behaves oddly" and "the game will not start", and
 * the user needs to know which one they have before they go looking.
 */
export function describePluginFlagRepair(
  result: PluginFlagRepair,
): string[] | undefined {
  const overLimit = result.regularAfter > REGULAR_PLUGIN_LIMIT;
  /**
   * ─── SILENCE IS NOT AN ACCEPTABLE REPORT FOR TOTAL FAILURE ──────────
   * This returned `undefined` whenever nothing was corrected, so both ways
   * the step can fail completely were reported as nothing at all: a package
   * that records no flags (every entry `unknown`), and a Data folder where
   * none of the plugins can be read (every entry `missing`). Neither sets
   * `corrected` or `failures`, and `regularAfter` was 0, so `overLimit` could
   * not fire either. The install said success and the flags that make the
   * collection loadable were never restored.
   */
  const total =
    result.unknown +
    result.missing +
    result.unreadable.length +
    result.alreadyCorrect +
    result.corrected;
  const blind =
    total > 0 &&
    result.unknown + result.missing + result.unreadable.length === total;
  if (
    result.corrected === 0 &&
    result.failures.length === 0 &&
    result.unreadable.length === 0 &&
    !overLimit &&
    !blind
  ) {
    return undefined;
  }

  const lines: string[] = [];
  if (overLimit) {
    lines.push(
      `This profile has ${result.regularAfter} regular plugins against a ` +
        `limit of ${REGULAR_PLUGIN_LIMIT}. The game will not start until that ` +
        `is under the limit — light (ESL) flags are what keep a collection ` +
        `this size loadable, and some could not be restored.`,
    );
  } else if (blind) {
    lines.push(
      result.unknown >= result.missing
        ? `No ESL (light) flag was recorded for any of the ${total} plugins ` +
          `in this collection, so none were restored. If the game will not ` +
          `start, that is the first thing to check — the package may predate ` +
          `this feature, or the curator's build could not read the headers.`
        : `None of the ${total} plugins in this collection could be read from ` +
          `your game's Data folder, so no ESL (light) flags were restored. ` +
          `That usually means the deploy has not happened yet.`,
    );
  } else if (result.corrected > 0) {
    // Set and cleared are opposite claims about the load-order budget, and
    // one message asserted the set-direction meaning for both.
    if (result.set > 0) {
      lines.push(
        `Restored the collection's ESL (light) flag on ${result.set} ` +
          `plugin(s). These do not use a regular load-order slot, which is ` +
          `what lets a collection this size load at all.`,
      );
    }
    if (result.cleared > 0) {
      lines.push(
        `Removed the ESL (light) flag from ${result.cleared} plugin(s) to ` +
          `match the curator. Each of these now uses a regular load-order ` +
          `slot; you have ${Math.max(0, REGULAR_PLUGIN_LIMIT - result.regularAfter)} ` +
          `spare.`,
      );
    }
  }
  if (result.failures.length > 0) {
    lines.push(
      `${result.failures.length} could not be changed: ` +
        `${result.failures.slice(0, 5).join("; ")}`,
    );
  }
  if (result.missing > 0 && !blind) {
    lines.push(
      `  - ${result.missing} plugin(s) in the collection are not on disk here.`,
    );
  }
  if (result.unreadable.length > 0) {
    // Distinct from missing on purpose: these files ARE there, and the usual
    // cause is the game or xEdit holding them open — which the user can fix
    // and re-run, if they are told that is what happened.
    lines.push(
      `  - ${result.unreadable.length} plugin(s) are on disk but could not be ` +
        `read, so their ESL flags were left alone. Close the game and any ` +
        `xEdit/LOOT windows, then re-run: ` +
        `${result.unreadable.slice(0, 3).join("; ")}`,
    );
  }
  return lines;
}
