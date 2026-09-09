/**
 * ──────────────────────────────────────────────────────────────────────
 * What is already sitting in Vortex's downloads folder?
 *
 * The resolver has always had an arm for this — `nexus-use-local-download`,
 * "the bytes are already here, skip the Nexus round-trip" — and it was
 * UNREACHABLE. Every call site passed `availableDownloads: undefined`, so
 * `findDownloadBySha` returned nothing every time and the arm never fired
 * once in the life of the project.
 *
 * The cost of that is not a slow install, it is a stuck one. A tester's run
 * was interrupted after Point Lookout had downloaded but before it installed.
 * On resume the resolver could not see the archive, chose `nexus-download`,
 * and Vortex — already holding the file — had nothing to do and emitted no
 * `did-install-mod`. The install sat on "downloading" a file that had
 * finished downloading in the previous session.
 *
 * ─── WHY HASH, RATHER THAN TRUST METADATA ──────────────────────────────
 * A download could be matched more cheaply by the Nexus mod/file id Vortex
 * records against it. Hashing is chosen anyway, deliberately:
 *
 *   - sha256 answers "are these the bytes the curator had", which is the
 *     question. An id answers "is this the file Vortex believes it fetched",
 *     which is a claim about provenance, and a partially-downloaded, resumed,
 *     manually-replaced or hand-copied archive can carry the right id and the
 *     wrong bytes.
 *   - It costs CPU and nothing else. The alternative buys back minutes on a
 *     first run and pays for them in a class of wrong answer that is very
 *     hard to see: a mod that installs from the wrong archive looks installed.
 *   - The AvailableDownload contract already demands sha256 for this reason —
 *     "we can't trust filenames per §5.5". Matching on ids would have widened
 *     that contract rather than satisfying it.
 *
 * The expense is also mostly one-off: hashes are cached by a
 * `path|size|mtime` fingerprint, the same cache the build side already uses,
 * so a resume re-reads only what actually changed on disk.
 * ──────────────────────────────────────────────────────────────────────
 */

import { isAbort } from "../../utils/abortError";
import * as fsp from "fs/promises";
import * as path from "path";

import {
  archiveFileCacheKey,
  type ArchiveHashCache,
} from "../archiveHashCache";
import { hashFileSha256 } from "../archiveHashing";
import { ehLog } from "../logging/ehLog";
import type { AvailableDownload } from "../../types/installPlan";

export type DownloadScanResult = {
  /** Downloads whose bytes we know, ready for the resolver. */
  downloads: AvailableDownload[];
  /** The cache, with any newly-computed hashes folded in. Save it. */
  cache: ArchiveHashCache;
  /** How many archives actually had to be read this time. */
  hashed: number;
  /** How many were answered from the cache — the reason a resume is cheap. */
  fromCache: number;
  /**
   * Why entries were passed over. Counted rather than dropped silently: "the
   * resolver saw 3 of your 400 downloads" is a bug report, and without this
   * it is an invisible one.
   */
  skipped: {
    otherGame: number;
    incomplete: number;
    missing: number;
    unreadable: number;
  };
};

/** One entry as Vortex stores it. Every field optional — it is not our shape. */
type RawDownload = {
  game?: string | string[];
  localPath?: string;
  state?: string;
  size?: number;
  received?: number;
};

/**
 * Hash everything in Vortex's download folder that could serve this game.
 *
 * Never throws for a single bad file: an archive that cannot be read is
 * simply not offered as a candidate, which lands the resolver back on
 * `nexus-download` — exactly the behaviour that existed before this function.
 * Failing the whole install because one download is unreadable would be a
 * worse trade than re-fetching it.
 */
