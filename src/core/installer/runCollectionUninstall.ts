/**
 * ──────────────────────────────────────────────────────────────────────
 * Carrying out an uninstall plan, and reporting exactly what happened.
 *
 * Does what `planCollectionUninstall` listed, and nothing it did not: the
 * dialog showed that list, and the player agreed to that list.
 *
 * Every step is injected so the order and the bookkeeping can be tested
 * without a Vortex:
 *  1. remove each mod, and switch the player's own displaced copy back on in
 *     the collection profile when that profile survives;
 *  2. delete the profiles the player ticked;
 *  3. delete the receipt and the stored package, but only when nothing
 *     failed. A mod that could not be removed is still on disk, and the
 *     receipt is the only record that it is ours, so it stays for a retry.
 *
 * Failures are counted, never swallowed: a staging drive going offline
 * mid-uninstall must not end in a clean-looking finish.
 * ──────────────────────────────────────────────────────────────────────
 */

import { ehLog } from "../logging/ehLog";
import type { ModToRemove, ProfileChoice, UninstallPlan } from "./collectionUninstall";

export type UninstallDeps = {
  uninstallMod: (vortexModId: string) => Promise<void>;
  enableModInProfile: (profileId: string, vortexModId: string) => void;
  removeProfiles: (
    profiles: readonly ProfileChoice[],
  ) => Promise<{ removed: readonly { id: string }[]; failed: readonly { profile: { id: string }; error: string }[] }>;
  deleteReceipt: () => Promise<void>;
  clearStoredPackage: () => Promise<void>;
  onProgress?: (done: number, total: number) => void;
};

export type UninstallOutcome = {
  removed: ModToRemove[];
  failed: { mod: ModToRemove; error: string }[];
  /** Player's own copies switched back on in the collection profile. */
  restored: number;
  profilesRemoved: string[];
  profilesFailed: { id: string; error: string }[];
  receiptDeleted: boolean;
};

export async function runCollectionUninstall(args: {
  plan: UninstallPlan;
  /** The receipt's own profile, where displaced copies are switched back on. */
  collectionProfileId: string;
  /** Ids of the profiles the player ticked; only deletable ones are acted on. */
  deleteProfileIds: ReadonlySet<string>;
  deps: UninstallDeps;
}): Promise<UninstallOutcome> {
  const { plan, deps } = args;
  const profilesToDelete = plan.profiles.filter((p) => p.deletable && args.deleteProfileIds.has(p.id));
  const collectionProfileSurvives = !profilesToDelete.some((p) => p.id === args.collectionProfileId);

  ehLog("info", "collection.uninstall.start", {
    packageId: plan.packageId,
    remove: plan.remove.length,
    removeRetired: plan.remove.filter((m) => m.from === "retired").length,
    keep: plan.keep.length,
    keepReasons: plan.keep.reduce<Record<string, number>>((acc, k) => {
      acc[k.reason.kind] = (acc[k.reason.kind] ?? 0) + 1;
      return acc;
    }, {}),
    notOurs: plan.notOursCount,
    alreadyGone: plan.alreadyGoneCount,
    deleteProfiles: profilesToDelete.map((p) => p.name),
  });

  const outcome: UninstallOutcome = {
    removed: [],
    failed: [],
    restored: 0,
    profilesRemoved: [],
    profilesFailed: [],
    receiptDeleted: false,
  };

  let done = 0;
  for (const mod of plan.remove) {
    try {
      await deps.uninstallMod(mod.vortexModId);
      outcome.removed.push(mod);
      // Only after ours is gone: two copies of one mod enabled in a profile is the conflict the
      // swap existed to avoid.
      if (mod.displacedModId !== undefined && collectionProfileSurvives) {
        deps.enableModInProfile(args.collectionProfileId, mod.displacedModId);
        outcome.restored += 1;
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      outcome.failed.push({ mod, error });
      ehLog("warn", "collection.uninstall.mod-failed", { name: mod.name, vortexModId: mod.vortexModId, error });
    }
    done += 1;
    deps.onProgress?.(done, plan.remove.length);
  }

  if (profilesToDelete.length > 0) {
    const result = await deps.removeProfiles(profilesToDelete);
    outcome.profilesRemoved = result.removed.map((p) => p.id);
    outcome.profilesFailed = result.failed.map((f) => ({ id: f.profile.id, error: f.error }));
  }

  if (outcome.failed.length === 0) {
    await deps.deleteReceipt();
    await deps.clearStoredPackage();
    outcome.receiptDeleted = true;
  } else {
    ehLog("info", "collection.uninstall.receipt-kept", {
      packageId: plan.packageId,
      failed: outcome.failed.length,
      why: "some mods could not be removed and are still on disk; the receipt is the only record that they are ours",
    });
  }

  ehLog(outcome.failed.length > 0 || outcome.profilesFailed.length > 0 ? "warn" : "info", "collection.uninstall.done", {
    packageId: plan.packageId,
    removed: outcome.removed.length,
    failed: outcome.failed.length,
    restored: outcome.restored,
    profilesRemoved: outcome.profilesRemoved.length,
    profilesFailed: outcome.profilesFailed.length,
    receiptDeleted: outcome.receiptDeleted,
  });
  return outcome;
}
