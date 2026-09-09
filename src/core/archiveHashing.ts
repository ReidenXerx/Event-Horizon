import * as crypto from "crypto";
import {
  archiveFileCacheKey,
  type ArchiveHashLookup,
} from "./archiveHashCache";
import * as fs from "fs";
import * as path from "path";

import { selectors } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";

import type { AuditorMod } from "./getModsListForProfile";
import { AbortError, isAbort } from "../utils/abortError";
import { ehLog } from "./logging/ehLog";
import { getDefaultHashConcurrency } from "./manifest/stagingFileWalker";
import { pMap } from "../utils/pMap";

/**
 * Sentinel error emitted by `pMap` and `enrichModsWithArchiveHashes`
 * when an `AbortSignal` is aborted. Callers can identify a clean
 * cancellation by checking `err instanceof AbortError` (or
 * `err.name === "AbortError"`) and treat it as "user cancelled, no
 * recovery needed" rather than a real failure.
 *
 * Re-exported from `src/utils/abortError.ts` — see that file for the
 * canonical class. Kept here for backward compat with existing
 * `import { AbortError } from "../core/archiveHashing"` sites; new
 * code should import from `src/utils/abortError` directly.
 */
export { AbortError };

/**
 * Streaming SHA-256 of a file. Lower memory footprint than reading the
 * whole file into a buffer; mod archives can be hundreds of MB.
 *
 * Pass an `AbortSignal` (via the optional second arg) to abort an
 * in-flight hash. The underlying stream is destroyed and the promise
 * rejects with an `AbortError`.
 */
export function hashFileSha256(
  filePath: string,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError());
      return;
    }
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);

    const onAbort = (): void => {
      stream.destroy();
      reject(new AbortError());
    };
    if (signal !== undefined) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const cleanup = (): void => {
      if (signal !== undefined) {
        signal.removeEventListener("abort", onAbort);
      }
    };

    stream.on("error", (err) => {
      cleanup();
      reject(err);
    });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => {
      cleanup();
      resolve(hash.digest("hex"));
    });
  });
}

/**
 * Resolve a mod's source archive on disk via Vortex's download cache.
 *
 * Vortex stores downloads at `selectors.downloadPathForGame(state, gameId)`
 * with `IDownload.localPath` as the relative filename. Archives are keyed
 * by `archiveId`, which we already capture on `AuditorMod`.
 */
export function getModArchivePath(
  state: types.IState,
  archiveId: string | undefined,
  gameId: string,
): string | undefined {
  if (!archiveId) {
    return undefined;
  }

  const downloads =
    ((state as any)?.persistent?.downloads?.files ?? {}) as Record<
      string,
      { localPath?: string; game?: string[] } | undefined
    >;

  const download = downloads[archiveId];
  if (!download?.localPath) {
    return undefined;
  }

  // downloadPathForGame returns an absolute per-game directory.
  const baseDir = selectors.downloadPathForGame(state, gameId);
  if (!baseDir) {
    return undefined;
  }

  return path.join(baseDir, download.localPath);
}

/**
 * A mod's archive on disk — INCLUDING one re-downloaded after its own record
 * died.
 *
 * `getModArchivePath` alone answers "what does Vortex think this mod came
 * from", and after a recovery that is the wrong question: the mod still points
 * at the download record that went missing, while the bytes sit in the cache
 * under a new id nobody consulted.
 *
 * The cost of asking the narrow question was silent and large. A curator
 * recovered 771 archives, built, and got a package whose self-check had skipped
 * 772 of 773 mods — reported as "archive missing from disk", which was by
 * then false. Verification was off for the entire collection, and the report
 * said so in words that read like a disk problem.
 *
 * Order matters: the mod's own record wins whenever it still resolves, because
 * that is the archive it was actually installed from. The recovered id is a
 * fallback, never an override.
 */
export function resolveModArchivePath(
  state: types.IState,
  mod: Pick<AuditorMod, "archiveId" | "recoveredDownloadId">,
  gameId: string,
): string | undefined {
  return (
    getModArchivePath(state, mod.archiveId, gameId) ??
    getModArchivePath(state, mod.recoveredDownloadId, gameId)
  );
}

