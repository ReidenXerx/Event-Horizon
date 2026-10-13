/**
 * Mods enabled in a collection's profile that the collection did not put there.
 *
 * Asked for by a Meridia helper (2026-10-14): a player with a broken game and
 * twenty-five leftovers from an old list looks, from the outside, exactly like
 * a broken collection. The list is what a helper asks for first, so the Doctor
 * shows it and copies it. It only LISTS: removing a mod Event Horizon did not
 * install is the player's call (NS-2).
 *
 * Three kinds, because they mean different things to a helper:
 *   - extra: nothing in the collection, the first suspects;
 *   - another file of a collection mod's Nexus page: usually a kept newer
 *     version (Keep my version), named beside the collection's own;
 *   - dropped by the curator in an update: installed by us, still enabled.
 * Mods of another collection installed into the same profile are not extra.
 */

import type { InstallReceipt } from "../../types/installLedger";

export type VortexModLike = {
  type?: string;
  attributes?: Record<string, unknown>;
};

export type OutsideMod = {
  vortexModId: string;
  name: string;
  /** The Nexus mod page, when Vortex knows it. */
  nexusModId?: number;
  /** For `otherFiles`: the collection mod from the same Nexus page. */
  collectionMod?: string;
  /** For `dropped`: the collection version that dropped it. */
  droppedIn?: string;
};

export type ModsOutsideCollection = {
  extra: OutsideMod[];
  otherFiles: OutsideMod[];
  dropped: OutsideMod[];
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** The name Vortex shows in its mod list. */
export function vortexModName(id: string, mod: VortexModLike | undefined): string {
  const a = mod?.attributes ?? {};
  return str(a.customFileName) ?? str(a.logicalFileName) ?? str(a.name) ?? id;
}

function nexusModIdOf(mod: VortexModLike | undefined): number | undefined {
  const raw = mod?.attributes?.modId;
  const n = typeof raw === "string" ? Number(raw) : raw;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined;
}

/** `nexus:<modId>:<fileId>` → modId. */
function pageOfCompareKey(compareKey: string): number | undefined {
  const m = /^nexus:(\d+):/.exec(compareKey);
  return m !== null ? Number(m[1]) : undefined;
}

const byName = (a: OutsideMod, b: OutsideMod): number => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

export function modsOutsideCollection(args: {
  receipt: Pick<InstallReceipt, "mods" | "retiredMods">;
  /** Other collections installed into the same profile: their mods are theirs, not extra. */
  otherReceipts?: ReadonlyArray<Pick<InstallReceipt, "mods">>;
  /** Vortex's mods for the game. */
  mods: Readonly<Record<string, VortexModLike>>;
  /** The profile's modState. */
  modState: Readonly<Record<string, { enabled?: boolean } | undefined>>;
}): ModsOutsideCollection {
  const ours = new Set(args.receipt.mods.map((m) => m.vortexModId));
  const theirs = new Set((args.otherReceipts ?? []).flatMap((r) => r.mods.map((m) => m.vortexModId)));
  const dropped = new Map((args.receipt.retiredMods ?? []).map((r) => [r.vortexModId, r]));
  const pages = new Map<number, string>();
  for (const m of args.receipt.mods) {
    const page = pageOfCompareKey(m.compareKey);
    if (page !== undefined && !pages.has(page)) pages.set(page, m.name);
  }

  const out: ModsOutsideCollection = { extra: [], otherFiles: [], dropped: [] };
  for (const [id, state] of Object.entries(args.modState)) {
    if (state?.enabled !== true || ours.has(id)) continue;
    const mod = args.mods[id];
    // Gone from the pool, or the collection's own entry in Vortex's list.
    if (mod === undefined || mod.type === "collection") continue;
    const retired = dropped.get(id);
    if (retired !== undefined) {
      out.dropped.push({ vortexModId: id, name: vortexModName(id, mod), droppedIn: retired.retiredInVersion });
      continue;
    }
    if (theirs.has(id)) continue;
    const nexusModId = nexusModIdOf(mod);
    const entry: OutsideMod = {
      vortexModId: id,
      name: vortexModName(id, mod),
      ...(nexusModId !== undefined ? { nexusModId } : {}),
    };
    const collectionMod = nexusModId !== undefined ? pages.get(nexusModId) : undefined;
    if (collectionMod !== undefined) out.otherFiles.push({ ...entry, collectionMod });
    else out.extra.push(entry);
  }
  out.extra.sort(byName);
  out.otherFiles.sort(byName);
  out.dropped.sort(byName);
  return out;
}

/** Plain text for a Discord or Nexus post: no paths, nothing to redact. */
export function describeModsOutsideCollection(packageName: string, found: ModsOutsideCollection): string {
  const page = (m: OutsideMod): string => (m.nexusModId !== undefined ? ` (Nexus ${m.nexusModId})` : "");
  const lines = [`Mods enabled in the ${packageName} profile that the collection did not install:`];
  lines.push(``, `Not in the collection (${found.extra.length}):`);
  lines.push(...(found.extra.length > 0 ? found.extra.map((m) => `- ${m.name}${page(m)}`) : ["- none"]));
  if (found.otherFiles.length > 0) {
    lines.push(``, `Another file of a collection mod's page (${found.otherFiles.length}):`);
    lines.push(...found.otherFiles.map((m) => `- ${m.name}${page(m)}, collection has ${m.collectionMod}`));
  }
  if (found.dropped.length > 0) {
    lines.push(``, `Dropped by the curator in an update, still enabled (${found.dropped.length}):`);
    lines.push(...found.dropped.map((m) => `- ${m.name}, dropped in ${m.droppedIn}`));
  }
  return lines.join("\n");
}
