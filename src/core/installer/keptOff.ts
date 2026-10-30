/**
 * ──────────────────────────────────────────────────────────────────────
 * Collection mods the player switched off stay off across updates.
 *
 * alasdairn (Ivy, 2026-10-31): he switches "Collection of textures and
 * presets" off for his own texture setup, and every update switched it back
 * on, because the installer enables every collection mod in the profile it
 * builds. Approved by him ("Build it"): an update offers each collection mod
 * the player switched off, kept off by default, one tick to turn it back on,
 * and the answer is remembered for the next update.
 *
 * A kept-off mod is handled exactly like an optional mod left out: not
 * enabled, its plugins absent, never a failure, never "missing" in Doctor.
 * That is the whole mechanism; `applyKeptOff` marks it optional for the run.
 *
 * ─── REFUSED WHEN ANOTHER COLLECTION PLUGIN NEEDS IT ──────────────────
 * A mod whose plugin is a MASTER of another collection plugin cannot be off:
 * the game stops at the main menu over a missing master. Those are listed
 * with the plugins that need them and switched on as before.
 * ──────────────────────────────────────────────────────────────────────
 */
import * as fsp from "fs/promises";

import type { EhcollMod } from "../../types/ehcoll";
import type { DriverContext } from "../../types/installDriver";
import { getEventHorizonDir } from "../paths/appDataPaths";
import { ehLog } from "../logging/ehLog";

export type KeptOffOffer = {
  compareKey: string;
  name: string;
  /** Why it is offered: switched off in the previous revision's profile, or kept off at the last update. */
  why: "switched-off" | "remembered";
};
export type KeptOffRefusal = { compareKey: string; name: string; neededBy: string[] };

const lower = (s: string): string => s.toLowerCase();
const pluginOf = (p: string): string | undefined =>
  /\.(esp|esm|esl)$/i.test(p) ? lower(p.split(/[\\/]/).pop()!) : undefined;

/** A resolution EH can leave off: the mod is already in the player's pool. */
export function isAlreadyInstalled(decision: { kind: string }): boolean {
  return decision.kind.endsWith("already-installed");
}

/**
 * The collection mods to offer: already installed, not optional or a version
 * (those have their own choice), and either switched off in the profile the
 * previous revision lives in or kept off at the last update.
 */
export function findKeptOffOffers(args: {
  manifestMods: readonly EhcollMod[];
  resolutions: ReadonlyArray<{ compareKey: string; name: string; decision: { kind: string }; existingModId?: string }>;
  /** The previous install of this collection: its mods and the profile they were enabled in. */
  receipt?: { vortexProfileId: string; mods: ReadonlyArray<{ compareKey: string; vortexModId: string }> };
  /** `modState` of the receipt's profile, when that profile still exists. */
  previousModState?: Readonly<Record<string, { enabled?: boolean } | undefined>>;
  remembered: ReadonlySet<string>;
}): KeptOffOffer[] {
  const byKey = new Map(args.manifestMods.map((m) => [m.compareKey, m]));
  const receiptIds = new Map((args.receipt?.mods ?? []).map((m) => [m.compareKey, m.vortexModId]));
  const out: KeptOffOffer[] = [];
  for (const r of args.resolutions) {
    const mod = byKey.get(r.compareKey);
    if (mod === undefined || mod.state?.optional === true || mod.state?.variant !== undefined) continue;
    if (!isAlreadyInstalled(r.decision)) continue;
    const previousId = receiptIds.get(r.compareKey);
    const switchedOff =
      previousId !== undefined &&
      args.previousModState !== undefined &&
      args.previousModState[previousId]?.enabled !== true;
    if (switchedOff) {
      out.push({ compareKey: r.compareKey, name: r.name, why: "switched-off" });
      continue;
    }
    // Kept off at the last update, so the receipt does not list it: still off
    // in that profile unless the player has switched it back on since.
    const stillOff =
      previousId === undefined &&
      (r.existingModId === undefined || args.previousModState?.[r.existingModId]?.enabled !== true);
    if (args.remembered.has(r.compareKey) && stillOff) out.push({ compareKey: r.compareKey, name: r.name, why: "remembered" });
  }
  return out;
}

