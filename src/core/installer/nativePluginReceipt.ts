/**
 * The script-extender verdict, recorded on the receipt at install time.
 *
 * The dashboard wants to say "236 of 236 plugins load on your game" without
 * opening the package — which may be 65 GB, and may be deleted by then. The
 * judgement itself is `judgeCollection`; this is the thin layer that answers
 * it for THIS machine and reduces it to four counts.
 *
 * Counts only, deliberately. The names belong to the package, and a name list
 * copied into a receipt goes stale the moment the player swaps a mod — a
 * stale list of "broken" mods is worse than no list, because it reads as a
 * current finding.
 *
 * `undefined` when the package recorded no plugin data, or when this game's
 * runtime could not be established. Absent means "not recorded", never "none".
 */

import type { EhcollManifest } from "../../types/ehcoll";
import {
  extenderApiFor,
  judgeCollection,
  runtimeIdFor,
} from "../environment/nativePluginCompat";

export interface NativePluginSummary {
  loads: number;
  unverified: number;
  cannotLoad: number;
  unknown: number;
  /** The game the counts describe — see the receipt type. */
  judgedFor?: { version: string; store?: string };
}

export function nativePluginSummaryFor(args: {
  manifest: Pick<EhcollManifest, "game" | "mods" | "rules">;
  /** The player's game version, as Vortex reports it. */
  installedVersion: string | undefined;
  /** The player's store, when known: Skyrim's GOG build has its own runtime id. */
  store: string | undefined;
}): NativePluginSummary | undefined {
  const { manifest, installedVersion } = args;
  if (installedVersion === undefined) return undefined;
  if (!manifest.mods.some((m) => m.state.nativePlugins !== undefined)) return undefined;

  const runtime = runtimeIdFor(manifest.game.id, installedVersion, args.store);
  const api = extenderApiFor(manifest.game.id, installedVersion);
  if (runtime === undefined || api === undefined) return undefined;

  const judged = judgeCollection({
    mods: manifest.mods.map((m) => ({
      name: m.name,
      compareKey: m.compareKey,
      ...(m.state.nativePlugins !== undefined ? { nativePlugins: m.state.nativePlugins } : {}),
    })),
    rules: manifest.rules,
    target: { runtime, api },
  });
  return {
    judgedFor: {
      version: installedVersion,
      ...(args.store !== undefined ? { store: args.store } : {}),
    },
    loads: judged.loads,
    unverified: judged.unverified,
    cannotLoad: judged.cannotLoad.length,
    // Undetermined conflicts are plugins whose winning copy could not be
    // decided; from the player's side that is the same "cannot tell" as an
    // unreadable DLL, and folding them in keeps the four counts a partition.
    unknown: judged.unknown.length + judged.undeterminedConflicts.length,
  };
}
