/**
 * ──────────────────────────────────────────────────────────────────────
 * Turn back on the INI tweaks the curator had turned on.
 *
 * A mod can ship optional `.ini` fragments in an `ini tweaks` folder — a
 * performance preset, a rain toggle, a "disable intro movie". Vortex leaves
 * them all OFF by default and the user ticks the ones they want; ticking one
 * is what makes Vortex merge that fragment into the game's INI at deploy.
 *
 * The curator's ticks were captured into `state.enabledINITweaks` from the
 * beginning and then never applied to anything, which is the worst place for
 * this to fail. A tweak is invisible: it does not add a file to the mod list,
 * it does not change a plugin count, and its absence looks exactly like its
 * presence right up until the game runs differently. A collection that ships
 * a performance preset and silently does not enable it has reproduced
 * everything the user can see and none of what they will feel.
 *
 * ── What this does NOT do ──
 * It never DISABLES a tweak the user chose. The user may have enabled
 * something on their own mods, and a collection that quietly unticks things
 * it did not tick would be reaching outside what it installed.
 *
 * ── EXCEPT THE ONES IT TICKED ITSELF ──
 * "Additive only" is right on a first install and wrong on an UPDATE. A
 * curator who ships a performance preset in one revision and drops it in the
 * next has changed their mind; the player still has it merged into their INI
 * at every deploy, with no file in the mod list and no plugin count to show
 * for it — the most invisible thing a collection ships, left on forever.
 *
 * What made unticking unsafe was not knowing whose tick it was. The receipt
 * now records which (mod, tweak) pairs WE enabled, so `planIniTweakRemovals`
 * can untick exactly those and nothing else. That stays inside NS-2: we
 * reverse our own writes, never the user's.
 * ──────────────────────────────────────────────────────────────────────
 */

import { actions } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";

import { ehLog } from "../logging/ehLog";
import type { EhcollMod } from "../../types/ehcoll";

export type IniTweakApplication = {
  /** Tweaks turned on, as `modName :: tweakFile` — for people to read. */
  enabled: string[];
  /**
   * The same ticks, as machine-readable pairs for the RECEIPT.
   *
   * `compareKey` rather than the Vortex mod id: the id is this machine's and
   * changes if the mod is reinstalled, while the compareKey is the
   * collection's own name for the mod and is what the next revision will look
   * it up by. Display names are no good here — two mods can share one.
   */
  enabledKeys: { compareKey: string; tweak: string }[];
  /**
   * Tweaks the manifest asked for on mods this install did not produce.
   * Not an error — a skipped or carried mod has no new id to tick against —
   * but recorded so a missing tweak is explainable rather than mysterious.
   */
  skipped: string[];
};

export function emptyIniTweakApplication(): IniTweakApplication {
  return { enabled: [], enabledKeys: [], skipped: [] };
}

/**
 * Enable each captured tweak on the mod this install produced for it.
 *
 * `installed` maps compareKey → the Vortex mod id created here, which is the
 * only correct target: the manifest's own mod id is the CURATOR's, and ticking
 * a tweak against it would either do nothing or, worse, land on an unrelated
 * mod that happens to share the id on this machine.
 */
