/**
 * ──────────────────────────────────────────────────────────────────────
 * Remembering the hash of an archive we had to re-download.
 *
 * Recovering 226 archives is gigabytes and a long wait. Without somewhere to
 * put the result it is gigabytes and a long wait EVERY build, because nothing
 * in Vortex changes: the mod still points at a dead download record, and
 * Event Horizon deliberately does not rewrite Vortex's mod records to fix that
 * — re-linking another application's state is not ours to do.
 *
 * So the hash is kept here instead, and the cost is paid once.
 *
 * ## Why a Nexus file id is a safe key
 *
 * A Nexus `fileId` names one immutable uploaded file. Its bytes do not change,
 * so neither does its sha256. That is not a convenience assumption bolted on
 * here — it is the same assumption the manifest itself rests on, since a mod is
 * identified by `(modId, fileId, sha256)`. If a fileId could serve different
 * bytes over time, every collection ever built would already be unsound.
 *
 * External mods are deliberately NOT cached: they have no stable identity to
 * key on, and a filename is not one.
 *
 * ## The cache fills gaps; it never overrides bytes
 *
 * If the archive is on disk, it gets hashed. A cached value is consulted only
 * where there is no archive to read, which keeps a stale or poisoned entry from
 * ever contradicting the real file. Entries are only written from downloads
 * Vortex reported as `finished` — meaning it verified them — so a truncated
 * transfer cannot be remembered as fact.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fsp from "fs/promises";
import * as path from "path";

import type { AuditorMod } from "./getModsListForProfile";
import { nexusCompareKey } from "./identity/compareKey";
import { ehLog, beginOp } from "./logging/ehLog";

export const ARCHIVE_HASH_CACHE_FILE = "archive-hashes.json";

export type CachedArchiveHash = {
  sha256: string;
  /** Bytes, when known. Diagnostic only — never used for matching. */
  size?: number;
  /** ISO timestamp, so a suspect entry can be aged out by hand. */
  recoveredAt: string;
  /**
   * The download record the recovered archive landed in.
   *
   * Without this the hash outlives the file: a later build can identify the mod
   * but cannot open it, so every check that reads archive bytes silently
   * degrades. Optional — entries written before this existed have no id,
   * and they still serve their original purpose.
   */
  downloadId?: string;
};

export type ArchiveHashCache = {
  schemaVersion: 1;
  entries: Record<string, CachedArchiveHash>;
};

export const emptyArchiveHashCache = (): ArchiveHashCache => ({
  schemaVersion: 1,
  entries: {},
});

/**
 * `file:<path>|<size>|<mtimeMs>|<ctimeMs>` — a fingerprint of the file ON DISK.
 *
 * The other key answers "what was this Nexus file's hash?" for archives that
 * are gone. This one answers a different question: "have I already hashed
 * exactly these bytes?" — so a build does not re-read 730 archives, ~15 minutes
 * and tens of gigabytes, every single time the Build page is opened.
 *
 * ─── WHY CTIME IS IN THE KEY, AND WHY IT IS NOT OPTIONAL ───────────────
 * This used to key on path+size+mtime alone, defended as: "any write updates
 * mtime… a file replaced with different bytes of identical size at an
 * identical millisecond would be missed — that is a deliberate act, not a
 * failure mode, and the archive-level sha256 is what would catch it anyway."
 *
 * Both halves of that turned out to be wrong.
 *
 * It is not only a deliberate act. Restoring timestamps is ROUTINE: archive
 * extraction applies the times stored in the archive, and `robocopy`
 * preserves them by default — which is how this project's own Skyrim mirror
 * pipeline moves staging between machines. Measured on NTFS: write a file,
 * rewrite it with different bytes of the SAME size, restore mtime with
 * `utimes`, and mtime is back to its original value while ctime is not.
 * `utimes` cannot set ctime; the filesystem stamps it on every write.
 *
 * And the "sha256 would catch it anyway" fallback does not exist for an
 * `external:staging:<hash>` mod, where the staging hash IS the identity —
 * precisely the regenerated-output case (BodySlide, FaceGen, LOD) that
 * shipped a broken collection.
 *
 * Five consumers rest on this key: a mod's `archiveSha256` identity, the
 * staged-file hashes players verify against, the resolver's view of a
 * download, the drift detector, and the pick-time archive check. A stale hit
 * is a wrong answer in every one of them, so `ctimeMs` is required rather
 * than optional — a caller that cannot supply it should not be reaching a
 * cache at all.
 *
 * It fails in the safe direction: a metadata-only change (attributes, a
 * move) moves ctime without moving content, which costs a re-read and never
 * a wrong hash. Old `file:…` entries written before this simply never match
 * and age out.
 */
