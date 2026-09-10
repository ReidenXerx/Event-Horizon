/**
 * ──────────────────────────────────────────────────────────────────────
 * AN ARCHIVE LISTING MUST NAME FILES THE WAY THE EXTRACTION DID.
 *
 * The curator was offered two "deleted" files in `BeastHHBB - Feminine
 * Female Khajiit`: `femaleheadlioness - C\uFFFDpia.tri`. Both were in the
 * staging folder, correctly named "Cópia". The zip stores the "ó" as OEM
 * byte 0xA2 without the UTF-8 flag; 7-Zip decoded it right when it
 * extracted, and printed it wrong when Event Horizon asked for a listing,
 * because nobody told it which encoding to print in. The curator answered
 * "ship my deletion" on that evidence.
 *
 * Two readers, two fixes: 7-Zip is told to print UTF-8, and the native ZIP
 * reader admits when a name is a guess so the listing can ask 7-Zip.
 * ──────────────────────────────────────────────────────────────────────
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listArchiveNativeFirst } from "./listArchive";
import { crc32, listZipEntries } from "./readZip";
import { sevenZipList, type SevenZipApi } from "./sevenZip";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-names-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A one-entry stored ZIP whose name bytes and UTF-8 flag are exactly as given. */
function rawZip(file: string, nameBytes: Buffer, utf8Flag: boolean): string {
  const data = Buffer.from("hello");
  const crc = crc32(data) >>> 0;
  const flag = utf8Flag ? 0x800 : 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(flag, 6);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(flag, 8);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);

  const localPart = Buffer.concat([local, nameBytes, data]);
  const centralPart = Buffer.concat([central, nameBytes]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);

  const p = path.join(dir, file);
  fs.writeFileSync(p, Buffer.concat([localPart, centralPart, eocd]));
  return p;
}

/** The real name from the real archive: "Cópia" with ó as OEM byte 0xA2. */
const OEM_COPIA = Buffer.concat([
  Buffer.from("femaleheadlioness - C"),
  Buffer.from([0xa2]),
  Buffer.from("pia.tri"),
]);

describe("7-Zip listings print names in UTF-8", () => {
  it("asks for UTF-8 output on every listing", async () => {
    let seen: string[] | undefined;
    const api = {
      list: async (_a: string, options: { raw?: string[] }, progress: (b: unknown[]) => void) => {
        seen = options.raw;
        progress([{ name: "x.esp", size: 1, attr: "A" }]);
        return { type: "zip" };
      },
    } as unknown as SevenZipApi;

    await sevenZipList(api, "a.zip");
    expect(seen).toContain("-sccUTF-8");
  });

  it("keeps a caller's own switches and filters", async () => {
    let seen: string[] | undefined;
    const api = {
      list: async (_a: string, options: { raw?: string[] }) => {
        seen = options.raw;
        return { type: "zip" };
      },
    } as unknown as SevenZipApi;

    await sevenZipList(api, "a.zip", { raw: ["-tzip", "fomod/ModuleConfig.xml"] });
    expect(seen).toEqual(["-tzip", "fomod/ModuleConfig.xml", "-sccUTF-8"]);
  });
});

describe("the native ZIP reader admits when a name is a guess", () => {
  it("is certain of a name flagged as UTF-8", async () => {
    const p = rawZip("u.zip", Buffer.from("Cópia.tri", "utf8"), true);
    const [e] = await listZipEntries(p);
    expect(e!.name).toBe("Cópia.tri");
    expect(e!.nameEncodingKnown).toBe(true);
  });

  it("is certain of a plain ASCII name without the flag", async () => {
    const p = rawZip("a.zip", Buffer.from("meshes/head.tri"), false);
    const [e] = await listZipEntries(p);
    expect(e!.nameEncodingKnown).toBe(true);
  });

  it("is NOT certain of non-ASCII bytes without the flag — the real archive's shape", async () => {
    const p = rawZip("oem.zip", OEM_COPIA, false);
    const [e] = await listZipEntries(p);
    expect(e!.nameEncodingKnown).toBe(false);
  });
});

describe("native-first listing defers an uncertain name to 7-Zip", () => {
  const sevenZipNaming = (name: string) =>
    ({
      list: async (_a: string, _o: unknown, progress: (b: unknown[]) => void) => {
        progress([{ name, size: 5, crc: "3610a686", attr: "A" }]);
        return { type: "zip" };
      },
    }) as unknown as SevenZipApi;

  it("uses 7-Zip's name when the ZIP's name is a codepage guess", async () => {
    const p = rawZip("oem.zip", OEM_COPIA, false);
    const r = await listArchiveNativeFirst({
      archivePath: p,
      sevenZip: sevenZipNaming("femaleheadlioness - Cópia.tri"),
    });

    expect(r.kind).toBe("listed");
    if (r.kind !== "listed") return;
    expect(r.via).toBe("seven-zip");
    expect(r.listing.entries[0]!.path).toBe("femaleheadlioness - Cópia.tri");
  });

  it("still lists natively when every name is certain", async () => {
    const p = rawZip("ok.zip", Buffer.from("head.tri"), false);
    const r = await listArchiveNativeFirst({
      archivePath: p,
      sevenZip: sevenZipNaming("SHOULD-NOT-BE-USED"),
    });
    expect(r.kind === "listed" && r.via).toBe("native-zip");
  });

  it("falls back to the native guess when 7-Zip cannot run at all", async () => {
    /**
     * The Wine-prefix case this module was built for. One uncertain name is
     * not worth an "unreadable" verdict on the whole mod.
     */
    const p = rawZip("oem.zip", OEM_COPIA, false);
    const broken = {
      list: async () => {
        throw new Error("7z will not start");
      },
    } as unknown as SevenZipApi;

    const r = await listArchiveNativeFirst({ archivePath: p, sevenZip: broken });
    expect(r.kind === "listed" && r.via).toBe("native-zip");
  });
});
