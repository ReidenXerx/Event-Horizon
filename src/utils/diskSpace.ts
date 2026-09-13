/**
 * Disk-space probing.
 *
 * We expose a single `getFreeBytes(path)` that returns the free bytes
 * available on the volume that hosts `path`, or `undefined` if the
 * underlying API isn't available (older Node, locked-down sandbox,
 * Electron renderer mismatch, ...).
 *
 * `undefined` is a deliberate signal — callers should treat "we don't
 * know" as "skip the warning" rather than "block the user". We never
 * want a flaky probe to gate an install.
 *
 * Implementation order:
 *   1. `fs.promises.statfs` (Node ≥ 18.15). Cheap, no shell out.
 *   2. (Future) `child_process` fallback for older Vortex bundles.
 */

import * as fs from "fs/promises";
import * as nodePath from "path";

import { AbortError } from "./abortError";

/**
 * Returns free bytes available to the current user on the volume that
 * contains `targetPath`. The path doesn't need to exist — we walk up
 * to the closest existing ancestor before probing, because pre-flight
 * checks usually run *before* a directory is created.
 *
 * Returns `undefined` if probing isn't possible. Callers should treat
 * that as "skip the disk-space warning".
 */
export async function getFreeBytes(
  targetPath: string,
): Promise<number | undefined> {
  // statfs landed in 18.15. Older bundles (some Vortex builds) ship
  // with 16.x where the property is missing. Guard with a runtime
  // typeof check so we degrade gracefully.
  type StatfsModule = typeof fs & {
    statfs?: (p: string) => Promise<{ bavail: bigint; bsize: bigint }>;
  };
  const fsx = fs as StatfsModule;
  if (typeof fsx.statfs !== "function") return undefined;

  const probePath = await findExistingAncestor(targetPath);
  if (probePath === undefined) return undefined;

  try {
    const s = await fsx.statfs(probePath);
    // bavail = blocks available to non-superuser; bsize = block size.
    // Both are bigints on Node ≥ 20; on 18.15 some shims return
    // numbers. We coerce defensively.
    const bavail = typeof s.bavail === "bigint" ? s.bavail : BigInt(s.bavail);
    const bsize = typeof s.bsize === "bigint" ? s.bsize : BigInt(s.bsize);
    const total = bavail * bsize;
    // Number can hold up to ~9 PB exactly which is enough for any
    // user-facing display. We clamp to MAX_SAFE_INTEGER to avoid
    // surprises if a hilariously huge raid array shows up.
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number.MAX_SAFE_INTEGER;
    }
    return Number(total);
  } catch {
    return undefined;
  }
}