export function archiveFileCacheKey(
  absolutePath: string,
  size: number,
  mtimeMs: number,
  ctimeMs: number,
): string {
  return `file:${absolutePath}|${size}|${Math.floor(mtimeMs)}|${Math.floor(ctimeMs)}`;
}

/**
 * A read-through cache of file hashes, as `enrichModsWithArchiveHashes` sees
 * it. Deliberately tiny: the hashing pass should not know about disk layout,
 * JSON, or when a save happens.
 */
export type ArchiveHashLookup = {
  get(key: string): string | undefined;
  set(key: string, sha256: string): void;
};

/**
 * Wrap a loaded cache as a lookup, recording whatever gets added.
 *
 * `ignoreExisting` makes every read miss while still recording what gets
 * computed. That is what a "re-verify everything" run needs: it must re-read
 * the bytes rather than trust a fingerprint, but it must still leave the cache
 * populated — otherwise one re-verification permanently costs the curator the
 * fast path, and the next ordinary build pays the full pass again for no
 * reason. Bypassing the cache entirely was the first attempt and it had exactly
 * that effect: 26 minutes of hashing, nothing written, right back to 26
 * minutes.
 */
export function makeHashLookup(
  cache: ArchiveHashCache,
  options: { ignoreExisting?: boolean } = {},
): {
  lookup: ArchiveHashLookup;
  /** Entries added this run; empty means nothing needs saving. */
  added: Map<string, string>;
  hits: number;
} {
  const added = new Map<string, string>();
  let hits = 0;
  return {
    added,
    get hits() {
      return hits;
    },
    lookup: {
      get(key) {
        if (options.ignoreExisting === true) return undefined;
        const hit = cache.entries[key]?.sha256;
        if (hit !== undefined) hits += 1;
        return hit;
      },
      set(key, sha256) {
        if (isHex64(sha256)) added.set(key, sha256);
      },
    },
  };
}

/** Merge freshly-computed hashes into a cache. Input is not mutated. */
export function mergeHashes(
  cache: ArchiveHashCache,
  added: ReadonlyMap<string, string>,
  at: string,
): ArchiveHashCache {
  if (added.size === 0) return cache;
  const entries = { ...cache.entries };
  for (const [key, sha256] of added) {
    entries[key] = { sha256, recoveredAt: at };
  }
  return { schemaVersion: 1, entries };
}

/** `nexus:<modId>:<fileId>` — the same identity the manifest uses. */
export function archiveHashCacheKey(
  nexusModId: string | number,
  nexusFileId: string | number,
): string {
  // The same identity the manifest uses — now literally, rather than by a
  // convention two files each spelled out.
  return nexusCompareKey(nexusModId, nexusFileId);
}

function cacheKeyForMod(mod: AuditorMod): string | undefined {
  return mod.nexusModId !== undefined && mod.nexusFileId !== undefined
    ? archiveHashCacheKey(mod.nexusModId, mod.nexusFileId)
    : undefined;
}

const isHex64 = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

/**
 * Read the cache, tolerating every way the file can be wrong.
 *
 * A cache is an optimisation, so a missing, truncated or hand-edited file must
 * degrade to "no cached hashes" rather than failing a build. Entries that are
 * not a plausible sha256 are dropped individually — one bad line should not
 * discard the other two hundred.
 */
export async function loadArchiveHashCache(
  dataDir: string,
): Promise<ArchiveHashCache> {
  const startedAt = Date.now();
  let raw: string;
  try {
    raw = await fsp.readFile(path.join(dataDir, ARCHIVE_HASH_CACHE_FILE), "utf8");
  } catch {
    ehLog("debug", "hash-cache.load.none", { ms: Date.now() - startedAt });
    return emptyArchiveHashCache();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    ehLog("warn", "hash-cache.load.corrupt-json", {
      ms: Date.now() - startedAt,
      err,
    });
    return emptyArchiveHashCache();
  }

  const entries = (parsed as ArchiveHashCache | undefined)?.entries;
  if (entries === null || typeof entries !== "object") {
    ehLog("warn", "hash-cache.load.bad-shape", { ms: Date.now() - startedAt });
    return emptyArchiveHashCache();
  }

  const clean: Record<string, CachedArchiveHash> = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
    const entry = value as Partial<CachedArchiveHash> | undefined;
    if (!isHex64(entry?.sha256)) {
      dropped += 1;
      continue;
    }
    clean[key] = {
      sha256: entry!.sha256!,
      ...(typeof entry!.size === "number" ? { size: entry!.size } : {}),
      recoveredAt:
        typeof entry!.recoveredAt === "string" ? entry!.recoveredAt : "unknown",
    };
  }
  ehLog("info", "hash-cache.load.ok", {
    entries: Object.keys(clean).length,
    dropped,
    ms: Date.now() - startedAt,
  });
  return { schemaVersion: 1, entries: clean };
}

