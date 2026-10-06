/**
 * ──────────────────────────────────────────────────────────────────────
 * "Keep my version": a player's own file of a collection mod's Nexus page.
 *
 * alasdairn (Ivy, 2026-10-06) swapped VTAC Operative Gear's 2k file for the
 * 4k file of the same Nexus mod. EH tracks the exact file, so the Doctor
 * called the 2k one missing and every update brought it back. Owner poll:
 * "Keep my version". The Doctor offers it when a collection mod is missing or
 * off while another file of the SAME Nexus page is installed and enabled;
 * the player confirms. Never automatic: a same-page file can be a separate
 * patch, not a variant, and only the player knows which.
 *
 * Accepting it rewrites the receipt (the player's file stands for the
 * collection's, owned by the player, never removed by an uninstall: NS-2)
 * and remembers the choice per collection, so the next update keeps that
 * file through the existing keep-existing path instead of reinstalling the
 * collection's. A choice is tied to the collection mod's identity: when the
 * curator changes that mod, it lapses and the new file installs.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fsp from "fs/promises";
import * as path from "path";

import type { InstallReceipt } from "../../types/installLedger";
import { ehLog } from "../logging/ehLog";
import { getEventHorizonDir } from "../paths/appDataPaths";

export type PoolNexusMod = { vortexModId: string; name: string; modId?: number; fileId?: number; installTime?: unknown };

export type PlayerVariant = {
  compareKey: string;
  /** The collection mod as the receipt names it. */
  name: string;
  /** The collection's own copy, when still in the pool. */
  collectionModId: string;
  variant: { vortexModId: string; name: string; modId: number; fileId: number };
};

export type VariantChoice = { nexusModId: number; nexusFileId: number; name: string };

/** `nexus:<modId>:<fileId>` → the ids; anything else → undefined. */
export function nexusIdsOfKey(compareKey: string): { modId: number; fileId: number } | undefined {
  const m = /^nexus:(\d+):(\d+)$/.exec(compareKey);
  return m === null ? undefined : { modId: Number(m[1]), fileId: Number(m[2]) };
}

/**
 * Collection mods that are missing or off while another enabled file of the
 * same Nexus page is installed. A file already standing for another
 * collection mod is never offered.
 */
export function findPlayerVariants(input: {
  receiptMods: ReadonlyArray<{ vortexModId: string; compareKey: string; name: string }>;
  pool: readonly PoolNexusMod[];
  enabled: ReadonlySet<string>;
}): PlayerVariant[] {
  const inPool = new Set(input.pool.map((m) => m.vortexModId));
  const claimed = new Set(input.receiptMods.map((m) => m.vortexModId));
  const out: PlayerVariant[] = [];
  for (const r of input.receiptMods) {
    const ids = nexusIdsOfKey(r.compareKey);
    if (ids === undefined) continue;
    const satisfied = inPool.has(r.vortexModId) && input.enabled.has(r.vortexModId);
    if (satisfied) continue;
    const candidate = input.pool.find(
      (m) =>
        m.modId === ids.modId &&
        m.fileId !== undefined &&
        m.fileId !== ids.fileId &&
        input.enabled.has(m.vortexModId) &&
        !claimed.has(m.vortexModId),
    );
    if (candidate === undefined) continue;
    claimed.add(candidate.vortexModId);
    out.push({
      compareKey: r.compareKey,
      name: r.name,
      collectionModId: r.vortexModId,
      variant: { vortexModId: candidate.vortexModId, name: candidate.name, modId: ids.modId, fileId: candidate.fileId! },
    });
  }
  return out;
}

/**
 * The receipt with each variant standing for its collection mod. The
 * collection's own copy, when still in the pool and ours, moves to
 * `retiredMods` with its install time, so an uninstall or an old-profile
 * cleanup can still remove it — and only it (Vortex reuses ids).
 */
export function applyPlayerVariants(
  receipt: InstallReceipt,
  variants: readonly PlayerVariant[],
  pool: readonly PoolNexusMod[],
): InstallReceipt {
  if (variants.length === 0) return receipt;
  const byKey = new Map(variants.map((v) => [v.compareKey, v] as const));
  const poolById = new Map(pool.map((m) => [m.vortexModId, m] as const));
  const retired = [...(receipt.retiredMods ?? [])];
  const mods = receipt.mods.map((m) => {
    const v = byKey.get(m.compareKey);
    if (v === undefined) return m;
    const original = poolById.get(m.vortexModId);
    if (original !== undefined && m.ownership === "installed" && typeof original.installTime === "string") {
      retired.push({
        vortexModId: m.vortexModId,
        compareKey: m.compareKey,
        name: m.name,
        retiredInVersion: receipt.packageVersion,
        installTime: original.installTime,
      });
    }
    const { stagingSetHash: _h, stagingSetPaths: _p, displacedModId: _d, ...rest } = m;
    return { ...rest, vortexModId: v.variant.vortexModId, ownership: "adopted" as const };
  });
  return { ...receipt, mods, ...(retired.length > 0 ? { retiredMods: retired } : {}) };
}

function choicesFile(packageId: string): string {
  return path.join(getEventHorizonDir("choices"), `${packageId}.json`);
}

/** The player's remembered variant choices for one collection, by collection-mod compareKey. */
export async function readVariantChoices(packageId: string): Promise<Map<string, VariantChoice>> {
  try {
    const raw = JSON.parse(await fsp.readFile(choicesFile(packageId), "utf8")) as { variants?: Record<string, unknown> };
    const out = new Map<string, VariantChoice>();
    for (const [key, v] of Object.entries(raw.variants ?? {})) {
      const c = v as Partial<VariantChoice>;
      if (typeof c.nexusModId === "number" && typeof c.nexusFileId === "number") {
        out.set(key, { nexusModId: c.nexusModId, nexusFileId: c.nexusFileId, name: typeof c.name === "string" ? c.name : key });
      }
    }
    return out;
  } catch {
    return new Map();
  }
}

export async function saveVariantChoices(packageId: string, variants: readonly PlayerVariant[]): Promise<void> {
  const current = await readVariantChoices(packageId);
  for (const v of variants) {
    current.set(v.compareKey, { nexusModId: v.variant.modId, nexusFileId: v.variant.fileId, name: v.variant.name });
  }
  const file = choicesFile(packageId);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify({ variants: Object.fromEntries(current) }, null, 2), "utf8");
  ehLog("info", "player-variants.saved", { packageId, variants: variants.map((v) => ({ key: v.compareKey, file: v.variant.name })) });
}
