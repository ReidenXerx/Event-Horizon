/**
 * ──────────────────────────────────────────────────────────────────────
 * "Remove old profiles": the profiles earlier revisions of ONE collection
 * left behind, and the mods only those profiles still used.
 *
 * A version-changing update installs into a NEW profile so the version that
 * worked stays switchable. After a few updates that is a pile of profiles,
 * and the mods the curator dropped along the way stay on disk because one of
 * those profiles still has them enabled (alasdairn, Ivy, 2026-10-05).
 *
 * Pure: the caller reads Vortex's state and the receipts, this decides.
 *
 * ─── WHICH PROFILES ────────────────────────────────────────────────────
 * Only profiles Event Horizon created for THIS collection: named the way its
 * installs name them (profileCleanup's anchored rule). The receipt's own
 * profile is the current revision and is never listed. Vortex's active and
 * last-active profiles are listed but cannot be ticked, with the reason (see
 * profileCleanup.ts for why a last-active profile cannot be deleted).
 * A profile the player made, or renamed, does not match the name rule and is
 * never offered.
 *
 * ─── WHICH MODS (NS-2) ─────────────────────────────────────────────────
 * Only the collection's RETIRED mods: Event Horizon installed them, a later
 * revision dropped them, and their Vortex `installTime` still matches the
 * one recorded when they retired (Vortex reuses mod ids). The current
 * revision's mods are never candidates: the collection is still using them.
 * A candidate is freed only when, once the ticked profiles are gone, NO
 * profile of the game enables it and no other installed collection uses it.
 * Mods the player had before the collection are not candidates at all.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { InstallReceipt } from "../../types/installLedger";
import type { UninstallProfileView } from "./collectionUninstall";
import { isCollectionProfileName } from "./profileCleanup";
import { installTimeMs } from "./retiredMods";

export type OldProfile = {
  id: string;
  name: string;
  /** The collection version its name records. */
  version: string;
  /** When Vortex last switched to it (ms), if it says. */
  lastActivated?: number;
  /** False when it cannot be deleted from here; `reason` says why. */
  deletable: boolean;
  reason?: string;
};

export type FreeableMod = { vortexModId: string; name: string };

export type OldProfilesPlan = {
  packageId: string;
  packageName: string;
  gameId: string;
  profiles: OldProfile[];
  /** Retired mods proven ours, still in the pool, used by no other collection. */
  candidates: FreeableMod[];
};

export type OldProfileView = UninstallProfileView & { lastActivated?: number };

function versionFromName(packageName: string, profileName: string): string {
  const prefix = `${packageName} (Event Horizon v`;
  const rest = profileName.startsWith(prefix) ? profileName.slice(prefix.length) : "";
  const end = rest.indexOf(")");
  return end > 0 ? rest.slice(0, end) : "";
}

export function planOldProfiles(input: {
  receipt: InstallReceipt;
  /** Every OTHER receipt on this machine. */
  otherReceipts: readonly InstallReceipt[];
  /** Vortex's mod pool for the receipt's game: `persistent.mods[gameId]`. */
  pool: Readonly<Record<string, { installTime?: unknown }>>;
  profiles: readonly OldProfileView[];
  activeProfileId?: string | undefined;
  lastActiveProfileId?: string | undefined;
}): OldProfilesPlan {
  const { receipt } = input;
  const gameId = receipt.gameId;

  const profiles: OldProfile[] = input.profiles
    .filter((p) => (p.gameId === undefined || p.gameId === gameId) && p.id !== receipt.vortexProfileId)
    .filter((p) => isCollectionProfileName(receipt.packageName, p.name))
    .map((p): OldProfile => {
      const base = {
        id: p.id,
        name: p.name,
        version: versionFromName(receipt.packageName, p.name),
        ...(typeof p.lastActivated === "number" && p.lastActivated > 0 ? { lastActivated: p.lastActivated } : {}),
      };
      if (p.id === input.activeProfileId) {
        return { ...base, deletable: false, reason: "Vortex is using it right now. Switch to another profile first." };
      }
      if (p.id === input.lastActiveProfileId) {
        return {
          ...base,
          deletable: false,
          reason: "Vortex remembers it as this game's last profile, and would be left pointing at nothing.",
        };
      }
      return { ...base, deletable: true };
    })
    // Newest first: the previous revision, the rollback most worth keeping, leads the list.
    .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));

  const usedByOther = new Set<string>();
  for (const other of input.otherReceipts) {
    if (other.packageId === receipt.packageId || other.gameId !== gameId) continue;
    for (const m of other.mods) usedByOther.add(m.vortexModId);
    for (const m of other.retiredMods ?? []) usedByOther.add(m.vortexModId);
  }
  const current = new Set(receipt.mods.map((m) => m.vortexModId));

  const candidates: FreeableMod[] = [];
  const seen = new Set<string>();
  for (const r of receipt.retiredMods ?? []) {
    const id = r.vortexModId;
    if (seen.has(id) || current.has(id) || usedByOther.has(id)) continue;
    seen.add(id);
    const live = input.pool[id];
    if (live === undefined) continue;
    const recorded = r.installTime === undefined ? undefined : installTimeMs(r.installTime);
    const now = installTimeMs(live.installTime);
    if (recorded === undefined || now === undefined || recorded !== now) continue;
    candidates.push({ vortexModId: id, name: r.name });
  }

  return {
    packageId: receipt.packageId,
    packageName: receipt.packageName,
    gameId,
    profiles,
    candidates: candidates.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * The candidates no profile enables once `goneProfileIds` are gone.
 *
 * Called twice: with the ticked profiles, for the "frees N GB" line, and
 * again with the profiles that were ACTUALLY removed, before any mod is. A
 * profile that failed to delete still enables its mods, and they stay.
 */
export function modsFreedBy(
  plan: OldProfilesPlan,
  profiles: readonly OldProfileView[],
  goneProfileIds: ReadonlySet<string>,
): FreeableMod[] {
  const remaining = profiles.filter(
    (p) => (p.gameId === undefined || p.gameId === plan.gameId) && !goneProfileIds.has(p.id),
  );
  return plan.candidates.filter((m) => !remaining.some((p) => p.enabled.has(m.vortexModId)));
}