export async function saveArchiveHashCache(
  dataDir: string,
  cache: ArchiveHashCache,
): Promise<void> {
  const op = beginOp("hash-cache.save", {
    entries: Object.keys(cache.entries).length,
  });
  try {
    await fsp.mkdir(dataDir, { recursive: true });
    const target = path.join(dataDir, ARCHIVE_HASH_CACHE_FILE);
    const tmp = `${target}.tmp`;
    // Write-then-rename: a build interrupted mid-save must not leave a truncated
    // cache that the next run silently reads as "no hashes".
    await fsp.writeFile(tmp, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
    await fsp.rename(tmp, target);
    op.ok();
  } catch (err) {
    op.fail(err);
    throw err;
  }
}

/** Record a hash. Returns a new cache; the input is not mutated. */
export function rememberArchiveHash(
  cache: ArchiveHashCache,
  args: {
    nexusModId: string | number;
    nexusFileId: string | number;
    sha256: string;
    size?: number;
    at: string;
    downloadId?: string;
  },
): ArchiveHashCache {
  if (!isHex64(args.sha256)) return cache;
  return {
    schemaVersion: 1,
    entries: {
      ...cache.entries,
      [archiveHashCacheKey(args.nexusModId, args.nexusFileId)]: {
        sha256: args.sha256,
        ...(args.size !== undefined ? { size: args.size } : {}),
        recoveredAt: args.at,
        ...(args.downloadId !== undefined
          ? { downloadId: args.downloadId }
          : {}),
      },
    },
  };
}

/**
 * Re-attach recovered download ids, and nothing else.
 *
 * Separate from `applyCachedHashes` because of WHEN it has to run. The build
 * asks "are the source archives even still there?" in its first second, before
 * committing to fifteen minutes of hashing — and at that moment the mods are
 * raw from Vortex, so the only thing that knows a recovered archive exists is
 * this cache. Restoring the hash there too would be wrong: a hash keyed by
 * Nexus ids would then stand in for a file that is present and readable, and
 * quietly outrank hashing the actual bytes.
 *
 * So this fills the link and leaves identity alone.
 */
export function applyCachedDownloadIds(
  mods: AuditorMod[],
  cache: ArchiveHashCache,
): AuditorMod[] {
  let changed = false;
  const out = mods.map((mod) => {
    if (mod.recoveredDownloadId !== undefined) return mod;
    const key = cacheKeyForMod(mod);
    if (key === undefined) return mod;
    const hit = cache.entries[key];
    if (hit?.downloadId === undefined) return mod;
    changed = true;
    return { ...mod, recoveredDownloadId: hit.downloadId };
  });
  return changed ? out : mods;
}

/**
 * Fill in hashes for mods whose archive is gone, and ONLY those.
 *
 * A mod that already has an `archiveSha256` was hashed from bytes on disk this
 * run; that always wins. The cache cannot overrule a real file.
 */
export function applyCachedHashes(
  mods: AuditorMod[],
  cache: ArchiveHashCache,
): { mods: AuditorMod[]; filled: number } {
  let filled = 0;
  const out = mods.map((mod) => {
    if (mod.archiveSha256 !== undefined) return mod;
    const key = cacheKeyForMod(mod);
    if (key === undefined) return mod;
    const hit = cache.entries[key];
    if (hit === undefined) return mod;
    filled += 1;
    // The download id travels with the hash. Restoring one without the other is
    // what let a mod be identifiable and unreadable at the same time.
    return {
      ...mod,
      archiveSha256: hit.sha256,
      ...(hit.downloadId !== undefined
        ? { recoveredDownloadId: hit.downloadId }
        : {}),
    };
  });
  return filled === 0 ? { mods, filled: 0 } : { mods: out, filled };
}
