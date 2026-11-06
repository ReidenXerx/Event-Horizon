/**
 * Mods switched on in a collection's profile that are not part of it.
 *
 * Owner, 2026-11-06 (ilhamitaa24, Ivy): a player clicked Curator Tools' "Make
 * it work" and got 8 extra mods, their rules cycled and Doctor could not
 * deploy. "Repair all should disable extra mods also because its reversible
 * action and it will help novices that clicked random buttons to restore
 * working state." Disabled, never removed (NS-2: never destroy a mod Event
 * Horizon did not install), and listed by name so a player re-enables their
 * own. A player who adds mods on purpose keeps the finding on purpose.
 */

import type { PoolNexusMod } from "../installer/playerVariants";

export type ExtraMod = { vortexModId: string; name: string };

/** Vortex's entry for a collection itself (type "collection") is not a mod a player plays. */
const NOT_A_MOD_TYPES = new Set(["collection"]);

export function findExtraMods(args: {
  /** Vortex mod ids the collection's receipt lists. */
  collectionModIds: ReadonlySet<string>;
  /** Mod ids enabled in the collection's profile. */
  enabled: ReadonlySet<string>;
  pool: readonly PoolNexusMod[];
  /** The player's own file standing for a collection mod ("Your own versions"): not extra. */
  variantModIds: ReadonlySet<string>;
}): ExtraMod[] {
  const byId = new Map(args.pool.map((m) => [m.vortexModId, m]));
  const out: ExtraMod[] = [];
  for (const id of args.enabled) {
    if (args.collectionModIds.has(id) || args.variantModIds.has(id)) continue;
    const mod = byId.get(id);
    if (mod === undefined) continue; // enabled in the profile but not installed: nothing loads, nothing to switch off
    if (mod.modType !== undefined && NOT_A_MOD_TYPES.has(mod.modType)) continue;
    out.push({ vortexModId: id, name: mod.name });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