export type EnrichOptions = {
  /**
   * Max concurrent archive hashes. Defaults to
   * {@link getDefaultHashConcurrency} (`min(8, max(2, cpus-1))`),
   * which scales with the user's machine while leaving a core free
   * for the UI/Vortex itself. Override to a small constant (e.g. 2)
   * when you know the install lives on spinning rust and seek
   * latency dominates throughput.
   */
  concurrency?: number;
  /**
   * Optional read-through cache of file hashes.
   *
   * OPT-IN, and deliberately so: six call sites reach this function and only
   * the build wants the caching. Omitting it reproduces the previous behaviour
   * exactly — every archive is read and hashed.
   */
  hashCache?: ArchiveHashLookup;
  /** Called for each mod after it has been processed (success or skip). */
  onProgress?: (done: number, total: number, mod: AuditorMod) => void;
  /**
   * Optional cancellation signal. When aborted:
   *   - new mods are no longer scheduled for hashing,
   *   - in-flight hash streams are destroyed,
   *   - the returned promise rejects with `AbortError`.
   *
   * Hashing is read-only, so abort is always safe — partial progress
   * is simply discarded.
   */
  signal?: AbortSignal;
};

/**
 * Compute SHA-256 for each mod's source archive (where one exists) and
 * return a new array of `AuditorMod` with `archiveSha256` populated.
 *
 * Mods without a resolvable archive (no `archiveId`, missing download
 * record, or file not present on disk) pass through unchanged. We do
 * not throw on individual failures — drift is more useful than a hard
 * stop when one file is missing.
 */
export async function enrichModsWithArchiveHashes(
  state: types.IState,
  gameId: string,
  mods: AuditorMod[],
  options: EnrichOptions = {},
): Promise<AuditorMod[]> {
  const {
    concurrency = getDefaultHashConcurrency(),
    onProgress,
    signal,
    hashCache,
  } = options;

  let done = 0;
  // Batch-level counters ONLY — this runs over hundreds of thousands of
  // files across a profile, so nothing per-file is logged here. See the
  // module-level rule this function exists to honor.
  let hashed = 0;
  let cacheHits = 0;
  let skipped = 0;
  let failed = 0;
  const startedAt = Date.now();

  ehLog("info", "archive-hash.batch.start", {
    mods: mods.length,
    concurrency,
    cacheEnabled: hashCache !== undefined,
  });

  try {
    const result = await pMap(
      mods,
      concurrency,
      async (mod) => {
        if (signal?.aborted) {
          throw new AbortError();
        }
        const archivePath = getModArchivePath(state, mod.archiveId, gameId);

        let archiveSha256: string | undefined;

        if (archivePath) {
          try {
            const stat = await fs.promises.stat(archivePath);

            if (stat.isFile()) {
              // Re-reading every archive on every build is ~17 minutes and tens
              // of gigabytes for a large profile, and the bytes have not moved.
              // The fingerprint is what makes skipping it safe: a cached hash is
              // reused only when path, size AND mtime all still match.
              const key =
                hashCache !== undefined
                  ? archiveFileCacheKey(archivePath, stat.size, stat.mtimeMs)
                  : undefined;
              const cached = key === undefined ? undefined : hashCache!.get(key);
              if (cached !== undefined) {
                archiveSha256 = cached;
                cacheHits += 1;
              } else {
                archiveSha256 = await hashFileSha256(archivePath, signal);
                hashed += 1;
                if (key !== undefined) {
                  hashCache!.set(key, archiveSha256);
                }
              }
            }
          } catch (err) {
            // Re-throw cancellation so pMap unwinds cleanly. Otherwise
            // swallow — file missing or unreadable is non-fatal: drift
            // is more useful than a hard stop.
            if (isAbort(err)) {
              throw err;
            }
            failed += 1;
          }
        } else {
          skipped += 1;
        }

        done += 1;
        onProgress?.(done, mods.length, mod);

        return archiveSha256 !== undefined ? { ...mod, archiveSha256 } : mod;
      },
      signal,
    );

    ehLog("info", "archive-hash.batch.ok", {
      mods: mods.length,
      hashed,
      cacheHits,
      skipped,
      failed,
      ms: Date.now() - startedAt,
    });
    return result;
  } catch (err) {
    const aborted = isAbort(err);
    ehLog(aborted ? "warn" : "error", "archive-hash.batch.fail", {
      mods: mods.length,
      done,
      hashed,
      cacheHits,
      skipped,
      failed,
      ms: Date.now() - startedAt,
      err: aborted ? "aborted" : err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
