/**
 * ──────────────────────────────────────────────────────────────────────
 * Record that the collection the player is set up for was actually started.
 *
 * This is the whole reason Event Horizon can ask "did it work?" honestly at
 * all: Vortex's collection installer asks the moment the install finishes,
 * when nobody has loaded a save yet. Event Horizon owns the Play button, so
 * it knows when the game really ran.
 *
 * ─── WHICH COLLECTION ──────────────────────────────────────────────────
 * The ACTIVE PROFILE's, through `pickDoctorReceipt`, not `receipts[0]`.
 * That picker exists because taking the first receipt diagnosed a
 * three-week-old collection on a real player's machine and then offered them
 * a profile switch that undid the install they had just finished. A vote is
 * public and permanent, so attributing one to the wrong collection would be
 * a worse version of the same mistake.
 *
 * Everything here is best effort and silent. A launch that cannot be
 * attributed costs one unasked question; a launch that fails to start the
 * game because bookkeeping threw would be unforgivable, so nothing here is
 * allowed to reach the caller.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { types } from "@nexusmods/vortex-api";

import { ehLog } from "../../core/logging/ehLog";

/** Called after the game has actually been started. Never throws. */
export async function notePlayedCollection(
  api: types.IExtensionApi,
): Promise<void> {
  try {
    const [{ listReceipts }, { getVortexUserDataPath }, { getEventHorizonRoot }] =
      await Promise.all([
        import("../../core/installLedger"),
        import("../../core/paths"),
        import("../../core/paths/appDataPaths"),
      ]);
    const receipts = await listReceipts(getVortexUserDataPath());
    if (receipts.length === 0) return;

    let activeProfileId: string | undefined;
    try {
      const { getActiveProfileId } = await import(
        "../../core/getModsListForProfile"
      );
      activeProfileId = getActiveProfileId(api.getState());
    } catch {
      activeProfileId = undefined;
    }

    const { pickDoctorReceipt } = await import("../../core/doctor/pickReceipt");
    const receipt = pickDoctorReceipt(receipts, activeProfileId);
    if (receipt === undefined) return;

    const nexus = receipt.nexusCollection;
    if (nexus === undefined) {
      // A package installed from a file rather than a collection page. There
      // is no revision to rate, so there is nothing to remember.
      ehLog("debug", "played.not-a-nexus-collection", {
        packageId: receipt.packageId,
      });
      return;
    }

    const { loadFeedback, notePlayed, saveFeedback } = await import(
      "../../core/feedback/collectionFeedback"
    );
    const root = getEventHorizonRoot();
    const before = await loadFeedback(root);
    const after = notePlayed(
      before,
      {
        packageId: receipt.packageId,
        packageName: receipt.packageName ?? nexus.slug,
        revisionNumber: nexus.revisionNumber,
        slug: nexus.slug,
        gameDomain: nexus.gameDomain,
        // Only present on receipts written once EH started recording it.
        // Absent means endorsing is not offered, never offered and broken.
        ...(typeof nexus.collectionId === "number"
          ? { collectionId: nexus.collectionId }
          : {}),
      },
      new Date().toISOString(),
    );
    // `notePlayed` returns the store unchanged on a repeat launch, so this
    // writes once per revision rather than on every press of Play.
    if (after === before) return;
    await saveFeedback(root, after);
    ehLog("info", "played.recorded", {
      packageId: receipt.packageId,
      revisionNumber: nexus.revisionNumber,
      why: "so Event Horizon can ask whether the collection worked",
    });
  } catch (err) {
    ehLog("debug", "played.record-failed", {
      err,
      consequence: "the collection will not be asked about; the game still started",
    });
  }
}
