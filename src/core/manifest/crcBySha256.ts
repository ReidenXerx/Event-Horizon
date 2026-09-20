/**
 * ──────────────────────────────────────────────────────────────────────
 * CRC-32 of bytes we have already identified, keyed by their SHA-256.
 *
 * The external-mod divergence check needs a CRC-32 per staged file, because
 * that is the only checksum an archive header gives us to compare against.
 * Computing it costs a full read: measured at 42.85 GiB and ~4.9 minutes on
 * one real collection, nearly all of it a 37 GiB FaceGen output that changes
 * about once a year.
 *
 * ─── WHY THIS CACHE CANNOT COST PRECISION ──────────────────────────────
 * It is keyed on the file's SHA-256, which the staging capture has already
 * computed and recorded in `stagingFiles` — not on its path, size or mtime.
 *
 * That distinction is the whole design. A path+size+mtime key is a BET: a
 * tool that rewrites a file and restores its timestamp — and several modding
 * tools do exactly that — produces a stale hit, and a stale hit here would
 * silently stop reporting a divergence, which is precisely the failure this
 * check exists to end. A SHA-256 key makes no bet at all: identical digest
 * means identical bytes means identical CRC-32. A hit is a fact, not an
 * assumption, and the only way to be wrong is a SHA-256 collision, which is
 * the assumption every other identity in this product already rests on.
 *
 * It is also why the cache is shared rather than per-mod or per-collection:
 * the same bytes have the same CRC wherever they are staged, so a mod that
 * appears in two collections is read once, ever.
 *
 * ─── WHAT IT DOES NOT DO ───────────────────────────────────────────────
 * It never decides anything. A miss costs a read; a corrupt or unreadable
 * cache file costs a read for everything. There is no path where a fault
 * here turns into a wrong answer about a mod — only into a slower build.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fsp from "fs/promises";
import * as path from "path";

import { beginOp, ehLog } from "../logging/ehLog";

export const CRC_CACHE_FILE = "crc-by-sha256.json";

const SCHEMA = "event-horizon.crc-by-sha256/1";

export type CrcBySha256Cache = {
  schema: string;
  /** Lowercase 64-hex SHA-256 → lowercase 8-hex CRC-32. */
  entries: Record<string, string>;
};

const isSha256 = (s: unknown): s is string =>
  typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
const isCrc32 = (s: unknown): s is string =>
  typeof s === "string" && /^[0-9a-f]{8}$/.test(s);

export function emptyCrcCache(): CrcBySha256Cache {
  return { schema: SCHEMA, entries: {} };
}

/** Never throws: a cache that cannot be read is a cache that is empty. */
export async function loadCrcCache(
  dataDir: string,
): Promise<CrcBySha256Cache> {
  try {
    const raw = await fsp.readFile(path.join(dataDir, CRC_CACHE_FILE), "utf8");
    const parsed = JSON.parse(raw) as Partial<CrcBySha256Cache>;
    const entries: Record<string, string> = {};
    for (const [sha, crc] of Object.entries(parsed?.entries ?? {})) {
      // Both halves validated on the way IN, so a hand-edited or truncated
      // file cannot put a wrong CRC in front of the comparison.
      if (isSha256(sha) && isCrc32(crc)) entries[sha] = crc;
    }
    return { schema: SCHEMA, entries };
  } catch {
    return emptyCrcCache();
  }
}

/**
 * A lookup over a loaded cache, recording what this run computed.
 *
 * Shaped like `makeHashLookup` so the two read the same way at their call
 * sites, and for the same reason: what was ADDED is what needs saving.
 */
export function makeCrcLookup(cache: CrcBySha256Cache): {
  get(sha256: string | undefined): string | undefined;
  set(sha256: string | undefined, crc: string): void;
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
    get(sha256) {
      if (sha256 === undefined) return undefined;
      const hit = cache.entries[sha256];
      if (hit !== undefined) hits += 1;
      return hit;
    },
    set(sha256, crc) {
      // A file with no recorded SHA-256 is not cacheable: there is nothing to
      // key it by that proves the bytes. It simply gets read every time.
      if (!isSha256(sha256) || !isCrc32(crc)) return;
      added.set(sha256, crc);
    },
  };
}

/** Merge and write. Never throws — losing a cache costs time, nothing else. */
export async function saveCrcCache(
  dataDir: string,
  cache: CrcBySha256Cache,
  added: ReadonlyMap<string, string>,
): Promise<void> {
  if (added.size === 0) return;
  const op = beginOp("crc-cache.save", { added: added.size });
  try {
    const merged: CrcBySha256Cache = {
      schema: SCHEMA,
      entries: { ...cache.entries },
    };
    for (const [sha, crc] of added) merged.entries[sha] = crc;
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.writeFile(
      path.join(dataDir, CRC_CACHE_FILE),
      JSON.stringify(merged),
      "utf8",
    );
    op.ok({ entries: Object.keys(merged.entries).length });
  } catch (err) {
    ehLog("warn", "crc-cache.save.failed", {
      err,
      consequence: "the next build re-reads these files; nothing is wrong",
    });
  }
}
