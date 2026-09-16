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

import { util, type types } from "@nexusmods/vortex-api";

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
 * Event Horizon's main page, as `registerMainPage` named it in `index.ts`.
 *
 * Vortex's `show-main-page` matches on the page ID, not the title — it
 * dispatches `setOpenMainPage(page.id)` — so "Event Horizon" would silently
 * do nothing at all.
 */
export const EH_MAIN_PAGE_ID = "event-horizon";

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
 * Take the archive to Event Horizon's own install page, and let Vortex go.
 *
 * ─── WHY VORTEX MUST NOT FINISH THIS INSTALL ───────────────────────────
 * Vortex loses extracted files when it installs in BULK, which a collection
 * is. Installing one mod at a time is the thing that avoids it, and Event
 * Horizon's driver is sequential for exactly that reason. So this hands the
 * archive over and stops Vortex here; it never returns instructions that
 * would have Vortex install the collection's mods.
 *
 * ─── WHY IT CANCELS RATHER THAN FAILING ────────────────────────────────
 * Three endings were possible and only one is honest:
 *
 *   `{ instructions: [] }`  — a SUCCESSFUL install of nothing. Leaves an empty
 *                             mod in Vortex's list and reads later as the
 *                             interception having half-worked.
 *   `throw new Error(...)`  — "Installation failed", in red, for a handover
 *                             that worked exactly as designed.
 *   `UserCanceled`          — Vortex's own "this install stopped on purpose".
 *                             No mod, no error dialog.
 *
 * Vortex removes the `<mod>.installing` temp folder in a `finally`, so the
 * cancel leaves nothing behind either way.
 *
 * `archivePath` is what makes this possible at all: Vortex hands over the real
 * archive on disk, so Event Horizon reads the package itself rather than
 * reconstructing it from Vortex's extraction.
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
    ehLog("info", "collection-intercept.claimed", {
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
    });

    /**
     * No path, no handover. Vortex has always supplied one here, but the
     * parameter is optional in the typings and inventing a path would send
     * the install page at a file that does not exist. Cancel and say why.
     */
    if (archivePath === undefined) {
      ehLog("warn", "collection-intercept.no-archive-path", {
        gameId,
        why: "Vortex claimed the archive but passed no archivePath",
      });
      api.sendNotification?.({
        id: "eh-collection-intercept",
        type: "warning",
        title: "Could not open this collection",
        message:
          "Vortex did not say where the downloaded file is, so Event Horizon " +
          "could not open it. Install it from the Event Horizon page instead.",
        displayMS: 12000,
      });
      throw new util.UserCanceled();
    }

    /**
     * Hand the package to the install session BEFORE asking for the page.
     * The session is a module-level singleton, so this works whether or not
     * Event Horizon's page has ever been open this session — the shell reads
     * the pending route when it mounts.
     *
     * Everything the user needs then happens on our side: the loading
     * pipeline validates the package and, when it cannot be installed by this
     * build (a schema from a newer Event Horizon, a damaged download), says
     * so on our own screen with the real reason. That is why nothing is
     * re-validated here — one explanation, in one place.
     */
    const { getInstallSession } = await import(
      "../../ui/pages/install/installSession"
    );
    const { getRouteRequest } = await import("../../ui/runtime/routeRequest");

    getInstallSession().pickFile(api, archivePath);
    getRouteRequest().request("install");
    api.events.emit("show-main-page", EH_MAIN_PAGE_ID);

    ehLog("info", "collection-intercept.handed-over", {
      archivePath,
      route: "install",
      page: EH_MAIN_PAGE_ID,
    });

    // Vortex's own "stopped on purpose". See the docblock for why this is not
    // an empty instruction list and not an Error.
    throw new util.UserCanceled();
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
