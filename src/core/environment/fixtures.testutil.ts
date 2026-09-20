/**
 * Byte-exact builders for the binary formats the environment checks read.
 * Test-only (`.testutil.ts` is excluded from the build).
 *
 * Built to the real layouts, which were validated against real files before
 * these existed: the PE parser against GOG Fallout 4 / Skyrim AE, Hunt and
 * CS2 executables; the depot-manifest parser against a real 91 GB Steam depot.
 * The GOG hash database follows imLinguin/gog_hashdb's reader; no real one has
 * been measured here yet.
 */

import * as zlib from "zlib";

import { crc32 } from "../manifest/readZip";

// ── PE (Windows executable / DLL) ────────────────────────────────────────

export type PeSpec = {
  is64?: boolean;
  exports?: string[];
  exportBase?: number;
  imports?: Array<{ dll: string; names?: string[]; ordinals?: number[] }>;
};

export function buildPe(spec: PeSpec): Buffer {
  const is64 = spec.is64 ?? true;
  const FILE_ALIGN = 0x200;
  const SECTION_RVA = 0x1000;
  /**
   * Sized from the spec, not fixed: the cap tests build tables with thousands
   * of descriptors or tens of thousands of thunks, and a fixed 32 KiB section
   * silently truncated them into a different fixture than the one asked for.
   * Every allocation below is 8-aligned, so the per-entry slack is generous
   * on purpose — a fixture that runs out of room is a test that proves
   * nothing.
   */
  const entryCount = (spec.imports ?? []).reduce(
    (n, imp) => n + (imp.names?.length ?? 0) + (imp.ordinals?.length ?? 0) + 1,
    0,
  );
  const sec = Buffer.alloc(
    0x8000 +
      24 * ((spec.imports?.length ?? 0) + 1) +
      64 * (spec.imports?.length ?? 0) +
      32 * entryCount +
      32 * (spec.exports?.length ?? 0),
  );
  let cursor = 0;
  const alloc = (n: number): number => {
    const at = cursor;
    cursor = (cursor + n + 7) & ~7;
    return at;
  };
  const rva = (offset: number): number => SECTION_RVA + offset;
  const cstr = (s: string): number => {
    const at = alloc(s.length + 1);
    sec.write(s, at, "latin1");
    return rva(at);
  };

  let exportRva = 0;
  const exports = spec.exports ?? [];
  if (exports.length > 0) {
    const dir = alloc(40);
    const nameRvas = exports.map(cstr);
    const names = alloc(4 * exports.length);
    nameRvas.forEach((r, i) => sec.writeUInt32LE(r, names + 4 * i));
    const ordinals = alloc(2 * exports.length);
    exports.forEach((_, i) => sec.writeUInt16LE(i, ordinals + 2 * i));
    const functions = alloc(4 * exports.length);
    exports.forEach((_, i) => sec.writeUInt32LE(SECTION_RVA, functions + 4 * i));
    sec.writeUInt32LE(cstr("fixture.dll"), dir + 12);
    sec.writeUInt32LE(spec.exportBase ?? 1, dir + 16);
    sec.writeUInt32LE(exports.length, dir + 20);
    sec.writeUInt32LE(exports.length, dir + 24);
    sec.writeUInt32LE(rva(functions), dir + 28);
    sec.writeUInt32LE(rva(names), dir + 32);
    sec.writeUInt32LE(rva(ordinals), dir + 36);
    exportRva = rva(dir);
  }

  let importRva = 0;
  const imports = spec.imports ?? [];
  if (imports.length > 0) {
    const descriptors = alloc(20 * (imports.length + 1));
    const width = is64 ? 8 : 4;
    imports.forEach((imp, i) => {
      const entries: Array<{ name?: string; ordinal?: number }> = [
        ...(imp.names ?? []).map((name) => ({ name })),
        ...(imp.ordinals ?? []).map((ordinal) => ({ ordinal })),
      ];
      const thunks = alloc(width * (entries.length + 1));
      entries.forEach((e, j) => {
        const at = thunks + width * j;
        if (e.name !== undefined) {
          const hint = alloc(2 + e.name.length + 1);
          sec.write(e.name, hint + 2, "latin1");
          sec.writeUInt32LE(rva(hint), at);
        } else if (is64) {
          sec.writeUInt32LE(e.ordinal!, at);
          sec.writeUInt32LE(0x80000000, at + 4);
        } else {
          sec.writeUInt32LE((0x80000000 | e.ordinal!) >>> 0, at);
        }
      });
      const d = descriptors + 20 * i;
      sec.writeUInt32LE(rva(thunks), d);
      sec.writeUInt32LE(cstr(imp.dll), d + 12);
      sec.writeUInt32LE(rva(thunks), d + 16);
    });
    importRva = rva(descriptors);
  }

  const optionalSize = is64 ? 240 : 224;
  const header = Buffer.alloc(FILE_ALIGN);
  header.write("MZ", 0, "latin1");
  header.writeUInt32LE(0x40, 0x3c);
  header.write("PE\0\0", 0x40, "latin1");
  const coff = 0x44;
  header.writeUInt16LE(is64 ? 0x8664 : 0x14c, coff);
  header.writeUInt16LE(1, coff + 2);
  header.writeUInt16LE(optionalSize, coff + 16);
  const opt = 0x58;
  header.writeUInt16LE(is64 ? 0x20b : 0x10b, opt);
  header.writeUInt32LE(FILE_ALIGN, opt + 60);
  header.writeUInt32LE(16, opt + (is64 ? 108 : 92));
  const dd = opt + (is64 ? 112 : 96);
  header.writeUInt32LE(exportRva, dd);
  header.writeUInt32LE(exportRva === 0 ? 0 : 40, dd + 4);
  header.writeUInt32LE(importRva, dd + 8);
  header.writeUInt32LE(importRva === 0 ? 0 : 20 * (imports.length + 1), dd + 12);
  const table = opt + optionalSize;
  const rawSize = Math.max(FILE_ALIGN, Math.ceil(cursor / FILE_ALIGN) * FILE_ALIGN);
  header.write(".rdata", table, "latin1");
  header.writeUInt32LE(cursor, table + 8);
  header.writeUInt32LE(SECTION_RVA, table + 12);
  header.writeUInt32LE(rawSize, table + 16);
  header.writeUInt32LE(FILE_ALIGN, table + 20);
  return Buffer.concat([header, sec.subarray(0, rawSize)]);
}

