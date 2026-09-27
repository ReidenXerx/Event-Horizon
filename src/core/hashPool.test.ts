/**
 * The hash pool runs real worker processes here (this Node, in place of
 * Vortex.exe): the claim worth pinning is that a pooled hash is the same
 * SHA-256 as the in-process one, and that every way the pool can fail still
 * ends in a correct hash, never a failed one.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";

import { hashFileSha256, hashFileSha256InProcess } from "./archiveHashing";
import { HashPool, PoolUnavailable, setHashPoolForTests } from "./hashPool";
import { AbortError } from "../utils/abortError";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-hashpool-"));
const write = (name: string, bytes: Buffer): string => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
};
const sha = (b: Buffer): string => crypto.createHash("sha256").update(b).digest("hex");

const empty = write("empty.bin", Buffer.alloc(0));
const small = write("small.esp", Buffer.from("TES4 plugin bytes"));
// Larger than one 8 MB read, so the worker's chunk loop runs more than once.
const bigBytes = crypto.randomBytes(8 * 1024 * 1024 + 12345);
const big = write("big.ba2", bigBytes);

let pool: HashPool | undefined;
afterEach(() => {
  pool?.shutdown("test");
  pool = undefined;
  setHashPoolForTests(undefined);
});

describe("hash pool", () => {
  it("gives the same SHA-256 as hashing in-process, for empty, small and multi-chunk files", async () => {
    pool = new HashPool({ workers: 3 });
    const got = await Promise.all([empty, small, big, small, big].map((f) => pool!.hash(f)));
    expect(got).toEqual([sha(Buffer.alloc(0)), sha(Buffer.from("TES4 plugin bytes")), sha(bigBytes), sha(Buffer.from("TES4 plugin bytes")), sha(bigBytes)]);
    expect(got[2]).toBe(await hashFileSha256InProcess(big));
  });

  it("keeps the error code of a file that cannot be read (not a pool failure)", async () => {
    pool = new HashPool({ workers: 1 });
    const err = await pool.hash(path.join(dir, "missing.esp")).catch((e) => e);
    expect(err).not.toBeInstanceOf(PoolUnavailable);
    expect(err.code).toBe("ENOENT");
  });

  it("rejects an aborted hash with AbortError", async () => {
    pool = new HashPool({ workers: 1 });
    const ac = new AbortController();
    const p = pool.hash(big, ac.signal);
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(AbortError);
    // The pool is still fine afterwards.
    await expect(pool.hash(small)).resolves.toBe(sha(Buffer.from("TES4 plugin bytes")));
  });

  it("a pool that cannot start answers PoolUnavailable, and hashFileSha256 hashes in-process instead", async () => {
    pool = new HashPool({ workers: 2, execPath: path.join(dir, "no-such-runtime.exe") });
    await expect(pool.hash(small)).rejects.toBeInstanceOf(PoolUnavailable);
    expect(pool.unavailableReason).toBeDefined();
    expect(pool.parallelism).toBe(0);
    setHashPoolForTests(pool);
    await expect(hashFileSha256(big)).resolves.toBe(sha(bigBytes));
    pool = undefined; // already shut down by setHashPoolForTests
  });

  it("a worker that dies mid-hash costs nothing: hashFileSha256 still returns the right hash", async () => {
    pool = new HashPool({ workers: 1 });
    setHashPoolForTests(pool);
    await pool.hash(small); // started
    const p = hashFileSha256(big);
    // Kill the only worker while it holds the job.
    (pool as unknown as { workers: Array<{ child: { kill: () => void } }> }).workers[0]!.child.kill();
    await expect(p).resolves.toBe(sha(bigBytes));
    pool = undefined;
  });

  it("stops its workers when idle", async () => {
    pool = new HashPool({ workers: 2, idleMs: 50 });
    await pool.hash(small);
    const kids = (pool as unknown as { workers: Array<{ child: { exitCode: number | null; signalCode: string | null } }> }).workers.map((w) => w.child);
    expect(kids).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 400));
    expect((pool as unknown as { workers: unknown[] }).workers).toHaveLength(0);
    expect(kids.every((k) => k.exitCode !== null || k.signalCode !== null)).toBe(true);
  });
});
