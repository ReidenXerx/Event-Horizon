/**
 * The mods "Repair all" switches off: on in a collection's profile, and not
 * part of it.
 *
 * Owner, 2026-11-06 (ilhamitaa24, Ivy): a player clicked Curator Tools' "Make
 * it work" and got 8 extra mods, their rules cycled and Doctor could not
 * deploy. "Repair all should disable extra mods also because its reversible
 * action and it will help novices that clicked random buttons to restore
 * working state." Disabled, never removed (NS-2), and listed by name so a
 * player re-enables their own. A player who adds mods on purpose keeps the
 * finding on purpose.
 *
 * The judging is the Doctor's existing list (modsOutsideCollection, the card
 * helpers copy): "extra" and "dropped by the curator" are switched off;
 * another file of a collection mod's page is the player's own version and
 * stays on, and so does every mod of another collection in the same profile.
 */

import type { InstallReceipt } from "../../types/installLedger";
import type { PoolNexusMod } from "../installer/playerVariants";
import { modsOutsideCollection, type OutsideMod } from "./modsOutsideCollection";

export type ExtraMod = Pick<OutsideMod, "vortexModId" | "name">;

export function modsToSwitchOff(args: {
  receipt: {
    mods: ReadonlyArray<{ vortexModId: string; compareKey: string; name: string }>;
    retiredMods?: ReadonlyArray<{ vortexModId: string; retiredInVersion?: string }>;
  };
  /** Mod ids of other collections installed into the same profile. */
  otherCollectionModIds: readonly string[];
  pool: readonly PoolNexusMod[];
  /** Mod ids enabled in the collection's profile. */
  enabled: ReadonlySet<string>;
}): ExtraMod[] {
  const mods = Object.fromEntries(
    args.pool.map((m) => [
      m.vortexModId,
      {
        ...(m.modType !== undefined ? { type: m.modType } : {}),
        attributes: { name: m.name, ...(m.modId !== undefined ? { modId: m.modId } : {}) },
      },
    ]),
  );
  const modState = Object.fromEntries([...args.enabled].map((id) => [id, { enabled: true }]));
  const found = modsOutsideCollection({
    // Only the fields it reads: mod ids, compareKeys, names, and the retired list.
    receipt: args.receipt as unknown as Pick<InstallReceipt, "mods" | "retiredMods">,
    otherReceipts: [{ mods: args.otherCollectionModIds.map((vortexModId) => ({ vortexModId })) } as unknown as Pick<InstallReceipt, "mods">],
    mods,
    modState,
  });
  return [...found.extra, ...found.dropped]
    .map((m) => ({ vortexModId: m.vortexModId, name: m.name }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}
