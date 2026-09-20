/**
 * The rule this file exists to defend: the cache FILLS GAPS, it never overrides
 * bytes. A hash computed from a real file this run always wins, so a stale or
 * hand-edited entry cannot contradict what is on disk.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ARCHIVE_HASH_CACHE_FILE,
  applyCachedHashes,
  archiveFileCacheKey,
  archiveHashCacheKey,
  emptyArchiveHashCache,
  loadArchiveHashCache,
  makeHashLookup,
  mergeHashes,
  rememberArchiveHash,
  saveArchiveHashCache,
} from "./archiveHashCache";
import type { AuditorMod } from "./getModsListForProfile";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

const mod = (over: Partial<AuditorMod> & { id: string }): AuditorMod =>
  ({
    name: over.id,
    enabled: true,
    collectionIds: [],
    hasInstallerChoices: false,
    hasDetailedInstallerChoices: false,
    fomodSelections: [],
    rules: [],
    modType: "",
    fileOverrides: [],
    enabledINITweaks: [],
    installOrder: 0,
    ...over,
  }) as AuditorMod;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-hashcache-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * ──────────────────────────────────────────────────────────────────────
 * A restored timestamp must not buy a cache hit.
 *
 * The key used to be path+size+mtime, defended as "any write updates mtime".
 * Restoring timestamps is routine, though — archive extraction applies the
 * times stored in the archive, and `robocopy` preserves them by default, which
 * is how this project's own Skyrim staging gets mirrored between machines.
 *
 * Measured on NTFS: rewrite a file with different bytes of the SAME size, then
 * restore mtime with `utimes`, and mtime is back to its original value while
 * ctime is not. `utimes` cannot set ctime. So the pair is a fingerprint a
 * timestamp-restoring tool cannot forge, and these tests pin that the key
 * actually uses it — five consumers read a wrong answer out of a stale hit,
 * including the drift detector whose entire job is noticing a rewrite.
 * ──────────────────────────────────────────────────────────────────────
 */
describe("the on-disk fingerprint", () => {
  it("differs when only ctime moved — same path, size and mtime", () => {
    const a = archiveFileCacheKey("C:/x/a.7z", 1024, 1_700_000_000_000, 1_700_000_000_000);
    const b = archiveFileCacheKey("C:/x/a.7z", 1024, 1_700_000_000_000, 1_700_000_009_999);
    expect(a).not.toBe(b);
  });

  it("is stable for a file nobody touched", () => {
    expect(archiveFileCacheKey("C:/x/a.7z", 1024, 1_700_000_000_000, 1_700_000_000_500)).toBe(
      archiveFileCacheKey("C:/x/a.7z", 1024, 1_700_000_000_000, 1_700_000_000_500),
    );
  });

  it("still separates on size and mtime", () => {
    const base = archiveFileCacheKey("C:/x/a.7z", 1024, 1_700_000_000_000, 1_700_000_000_000);
    expect(archiveFileCacheKey("C:/x/a.7z", 2048, 1_700_000_000_000, 1_700_000_000_000)).not.toBe(base);
    expect(archiveFileCacheKey("C:/x/a.7z", 1024, 1_700_000_000_001, 1_700_000_000_000)).not.toBe(base);
  });

  it("cannot collide with an entry written before ctime was in the key", () => {
    // Old entries are `file:<path>|<size>|<mtime>`. They must simply never
    // match rather than aliasing onto a new one.
    expect(
      archiveFileCacheKey("C:/x/a.7z", 1024, 1_700_000_000_000, 1_700_000_000_000),
    ).not.toBe("file:C:/x/a.7z|1024|1700000000000");
  });
});

describe("applyCachedHashes", () => {
  it("NEVER overrides a hash computed from a real file", () => {
    const cache = rememberArchiveHash(emptyArchiveHashCache(), {
      nexusModId: 1, nexusFileId: 2, sha256: SHA_B, at: "now",
    });
    const { mods, filled } = applyCachedHashes(
      [mod({ id: "m", nexusModId: 1, nexusFileId: 2, archiveSha256: SHA_A })],
      cache,
    );
    expect(mods[0]!.archiveSha256).toBe(SHA_A);
    expect(filled).toBe(0);
  });

  it("fills a mod whose archive is gone", () => {
    const cache = rememberArchiveHash(emptyArchiveHashCache(), {
      nexusModId: 1, nexusFileId: 2, sha256: SHA_A, at: "now",
    });
    const { mods, filled } = applyCachedHashes(
      [mod({ id: "m", nexusModId: 1, nexusFileId: 2 })],
      cache,
    );
    expect(mods[0]!.archiveSha256).toBe(SHA_A);
    expect(filled).toBe(1);
  });

  it("does not match a different file of the same mod", () => {
    // A new version is a new fileId and genuinely different bytes.
    const cache = rememberArchiveHash(emptyArchiveHashCache(), {
      nexusModId: 1, nexusFileId: 2, sha256: SHA_A, at: "now",
    });
    const { filled } = applyCachedHashes(
      [mod({ id: "m", nexusModId: 1, nexusFileId: 99 })],
      cache,
    );
    expect(filled).toBe(0);
  });

  it("ignores external mods — a filename is not an identity", () => {
    const cache = rememberArchiveHash(emptyArchiveHashCache(), {
      nexusModId: 1, nexusFileId: 2, sha256: SHA_A, at: "now",
    });
    const { filled } = applyCachedHashes([mod({ id: "ext" })], cache);
    expect(filled).toBe(0);
  });

  it("returns the original array when it changes nothing", () => {
    const mods = [mod({ id: "m" })];
    expect(applyCachedHashes(mods, emptyArchiveHashCache()).mods).toBe(mods);
  });
});

