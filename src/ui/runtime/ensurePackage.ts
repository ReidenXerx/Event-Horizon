/**
 * Get this collection's package, without asking the player for it.
 *
 * ─── THE UX FAILURE ────────────────────────────────────────────────────
 * The Doctor diagnoses from the receipt but repairs by re-running pipeline
 * steps that read the collection, so half its cures used to end at "point at
 * the .ehcoll to continue" — weeks after the install, possibly after the
 * player cleared their downloads. A tool that knows exactly what is wrong and
 * then asks the player to go and find a file is not a repair, it is homework.
 *
 * Three answers, in the order that costs the player least:
 *
 *   1. The copy kept when the collection was installed (packageStore) — exact,
 *      version-checked, and there is nothing to do.
 *   2. A filename match in the collections folder — what existed before this,
 *      and still the right answer on a curator's own machine.
 *   3. Download the EXACT revision the receipt records, from the collection
 *      page it came from, and keep it. Not the latest revision: the newest
 *      publication is a different collection from the one installed, and
 *      repairing with it would quietly migrate the player (owner poll,
 *      2026-09-18).
 *
 * A downloaded package is stored on the way past, so this happens at most once
 * per collection.
 */

import type { types } from "@nexusmods/vortex-api";

import { ehLog } from "../../core/logging/ehLog";
import type { InstallReceipt } from "../../types/installLedger";
import type { CollectionUpdate } from "../../core/nexus/collectionUpdates";

export type EnsuredPackage =
  | { kind: "ready"; path: string; source: "kept" | "found" | "downloaded" }
  | { kind: "unavailable"; reason: string };

export type EnsurePackageDeps = {
  locate: (args: {
    packageId?: string;
    packageName: string;
    packageVersion: string;
  }) => Promise<{ path: string; source: "kept" | "found" } | undefined>;
  /** Fetches one revision's file and returns where Vortex saved it. */
  download: (
    api: types.IExtensionApi,
    update: CollectionUpdate,
    onProgress: (received: number, total: number | undefined) => void,
  ) => Promise<string>;
  /** Keeps what was downloaded, so the next repair needs no network at all. */
  store: (input: {
    appDataPath: string;
    packageId: string;
    packageVersion: string;
    packageName: string;
    sourcePath: string;
  }) => Promise<unknown>;
  loggedIn: (state: unknown) => boolean;
};

async function defaultDeps(): Promise<EnsurePackageDeps> {
  const [{ locateCollectionPackage }, { downloadRevision }, { storeInstalledPackage }, { isLoggedInToNexus }] =
    await Promise.all([
      import("../../core/manifest/locatePackage"),
      import("./collectionUpdates"),
      import("../../core/installer/packageStore"),
      import("../../core/nexus/collectionUpload"),
    ]);
  return {
    locate: async (args) => {
      const found = await locateCollectionPackage(args);
      return found === undefined ? undefined : { path: found.path, source: found.source };
    },
    download: async (api, update, onProgress) => {
      // The same two collaborators the update flow uses, so a re-download
      // behaves exactly like the one a player already knows.
      const [{ waitForVortexDownload }, { selectors }] = await Promise.all([
        import("../pages/install/fetchLink"),
        import("@nexusmods/vortex-api"),
      ]);
      return downloadRevision(
        api,
        update,
        {
          waitForDownload: async (a, downloadId, signal, progress, options) =>
            waitForVortexDownload(a, downloadId, signal, progress, options),
          downloadDirFor: (a, gameId) =>
            selectors.downloadPathForGame(a.getState(), gameId),
        },
        onProgress,
      );
    },
    store: async (input) => storeInstalledPackage(input),
    loggedIn: (state) => isLoggedInToNexus(state as never),
  };
}

export async function ensureCollectionPackage(input: {
  api: types.IExtensionApi;
  receipt: InstallReceipt;
  appDataPath: string;
  /** Called only when a download actually starts, so a UI can say so. */
  onDownloadProgress?: (received: number, total: number | undefined) => void;
  deps?: EnsurePackageDeps;
}): Promise<EnsuredPackage> {
  const { api, receipt } = input;
  const deps = input.deps ?? (await defaultDeps());

  const local = await deps.locate({
    packageId: receipt.packageId,
    packageName: receipt.packageName,
    packageVersion: receipt.packageVersion,
  });
  if (local !== undefined) return { kind: "ready", path: local.path, source: local.source };

  const from = receipt.nexusCollection;
  if (from === undefined) {
    // A file install: there is no page to fetch it from, and guessing one
    // would be how a player ends up repairing with someone else's collection.
    return {
      kind: "unavailable",
      reason:
        "This collection was installed from a file, so there is nowhere to " +
        "fetch it from. Point at the package to continue.",
    };
  }
  if (!deps.loggedIn(api.getState())) {
    return {
      kind: "unavailable",
      reason:
        "Vortex is not logged in to Nexus, so the collection cannot be " +
        "downloaded again. Log in from Vortex's header, or point at the package.",
    };
  }

  /**
   * The revision the player HAS, not the newest one. `downloadRevision` takes
   * the shape the update flow uses, so `latestRevision` here is deliberately
   * the installed revision number — the same code path, pointed at the past.
   */
  const target: CollectionUpdate = {
    packageId: receipt.packageId,
    packageName: receipt.packageName,
    gameId: receipt.gameId,
    installed: from,
    latestRevision: from.revisionNumber,
  };

  try {
    const path = await deps.download(api, target, input.onDownloadProgress ?? ((): void => undefined));
    await deps.store({
      appDataPath: input.appDataPath,
      packageId: receipt.packageId,
      packageVersion: receipt.packageVersion,
      packageName: receipt.packageName,
      sourcePath: path,
    });
    ehLog("info", "package.re-downloaded", {
      packageId: receipt.packageId,
      slug: from.slug,
      revision: from.revisionNumber,
      why: "the kept copy was gone and a repair needed the collection itself",
    });
    return { kind: "ready", path, source: "downloaded" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ehLog("warn", "package.re-download.failed", {
      packageId: receipt.packageId,
      slug: from.slug,
      revision: from.revisionNumber,
      message,
    });
    return {
      kind: "unavailable",
      reason: `Could not download the collection again: ${message}`,
    };
  }
}
