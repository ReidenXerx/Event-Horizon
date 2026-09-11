/**
 * A landing page's link file decides which bytes a user downloads and which
 * checksum proves them, so it is read strictly: one link, one checksum, a
 * zip whose CRCs hold — and anything short of that is refused with what was
 * found, never guessed from.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";

import { describe, expect, it } from "vitest";

import { LINK_FILE_NAME, parseLinkCarrier, readLinkCarrier, readSmallZip } from "./linkCarrier";

const SHA = "C0FFEE".padEnd(64, "0");
const sha = SHA.toLowerCase();

/** A zip built by hand: stored or deflated entries, UTF-8 names, real CRCs. */
function zip(entries: Array<{ name: string; data: string | Buffer; method?: 0 | 8 }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf8");
    const method = e.method ?? 8;
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = zlib.crc32(data);
    const name = Buffer.from(e.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

const carrierOf = (buf: Buffer): ReturnType<typeof parseLinkCarrier> => parseLinkCarrier(readSmallZip(buf));

describe("readSmallZip", () => {
  it("reads stored and deflated entries", () => {
    const entries = readSmallZip(zip([
      { name: "a.txt", data: "stored", method: 0 },
      { name: "dir/b.txt", data: "deflated ".repeat(50) },
    ]));
    expect(entries.map((e) => [e.name, e.data.toString("utf8").slice(0, 8)])).toEqual([
      ["a.txt", "stored"],
      ["dir/b.txt", "deflated"],
    ]);
  });

  it("refuses a damaged entry rather than reading a link from it", () => {
    const buf = zip([{ name: "link.txt", data: `https://pixeldrain.com/api/file/abc?download ${SHA}`, method: 0 }]);
    buf[30 + "link.txt".length + 10] ^= 0xff; // flip a byte of the stored body
    expect(() => readSmallZip(buf)).toThrow(/CRC/);
  });

  it("refuses something that is not a zip", () => {
    expect(() => readSmallZip(Buffer.from("<html>not a zip</html>"))).toThrow(/not a zip/);
  });
});

describe("parseLinkCarrier", () => {
  it("reads event-horizon-link.json, and normalizes a share link the way a pasted one is", () => {
    const doc = {
      format: "event-horizon-link",
      version: 1,
      url: "https://pixeldrain.com/u/Qc8K6SYR",
      sha256: SHA,
      fileName: "meridia-panties-1.0.15.ehcoll",
      size: 10_679_496_477,
    };
    expect(carrierOf(zip([{ name: LINK_FILE_NAME, data: JSON.stringify(doc) }, { name: "README.txt", data: "other" }]))).toEqual({
      url: "https://pixeldrain.com/api/file/Qc8K6SYR?download",
      sha256: sha,
      fileName: "meridia-panties-1.0.15.ehcoll",
      size: 10_679_496_477,
      source: LINK_FILE_NAME,
    });
  });

  it("refuses a JSON link file whose checksum is not a SHA-256", () => {
    const doc = { format: "event-horizon-link", version: 1, url: "https://pixeldrain.com/u/Qc8K6SYR", sha256: "abc" };
    expect(carrierOf(zip([{ name: LINK_FILE_NAME, data: JSON.stringify(doc) }]))).toMatchObject({ why: expect.stringMatching(/sha256/) });
  });

  it("reads a human text file with one link and one checksum, ignoring the page's own Nexus link", () => {
    const text = [
      "Ivy's Panties 1.0.19 — install with Event Horizon",
      "Page: https://www.nexusmods.com/fallout4/mods/108944",
      "Paste this link: https://pixeldrain.com/api/file/4gheZH7F?download",
      "Share page: https://pixeldrain.com/u/4gheZH7F.",
      "File: ivy-panties-1.0.19.ehcoll (3430197672 bytes)",
      `SHA-256: ${SHA}`,
    ].join("\r\n");
    expect(carrierOf(zip([{ name: "Ivy's Panties - link.txt", data: text }]))).toEqual({
      url: "https://pixeldrain.com/api/file/4gheZH7F?download",
      sha256: sha,
      source: "Ivy's Panties - link.txt",
    });
  });

  it("refuses text with two different download links", () => {
    const text = `https://pixeldrain.com/api/file/aaa?download\nhttps://example.com/other.ehcoll\n${SHA}`;
    expect(carrierOf(zip([{ name: "link.txt", data: text }]))).toMatchObject({ why: expect.stringMatching(/2 different download links/) });
  });

  it("refuses text with two different checksums", () => {
    const text = `https://pixeldrain.com/api/file/aaa?download\n${SHA}\n${"1".repeat(64)}`;
    expect(carrierOf(zip([{ name: "link.txt", data: text }]))).toMatchObject({ why: expect.stringMatching(/2 different SHA-256/) });
  });

  it("refuses a link file that gives no checksum", () => {
    expect(carrierOf(zip([{ name: "link.txt", data: "https://pixeldrain.com/api/file/aaa?download" }]))).toMatchObject({
      why: expect.stringMatching(/no SHA-256/),
    });
  });

  it("does not count a plain http link as the download, and says so", () => {
    expect(carrierOf(zip([{ name: "link.txt", data: `http://pixeldrain.com/api/file/aaa?download ${SHA}` }]))).toMatchObject({
      why: expect.stringMatching(/no direct download link; refused: .*Plain http/),
    });
  });
});

describe("readLinkCarrier", () => {
  it("refuses a file too large to be a link file without reading it as one", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "eh-carrier-"));
    const big = path.join(dir, "big.zip");
    await fs.promises.writeFile(big, Buffer.alloc(2 * 1024 * 1024));
    await expect(readLinkCarrier(big)).rejects.toThrow(/too large to be a link file/);
    await fs.promises.rm(dir, { recursive: true, force: true });
  });
});