async function findExistingAncestor(p: string): Promise<string | undefined> {
  let current = p;
  // Cap iterations so a malformed path can't spin forever.
  for (let i = 0; i < 64; i++) {
    try {
      await fs.access(current);
      return current;
    } catch {
      // Not present — walk up.
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require("path") as typeof import("path");
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/** Human-readable byte string like "1.4 GB". Mirrored in BuildPage but
 * kept here so non-UI callers (logs, error context) can format too. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

/** Free bytes on the drive holding a directory; `undefined` when that cannot be known. */
export type FreeBytesProbe = (dir: string) => Promise<number | undefined>;

/** One write that needs room: where it goes, how much it takes, and what it is, for the refusal. */
export type DiskNeed = { dir: string; bytes: number; what: string };

export type DiskShortfall = { dir: string; neededBytes: number; freeBytes: number; what: string[] };

/**
 * A write refused before it started, because the drive it goes to lacks the
 * room. It carries `code: "ENOSPC"`, the code the same failure has when a disk
 * fills partway through, so whatever handles one handles both.
 */
export class DiskSpaceError extends Error {
  readonly code = "ENOSPC";
  readonly shortfalls: readonly DiskShortfall[];
  constructor(shortfalls: readonly DiskShortfall[]) {
    super(shortfalls.map(describeShortfall).join("\n"));
    this.name = "DiskSpaceError";
    this.shortfalls = shortfalls;
  }
}

function describeShortfall(s: DiskShortfall): string {
  return (
    `Not enough free space on the drive holding "${s.dir}": ${s.what.join(" and ")} ` +
    `${s.what.length === 1 ? "needs" : "need"} about ${formatBytes(s.neededBytes)}, and ` +
    `${formatBytes(s.freeBytes)} is free. Free up at least ` +
    `${formatBytes(s.neededBytes - s.freeBytes)} there, then try again.`
  );
}

/** The drive a directory is on, as a key two directories can be compared by. */
async function driveOf(dir: string): Promise<string> {
  const existing = await findExistingAncestor(dir);
  if (existing !== undefined) {
    try {
      return `dev:${(await fs.stat(existing)).dev}`;
    } catch {
      // The path's root below is the next best answer.
    }
  }
  return `root:${nodePath.parse(nodePath.resolve(dir)).root.toLowerCase()}`;
}

/**
 * Refuse a set of writes, before any of them starts, when a drive cannot take
 * what is headed for it. Needs on one drive add up. A drive whose free space
 * cannot be read is let through: a probe that fails must never block anyone.
 */
export async function requireFreeSpace(
  needs: readonly DiskNeed[],
  probe: FreeBytesProbe = getFreeBytes,
): Promise<void> {
  const byDrive = new Map<string, { dir: string; bytes: number; what: string[] }>();
  for (const need of needs) {
    if (need.bytes <= 0) continue;
    const drive = await driveOf(need.dir);
    const entry = byDrive.get(drive) ?? { dir: need.dir, bytes: 0, what: [] };
    entry.bytes += need.bytes;
    entry.what.push(`${need.what} (${formatBytes(need.bytes)})`);
    byDrive.set(drive, entry);
  }
  const short: DiskShortfall[] = [];
  for (const entry of byDrive.values()) {
    const free = await probe(entry.dir);
    if (free === undefined || free >= entry.bytes) continue;
    short.push({ dir: entry.dir, neededBytes: entry.bytes, freeBytes: free, what: entry.what });
  }
  if (short.length > 0) throw new DiskSpaceError(short);
}

/** Room claimed on a drive, held for as long as its write runs. */
export type DiskClaim = { release: () => void };

const claimsByDrive = new Map<string, Set<{ bytes: number }>>();
let wakeOnRelease: Array<() => void> = [];

/**
 * Claim room for a write that can run alongside others on the same drive.
 *
 * A write that fits after counting the claims already held starts at once. One
 * that does not waits for those writes to finish and looks again. One that
 * does not fit with nothing else running is refused. A held claim is counted
 * whole even while its bytes are landing, so a tight drive runs its writes one
 * at a time rather than refusing one that would have fit on its own.
 */
export async function claimFreeSpace(
  need: DiskNeed,
  options: { probe?: FreeBytesProbe; signal?: AbortSignal } = {},
): Promise<DiskClaim> {
  const probe = options.probe ?? getFreeBytes;
  const drive = await driveOf(need.dir);
  for (;;) {
    if (options.signal?.aborted === true) throw new AbortError("Cancelled");
    const held = claimsByDrive.get(drive) ?? new Set<{ bytes: number }>();
    const heldBytes = [...held].reduce((n, c) => n + c.bytes, 0);
    const free = await probe(need.dir);
    if (free === undefined || free - heldBytes >= need.bytes) {
      const claim = { bytes: need.bytes };
      held.add(claim);
      claimsByDrive.set(drive, held);
      let released = false;
      return {
        release: (): void => {
          if (released) return;
          released = true;
          held.delete(claim);
          const waiting = wakeOnRelease;
          wakeOnRelease = [];
          for (const wake of waiting) wake();
        },
      };
    }
    if (heldBytes === 0) {
      throw new DiskSpaceError([
        {
          dir: need.dir,
          neededBytes: need.bytes,
          freeBytes: free,
          what: [`${need.what} (${formatBytes(need.bytes)})`],
        },
      ]);
    }
    await new Promise<void>((wake) => wakeOnRelease.push(wake));
  }
}
