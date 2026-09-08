/**
 * Bundled archive prefetch pool — overlap 7z extraction with Vortex
 * mod installs.
 *
 * Vortex serializes mod installs internally (FOMOD UI is modal,
 * `start-install` holds the global install lock). For collections
 * with many bundled archives this means we waste wall-clock time:
 * while Vortex spends 30 seconds installing mod N, the user's CPU
 * sits idle even though we could already be extracting mod N+1's
 * archive out of the .ehcoll ZIP.
 *
 * This pool runs up to `concurrency` extractions in the background
 * via {@link extractBundledFromEhcoll}. The driver consumes them
 * via `take(zipEntry)` which:
 *
 *  - Returns the pre-extracted result immediately when available.
 *  - Awaits the in-flight extraction when one is mid-flight.
 *  - Kicks off a fresh extraction inline when the entry was never
 *    queued (e.g. the driver hit a recovery path that asks for a
 *    different bundled entry than we'd primed).
 *
 * ### Why concurrency=2 and not "all at once"?
 *
 * Bundled archives can be hundreds of MB each (think Skyrim mesh
 * packs, voice mods). Extracting all of them up front would balloon
 * the temp directory to multi-GB and on small SSDs OR low-end
 * laptops could even ENOSPC the install. Concurrency=2 keeps the
 * pipeline at most "current install + one prefetch", which mirrors
 * the way humans pipeline — installing one while reaching for the
 * next. It also matches the empirical sweet spot in the Vortex
 * extension test fixture (3+ regressed throughput on HDDs because
 * 7z's own thread pool fights with the parallel reads).
 *
 * ### Failure semantics
 *
 * Extraction errors are LATCHED: when the user takes a zipEntry
 * whose background extraction failed, the failure is re-thrown.
 * We don't retry transparently because the caller's recovery path
 * (uninstall + reinstall in the verifying-mods phase) handles
 * transient errors at a higher level, and silently re-extracting
 * would mask antivirus / disk full / corrupt-package problems.
 *
 * ### Cleanup
 *
 * Every extracted tempDir is owned by the pool until the driver
 * `take()`s it. After `take` the ownership transfers to the driver
 * (it's already collecting tempDirs for end-of-run cleanup).
 *
 * Extractions that finished but were NEVER taken (because the
 * driver aborted, or because the recovery path bypassed the
 * prefetch) are cleaned up by `dispose()` — call this in the
 * driver's `finally` block.
 */

import { AbortError } from "../../utils/abortError";
import { ehLog } from "../logging/ehLog";
// No 7z import. Extraction from a .ehcoll is a ZIP read of our own format and
// is done natively — see extractBundledFromEhcoll. This pool used to call
// resolveSevenZip() in its CONSTRUCTOR, which throws when util.SevenZip is
// unavailable, so building the pool failed on a Proton prefix before a single
// byte had been read.
import {
  extractBundledFromEhcoll,
  safeRmTempDir,
} from "./modInstall";

export type PrefetchedBundle = {
  extractedPath: string;
  tempDir: string;
};

export type BundledPrefetchPoolOptions = {
  ehcollZipPath: string;
  /**
   * Maximum concurrent extractions. Defaults to 2 (see module
   * header for the rationale). Clamped to >= 1.
   */
  concurrency?: number;
  signal?: AbortSignal;
  /**
   * Optional per-extraction timing callback. Used by the install
   * driver to surface "prefetched in 3.2s" diagnostics — purely
   * informational, never affects behavior. Fires on success only.
   */
  onExtracted?: (zipEntry: string, ms: number) => void;
};

/**
 * One entry to prefetch: which archive inside the .ehcoll, and what the
 * curator calls the mod it holds.
 *
 * The name is not decoration. It becomes the extracted file's name, which
 * becomes the mod's name in Vortex, which is what
 * `enrichInstalledModsWithStagingSetHashes` matches on to decide whether a
 * bundled external mod is already installed. Prime without it and every such
 * mod is reinstalled on every resume — see {@link bundledArchiveFileName}.
 */
export type PrefetchRequest = {
  zipEntry: string;
  preferredName?: string;
};

type Slot =
  | { state: "queued"; zipEntry: string }
  | {
      state: "extracting";
      zipEntry: string;
      promise: Promise<PrefetchedBundle>;
    }
  | {
      state: "ready";
      zipEntry: string;
      result: PrefetchedBundle;
      taken: boolean;
    }
  | { state: "failed"; zipEntry: string; error: Error };

export class BundledPrefetchPool {
  private readonly ehcollZipPath: string;
  private readonly concurrency: number;
  private readonly signal: AbortSignal | undefined;
  private readonly onExtracted: ((zipEntry: string, ms: number) => void) | undefined;

  /**
   * Map from zipEntry → its current pool slot. We key by zipEntry
   * because that's the canonical id Vortex's bundledArchives carry
   * (sha256-keyed at the manifest level, but path-keyed at the .ehcoll
   * cherry-pick level — see {@link extractBundledFromEhcoll}).
   *
   * Multiple manifest mods CAN reference the same zipEntry (rare but
   * legal — the curator deduped by hash). We share a single
   * extraction in that case; the second `take()` walks the readiness
   * waiter chain like the first.
   */
  private readonly slots = new Map<string, Slot>();

