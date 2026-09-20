/**
 * ──────────────────────────────────────────────────────────────────────
 * A cache that cannot change an answer.
 *
 * The external-mod divergence check needs a CRC-32 per staged file, and that
 * costs a full read — 42.85 GiB on one real collection, nearly all of it a
 * 37 GiB output that changes about once a year.
 *
 * The obvious cache key is path+size+mtime, and it is a BET: a tool that
 * rewrites a file and restores its timestamp produces a stale hit, and a
 * stale hit here silently stops reporting a divergence — exactly the failure
 * this check was added to end. Keying on the SHA-256 the capture already
 * recorded makes no bet: the same digest is the same bytes is the same CRC.
 *
 * So these tests are about one property above all — a hit is a fact, and
 * anything that is not provably the same bytes is not a hit.
 * ──────────────────────────────────────────────────────────────────────
 */
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CRC_CACHE_FILE,
  emptyCrcCache,
  loadCrcCache,
  makeCrcLookup,
  saveCrcCache,
} from "./crcBySha256";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const CRC_A = "deadbeef";

let dir: string;
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "eh-crc-"));
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe("what counts as a hit", () => {
  it("returns a CRC for bytes it has already identified", () => {
    const c = makeCrcLookup({ schema: "s", entries: { [SHA_A]: CRC_A } });
    expect(c.get(SHA_A)).toBe(CRC_A);
    expect(c.hits).toBe(1);
  });

  it("misses for a digest it has never seen", () => {
    const c = makeCrcLookup({ schema: "s", entries: { [SHA_A]: CRC_A } });
    expect(c.get(SHA_B)).toBeUndefined();
    expect(c.hits).toBe(0);
  });

  it("misses when the file has NO recorded digest — nothing proves the bytes", () => {
    // A "fast" capture records no sha256. Such a file is read every time,
    // which is the honest outcome: there is no key that proves anything.
    const c = makeCrcLookup({ schema: "s", entries: { [SHA_A]: CRC_A } });
    expect(c.get(undefined)).toBeUndefined();
  });

  it("refuses to record an entry it could not key by content", () => {
    const c = makeCrcLookup(emptyCrcCache());
    c.set(undefined, CRC_A);
    c.set("not-a-sha", CRC_A);
    c.set(SHA_A, "nope");
    expect([...c.added]).toEqual([]);
  });

  it("records a well-formed pair", () => {
    const c = makeCrcLookup(emptyCrcCache());
    c.set(SHA_A, CRC_A);
    expect([...c.added]).toEqual([[SHA_A, CRC_A]]);
  });
});

describe("surviving the disk", () => {
  it("round-trips what a run computed", async () => {
    const c = makeCrcLookup(emptyCrcCache());
    c.set(SHA_A, CRC_A);
    await saveCrcCache(dir, emptyCrcCache(), c.added);

    const back = await loadCrcCache(dir);
    expect(back.entries[SHA_A]).toBe(CRC_A);
  });

  it("keeps earlier entries when merging a later run", async () => {
    await saveCrcCache(dir, emptyCrcCache(), new Map([[SHA_A, CRC_A]]));
    const first = await loadCrcCache(dir);
    await saveCrcCache(dir, first, new Map([[SHA_B, "12345678"]]));

    const back = await loadCrcCache(dir);
    expect(Object.keys(back.entries).sort()).toEqual([SHA_A, SHA_B].sort());
  });

  it("writes nothing when a run computed nothing", async () => {
    await saveCrcCache(dir, emptyCrcCache(), new Map());
    await expect(
      fsp.readFile(path.join(dir, CRC_CACHE_FILE), "utf8"),
    ).rejects.toThrow();
  });

  it("drops a malformed entry on the way IN, not on the way out", async () => {
    // A hand-edited or truncated file must never put a wrong CRC in front of
    // the comparison.
    await fsp.writeFile(
      path.join(dir, CRC_CACHE_FILE),
      JSON.stringify({
        schema: "x",
        entries: { [SHA_A]: CRC_A, "short": "beef", [SHA_B]: "not-a-crc" },
      }),
      "utf8",
    );
    const back = await loadCrcCache(dir);
    expect(back.entries).toEqual({ [SHA_A]: CRC_A });
  });

  it("treats an unreadable or absent cache as empty", async () => {
    expect((await loadCrcCache(path.join(dir, "nope"))).entries).toEqual({});
    await fsp.writeFile(path.join(dir, CRC_CACHE_FILE), "{ not json", "utf8");
    expect((await loadCrcCache(dir)).entries).toEqual({});
  });
});
