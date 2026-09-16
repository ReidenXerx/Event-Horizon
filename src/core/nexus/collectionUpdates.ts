/**
 * Which installed collections have a newer revision published on Nexus.
 *
 * Owner decision 2026-09-16: a collection installed from its Nexus collection
 * page is checked, and nothing else is. The receipt records the revision only
 * when Vortex downloaded the package as one (see collectionRevision.ts), so a
 * receipt without it is a file install and is skipped — never compared by
 * date, which would offer the version the player already has.
 *
 * The comparison is Vortex's own: the collection's `latestPublishedRevision`
 * against the revision that was installed. A draft is not published and is
 * never offered; a revision the curator retracted drops back to the previous
 * published one, which is not newer, so nothing is offered either.
 */

import type { types } from "@nexusmods/vortex-api";

import { ehLog } from "../logging/ehLog";
import type { InstallReceipt, InstallReceiptNexusCollection } from "../../types/installLedger";
import { isLoggedInToNexus } from "./collectionUpload";

export type CollectionUpdate = {
  packageId: string;
  packageName: string;
  /** Vortex's game id, from the receipt. */
  gameId: string;
  installed: InstallReceiptNexusCollection;
  latestRevision: number;
};

type NexusApi = Pick<types.IExtensionApi, "getState"> & {
  emitAndAwait?: (event: string, ...args: unknown[]) => PromiseLike<unknown>;
};

/**
 * The newest published revision number of a collection, or undefined when
 * Nexus did not answer. `emitAndAwait` resolves to the array of handler
 * results and never rejects, so a failed request is an empty array here.
 */
export async function latestPublishedRevision(api: NexusApi, slug: string): Promise<number | undefined> {
  if (api.emitAndAwait === undefined) return undefined;
  const results = (await api.emitAndAwait("get-nexus-collection", slug)) as unknown[] | undefined;
  const collection = results?.[0] as { latestPublishedRevision?: { revisionNumber?: unknown } } | undefined;
  const revision = collection?.latestPublishedRevision?.revisionNumber;
  return typeof revision === "number" && Number.isInteger(revision) ? revision : undefined;
}

/**
 * The updates for these receipts, one per collection with a newer revision.
 *
 * Asks nothing when Vortex is not logged in: Nexus answers a logged-out
 * request for an adult collection with an error, and Vortex turns every
 * failed request into an error notification — at startup, for a check the
 * player never asked for.
 */
export async function findCollectionUpdates(
  api: NexusApi,
  receipts: readonly InstallReceipt[],
): Promise<CollectionUpdate[]> {
  const tracked = receipts.filter((r) => r.nexusCollection !== undefined);
  if (tracked.length === 0) return [];
  if (!isLoggedInToNexus(api.getState())) {
    ehLog("info", "collection-updates.skipped", { tracked: tracked.length, why: "Vortex is not logged in to Nexus" });
    return [];
  }
  const latestBySlug = new Map<string, number | undefined>();
  const updates: CollectionUpdate[] = [];
  for (const receipt of tracked) {
    const installed = receipt.nexusCollection!;
    if (!latestBySlug.has(installed.slug)) {
      latestBySlug.set(installed.slug, await latestPublishedRevision(api, installed.slug));
    }
    const latest = latestBySlug.get(installed.slug);
    ehLog("info", "collection-updates.checked", {
      packageId: receipt.packageId,
      slug: installed.slug,
      installed: installed.revisionNumber,
      latest: latest ?? "(no answer)",
    });
    if (latest !== undefined && latest > installed.revisionNumber) {
      updates.push({
        packageId: receipt.packageId,
        packageName: receipt.packageName,
        gameId: receipt.gameId,
        installed,
        latestRevision: latest,
      });
    }
  }
  return updates;
}