// ── Steam depot manifest ─────────────────────────────────────────────────

const varint = (n: number): number[] => {
  const out: number[] = [];
  while (n >= 128) {
    out.push((n % 128) | 128);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
};
const lenField = (field: number, bytes: Buffer): Buffer =>
  Buffer.concat([Buffer.from([...varint(field * 8 + 2), ...varint(bytes.length)]), bytes]);
const varField = (field: number, n: number): Buffer => Buffer.from([...varint(field * 8), ...varint(n)]);
const section = (magic: number, body: Buffer): Buffer => {
  const head = Buffer.alloc(8);
  head.writeUInt32LE(magic, 0);
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
};

export function buildDepotManifest(
  files: Array<{ name: string; size: number; flags?: number }>,
  options: { encrypted?: boolean } = {},
): Buffer {
  const payload = Buffer.concat(
    files.map((f) =>
      lenField(
        1,
        Buffer.concat([
          lenField(1, Buffer.from(f.name, "utf8")),
          varField(2, f.size),
          varField(3, f.flags ?? 0),
          lenField(5, Buffer.alloc(20, 7)),
        ]),
      ),
    ),
  );
  const metadata = Buffer.concat([varField(1, 377161), varField(4, options.encrypted === true ? 1 : 0)]);
  const end = Buffer.alloc(4);
  end.writeUInt32LE(0x32c415ab, 0);
  return Buffer.concat([
    section(0x71f617d0, payload),
    section(0x1f4812be, metadata),
    section(0x1b81b817, Buffer.alloc(0)),
    end,
  ]);
}

// ── Zip, and GOG's hash database ─────────────────────────────────────────

/** A zip with UTF-8 names, each entry stored or deflated. */
export function buildZip(entries: Array<{ name: string; data: Buffer }>, method: "store" | "deflate" = "deflate"): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const packed = method === "deflate" ? zlib.deflateRawSync(e.data) : e.data;
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method === "deflate" ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, packed);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE(method === "deflate" ? 8 : 0, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(packed.length, 20);
    record.writeUInt32LE(e.data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, eocd]);
}

/** The table inside a `goggame-<id>.hashdb`: header (12, 1, count), then a 1024-byte path and a 32-byte hash per file. */
export function buildGogHashdbTable(paths: string[], options: { count?: number; hash?: string } = {}): Buffer {
  const table = Buffer.alloc(12 + paths.length * 1056);
  table.writeUInt32LE(12, 0);
  table.writeUInt32LE(1, 4);
  table.writeUInt32LE(options.count ?? paths.length, 8);
  paths.forEach((p, i) => {
    table.write(p, 12 + i * 1056, "utf8");
    table.write(options.hash ?? "0123456789abcdef0123456789abcdef", 12 + i * 1056 + 1024, "latin1");
  });
  return table;
}

/** A whole `goggame-<id>.hashdb`: the table, zipped as its one entry. */
export function buildGogHashdb(
  paths: string[],
  options: { count?: number; hash?: string; method?: "store" | "deflate" } = {},
): Buffer {
  return buildZip([{ name: "hashdb", data: buildGogHashdbTable(paths, options) }], options.method);
}
