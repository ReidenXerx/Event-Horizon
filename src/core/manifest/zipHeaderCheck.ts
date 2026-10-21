/**
 * ──────────────────────────────────────────────────────────────────────
 * Would 7-Zip open this package? Every entry's local header against the index.
 *
 * A zip names each file twice: once in the central directory at the end (the
 * index every reader lists from) and once in a local header in front of the
 * file's bytes. This file's reader, like Python's, trusts the index and only
 * steps over the local header. 7-Zip — which is what Vortex extracts with —
 * reads both and refuses an entry whose two copies disagree: "Headers Error".
 *
 * Ivy Rev 23 (2026-10-21) was repacked outside Event Horizon with Python's
 * zipfile, which copied each entry's extra field from the old package's index,
 * stale ZIP64 offset included, then added a fresh ZIP64 field after it. 5,595
 * of 12,418 local headers carried two ZIP64 fields; 7-Zip read the first, took
 * an old offset for the file's size, and every player who updated got Vortex's
 * "Archive damaged" dialog. Python read the package without a complaint, so
 * the repack's own check passed.
 *
 * So this compares what 7-Zip compares — name, method, CRC and sizes, sizes
 * taken from the FIRST ZIP64 field as 7-Zip takes them — and calls a second
 * ZIP64 field what it is. It reads headers only: one small read per entry,
 * seconds for a 10 GB package, never the payloads.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fsp from "fs/promises";
import * as path from "path";

import { ehLog } from "../logging/ehLog";
import { listZipEntries, type ZipEntry } from "./readZip";

export type ZipHeaderProblem = { entry: string; problem: string };

export type ZipHeaderCheck =
  | { ok: true; entries: number }
  /** The index itself could not be read: a truncated or non-zip file. */
  | { ok: false; kind: "unreadable"; reason: string }
  /** The index reads, but entries' local headers disagree with it. */
  | { ok: false; kind: "bad-headers"; entries: number; bad: number; examples: ZipHeaderProblem[] };

const LOCAL_SIG = 0x04034b50;
const ZIP64_ID = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x8;
const SATURATED = 0xffffffff;
/** Name + extra of a normal entry fit in one read; longer ones get a second. */
const FIRST_READ = 30 + 1024;
const EXAMPLES = 5;

/** One entry's local header against its index record; undefined when they agree. */
function compareLocal(local: Buffer, entry: ZipEntry): string | undefined {
  if (local.length < 30 || local.readUInt32LE(0) !== LOCAL_SIG) return "no local header where the index points";
  const flags = local.readUInt16LE(6);
  const method = local.readUInt16LE(8);
  const crc = local.readUInt32LE(14);
  let compressed = local.readUInt32LE(18);
  let uncompressed = local.readUInt32LE(22);
  const nameLength = local.readUInt16LE(26);
  const extraLength = local.readUInt16LE(28);
  if (local.length < 30 + nameLength + extraLength) return "local header runs past the end of the file";

  const name = local.toString("utf8", 30, 30 + nameLength);
  if (name !== entry.name) return `local header names "${name}"`;
  if (method !== entry.method) return `method ${method} here, ${entry.method} in the index`;

  let zip64: Buffer | undefined;
  let zip64Fields = 0;
  for (let p = 30 + nameLength, end = p + extraLength; p + 4 <= end; ) {
    const id = local.readUInt16LE(p);
    const size = local.readUInt16LE(p + 2);
    if (id === ZIP64_ID) {
      zip64Fields += 1;
      zip64 ??= local.subarray(p + 4, Math.min(p + 4 + size, end));
    }
    p += 4 + size;
  }
  if (zip64Fields > 1) return `${zip64Fields} ZIP64 fields in the local header (7-Zip reads the first)`;

  if ((flags & FLAG_DATA_DESCRIPTOR) !== 0) return undefined;
  if (crc !== entry.crc32) return "CRC differs from the index";
  if (uncompressed === SATURATED || compressed === SATURATED) {
    let z = 0;
    const next = (): number | undefined => {
      if (zip64 === undefined || z + 8 > zip64.length) return undefined;
      const v = Number(zip64.readBigUInt64LE(z));
      z += 8;
      return v;
    };
    if (uncompressed === SATURATED) uncompressed = next() ?? -1;
    if (compressed === SATURATED) compressed = next() ?? -1;
    if (uncompressed < 0 || compressed < 0) return "ZIP64 sizes missing from the local header";
  }
  if (uncompressed !== entry.uncompressedSize) return `size ${uncompressed} here, ${entry.uncompressedSize} in the index`;
  if (compressed !== entry.compressedSize) return `packed size ${compressed} here, ${entry.compressedSize} in the index`;
  return undefined;
}

export async function checkZipHeaders(filePath: string, signal?: AbortSignal): Promise<ZipHeaderCheck> {
  const startedAt = Date.now();
  const file = path.basename(filePath);
  let entries: ZipEntry[];
  try {
    entries = await listZipEntries(filePath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    ehLog("warn", "zip.header-check.unreadable", { file, reason });
    return { ok: false, kind: "unreadable", reason };
  }

  // In file order, so a spinning disk reads forward instead of seeking about.
  const ordered = [...entries].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset);
  const examples: ZipHeaderProblem[] = [];
  let bad = 0;
  const handle = await fsp.open(filePath, "r");
  try {
    const buf = Buffer.alloc(FIRST_READ);
    for (const entry of ordered) {
      signal?.throwIfAborted();
      let { bytesRead } = await handle.read(buf, 0, FIRST_READ, entry.localHeaderOffset);
      let local = buf.subarray(0, bytesRead);
      if (bytesRead >= 30) {
        const need = 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
        if (need > FIRST_READ) {
          local = Buffer.alloc(need);
          ({ bytesRead } = await handle.read(local, 0, need, entry.localHeaderOffset));
          local = local.subarray(0, bytesRead);
        }
      }
      const problem = compareLocal(local, entry);
      if (problem !== undefined) {
        bad += 1;
        if (examples.length < EXAMPLES) examples.push({ entry: entry.name, problem });
      }
    }
  } finally {
    await handle.close();
  }

  const ms = Date.now() - startedAt;
  if (bad === 0) {
    ehLog("info", "zip.header-check.ok", { file, entries: entries.length, ms });
    return { ok: true, entries: entries.length };
  }
  ehLog("warn", "zip.header-check.bad", { file, entries: entries.length, bad, examples, ms });
  return { ok: false, kind: "bad-headers", entries: entries.length, bad, examples };
}

/** One line a person can act on, for logs and notifications. */
export function describeZipHeaderCheck(check: Exclude<ZipHeaderCheck, { ok: true }>): string {
  if (check.kind === "unreadable") return check.reason;
  const first = check.examples[0];
  return (
    `${check.bad} of ${check.entries} files in it have damaged headers` +
    (first === undefined ? "" : ` (first: "${first.entry}": ${first.problem})`) +
    `. 7-Zip, which Vortex extracts with, refuses them.`
  );
}
