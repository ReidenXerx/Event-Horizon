/**
 * ──────────────────────────────────────────────────────────────────────
 * The build's proof that each store build is the build it says it is.
 *
 * The curator plays one store (Meridia: GOG Skyrim), so nobody on the team
 * can launch the Steam builds they ship. What can be checked is what each
 * DLL declares: a member tagged `store: "steam"` whose plugin does not list
 * Steam's runtime is a false claim, and every Steam player would get a mod
 * that silently does nothing. That REFUSES the build (owner, 2026-10-18:
 * "refuse to build if a Steam build doesn't list Steam 1.6.1170").
 *
 * Untagged plugins that cannot load on the other store are only reported:
 * they are the list of builds the curator has not added yet, which is
 * today's state, not a regression.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { EhcollManifest } from "../../types/ehcoll";
import { extenderApiFor, judgeCollection, runtimeIdFor } from "../environment/nativePluginCompat";
import { STORE_BUILDS } from "../environment/storeBuilds";
import {
  GAME_STORES,
  asGameStore,
  modsForStore,
  storeGroupProblems,
  variantGroupsOf,
  type GameStore,
} from "../installer/variantGroups";

export type StoreBuildCheck = {
  /** Each one refuses the build. */
  refusals: string[];
  /** Said to the curator; the build goes ahead. */
  warnings: string[];
  /** Per store judged: what was judged and against which build. */
  judged: Array<{ store: GameStore; version: string; runtime: string; loads: number; cannotLoad: number }>;
};

const label = (s: GameStore): string => (s === "gog" ? "GOG" : "Steam");

/** `skse64_1_6_1170.dll` / `f4se_1_10_163.dll` at any depth: the game build each extender runtime is for. */
function extenderRuntimeBuilds(files: ReadonlyArray<{ path: string }>): Array<{ file: string; version: string }> {
  const out: Array<{ file: string; version: string }> = [];
  for (const f of files) {
    const base = f.path.split(/[\\/]/).pop() ?? "";
    const m = /^(?:skse64|f4se)_(\d+)_(\d+)_(\d+)\.dll$/i.exec(base);
    if (m !== null) out.push({ file: base, version: `${m[1]}.${m[2]}.${m[3]}` });
  }
  return out;
}

/** "1.6.1170" and "1.6.1170.0" are one build. */
const sameBuild = (a: string, b: string): boolean => {
  const norm = (v: string): string => v.split(".").slice(0, 3).join(".");
  return norm(a) === norm(b);
};

export function checkStoreBuilds(manifest: Pick<EhcollManifest, "game" | "mods" | "rules">): StoreBuildCheck {
  const out: StoreBuildCheck = { refusals: [], warnings: [], judged: [] };
  const tagged = new Set(manifest.mods.map((m) => m.state.variant?.store).filter((s): s is GameStore => s !== undefined));
  if (tagged.size === 0) return out;

  out.refusals.push(...storeGroupProblems(variantGroupsOf(manifest.mods)));

  const g = manifest.game;
  const curatorStore = asGameStore(g.store);
  for (const store of GAME_STORES) {
    // Every store the curator built for, plus each one they tagged a build for.
    if (store !== curatorStore && !tagged.has(store)) continue;
    const version = store === curatorStore ? g.version : STORE_BUILDS[g.id]?.[store];
    const runtime = version === undefined ? undefined : runtimeIdFor(g.id, version, store);
    const api = version === undefined ? undefined : extenderApiFor(g.id, version);
    if (version === undefined || runtime === undefined || api === undefined) {
      if (tagged.has(store)) {
        out.warnings.push(
          `The ${label(store)} builds could not be checked: Event Horizon does not know ${label(store)}'s build of ${g.id}.`,
        );
      }
      continue;
    }
    const mods = modsForStore(manifest.mods, store);
    const j = judgeCollection({
      mods: mods.map((m) => ({
        name: m.name,
        compareKey: m.compareKey,
        ...(m.state.nativePlugins !== undefined ? { nativePlugins: m.state.nativePlugins } : {}),
      })),
      rules: manifest.rules,
      target: { runtime, api },
    });
    out.judged.push({ store, version, runtime, loads: j.loads, cannotLoad: j.cannotLoad.length });

    const taggedNames = new Set(mods.filter((m) => m.state.variant?.store === store).map((m) => m.name));
    // The script extender itself is no plugin and declares nothing, but its
    // runtime DLL is named for the game build it runs: skse64_1_6_1170.dll.
    for (const m of mods.filter((x) => x.state.variant?.store === store)) {
      for (const built of extenderRuntimeBuilds(m.state.stagingFiles ?? [])) {
        if (sameBuild(built.version, version)) continue;
        out.refusals.push(
          `"${m.name}" is marked as the ${label(store)} build, but ships ${built.file}, the script extender for ` +
            `${built.version}; ${label(store)}'s build is ${version}.`,
        );
      }
    }
    for (const f of j.cannotLoad.filter((f) => taggedNames.has(f.mod))) {
      out.refusals.push(
        `"${f.mod}" is marked as the ${label(store)} build, but ${f.path} cannot load on ${label(store)} ${version}: ${f.why}.`,
      );
    }
    // The curator's own store is covered by the build's general plugin check.
    if (store === curatorStore) continue;
    const missing = j.cannotLoad.filter((f) => !taggedNames.has(f.mod));
    if (missing.length > 0) {
      out.warnings.push(
        [
          `${missing.length} script-extender plugin${missing.length === 1 ? "" : "s"} cannot load on ${label(store)} ${version} ` +
            `and ${missing.length === 1 ? "has" : "have"} no ${label(store)} build in the collection, so ${label(store)} players ` +
            `still swap ${missing.length === 1 ? "it" : "them"} by hand:`,
          ...missing.map((f) => `  • ${f.path} (${f.mod}): ${f.why}.`),
        ].join("\n"),
      );
    }
  }
  return out;
}