describe("rememberArchiveHash", () => {
  it("refuses anything that is not a sha256", () => {
    const cache = rememberArchiveHash(emptyArchiveHashCache(), {
      nexusModId: 1, nexusFileId: 2, sha256: "not-a-hash", at: "now",
    });
    expect(cache.entries).toEqual({});
  });

  it("keys on the identity the manifest uses", () => {
    const cache = rememberArchiveHash(emptyArchiveHashCache(), {
      nexusModId: "77337", nexusFileId: 42, sha256: SHA_A, size: 10, at: "t",
    });
    expect(cache.entries[archiveHashCacheKey(77337, "42")]!.sha256).toBe(SHA_A);
  });
});

describe("persistence", () => {
  it("round-trips", async () => {
    const cache = rememberArchiveHash(emptyArchiveHashCache(), {
      nexusModId: 1, nexusFileId: 2, sha256: SHA_A, size: 5, at: "t",
    });
    await saveArchiveHashCache(dir, cache);
    await expect(loadArchiveHashCache(dir)).resolves.toEqual(cache);
  });

  it("treats a missing file as an empty cache, not an error", async () => {
    await expect(loadArchiveHashCache(dir)).resolves.toEqual(emptyArchiveHashCache());
  });

  it("survives a corrupt file rather than failing the build", async () => {
    fs.writeFileSync(path.join(dir, ARCHIVE_HASH_CACHE_FILE), "{ not json");
    await expect(loadArchiveHashCache(dir)).resolves.toEqual(emptyArchiveHashCache());
  });

  it("keeps the download id a recovered archive was found under", async () => {
    /**
     * The field is written on recovery and was then destroyed by the loader on
     * the very next read, so it only ever worked inside the run that created
     * it. Measured on a real curator's cache before this: 990 Nexus-keyed
     * entries, ZERO carrying a downloadId — the exact failure the type's own
     * docblock names, "the hash outlives the file".
     */
    const cache = rememberArchiveHash(emptyArchiveHashCache(), {
      nexusModId: 1,
      nexusFileId: 2,
      sha256: SHA_A,
      at: "t",
      downloadId: "dl-99",
    });
    await saveArchiveHashCache(dir, cache);
    const back = await loadArchiveHashCache(dir);
    expect(back.entries[archiveHashCacheKey(1, 2)]?.downloadId).toBe("dl-99");
  });

  it("drops a file key from before ctime joined the fingerprint", async () => {
    /**
     * Those keys can never be matched again, and there were 430,675 of them
     * on one real machine the moment the key changed — 134 MB of JSON parsed
     * on every build for entries that could not hit. Dropped because they are
     * UNREACHABLE; nothing here evicts an entry for being old or large, and a
     * `nexus:` key never expires at all.
     */
    fs.writeFileSync(
      path.join(dir, ARCHIVE_HASH_CACHE_FILE),
      JSON.stringify({
        schemaVersion: 1,
        entries: {
          "file:C:/dl/old.7z|100|1000": { sha256: SHA_A, recoveredAt: "t" },
          [archiveFileCacheKey("C:/dl/new.7z", 100, 1000, 2000)]: {
            sha256: SHA_B,
            recoveredAt: "t",
          },
          [archiveHashCacheKey(7, 8)]: { sha256: SHA_A, recoveredAt: "t" },
        },
      }),
    );
    const back = await loadArchiveHashCache(dir);
    expect(Object.keys(back.entries).sort()).toEqual(
      [archiveFileCacheKey("C:/dl/new.7z", 100, 1000, 2000), archiveHashCacheKey(7, 8)].sort(),
    );
  });

  it("keeps a file key whose PATH contains no pipe but is otherwise odd", async () => {
    // The shape test counts separators, so a long Windows path with spaces
    // and dots must still read as current rather than being thrown away.
    const key = archiveFileCacheKey(
      "C:/Users/x/AppData/Roaming/Vortex/downloads/fallout4/Some Mod - v1.2.3 (final).7z",
      12345,
      1_700_000_000_000,
      1_700_000_000_001,
    );
    fs.writeFileSync(
      path.join(dir, ARCHIVE_HASH_CACHE_FILE),
      JSON.stringify({ schemaVersion: 1, entries: { [key]: { sha256: SHA_A, recoveredAt: "t" } } }),
    );
    const back = await loadArchiveHashCache(dir);
    expect(back.entries[key]?.sha256).toBe(SHA_A);
  });

  it("drops only the bad entries, keeping the rest", async () => {
    fs.writeFileSync(
      path.join(dir, ARCHIVE_HASH_CACHE_FILE),
      JSON.stringify({
        schemaVersion: 1,
        entries: {
          good: { sha256: SHA_A, recoveredAt: "t" },
          truncated: { sha256: "abc" },
          empty: {},
        },
      }),
    );
    const loaded = await loadArchiveHashCache(dir);
    expect(Object.keys(loaded.entries)).toEqual(["good"]);
  });

  it("does not leave a truncated cache if a write is interrupted", async () => {
    // Written to a temp name and renamed, so readers never see a partial file.
    await saveArchiveHashCache(dir, emptyArchiveHashCache());
    expect(fs.readdirSync(dir)).toEqual([ARCHIVE_HASH_CACHE_FILE]);
  });
});

