/**
 * ──────────────────────────────────────────────────────────────────────
 * A plain ZIP writer, for handing files to someone who can read them.
 *
 * Not 7-Zip: the one component most likely to be broken on a tester's machine
 * (Wine prefixes, missing runtimes) is exactly the one a bug report must not
 * depend on. Node's zlib is always there.
 *
 * Deflate per entry, stored when deflate does not shrink it; names are flagged
 * UTF-8 (general-purpose bit 11), so a non-ASCII name reads the same on every
 * machine instead of through its OEM codepage. No ZIP64 — a log bundle is
 * nowhere near 4 GB or 65,535 files, and the writer refuses rather than emit
 * a silently corrupt archive if one ever is.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fsp from "fs/promises";
import { deflateRawSync } from "zlib";

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export type ZipSource = {
  /** Path inside the archive, "/"-separated. */
  name: string;
  /** Read lazily, one entry at a time, so memory holds one file, not the bundle. */
  read: () => Promise<Buffer>;
  mtime?: Date;
};

const LIMIT_32 = 0xffffffff;
const FLAG_UTF8 = 0x0800;

/**
 * Write `sources` to `filePath`. A source whose `read` throws is skipped and
 * reported — one unreadable log must not cost the whole bundle.
 */
export async function writeZip(
  filePath: string,
  sources: Iterable<ZipSource>,
): Promise<{ entries: number; bytes: number; skipped: Array<{ name: string; error: string }> }> {
  const handle = await fsp.open(filePath, "w");
  const central: Buffer[] = [];
  const skipped: Array<{ name: string; error: string }> = [];
  let offset = 0;
  let count = 0;
  const put = async (buf: Buffer): Promise<void> => {
    await handle.write(buf, 0, buf.length, null);
    offset += buf.length;
  };
  try {
    for (const source of sources) {
      let data: Buffer;
      try {
        data = await source.read();
      } catch (err) {
        skipped.push({ name: source.name, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      const name = Buffer.from(source.name, "utf8");
      const deflated = deflateRawSync(data);
      const stored = deflated.length >= data.length;
      const body = stored ? data : deflated;
      if (data.length > LIMIT_32 || body.length > LIMIT_32 || offset > LIMIT_32 || count >= 0xffff) {
        throw new Error(`${source.name} does not fit a non-ZIP64 archive`);
      }
      const crc = crc32(data);
      const { time, date } = dosDateTime(source.mtime ?? new Date());
      const method = stored ? 0 : 8;

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(FLAG_UTF8, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      const localOffset = offset;
      await put(local);
      await put(name);
      await put(body);

      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(0x02014b50, 0);
      entry.writeUInt16LE(20, 4);
      entry.writeUInt16LE(20, 6);
      entry.writeUInt16LE(FLAG_UTF8, 8);
      entry.writeUInt16LE(method, 10);
      entry.writeUInt16LE(time, 12);
      entry.writeUInt16LE(date, 14);
      entry.writeUInt32LE(crc, 16);
      entry.writeUInt32LE(body.length, 20);
      entry.writeUInt32LE(data.length, 24);
      entry.writeUInt16LE(name.length, 28);
      entry.writeUInt32LE(localOffset, 42);
      central.push(entry, name);
      count += 1;
    }
    const cdOffset = offset;
    const cd = Buffer.concat(central);
    await put(cd);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(count, 8);
    eocd.writeUInt16LE(count, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    await put(eocd);
  } finally {
    await handle.close();
  }
  return { entries: count, bytes: offset, skipped };
}