export function applyIniTweaks(args: {
  api: types.IExtensionApi;
  gameId: string;
  /** compareKey → the Vortex mod id this install produced. */
  installed: ReadonlyMap<string, string>;
  manifestMods: readonly EhcollMod[];
}): IniTweakApplication {
  const out = emptyIniTweakApplication();

  for (const mod of args.manifestMods) {
    const tweaks = mod.state.enabledINITweaks ?? [];
    if (tweaks.length === 0) continue;

    const vortexModId = args.installed.get(mod.compareKey);
    if (vortexModId === undefined) {
      for (const tweak of tweaks) out.skipped.push(`${mod.name} :: ${tweak}`);
      continue;
    }

    for (const tweak of tweaks) {
      try {
        args.api.store?.dispatch(
          (
            actions as unknown as {
              setINITweakEnabled: (
                gameId: string,
                modId: string,
                tweak: string,
                enabled: boolean,
              ) => unknown;
            }
          ).setINITweakEnabled(args.gameId, vortexModId, tweak, true),
        );
        out.enabled.push(`${mod.name} :: ${tweak}`);
        out.enabledKeys.push({ compareKey: mod.compareKey, tweak });
      } catch (err) {
        // One tweak that will not tick is not worth failing an install over,
        // but it IS worth saying — see describeIniTweaks.
        out.skipped.push(`${mod.name} :: ${tweak}`);
        ehLog("warn", "installer.ini-tweak-failed", {
          tweak,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  ehLog("info", "installer.ini-tweaks-applied", {
    enabled: out.enabled.length,
    skipped: out.skipped.length,
  });
  return out;
}

/**
 * What to tell the user, and only when there is something they can act on.
 *
 * Successes are silent: a tweak that worked is indistinguishable from a
 * collection that had none, and neither needs a sentence. A tweak that did NOT
 * get enabled is the one worth naming, because it is otherwise invisible —
 * the game just behaves differently and nothing on screen says why.
 */
export function describeIniTweaks(result: IniTweakApplication): string[] {
  if (result.skipped.length === 0) return [];

  const lines = [
    `${result.skipped.length} INI tweak(s) the curator had enabled could not ` +
      `be enabled here, because the mods they belong to were skipped or ` +
      `already present. INI tweaks change how the game runs without changing ` +
      `anything you can see in the mod list, so this is worth a look:`,
  ];
  for (const entry of result.skipped.slice(0, 5)) lines.push(`  • ${entry}`);
  if (result.skipped.length > 5) {
    lines.push(`  • and ${result.skipped.length - 5} more.`);
  }
  lines.push(
    `You can tick them yourself on each mod's INI Tweaks tab in Vortex.`,
  );
  return lines;
}

/** One tick to reverse: which mod, and which tweak file. */
export type IniTweakRemoval = {
  compareKey: string;
  vortexModId: string;
  tweak: string;
};

/**
 * Ticks THIS collection made last time that it no longer asks for.
 *
 * The rule, and every clause of it is load-bearing:
 *
 *  - it must be in `previouslyEnabled` — the previous receipt's record of
 *    what WE ticked. A tweak the user enabled themselves is not in there and
 *    is never touched (NS-2);
 *  - the new manifest must NOT ask for it — otherwise it simply stays on;
 *  - the mod must be one THIS run installed, so there is a current id to
 *    dispatch against. A carried or absent mod is left alone rather than
 *    guessed at.
 *
 * Pure: the caller dispatches.
 */
export function planIniTweakRemovals(args: {
  previouslyEnabled: readonly { compareKey: string; tweak: string }[];
  manifestMods: readonly EhcollMod[];
  /** compareKey → the Vortex mod id this install produced. */
  installed: ReadonlyMap<string, string>;
}): IniTweakRemoval[] {
  const wantedNow = new Set<string>();
  for (const mod of args.manifestMods) {
    for (const tweak of mod.state.enabledINITweaks ?? []) {
      wantedNow.add(`${mod.compareKey}\u0000${tweak}`);
    }
  }

  const out: IniTweakRemoval[] = [];
  const seen = new Set<string>();
  for (const previous of args.previouslyEnabled) {
    const key = `${previous.compareKey}\u0000${previous.tweak}`;
    if (wantedNow.has(key)) continue;
    if (seen.has(key)) continue;
    const vortexModId = args.installed.get(previous.compareKey);
    if (vortexModId === undefined) continue;
    seen.add(key);
    out.push({ compareKey: previous.compareKey, vortexModId, tweak: previous.tweak });
  }
  return out;
}

/**
 * Reverse those ticks. Never throws; a tweak that will not untick is logged.
 *
 * Returns what was actually turned off, for the install report — the player
 * should be told, because an INI tweak going away changes how the game runs
 * and nothing else on screen would show it.
 */
export function applyIniTweakRemovals(args: {
  api: types.IExtensionApi;
  gameId: string;
  removals: readonly IniTweakRemoval[];
}): string[] {
  const done: string[] = [];
  for (const removal of args.removals) {
    try {
      args.api.store?.dispatch(
        (
          actions as unknown as {
            setINITweakEnabled: (
              gameId: string,
              modId: string,
              tweak: string,
              enabled: boolean,
            ) => unknown;
          }
        ).setINITweakEnabled(args.gameId, removal.vortexModId, removal.tweak, false),
      );
      done.push(removal.tweak);
    } catch (err) {
      ehLog("warn", "installer.ini-tweak-untick-failed", {
        tweak: removal.tweak,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (done.length > 0) {
    ehLog("info", "installer.ini-tweaks-removed", { count: done.length, tweaks: done.slice(0, 10) });
  }
  return done;
}

/**
 * What to tell the player about ticks this version withdrew.
 *
 * Named, not counted: an INI tweak is invisible in the mod list, so "2 tweaks
 * turned off" leaves someone with no way to tell what changed about their game.
 */
export function describeIniTweakRemovals(tweaks: readonly string[]): string[] {
  if (tweaks.length === 0) return [];
  const n = tweaks.length;
  return [
    `${n} INI tweak${n === 1 ? "" : "s"} this collection had switched on ` +
      `${n === 1 ? "is" : "are"} not part of this version and ${n === 1 ? "has" : "have"} ` +
      `been switched back off: ${tweaks.slice(0, 8).join(", ")}` +
      (n > 8 ? `, and ${n - 8} more` : "") +
      `. Only ticks Event Horizon made itself are reversed — anything you ` +
      `enabled yourself is untouched.`,
  ];
}
