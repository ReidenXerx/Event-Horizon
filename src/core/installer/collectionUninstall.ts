/**
 * ──────────────────────────────────────────────────────────────────────
 * What "Uninstall this collection" removes, what it keeps, and why.
 *
 * Pure: the caller reads Vortex's state and the receipts, and this decides.
 * The dialog shows the result before anything happens, and the executor does
 * exactly what the dialog showed, so what the player agreed to and what runs
 * are the same list.
 *
 * ─── WHAT IS REMOVED ───────────────────────────────────────────────────
 * Only mods PROVEN ours (NS-2): the receipt's mods with `ownership:
 * "installed"`, plus `retiredMods`, the mods earlier revisions installed and
 * later revisions dropped. A retired mod is removed only while its Vortex
 * `installTime` still matches the one recorded when it retired. Vortex reuses
 * mod ids, so an id alone could point at a mod the player installed later.
 *
 * ─── WHAT IS KEPT, EVEN THOUGH IT IS OURS ─────────────────────────────
 *  • used by another installed collection: removing it would break that one;
 *  • enabled in a profile that is not this collection's: the player chose to
 *    use it outside the collection, so it has become theirs to remove.
 * Mods the collection adopted (the player already had them) are never
 * candidates, only counted.
 *
 * ─── WHICH PROFILES ────────────────────────────────────────────────────
 * The collection's profiles are the ones Event Horizon created for it: the
 * receipt's own profile when the install made a fresh one, plus every
 * profile named the way installs of this collection name them
 * (profileCleanup's anchored rule). A current-profile install went into the
 * player's OWN profile, so that one is never offered. Vortex's active and
 * last-active profiles cannot be deleted from here (see profileCleanup.ts),
 * so they are listed with the reason.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { InstallReceipt } from "../../types/installLedger";
import { isCollectionProfileName } from "./profileCleanup";
import { installTimeMs } from "./retiredMods";

export type PoolMod = { installTime?: unknown };

export type UninstallProfileView = {
  id: string;
  name: string;
  gameId?: string;
  /** Mod ids enabled in this profile. */
  enabled: ReadonlySet<string>;
};

export type ModToRemove = {
  vortexModId: string;
  name: string;
  /** `current`: in the installed revision. `retired`: dropped by a later revision. */
  from: "current" | "retired";
  /** The player's own copy this mod displaced in the collection profile, to switch back on. */
  displacedModId?: string;
};

export type KeepReason =
  | { kind: "other-collection"; collections: string[] }
  | { kind: "your-profile"; profiles: string[] }
  | { kind: "unproven"; why: string };

export type ModToKeep = { vortexModId: string; name: string; reason: KeepReason };

export type ProfileChoice = {
  id: string;
  name: string;
  /** False when this profile cannot be deleted from here; `reason` says why. */
  deletable: boolean;
  reason?: string;
};

export type UninstallPlan = {
  packageId: string;
  packageName: string;
  gameId: string;
  remove: ModToRemove[];
  keep: ModToKeep[];
  /** Mods in the receipt that the player already had; never removed. */
  notOursCount: number;
  /** Mods proven ours that are no longer in the pool (the player removed them). */
  alreadyGoneCount: number;
  profiles: ProfileChoice[];
};