  /**
   * zipEntry → the curator's mod name for it.
   *
   * Separate from {@link slots} because a slot is CONSUMED by `take` while the
   * name must outlive it: a retry after a failed verification takes the same
   * entry again on the cold path, and it should land in a folder with the same
   * name as the first attempt rather than one named after the hash.
   */
  private readonly names = new Map<string, string>();

  /**
   * Order the driver primed entries in. We extract in this order so
   * the prefetch matches the install order — the pool can't know the
   * driver's actual sequence, but the curator's manifest order is
   * what the driver iterates.
   */
  private readonly queue: string[] = [];

  /** How many extractions are currently in flight. Capped at `concurrency`. */
  private inFlight = 0;

  /** Resolves when the pool is fully drained — currently unused but useful for tests. */
  private disposed = false;

  constructor(opts: BundledPrefetchPoolOptions) {
    this.ehcollZipPath = opts.ehcollZipPath;
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
    this.signal = opts.signal;
    this.onExtracted = opts.onExtracted;
  }

  /**
   * Seed the pool with the zipEntries the driver expects to take.
   * Idempotent — calling twice with overlapping sets is fine, the
   * second call only adds the new entries.
   *
   * Calling `prime` does NOT block; extractions kick off
   * asynchronously and saturate up to `concurrency`. Use
   * {@link take} to consume them.
   */
  prime(entries: readonly PrefetchRequest[]): void {
    if (this.disposed) return;
    let added = 0;
    for (const { zipEntry, preferredName } of entries) {
      // Recorded even for an entry we have already queued: two manifest mods
      // can share one bundled archive, and the first name that arrives is the
      // one both installs will carry. Not worth resolving — they are the same
      // bytes — but worth not overwriting mid-flight.
      if (preferredName !== undefined && !this.names.has(zipEntry)) {
        this.names.set(zipEntry, preferredName);
      }
      if (this.slots.has(zipEntry)) continue;
      this.slots.set(zipEntry, { state: "queued", zipEntry });
      this.queue.push(zipEntry);
      added++;
    }
    ehLog("info", "bundled-prefetch.primed", {
      requested: entries.length,
      added,
      alreadyQueued: entries.length - added,
      named: this.names.size,
      concurrency: this.concurrency,
    });
    this.pump();
  }

  /**
   * Get the extraction result for `zipEntry`. Returns immediately
   * when the slot is `ready`. Awaits the in-flight extraction when
   * `extracting`. Re-throws the latched error when `failed`. Falls
   * back to a fresh inline extraction when the entry was never
   * primed (driver took an unexpected recovery path).
   *
   * Once `take` resolves, the caller owns the tempDir and is
   * responsible for {@link safeRmTempDir} after Vortex finishes
   * with the extracted file. The pool removes the slot to avoid
   * double-cleanup at `dispose()` time.
   */
  async take(
    zipEntry: string,
    /**
     * The curator's mod name, for the cold path. A primed entry already
     * carries one from {@link prime}; this only matters when the driver takes
     * a bundled entry nobody predicted, and passing it keeps that mod's
     * folder named like every other one rather than after its hash.
     */
    preferredName?: string,
  ): Promise<PrefetchedBundle> {
    if (this.signal?.aborted) {
      throw new AbortError();
    }

    const slot = this.slots.get(zipEntry);
    if (slot === undefined) {
      // Never primed — extract inline. This is the cold path; the
      // driver's prime() call should usually have caught it.
      ehLog("warn", "bundled-prefetch.take.cold", { zipEntry });
      if (preferredName !== undefined && !this.names.has(zipEntry)) {
        this.names.set(zipEntry, preferredName);
      }
      return await this.runExtraction(zipEntry, /* tracked */ false);
    }

    if (slot.state === "ready") {
      this.slots.delete(zipEntry);
      const taken = slot.result;
      ehLog("debug", "bundled-prefetch.take.hit", { zipEntry });
      // Now that this slot is consumed, see if we can start the
      // next queued extraction (we were holding back at concurrency).
      this.pump();
      return taken;
    }

    if (slot.state === "extracting") {
      ehLog("debug", "bundled-prefetch.take.await", { zipEntry });
      try {
        const result = await slot.promise;
        // Fall through: re-read the slot (it may have transitioned
        // to "ready" or "failed" by the time we get here).
        const after = this.slots.get(zipEntry);
        if (after?.state === "ready") {
          this.slots.delete(zipEntry);
          this.pump();
          return after.result;
        }
        if (after?.state === "failed") {
          this.slots.delete(zipEntry);
          throw after.error;
        }
        // Defensive: returned from extracting and the slot was
        // already consumed by another race. Re-extract inline.
        if (after === undefined) {
          this.pump();
          return result;
        }
        // Shouldn't reach here. Treat as cold extraction.
        return await this.runExtraction(zipEntry, /* tracked */ false);
      } catch (err) {
        const after = this.slots.get(zipEntry);
        if (after?.state === "failed") {
          this.slots.delete(zipEntry);
        }
        ehLog("debug", "bundled-prefetch.take.await-failed", { zipEntry });
        throw err;
      }
    }

    if (slot.state === "failed") {
      this.slots.delete(zipEntry);
      ehLog("debug", "bundled-prefetch.take.latched-failure", { zipEntry });
      throw slot.error;
    }

    // queued: promote to in-flight inline (the pump hasn't gotten
    // to it yet).
    return await this.startExtraction(zipEntry);
  }

