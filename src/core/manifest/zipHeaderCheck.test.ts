import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";

import { afterAll, describe, expect, it } from "vitest";

import { checkZipHeaders, describeZipHeaderCheck } from "./zipHeaderCheck";

/**
 * A stored-entry zip written byte by byte, so a test can damage exactly one
 * header the way a real repack did. `localExtra` replaces an entry's local
 * extra field and, when given, saturates its local sizes to 0xFFFFFFFF.
 */
type Spec = { name: string; data: Buffer; localName?: string; localExtra?: Buffer };

function zip64Field(...values: number[]): Buffer {
  const b = Buffer.alloc(4 + 8 * values.length);
  b.writeUInt16LE(1, 0);
  b.writeUInt16LE(8 * values.length, 2);
  values.forEach((v, i) => b.writeBigUInt64LE(BigInt(v), 4 + 8 * i));
  return b;
}

function buildZip(specs: Spec[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const s of specs) {
    const crc = zlib.crc32(s.data);
    const lname = Buffer.from(s.localName ?? s.name, "utf8");
    const extra = s.localExtra ?? Buffer.alloc(0);
    const sat = s.localExtra !== undefined;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(45, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(sat ? 0xffffffff : s.data.length, 18);
    local.writeUInt32LE(sat ? 0xffffffff : s.data.length, 22);
    local.writeUInt16LE(lname.length, 26);
    local.writeUInt16LE(extra.length, 28);
    parts.push(local, lname, extra, s.data);

    const cname = Buffer.from(s.name, "utf8");
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(45, 4);
    c.writeUInt16LE(45, 6);
    c.writeUInt16LE(0x800, 8);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(s.data.length, 20);
    c.writeUInt32LE(s.data.length, 24);
    c.writeUInt16LE(cname.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, cname);
    offset += 30 + lname.length + extra.length + s.data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(specs.length, 8);
  eocd.writeUInt16LE(specs.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-zipcheck-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
let n = 0;
function write(buf: Buffer): string {
  const p = path.join(dir, `p${n++}.zip`);
  fs.writeFileSync(p, buf);
  return p;
}

const A = Buffer.from("first file");
const B = Buffer.from("second file, a little longer");

describe("a package's local headers against its index", () => {
  it("passes a zip whose two copies of every header agree, ZIP64 sizes included", async () => {
    const p = write(buildZip([
      { name: "a.txt", data: A },
      { name: "dir/b.nif", data: B, localExtra: zip64Field(B.length, B.length) },
    ]));
    expect(await checkZipHeaders(p)).toEqual({ ok: true, entries: 2 });
  });

  it("refuses the Ivy Rev 23 shape: a stale ZIP64 field copied in front of the real one", async () => {
    // What Python's zipfile wrote: the old package's index field (one offset)
    // and then the fresh sizes. 7-Zip reads the first and takes the offset
    // for a size; Python's own reader never notices.
    const stale = zip64Field(4_559_301_268);
    const fresh = zip64Field(B.length, B.length);
    const p = write(buildZip([
      { name: "a.txt", data: A },
      { name: "bundled/71c7/meshes/tifagloves.nif", data: B, localExtra: Buffer.concat([stale, fresh]) },
    ]));
    const check = await checkZipHeaders(p);
    expect(check).toMatchObject({ ok: false, kind: "bad-headers", entries: 2, bad: 1 });
    if (check.ok || check.kind !== "bad-headers") throw new Error("unreachable");
    expect(check.examples[0]).toEqual({
      entry: "bundled/71c7/meshes/tifagloves.nif",
      problem: "2 ZIP64 fields in the local header (7-Zip reads the first)",
    });
    expect(describeZipHeaderCheck(check)).toContain("1 of 2 files in it have damaged headers");
  });

  it("reads ZIP64 sizes from the first field, as 7-Zip does", async () => {
    const p = write(buildZip([{ name: "b.nif", data: B, localExtra: zip64Field(999, B.length) }]));
    const check = await checkZipHeaders(p);
    expect(check).toMatchObject({ ok: false, kind: "bad-headers", bad: 1 });
    if (!check.ok && check.kind === "bad-headers") expect(check.examples[0]!.problem).toMatch(/^size 999 here/);
  });

  it("refuses a local header that names a different file", async () => {
    const p = write(buildZip([{ name: "a.txt", data: A, localName: "z.txt" }]));
    expect(await checkZipHeaders(p)).toMatchObject({ ok: false, kind: "bad-headers", bad: 1 });
  });

  it("calls a cut-off download unreadable rather than damaged at the source", async () => {
    const whole = buildZip([{ name: "a.txt", data: A }, { name: "b.txt", data: B }]);
    const p = write(whole.subarray(0, 40));
    expect(await checkZipHeaders(p)).toMatchObject({ ok: false, kind: "unreadable" });
  });
});