export function planCollectionUninstall(input: {
  receipt: InstallReceipt;
  /** Every OTHER receipt on this machine. */
  otherReceipts: readonly InstallReceipt[];
  /** Vortex's mod pool for the receipt's game: `persistent.mods[gameId]`. */
  pool: Readonly<Record<string, PoolMod>>;
  profiles: readonly UninstallProfileView[];
  activeProfileId?: string | undefined;
  lastActiveProfileId?: string | undefined;
}): UninstallPlan {
  const { receipt } = input;
  const gameId = receipt.gameId;

  // ── The collection's profiles ─────────────────────────────────────────
  const gameProfiles = input.profiles.filter((p) => p.gameId === undefined || p.gameId === gameId);
  const collectionProfileIds = new Set<string>();
  for (const p of gameProfiles) {
    if (isCollectionProfileName(receipt.packageName, p.name)) collectionProfileIds.add(p.id);
  }
  const receiptProfileIsOurs = receipt.installTargetMode === "fresh-profile";
  if (receiptProfileIsOurs) collectionProfileIds.add(receipt.vortexProfileId);

  const profiles: ProfileChoice[] = gameProfiles
    .filter((p) => collectionProfileIds.has(p.id))
    .map((p): ProfileChoice => {
      if (p.id === input.activeProfileId) {
        return {
          id: p.id,
          name: p.name,
          deletable: false,
          reason: "Vortex is using it right now. Switch to another profile first if you want it gone.",
        };
      }
      if (p.id === input.lastActiveProfileId) {
        return {
          id: p.id,
          name: p.name,
          deletable: false,
          reason: "Vortex remembers it as this game's last profile, and would be left pointing at nothing.",
        };
      }
      return { id: p.id, name: p.name, deletable: true };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // ── Who else uses a mod ───────────────────────────────────────────────
  const usedByOther = new Map<string, Set<string>>();
  for (const other of input.otherReceipts) {
    if (other.packageId === receipt.packageId || other.gameId !== gameId) continue;
    const ids = [...other.mods.map((m) => m.vortexModId), ...(other.retiredMods ?? []).map((m) => m.vortexModId)];
    for (const id of ids) {
      const set = usedByOther.get(id) ?? new Set<string>();
      set.add(other.packageName);
      usedByOther.set(id, set);
    }
  }
  // Profiles whose enabled mods are the collection's doing: its own profiles, and — for a
  // current-profile install — the player's profile it was installed into.
  const collectionUseProfileIds = new Set([...collectionProfileIds, receipt.vortexProfileId]);
  const enabledByPlayer = (id: string): string[] =>
    gameProfiles.filter((p) => !collectionUseProfileIds.has(p.id) && p.enabled.has(id)).map((p) => p.name);

  const remove: ModToRemove[] = [];
  const keep: ModToKeep[] = [];
  let notOursCount = 0;
  let alreadyGoneCount = 0;
  const seen = new Set<string>();

  const consider = (candidate: ModToRemove): void => {
    const id = candidate.vortexModId;
    if (seen.has(id)) return;
    seen.add(id);
    if (input.pool[id] === undefined) {
      alreadyGoneCount += 1;
      return;
    }
    const others = usedByOther.get(id);
    if (others !== undefined) {
      keep.push({ vortexModId: id, name: candidate.name, reason: { kind: "other-collection", collections: [...others].sort() } });
      return;
    }
    const inPlayerProfiles = enabledByPlayer(id);
    if (inPlayerProfiles.length > 0) {
      keep.push({ vortexModId: id, name: candidate.name, reason: { kind: "your-profile", profiles: inPlayerProfiles } });
      return;
    }
    remove.push(candidate);
  };

  for (const m of receipt.mods) {
    if (m.ownership !== "installed") {
      notOursCount += 1;
      continue;
    }
    consider({
      vortexModId: m.vortexModId,
      name: m.name,
      from: "current",
      ...(m.displacedModId !== undefined ? { displacedModId: m.displacedModId } : {}),
    });
  }

  for (const r of receipt.retiredMods ?? []) {
    if (seen.has(r.vortexModId)) continue;
    const live = input.pool[r.vortexModId];
    if (live !== undefined) {
      const recorded = r.installTime === undefined ? undefined : installTimeMs(r.installTime);
      const now = installTimeMs(live.installTime);
      if (recorded === undefined || now === undefined || recorded !== now) {
        seen.add(r.vortexModId);
        keep.push({
          vortexModId: r.vortexModId,
          name: r.name,
          reason: {
            kind: "unproven",
            why:
              recorded === undefined || now === undefined
                ? "its install time was not recorded, so it cannot be told apart from a copy you installed yourself"
                : "the mod under this name was installed again since, so it may be your own copy now",
          },
        });
        continue;
      }
    }
    consider({ vortexModId: r.vortexModId, name: r.name, from: "retired" });
  }

  const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name);
  return {
    packageId: receipt.packageId,
    packageName: receipt.packageName,
    gameId,
    remove: remove.sort(byName),
    keep: keep.sort(byName),
    notOursCount,
    alreadyGoneCount,
    profiles,
  };
}
