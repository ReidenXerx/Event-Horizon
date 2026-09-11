/**
 * ──────────────────────────────────────────────────────────────────────
 * What Vortex's download store says about one Nexus page.
 *
 * Read from `persistent.downloads.files`, the record Vortex's own Nexus
 * integration writes when a download starts: `startDownloadMod` emits
 * `start-download` with `modInfo.nexus.ids = { gameId, modId, fileId }`
 * (verified in the deployed bundle). The record appears once Vortex has
 * asked Nexus about the file, before a byte is fetched.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as path from "path";

import { selectors } from "@nexusmods/vortex-api";

/** The parts of one download record this module reads. */
export type DownloadRecord = {
  /** Vortex game ids the archive is for. An array in current Vortex. */
  game?: string[] | string;
  /** File name under the game's download folder. */
  localPath?: string;
  /** "init" | "started" | "paused" | "finished" | "failed" | "redirect" */
  state?: string;
  modInfo?: { nexus?: { ids?: { modId?: unknown; fileId?: unknown } } };
};

export function readDownloadRecords(state: unknown): Readonly<Record<string, DownloadRecord>> {
  return (
    (state as { persistent?: { downloads?: { files?: Record<string, DownloadRecord> } } })?.persistent?.downloads
      ?.files ?? {}
  );
}

const asNumber = (raw: unknown): number | undefined => {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

/** Ids of every download whose record names this Nexus mod page. */
export function downloadIdsForPage(downloads: Readonly<Record<string, DownloadRecord>>, nexusModId: number): string[] {
  return Object.keys(downloads).filter((id) => asNumber(downloads[id]?.modInfo?.nexus?.ids?.modId) === nexusModId);
}

/**
 * The download Vortex would hand back instead of fetching this file again.
 *
 * Mirrors the check in Vortex's own `downloadFile` (nexus_integration,
 * verified in the deployed bundle): a record whose `game` includes the game,
 * whose `modInfo.nexus.ids` name this mod AND this file, with a `localPath`,
 * and not `failed`. Vortex then stats the file and, when it is there,
 * resolves THAT id — no download, and no install either. Whether the file is
 * on disk is {@link existingArchiveFor}'s question; this reads the store only.
 */
export function findExistingNexusDownload(
  downloads: Readonly<Record<string, DownloadRecord>>,
  vortexGameId: string,
  nexusModId: number,
  fileId: number,
): { id: string; localPath: string; state?: string } | undefined {
  for (const [id, dl] of Object.entries(downloads)) {
    if (dl === undefined) continue;
    const games = Array.isArray(dl.game) ? dl.game : dl.game === undefined ? [] : [dl.game];
    if (!games.includes(vortexGameId)) continue;
    const ids = dl.modInfo?.nexus?.ids;
    if (asNumber(ids?.modId) !== nexusModId || asNumber(ids?.fileId) !== fileId) continue;
    if (typeof dl.localPath !== "string" || dl.localPath === "") continue;
    if (dl.state === "failed") continue;
    return { id, localPath: dl.localPath, ...(dl.state === undefined ? {} : { state: dl.state }) };
  }
  return undefined;
}

export type ExistingArchive = {
  /** The matching record, when there is one. */
  found?: { id: string; localPath: string; state?: string };
  /** Where Vortex would look for it: its download folder for the game + `localPath`. */
  fullPath?: string;
  onDisk: boolean;
  /** The download id to install from: found, finished, and on disk. */
  installable?: string;
};

/**
 * Is the planned file's archive already in Downloads, ready to install?
 *
 * The path is Vortex's: `downloadPathForGame(state, game)` joined with the
 * record's `localPath`, the same two parts its `downloadFile` stats. Only a
 * FINISHED download is installable — Vortex's `start-install-download`
 * refuses anything else ("Download not finished").
 */
export async function existingArchiveFor(
  state: unknown,
  vortexGameId: string,
  nexusModId: number,
  fileId: number,
  exists: (fullPath: string) => Promise<boolean>,
): Promise<ExistingArchive> {
  const found = findExistingNexusDownload(readDownloadRecords(state), vortexGameId, nexusModId, fileId);
  if (found === undefined) return { onDisk: false };
  let dir: string | undefined;
  try {
    dir = selectors.downloadPathForGame(state as never, vortexGameId);
  } catch {
    dir = undefined;
  }
  if (typeof dir !== "string" || dir === "") return { found, onDisk: false };
  const fullPath = path.join(dir, found.localPath);
  const onDisk = await exists(fullPath);
  return {
    found,
    fullPath,
    onDisk,
    ...(onDisk && found.state === "finished" ? { installable: found.id } : {}),
  };
}
