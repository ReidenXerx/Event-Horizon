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

/** The parts of one download record this module reads. */
export type DownloadRecord = {
  /** Vortex game ids the archive is for. An array in current Vortex. */
  game?: string[] | string;
  /** File name under the game's download folder. */
  localPath?: string;
  /** "started" | "paused" | "finished" | "failed" | … */
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
