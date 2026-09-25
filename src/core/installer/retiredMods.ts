/**
 * ──────────────────────────────────────────────────────────────────────
 * Remembering the mods a collection dropped, so uninstall can find them.
 *
 * The receipt is one file per collection and every update rewrites it with
 * the mods of the revision just installed. A mod the curator dropped fell out
 * of it, and with it went the only proof that Event Horizon had installed it.
 * The mod itself stays in the player's pool, because an update never deletes
 * (NS-2). So "Uninstall this collection" could reach only the latest
 * revision's mods, and a player who followed a collection for twenty
 * revisions kept every mod it had ever dropped, with nothing able to say
 * where those mods came from.
 *
 * `carryRetiredMods` runs when a receipt is written. It keeps every mod that
 * was OURS in the previous receipt (live or retired) and is not in the new
 * revision, stamped with the version that dropped it.
 *
 * ─── WHY THE INSTALL TIME RIDES ALONG ──────────────────────────────────
 * Vortex derives a mod's id from its archive name and reuses it. A player who
 * deletes a retired mod and later installs their own copy of the same file
 * gets the same id back. Matching on the id alone, the uninstall would then
 * delete THEIR mod, which is exactly the failure NS-2 exists to prevent. So
 * each entry records the mod's `installTime` at the moment it retired, and the
 * uninstall removes a mod only while that time still matches. A mod that is no
 * longer in the pool is not carried at all.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { InstallReceiptMod, InstallReceiptRetiredMod } from "../../types/installLedger";

/** A Vortex `installTime` attribute as epoch milliseconds, or undefined when it cannot be read. */
export function installTimeMs(value: unknown): number | undefined {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : undefined;
  }
  if (typeof value === "string" && value.length > 0) {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

export function carryRetiredMods(args: {
  /** The previous receipt's `mods`. */
  previousMods: readonly InstallReceiptMod[];
  /** The previous receipt's `retiredMods`. */
  previousRetired: readonly InstallReceiptRetiredMod[];
  /** Vortex mod ids in the receipt being written. */
  currentModIds: ReadonlySet<string>;
  /** The version being installed now, which is the one that dropped them. */
  newVersion: string;
  /**
   * Live `installTime` per mod id in the pool. `undefined`: the mod is gone and is not carried.
   * `NaN`: the mod is there but its time cannot be read, so it is carried with no time and the
   * uninstall will leave it alone.
   */
  liveInstallTime: (vortexModId: string) => number | undefined;
}): InstallReceiptRetiredMod[] {
  const out = new Map<string, InstallReceiptRetiredMod>();

  for (const r of args.previousRetired) {
    if (args.currentModIds.has(r.vortexModId)) continue; // back in the collection
    const live = args.liveInstallTime(r.vortexModId);
    if (live === undefined) continue; // no longer in the pool
    // A different installation now holds the id: it is not ours any more.
    if (r.installTime !== undefined && installTimeMs(r.installTime) !== live) continue;
    out.set(r.vortexModId, r);
  }

  for (const m of args.previousMods) {
    if (m.ownership !== "installed") continue; // only what we can prove is ours
    if (args.currentModIds.has(m.vortexModId)) continue;
    if (out.has(m.vortexModId)) continue;
    const live = args.liveInstallTime(m.vortexModId);
    if (live === undefined) continue;
    out.set(m.vortexModId, {
      vortexModId: m.vortexModId,
      compareKey: m.compareKey,
      name: m.name,
      retiredInVersion: args.newVersion,
      ...(Number.isNaN(live) ? {} : { installTime: new Date(live).toISOString() }),
    });
  }

  return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