  /**
   * Best-effort cleanup of any extractions that finished but were
   * never taken. Called by the driver's `finally` block.
   *
   * Aborts the remaining queued extractions (they never started).
   * In-flight extractions are NOT aborted here — 7z streams don't
   * expose a clean cancel; instead they finish and the temp dir is
   * removed on the next pump tick. For prompt cancellation,
   * propagate `signal` via the constructor.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    const cleanups: Promise<void>[] = [];
    for (const slot of this.slots.values()) {
      if (slot.state === "ready" && !slot.taken) {
        cleanups.push(safeRmTempDir(slot.result.tempDir));
      }
    }
    ehLog("info", "bundled-prefetch.dispose", {
      remainingSlots: this.slots.size,
      untakenReady: cleanups.length,
    });
    this.slots.clear();
    this.queue.length = 0;
    await Promise.all(cleanups);
  }

  /**
   * Saturate the in-flight extraction count up to `concurrency`,
   * pulling the next queued entry on each free slot. Called after
   * `prime()`, `take()`, and on every individual extraction
   * finish (success or failure).
   */
  private pump(): void {
    if (this.disposed) return;
    while (this.inFlight < this.concurrency && this.queue.length > 0) {
      const zipEntry = this.queue.shift()!;
      const slot = this.slots.get(zipEntry);
      if (slot === undefined || slot.state !== "queued") {
        // The slot was promoted by an inline `take()` already.
        continue;
      }
      // `.catch`, not a bare `void`: `runExtraction` re-throws after latching
      // the failure into the slot, and nothing is awaiting this promise yet —
      // the driver may not call `take()` for minutes. Without the handler that
      // rejection surfaces as an unhandled-rejection dialog mid-install, for a
      // mod the driver has not reached. `take()` still re-throws `slot.error`,
      // so swallowing it here loses nothing.
      void this.startExtraction(zipEntry).catch(() => undefined);
    }
  }

  /** Promote a queued slot into in-flight and run the extraction. */
  private startExtraction(zipEntry: string): Promise<PrefetchedBundle> {
    const promise = this.runExtraction(zipEntry, /* tracked */ true);
    this.slots.set(zipEntry, { state: "extracting", zipEntry, promise });
    this.inFlight++;
    return promise;
  }

  /**
   * Actually call {@link extractBundledFromEhcoll} and bookkeep the
   * result into the slot map.
   *
   * `tracked` controls whether the result lands in the pool. Inline
   * fallbacks (`prime` was never called for this entry) bypass the
   * pool entirely — the driver gets the result and owns the tempDir
   * directly.
   */
  private async runExtraction(
    zipEntry: string,
    tracked: boolean,
  ): Promise<PrefetchedBundle> {
    const startedAt = Date.now();
    ehLog("debug", "bundled-prefetch.extract.start", { zipEntry, tracked });
    try {
      if (this.signal?.aborted) {
        throw new AbortError();
      }
      const result = await extractBundledFromEhcoll(
        this.ehcollZipPath,
        zipEntry,
        this.names.get(zipEntry),
      );
      const elapsed = Date.now() - startedAt;
      this.onExtracted?.(zipEntry, elapsed);
      ehLog("info", "bundled-prefetch.extract.ok", {
        zipEntry,
        tracked,
        ms: elapsed,
      });

      if (tracked) {
        this.inFlight = Math.max(0, this.inFlight - 1);
        if (this.disposed) {
          /**
           * The pool was disposed while this extraction was in flight.
           *
           * Storing the result now would REPOPULATE the map `dispose()` just
           * cleared, and nothing would ever read it — so the extracted folder
           * stayed on disk until the OS reclaimed it. A real aborted run left
           * 7.4 GB in %TEMP% that way: `bundled-prefetch.dispose` at 22:13:47,
           * then a 2,577 MB and a 4,890 MB `extract.ok` after it.
           */
          ehLog("info", "bundled-prefetch.discarded-after-dispose", {
            zipEntry,
            tempDir: result.tempDir,
          });
          await safeRmTempDir(result.tempDir);
          return result;
        }
        this.slots.set(zipEntry, {
          state: "ready",
          zipEntry,
          result,
          taken: false,
        });
        this.pump();
      }
      return result;
    } catch (err) {
      ehLog("error", "bundled-prefetch.extract.fail", {
        zipEntry,
        tracked,
        ms: Date.now() - startedAt,
        err,
      });
      if (tracked) {
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.slots.set(zipEntry, {
          state: "failed",
          zipEntry,
          error: err instanceof Error ? err : new Error(String(err)),
        });
        this.pump();
      }
      throw err;
    }
  }
}
