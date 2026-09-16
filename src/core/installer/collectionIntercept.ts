/**
 * ──────────────────────────────────────────────────────────────────────
 * Claiming an Event Horizon collection archive before Vortex installs it.
 *
 * ─── WHY THIS IS THE ONLY LEVER ────────────────────────────────────────
 * Two obvious hooks look like the place for this and neither is:
 *
 *   `will-install-collection` is a plain `events.emit` fired as Vortex's
 *   InstallDriver starts. Fire-and-forget: a listener cannot veto it, cannot
 *   redirect it, cannot even delay it.
 *
 *   A collection feature's `parse` runs in collection POST-processing — after
 *   the mods are installed and deployed. Far too late to matter.
 *
 * The installer registry is different, because it decides WHO installs an
 * archive before anyone installs it. Read from Vortex's own InstallManager:
 *
 *     this.mInstallers.push({ id, priority, testSupported, install });
 *     this.mInstallers.sort((lhs, rhs) => lhs.priority - rhs.priority);
 *
 * `getInstaller` then walks that array from index 0 and takes the FIRST whose
 * `testSupported` says supported. Ascending sort, first match: the lowest
 * number wins. Vortex registers collections at priority 5, and nothing forces
 * an installer on that path (the only `forceInstaller` anywhere is the user's
 * own "install as-is", which forces `fallback`), so a lower number is asked
 * first.
 *
 * ─── WHY THE TEST MUST BE NARROWER THAN THEIRS ─────────────────────────
 * Vortex's collection test is one line — `files.indexOf("collection.json") !== -1`.
 * Matching that alone would claim EVERY Nexus collection the user ever
 * installs and break all of them silently, which is far worse than not doing
 * this at all. So this demands EH's own `manifest.json` BESIDE the
 * `collection.json`: a normal collection has no manifest, a normal mod has no
 * collection.json, and only a package Event Horizon built has both.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { types } from "@nexusmods/vortex-api";

import { ehLog } from "../logging/ehLog";

/** Vortex's own marker — what makes an archive a collection to Vortex. */
const COLLECTION_MARKER = "collection.json";
/** Ours. Event Horizon's package manifest, at the archive root. */
const EH_MARKER = "manifest.json";

/**
 * Below Vortex's collections installer (5), above nothing else of ours.
 *
 * Not 0: `site-installer` sits there for the `site` pseudo-game, and sharing a
 * number with it buys nothing. 1 leaves room to slot something between us and
 * collections later without renumbering.
 */
export const EH_INSTALLER_PRIORITY = 1;
export const EH_INSTALLER_ID = "event-horizon-collection";

/**
 * Is this path that marker, at the ROOT of the archive?
 *
 * Vortex hands `files` as archive-relative paths with either separator, and a
 * nested `foo/collection.json` is a different thing entirely — a mod that
 * happens to ship one. Root-only, case-insensitive because Windows archives
 * are.
 */
function hasRootFile(files: readonly string[], marker: string): boolean {
  return files.some((f) => f.replace(/\\/g, "/").toLowerCase() === marker);
}

/**
 * Only an Event Horizon collection, and never anything else.
 *
 * NOTE this runs for EVERY archive the user installs, so it stays cheap and it
 * stays quiet: a log line per install would bury the log it shares with the
 * installer. Logged only when the archive carries Vortex's collection marker,
 * which is rare and is exactly the case worth being able to read afterwards —
 * including the near-miss where a collection is NOT ours, because "why did EH
 * not claim it" is the question that would otherwise have no evidence.
 */
export const testSupported: types.TestSupported = async (files, gameId) => {
  const isCollection = hasRootFile(files, COLLECTION_MARKER);
  if (!isCollection) return { supported: false, requiredFiles: [] };

  const isOurs = hasRootFile(files, EH_MARKER);
  ehLog("info", "collection-intercept.test", {
    gameId,
    fileCount: files.length,
    collectionJson: true,
    ehManifest: isOurs,
    claimed: isOurs,
    why: isOurs
      ? "collection.json and Event Horizon's manifest.json both at the root"
      : "a collection that Event Horizon did not build — left to Vortex",
  });

  return isOurs
    ? { supported: true, requiredFiles: [COLLECTION_MARKER, EH_MARKER] }
    : { supported: false, requiredFiles: [] };
};

/**
 * EXPERIMENT ONE: prove the claim fires, change nothing.
 *
 * This deliberately installs NOTHING. The question it exists to answer is
 * whether the priority claim reaches us at all and what Vortex hands over when
 * it does — and an experiment that also writes mods cannot be run twice on the
 * same machine without cleaning up after itself.
 *
 * So it records the payload, says so on screen, and refuses the install. The
 * refusal is a thrown error rather than an empty instruction list on purpose:
 * `{ instructions: [] }` is a SUCCESSFUL install of nothing, which leaves an
 * empty mod in Vortex's list and reads, later, as the interception having
 * silently half-worked.
 */
export function makeInstall(api: types.IExtensionApi): types.InstallFunc {
  const install: types.InstallFunc = async (
    files,
    destinationPath,
    gameId,
    _progress,
    choices,
    unattended,
    archivePath,
  ) => {
    ehLog("warn", "collection-intercept.claimed", {
      gameId,
      fileCount: files.length,
      archivePath: archivePath ?? "(not given)",
      destinationPath,
      unattended: unattended === true,
      choicesGiven: choices !== undefined,
      // The shape of what rode along, not the contents: a collection archive
      // lists every bundled file and the log is something people paste.
      rootEntries: files
        .map((f) => f.replace(/\\/g, "/"))
        .filter((f) => !f.includes("/"))
        .slice(0, 25),
      note:
        "Event Horizon claimed this archive ahead of Vortex's collection " +
        "installer (priority 1 vs 5). Nothing was installed: this build only " +
        "observes.",
    });

    api.sendNotification?.({
      id: "eh-collection-intercept",
      type: "success",
      title: "Event Horizon claimed the collection",
      message:
        "The interception works. Nothing was installed — this build only " +
        "records what Vortex handed over. See the Event Horizon log.",
      displayMS: 12000,
    });

    // Refused, loudly and on purpose. See the docblock: a silent empty success
    // is the one outcome that would be mistaken for this working.
    throw new Error(
      "Event Horizon intercepted this collection archive (observation build). " +
        "Nothing was installed.",
    );
  };
  return install;
}

/**
 * Register the claim. Call from `init`, before Vortex's collections extension
 * is consulted — ordering between extensions does not matter, only the number.
 */
export function registerCollectionIntercept(
  context: types.IExtensionContext,
): void {
  context.registerInstaller(
    EH_INSTALLER_ID,
    EH_INSTALLER_PRIORITY,
    testSupported,
    makeInstall(context.api),
  );
  ehLog("info", "collection-intercept.registered", {
    id: EH_INSTALLER_ID,
    priority: EH_INSTALLER_PRIORITY,
    vortexCollectionPriority: 5,
    claims: `${COLLECTION_MARKER} + ${EH_MARKER} at the archive root`,
  });
}