describe("file fingerprint cache", () => {
  // Re-hashing 730 archives is ~15 minutes and tens of gigabytes on every
  // build. Skipping that is only safe if the fingerprint proves the bytes are
  // the ones already hashed.
  it("reuses a hash only when path, size AND mtime all match", () => {
    const cache = mergeHashes(
      emptyArchiveHashCache(),
      new Map([[archiveFileCacheKey("C:/dl/a.7z", 100, 1000, 9), SHA_A]]),
      "t",
    );
    const { lookup } = makeHashLookup(cache);
    expect(lookup.get(archiveFileCacheKey("C:/dl/a.7z", 100, 1000, 9))).toBe(SHA_A);
    // any one of them differing is a different file as far as this is concerned
    expect(lookup.get(archiveFileCacheKey("C:/dl/a.7z", 101, 1000, 9))).toBeUndefined();
    expect(lookup.get(archiveFileCacheKey("C:/dl/a.7z", 100, 1001, 9))).toBeUndefined();
    expect(lookup.get(archiveFileCacheKey("C:/dl/b.7z", 100, 1000, 9))).toBeUndefined();
  });

  it("ignores sub-millisecond mtime jitter", () => {
    // Windows reports fractional mtimeMs; the same file must not miss its own
    // entry because the float came back a hair different.
    expect(archiveFileCacheKey("a", 1, 1000.4, 2000.4)).toBe(
      archiveFileCacheKey("a", 1, 1000.9, 2000.9),
    );
  });

  it("records what it computed, and nothing it did not", () => {
    const { lookup, added } = makeHashLookup(emptyArchiveHashCache());
    lookup.set(archiveFileCacheKey("C:/dl/a.7z", 1, 2, 9), SHA_A);
    lookup.set(archiveFileCacheKey("C:/dl/b.7z", 1, 2, 9), "not-a-hash");
    expect(added.size).toBe(1);
  });

  it("keeps the nexus-keyed entries when merging file hashes", () => {
    // Both key spaces share one file; recovering archives and hashing them
    // must not evict each other.
    const withNexus = rememberArchiveHash(emptyArchiveHashCache(), {
      nexusModId: 1, nexusFileId: 2, sha256: SHA_A, at: "t",
    });
    const merged = mergeHashes(
      withNexus,
      new Map([[archiveFileCacheKey("C:/dl/a.7z", 1, 2, 9), SHA_B]]),
      "t",
    );
    expect(merged.entries[archiveHashCacheKey(1, 2)]!.sha256).toBe(SHA_A);
    expect(Object.keys(merged.entries)).toHaveLength(2);
  });

  it("re-verify ignores existing entries but STILL records what it computes", () => {
    // Bypassing the cache entirely meant one re-verification cost the curator
    // the fast path forever: everything re-read, nothing written, and the next
    // ordinary build paying the full 26-minute pass again.
    const key = archiveFileCacheKey("C:/dl/a.7z", 1, 2, 9);
    const cache = mergeHashes(emptyArchiveHashCache(), new Map([[key, SHA_A]]), "t");
    const { lookup, added, ...rest } = makeHashLookup(cache, { ignoreExisting: true });

    expect(lookup.get(key)).toBeUndefined(); // forced to re-read
    lookup.set(key, SHA_B); // and the fresh answer is kept
    expect(added.get(key)).toBe(SHA_B);
    expect(rest.hits).toBe(0);
  });

  it("returns the same cache when nothing was computed", () => {
    const cache = emptyArchiveHashCache();
    expect(mergeHashes(cache, new Map(), "t")).toBe(cache);
  });
});
