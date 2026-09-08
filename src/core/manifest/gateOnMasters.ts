/**
 * The missing-master gate, in ONE place, for every path that builds a package.
 *
 * ─── WHY THIS IS ITS OWN MODULE ─────────────────────────────────────────────
 * The check itself (`checkMasters`) and the parser under it (`pluginMasters`)
 * were already shared. What was not shared was the forty lines that turn them
 * into a gate: read plugins.txt, resolve the Data folder, walk the enabled
 * plugins reading headers, log the outcome, refuse on a miss, warn on the
 * rest. That block lived in the build PAGE, and this project has two live
 * build paths — the page and `Event Horizon: Build (legacy dialog)`, which
 * `src/index.ts` registers and which runs the same `buildManifest` →
 * `packageEhcoll` pipeline to produce a real `.ehcoll`.
 *
 * So the gate written to stop an unloadable collection from shipping guarded
 * one of the two doors. The other one shipped the exact package the gate
 * exists to refuse, and could not even catch the refusal — `BuildRefusedError`
 * is declared inside the page module.
 *
 * That is not a hypothetical for this codebase: six test files exist purely to
 * assert that these two paths have not diverged on some rule, each named for a
 * rule that diverged once already. Rather than add a seventh, the rule gets
 * one home and both callers get one line.
 *
 * ─── WHAT IT DECIDES ────────────────────────────────────────────────────────
 * A Bethesda plugin declares the masters it was built against, and the game
 * refuses to load one whose masters are absent. On a real 1,755-mod package
 * `RaceCompatibility.esm` was provided by zero mods and appeared nowhere in
 * the 1,607-entry plugin order, while two plugins requiring it shipped
 * enabled — working on the curator's machine because they had the master from
 * outside the collection's scope.
 *
 * Refused rather than warned: the curator is the only person who can fix it,
 * and a warning in a long build log is how it shipped the first time.
 */

import * as path from "path";

import { checkMasters, describeMissingMasters, describeUserOwnedMasters } from "./checkMasters";
import { parsePluginsTxt } from "../comparePlugins";
import { readPluginMasters } from "./pluginMasters";
import { ehLog } from "../logging/ehLog";

/** What the gate decided. */
export type MasterGateResult = {
  /**
   * Present when the build must be REFUSED, and already formatted for the
   * curator. Absent means the check found nothing blocking — which is not the
   * same as "the check ran"; see `checkedNothing`.
   */
  refusal?: string;
  /** Non-blocking lines for the build summary. Never empty-checked by callers. */
  warnings: string[];
  /**
   * The check examined ZERO plugins.
   *
   * Distinct from "found nothing wrong". It happens when the game has no
   * plugins.txt this project can read (Starfield, and the older `original`
   * format), and a caller that reports it as a pass is reporting a pass
   * nobody verified.
   */
  checkedNothing: boolean;
};

/**
 * Run the gate.
 *
 * `gameDir` absent means the Data folder could not be located, in which case
 * every plugin is recorded as UNKNOWN rather than as "needs nothing" — the
 * check reports that it could not run instead of passing silently.
 */
export async function gateOnMasters(args: {
  gameId: string;
  gameDir: string | undefined;
  pluginsTxtContent: string | undefined;
  /** Called once per plugin so a long walk stays cancellable. Optional. */
  checkAbort?: () => void;
}): Promise<MasterGateResult> {
  const { gameId, gameDir, pluginsTxtContent, checkAbort } = args;

  const enabledPlugins =
    pluginsTxtContent === undefined
      ? []
      : parsePluginsTxt(pluginsTxtContent).filter((e) => e.enabled);
  const dataDir = gameDir === undefined ? undefined : path.join(gameDir, "Data");

  const pluginsWithMasters: {
    name: string;
    enabled: boolean;
    masters: string[] | undefined;
  }[] = [];
  for (const entry of enabledPlugins) {
    checkAbort?.();
    if (dataDir === undefined) {
      pluginsWithMasters.push({
        name: entry.name,
        enabled: true,
        masters: undefined,
      });
      continue;
    }
    const read = await readPluginMasters(path.join(dataDir, entry.name));
    pluginsWithMasters.push({
      name: entry.name,
      enabled: true,
      masters: read.kind === "ok" ? read.masters : undefined,
    });
  }

  const masterCheck = checkMasters(pluginsWithMasters, gameId);
  const checkedNothing = masterCheck.checked === 0;

  ehLog(
    masterCheck.missing.length > 0 ? "error" : "info",
    "build.masters.checked",
    {
      gameId,
      checked: masterCheck.checked,
      enabledPlugins: enabledPlugins.length,
      dataDir: dataDir !== undefined,
      missing: masterCheck.missing.length,
      userOwned: masterCheck.userOwned.length,
      unreadable: masterCheck.unreadable.length,
      examples: masterCheck.missing.slice(0, 5),
    },
  );

  const warnings: string[] = [...describeUserOwnedMasters(masterCheck)];

  /**
   * A check that examined NOTHING is not a pass.
   *
   * Every plugin unreadable means the same thing as no plugins at all: the
   * gate looked and learned nothing. Reporting "0 missing" for that is the
   * confident zero — it reads as knowledge and is the absence of it.
   */
  if (
    enabledPlugins.length > 0 &&
    masterCheck.unreadable.length === enabledPlugins.length
  ) {
    warnings.push(
      `None of this collection's ${enabledPlugins.length} enabled plugin(s) ` +
        `could be read, so NOTHING was checked for missing masters. This is ` +
        `not a pass — it usually means the game folder moved or has not been ` +
        `deployed since it did.`,
    );
  } else if (masterCheck.unreadable.length > 0) {
    warnings.push(
      `${masterCheck.unreadable.length} plugin(s) could not be read, so their ` +
        `master requirements were not checked: ` +
        `${masterCheck.unreadable.slice(0, 3).join(", ")}` +
        `${masterCheck.unreadable.length > 3 ? ", and more" : ""}.`,
    );
  } else if (checkedNothing) {
    warnings.push(
      `No plugin master requirements were checked for this game — Event ` +
        `Horizon could not read a plugin list for it. The package may ship ` +
        `plugins whose masters are missing.`,
    );
  }

  return {
    ...(masterCheck.missing.length > 0
      ? { refusal: describeMissingMasters(masterCheck) }
      : {}),
    warnings,
    checkedNothing,
  };
}