/**
 * Split offers into the ones that may stay off and the ones a collection
 * plugin needs as a master. `mastersOf` gives the masters of every OTHER
 * collection plugin that will be installed, by lowercased plugin name.
 */
export function refuseNeededMasters(
  offers: readonly KeptOffOffer[],
  manifestMods: readonly EhcollMod[],
  mastersOf: ReadonlyMap<string, readonly string[]>,
): { offers: KeptOffOffer[]; refused: KeptOffRefusal[] } {
  const byKey = new Map(manifestMods.map((m) => [m.compareKey, m]));
  const offKeys = new Set(offers.map((o) => o.compareKey));
  const pluginsOf = (key: string): string[] =>
    (byKey.get(key)?.state?.stagingFiles ?? []).map((f) => pluginOf(f.path)).filter((n): n is string => n !== undefined);
  const offPlugins = new Set(offers.flatMap((o) => pluginsOf(o.compareKey)));
  const keepPlugins = new Set(
    manifestMods.filter((m) => !offKeys.has(m.compareKey)).flatMap((m) => pluginsOf(m.compareKey)),
  );
  const kept: KeptOffOffer[] = [];
  const refused: KeptOffRefusal[] = [];
  for (const o of offers) {
    const mine = new Set(pluginsOf(o.compareKey));
    const neededBy: string[] = [];
    for (const [plugin, masters] of mastersOf) {
      if (mine.has(plugin) || offPlugins.has(plugin) || !keepPlugins.has(plugin)) continue;
      if (masters.some((m) => mine.has(lower(m)))) neededBy.push(plugin);
    }
    if (neededBy.length > 0) refused.push({ compareKey: o.compareKey, name: o.name, neededBy: neededBy.sort() });
    else kept.push(o);
  }
  return { offers: kept, refused };
}

/**
 * The run's view of a kept-off mod: optional and left out, so every phase
 * that already handles a left-out optional mod handles this one.
 */
export function applyKeptOff(ctx: DriverContext): DriverContext {
  const keys = new Set(ctx.decisions.keptOff ?? []);
  if (keys.size === 0) return ctx;
  const markMod = (m: EhcollMod): EhcollMod => (keys.has(m.compareKey) ? { ...m, state: { ...m.state, optional: true } } : m);
  ehLog("info", "install.kept-off", { count: keys.size, compareKeys: [...keys] });
  return {
    ...ctx,
    plan: {
      ...ctx.plan,
      manifest: { ...ctx.plan.manifest, mods: ctx.plan.manifest.mods.map(markMod) },
      modResolutions: ctx.plan.modResolutions.map((r) => (keys.has(r.compareKey) ? { ...r, optional: true as const } : r)),
    },
    decisions: {
      ...ctx.decisions,
      optionalSkipped: [...new Set([...(ctx.decisions.optionalSkipped ?? []), ...keys])],
    },
  };
}

/** The package's mods with the kept-off ones marked optional, for checks that judge an absent mod (Doctor). */
export function markKeptOffOptional<M extends { mods: EhcollMod[] }>(manifest: M, keys: ReadonlySet<string>): M {
  if (keys.size === 0) return manifest;
  return {
    ...manifest,
    mods: manifest.mods.map((m) => (keys.has(m.compareKey) ? { ...m, state: { ...m.state, optional: true } } : m)),
  };
}

function keptOffFile(packageId: string): string {
  return getEventHorizonDir("choices", `${packageId}.kept-off.json`);
}

/** The collection mods the player kept off at the last update. Empty when none. */
export async function readKeptOff(packageId: string): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(await fsp.readFile(keptOffFile(packageId), "utf8")) as { keptOff?: unknown };
    return new Set(Array.isArray(parsed.keptOff) ? parsed.keptOff.filter((k): k is string => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

/** Remember what the player kept off, for the next update. Never throws. */
export async function saveKeptOff(packageId: string, keptOff: readonly string[]): Promise<void> {
  try {
    const file = keptOffFile(packageId);
    await fsp.mkdir(getEventHorizonDir("choices"), { recursive: true });
    await fsp.writeFile(file, JSON.stringify({ keptOff: [...keptOff].sort() }, null, 2), "utf8");
    ehLog("info", "kept-off.saved", { packageId, count: keptOff.length });
  } catch (err) {
    ehLog("warn", "kept-off.save-failed", { packageId, err });
  }
}
