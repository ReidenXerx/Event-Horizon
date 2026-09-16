/**
 * Which Nexus collection revision a package file is.
 *
 * The package itself cannot say: its manifest is written before anything is
 * uploaded, and one package can become several revisions. What knows is the
 * DOWNLOAD. When Vortex fetches a collection revision — the website's Install
 * button, or Event Horizon's own Update — it records the collection and
 * revision on the download (`modInfo.nexus.ids`), next to where the file
 * landed. Matching the installed file's path against those records is the
 * only honest source, and a file that matches none has no revision.
 *
 * Read from Vortex 2.6.3: `startDownloadCollection` and `onCollectionUpdate`
 * both pass `nexus.ids = { gameId, collectionId, collectionSlug, revisionId,
 * revisionNumber }`, and the downloads reducer stores `modInfo` as given.
 */

import * as path from "path";

import type { InstallReceiptNexusCollection } from "../../types/installLedger";

/**
 * A recorded revision, or undefined when the value cannot be used. The slug and
 * domain end up in a web address and a GraphQL query, so both are held to the
 * characters Nexus itself uses.
 */
export function readNexusCollectionRevision(raw: unknown): InstallReceiptNexusCollection | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.slug !== "string" || !/^[a-z0-9]+$/i.test(r.slug)) return undefined;
  if (typeof r.gameDomain !== "string" || !/^[a-z0-9]+$/i.test(r.gameDomain)) return undefined;
  if (typeof r.revisionNumber !== "number" || !Number.isInteger(r.revisionNumber) || r.revisionNumber < 1) {
    return undefined;
  }
  const collectionId = r.collectionId;
  return {
    slug: r.slug,
    revisionNumber: r.revisionNumber,
    gameDomain: r.gameDomain,
    ...(typeof collectionId === "number" && Number.isInteger(collectionId) && collectionId > 0 ? { collectionId } : {}),
  };
}

type DownloadRecord = {
  localPath?: unknown;
  game?: unknown;
  modInfo?: { nexus?: { ids?: Record<string, unknown> } };
};

/**
 * The revision Vortex downloaded `archivePath` as, if it did.
 *
 * `downloadDirFor` maps a Vortex game id to that game's download folder
 * (Vortex's `downloadPathForGame`); passed in so this stays a function of its
 * inputs. Paths compare without regard to case or separator, because Windows
 * treats `D:\Vortex\...` and `d:/vortex/...` as the same file.
 */
export function nexusCollectionOfDownload(
  state: unknown,
  archivePath: string,
  downloadDirFor: (gameId: string) => string | undefined,
): InstallReceiptNexusCollection | undefined {
  const files = (state as { persistent?: { downloads?: { files?: Record<string, DownloadRecord> } } })?.persistent
    ?.downloads?.files;
  if (files === undefined || files === null || typeof files !== "object") return undefined;
  const wanted = comparable(archivePath);
  for (const record of Object.values(files)) {
    const ids = record?.modInfo?.nexus?.ids;
    if (ids === undefined || typeof ids.collectionSlug !== "string") continue;
    if (typeof record.localPath !== "string" || record.localPath === "") continue;
    const games = Array.isArray(record.game) ? record.game.filter((g): g is string => typeof g === "string") : [];
    const onDisk = games
      .map((gameId) => downloadDirFor(gameId))
      .filter((dir): dir is string => typeof dir === "string" && dir !== "")
      .map((dir) => comparable(path.join(dir, record.localPath as string)));
    if (!onDisk.includes(wanted)) continue;
    return readNexusCollectionRevision({
      slug: ids.collectionSlug,
      revisionNumber: typeof ids.revisionNumber === "string" ? Number(ids.revisionNumber) : ids.revisionNumber,
      gameDomain: ids.gameId,
      collectionId: typeof ids.collectionId === "string" ? Number(ids.collectionId) : ids.collectionId,
    });
  }
  return undefined;
}

function comparable(p: string): string {
  return path.normalize(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