export async function collectAvailableDownloads(args: {
  state: unknown;
  gameId: string;
  downloadsDir: string;
  cache: ArchiveHashCache;
  signal?: AbortSignal;
  /** Called per archive, so a multi-minute first scan is not a frozen window. */
  onProgress?: (done: number, total: number, name: string) => void;
}): Promise<DownloadScanResult> {
  const { state, gameId, downloadsDir, signal, onProgress } = args;
  const startedAt = Date.now();
  const cache: ArchiveHashCache = {
    schemaVersion: 1,
    entries: { ...args.cache.entries },
  };

  const skipped = { otherGame: 0, incomplete: 0, missing: 0, unreadable: 0 };
  const downloads: AvailableDownload[] = [];
  let hashed = 0;
  let fromCache = 0;

  ehLog("info", "resolver.downloads.start", {
    gameId,
    cachedEntries: Object.keys(args.cache.entries).length,
  });

  const files = readDownloadFiles(state);
  const candidates: Array<{ archiveId: string; entry: RawDownload }> = [];
  for (const [archiveId, entry] of Object.entries(files)) {
    if (!belongsToGame(entry, gameId)) {
      skipped.otherGame += 1;
      continue;
    }
    if (typeof entry.localPath !== "string" || entry.localPath.length === 0) {
      skipped.missing += 1;
      continue;
    }
    candidates.push({ archiveId, entry });
  }
  ehLog("debug", "resolver.downloads.candidates", {
    gameId,
    total: candidates.length,
    skippedOtherGame: skipped.otherGame,
    skippedNoLocalPath: skipped.missing,
  });

  let done = 0;
  for (const { archiveId, entry } of candidates) {
    if (signal?.aborted) break;
    done += 1;
    const localPath = path.isAbsolute(entry.localPath!)
      ? entry.localPath!
      : path.join(downloadsDir, entry.localPath!);

    let stat: Awaited<ReturnType<typeof fsp.stat>>;
    try {
      stat = await fsp.stat(localPath);
    } catch (err) {
      // Vortex still lists it; the file is gone. Common after a manual clean.
      skipped.missing += 1;
      ehLog("debug", "resolver.downloads.file-missing", {
        archiveId,
        name: path.basename(localPath),
        err,
      });
      continue;
    }
    if (!stat.isFile() || stat.size === 0) {
      skipped.missing += 1;
      ehLog("debug", "resolver.downloads.file-empty-or-not-a-file", {
        archiveId,
        name: path.basename(localPath),
      });
      continue;
    }

    // An incomplete download's hash matches nothing, so hashing one is pure
    // waste — and on a resumed install, a half-fetched 2 GB archive is
    // exactly what is sitting there. Judge by BYTES ON DISK against the size
    // Vortex recorded, rather than by its state string: the bytes are the
    // thing we are about to hash, and the string is a label about them.
    if (typeof entry.size === "number" && entry.size > 0 && stat.size < entry.size) {
      skipped.incomplete += 1;
      ehLog("debug", "resolver.downloads.incomplete", {
        archiveId,
        name: path.basename(localPath),
      });
      continue;
    }

    onProgress?.(done, candidates.length, path.basename(localPath));

    const key = archiveFileCacheKey(localPath, stat.size, stat.mtimeMs);
    const cached = cache.entries[key];
    if (cached !== undefined) {
      fromCache += 1;
      downloads.push({
        archiveId,
        localPath,
        sha256: cached.sha256,
        fileName: path.basename(localPath),
      });
      continue;
    }

    let sha256: string;
    try {
      sha256 = await hashFileSha256(localPath, signal);
    } catch (err) {
      if (isAbort(err)) {
        ehLog("warn", "resolver.downloads.aborted", {
          ms: Date.now() - startedAt,
          done,
          total: candidates.length,
          hashed,
          fromCache,
        });
        break;
      }
      skipped.unreadable += 1;
      ehLog("debug", "resolver.downloads.hash-failed", {
        archiveId,
        name: path.basename(localPath),
        err,
      });
      continue;
    }

    hashed += 1;
    cache.entries[key] = {
      sha256,
      size: stat.size,
      recoveredAt: new Date().toISOString(),
    };
    downloads.push({
      archiveId,
      localPath,
      sha256,
      fileName: path.basename(localPath),
    });
  }

  ehLog("info", "resolver.downloads.done", {
    ms: Date.now() - startedAt,
    usable: downloads.length,
    hashed,
    fromCache,
    skippedOtherGame: skipped.otherGame,
    skippedIncomplete: skipped.incomplete,
    skippedMissing: skipped.missing,
    skippedUnreadable: skipped.unreadable,
  });
  return { downloads, cache, hashed, fromCache, skipped };
}

/** Vortex's download table, or an empty one if the shape is not what we expect. */
function readDownloadFiles(state: unknown): Record<string, RawDownload> {
  const files = (
    state as {
      persistent?: { downloads?: { files?: Record<string, RawDownload> } };
    } | null
  )?.persistent?.downloads?.files;
  if (files === null || files === undefined || typeof files !== "object") {
    return {};
  }
  return files;
}

/**
 * Does this download belong to the game being installed?
 *
 * Vortex writes `game` as either a string or an array — a download can be
 * valid for several games. Handling only the string form would silently drop
 * every multi-game download, which is the kind of miss that looks like the
 * feature simply not working.
 */
function belongsToGame(entry: RawDownload, gameId: string): boolean {
  const g = entry.game;
  if (typeof g === "string") return g === gameId;
  if (Array.isArray(g)) return g.includes(gameId);
  // No game recorded: keep it. A false candidate costs one hash and fails to
  // match; a dropped real one costs a re-download.
  return true;
}

/** One line for the log — a scan that found nothing needs to say why. */
export function describeDownloadScan(r: DownloadScanResult): string {
  const parts = [
    `${r.downloads.length} usable`,
    `${r.hashed} hashed`,
    `${r.fromCache} cached`,
  ];
  const s = r.skipped;
  const dropped = s.otherGame + s.incomplete + s.missing + s.unreadable;
  if (dropped > 0) {
    parts.push(
      `skipped ${dropped} (${s.otherGame} other game, ${s.incomplete} incomplete, ` +
        `${s.missing} missing, ${s.unreadable} unreadable)`,
    );
  }
  return parts.join(", ");
}
