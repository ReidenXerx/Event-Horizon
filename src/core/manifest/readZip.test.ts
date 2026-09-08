/**
 * These tests read archives this code did not write. See readZip.fixtures.ts
 * for where each came from and what it was chosen to exercise.
 *
 * The first version of this file passed 16/16 while the CRC check was DELETED
 * and while the local extra-length field was IGNORED — two of the three places
 * a ZIP reader is most likely to be confidently wrong. Both survived because
 * the fixture could not express them: every entry was deflate, so a corrupt
 * payload always failed to inflate before the checksum was ever consulted, and
 * every local extra length was zero, so ignoring it changed nothing.
 *
 * Each fixture below therefore earns its place by making a specific mutation
 * fail. A test that has never failed has never been tested.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DOTNET_ZIP,
  MANIFEST_TEXT,
  SEVENZIP_STORED_CRC_OFFSET,
  SEVENZIP_WITH_LOCAL_EXTRA,
} from "./readZip.fixtures";
import {
  ZipReadError,
  crc32,
  extractZipEntryToFile,
  listZipEntries,
  readZipEntry,
} from "./readZip";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-zip-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (
  b64: string,
  name: string,
  mutate?: (b: Buffer) => void,
): string => {
  const buf = Buffer.from(b64, "base64");
  mutate?.(buf);
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
};

const dotnet = (name = "c.ehcoll", mutate?: (b: Buffer) => void): string =>
  write(DOTNET_ZIP, name, mutate);

const sevenZip = (name = "s.ehcoll", mutate?: (b: Buffer) => void): string =>
  write(SEVENZIP_WITH_LOCAL_EXTRA, name, mutate);

describe("listZipEntries", () => {
  it("finds every entry in an archive written by another tool", async () => {
    const entries = await listZipEntries(dotnet());
    expect(entries.map((e) => e.name).sort()).toEqual([
      "manifest.json",
      "sub/nested.txt",
      "tiny.txt",
    ]);
  });

  it("reports the uncompressed size, not the stored size", async () => {
    // Callers size their reads off this, and for a deflated entry the two
    // differ by an order of magnitude here.
    const entries = await listZipEntries(dotnet());
    const manifest = entries.find((e) => e.name === "manifest.json");
    expect(manifest?.uncompressedSize).toBe(MANIFEST_TEXT.length);
    expect(manifest?.compressedSize).toBeLessThan(MANIFEST_TEXT.length);
  });

  it("reads an archive written by 7-Zip, which is what builds a real .ehcoll", async () => {
    const entries = await listZipEntries(sevenZip());
    expect(entries.map((e) => e.name).sort()).toEqual([
      "manifest.json",
      "stored.bin",
    ]);
  });

  it("does not need 7z, a subprocess, or anything on PATH", async () => {
    // The reason this module exists. If it ever regains a dependency on a
    // spawned binary it stops working on the platform it was written for.
    const src = fs.readFileSync(path.join(__dirname, "readZip.ts"), "utf8");
    expect(src).not.toMatch(/child_process|spawn\(|exec\(|SevenZip/);
  });
});

describe("reading entry payloads", () => {
  it("inflates a deflated entry to exactly the original bytes", async () => {
    const out = await readZipEntry(dotnet(), "manifest.json");
    expect(out.toString("utf8")).toBe(MANIFEST_TEXT);
  });

  it("reads an entry nested in a subdirectory", async () => {
    const out = await readZipEntry(dotnet(), "sub/nested.txt");
    expect(out.toString("utf8")).toBe("nested content here");
  });

  it("reads a very small entry", async () => {
    const out = await readZipEntry(dotnet(), "tiny.txt");
    expect(out.toString("utf8")).toBe("hi");
  });

  it("reads a STORED entry, which is never inflated", async () => {
    const out = await readZipEntry(sevenZip(), "stored.bin");
    expect(out.length).toBe(2048);
  });

  it("honours the LOCAL header's extra field, not the central one", async () => {
    // manifest.json here carries an 8-byte extra field in its local header and
    // a 36-byte one in the central directory. Computing the data offset from
    // the central copy, or ignoring the local field, starts the read at the
    // wrong byte -- which is a bug no size check would notice.
    const out = await readZipEntry(sevenZip(), "manifest.json");
    expect(out.toString("utf8")).toBe(MANIFEST_TEXT);
  });

  it("names the entry it could not find", async () => {
    await expect(readZipEntry(dotnet(), "manifest.JSON")).rejects.toThrow(
      /no entry named "manifest\.JSON"/,
    );
  });

  it("refuses an entry larger than the caller allowed", async () => {
    await expect(readZipEntry(dotnet(), "manifest.json", 10)).rejects.toThrow(
      /over the 10-byte limit/,
    );
  });
});

describe("extractZipEntryToFile", () => {
  it("writes the entry's real content, creating parent directories", async () => {
    const dest = path.join(dir, "out", "deep", "manifest.json");
    await extractZipEntryToFile(dotnet(), "manifest.json", dest);
    expect(fs.readFileSync(dest, "utf8")).toBe(MANIFEST_TEXT);
  });

  it("streams a stored entry byte-for-byte", async () => {
    const dest = path.join(dir, "stored.bin");
    await extractZipEntryToFile(sevenZip(), "stored.bin", dest);
    const viaBuffer = await readZipEntry(sevenZip("s2.ehcoll"), "stored.bin");
    expect(fs.readFileSync(dest).equals(viaBuffer)).toBe(true);
  });
});

describe("damaged archives", () => {
  it("calls a cut-short file incomplete, and says to transfer it again", async () => {
    // The tester's actual failure mode. The header is intact and only the end
    // is missing, so any message about corruption sends them off to rebuild a
    // package that was never broken.
    const whole = Buffer.from(DOTNET_ZIP, "base64");
    const p = path.join(dir, "cut.ehcoll");
    fs.writeFileSync(p, whole.subarray(0, whole.length - 60));
    await expect(listZipEntries(p)).rejects.toThrow(
      /no end-of-central-directory[\s\S]*incomplete file[\s\S]*transfer it again/,
    );
  });

  it("catches a corrupted payload it STREAMS to disk, and deletes the result", async () => {
    /**
     * The same corruption as the buffered case below, through the path that
     * handles anything too large to hold in memory — `manifest.json` and every
     * multi-gigabyte bundled archive. It verified NOTHING: no CRC, no length.
     * Whole-file truncation is caught because the central directory sits at
     * the end, but bit rot in the middle of a STORED entry produced a corrupt
     * archive that was handed straight to Vortex to install.
     */
    const p = sevenZip("corrupt-stream.ehcoll", (b) => {
      b[1000] = b[1000]! ^ 0xff;
    });
    const dest = path.join(dir, "streamed.bin");
    await expect(
      extractZipEntryToFile(p, "stored.bin", dest),
    ).rejects.toThrow(/did not survive extraction/);
    // And it must not be left behind: a corrupt file on disk is one a later
    // step picks up and trusts, usually under a name that looks verified.
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("catches a corrupted STORED payload, which only a checksum can see", async () => {
    // The decisive case. stored.bin is method 0, so flipping bytes inside it
    // does not break decompression -- there is none. The read succeeds and
    // returns the wrong bytes unless the CRC is actually checked.
    //
    // Byte 1000 is inside stored.bin's payload: the archive is 2410 bytes, its
    // index starts at 2201, manifest.json's compressed data is ~62 bytes near
    // the front, and stored.bin's 2048 bytes fill everything between.
    const p = sevenZip("corrupt.ehcoll", (b) => {
      b[1000] = b[1000] ^ 0xff;
    });
    await expect(readZipEntry(p, "stored.bin")).rejects.toThrow(
      /failed its checksum/,
    );
  });

  it("reports a checksum failure rather than returning wrong bytes", async () => {
    // Same check from the other side: leave the data alone and corrupt the
    // RECORDED crc. A reader that never compares them passes both ways.
    const p = sevenZip("badcrc.ehcoll", (b) => {
      b.writeUInt32LE(0xdeadbeef, SEVENZIP_STORED_CRC_OFFSET);
    });
    await expect(readZipEntry(p, "stored.bin")).rejects.toThrow(
      /failed its checksum/,
    );
  });

  it("rejects an index pointing outside the file, naming both numbers", async () => {
    // Asserting the SPECIFIC message, not just /truncated/. The generic
    // "ends inside its own index" error fires here too once the read comes up
    // short, so a loose matcher passes whether the bounds check exists or not
    // -- which it did, until this assertion was tightened.
    const p = dotnet("badoffset.ehcoll", (b) => {
      b.writeUInt32LE(0x7fffff00, b.length - 22 + 16);
    });
    await expect(listZipEntries(p)).rejects.toThrow(
      /says its index ends at byte \d+ but the file is only \d+ bytes/,
    );
  });

  it("refuses an encrypted entry instead of inflating garbage", async () => {
    // Encryption is one flag bit, so it can be set on a real archive. Without
    // the guard the entry decompresses to noise and fails its checksum, which
    // reports damage for a file that is merely locked -- and sends the user
    // to re-download something a password would have opened.
    const p = sevenZip("enc.ehcoll", (b) => {
      const cdOff = b.readUInt32LE(b.length - 22 + 16);
      b.writeUInt16LE(b.readUInt16LE(cdOff + 8) | 0x1, cdOff + 8);
    });
    await expect(listZipEntries(p)).rejects.toThrow(/is encrypted/);
  });

  it("names an unsupported compression method instead of inflating blindly", async () => {
    // Method is one field. Set it to 12 (bzip2) and a reader without the guard
    // hands bzip2 data to an inflate stream, which reports damage -- when the
    // real answer is that the package was not built by Event Horizon.
    const p = sevenZip("bzip.ehcoll", (b) => {
      const cdOff = b.readUInt32LE(b.length - 22 + 16);
      b.writeUInt16LE(12, cdOff + 10);
    });
    await expect(readZipEntry(p, "manifest.json")).rejects.toThrow(
      /compression method 12, which this reader does not support/,
    );
  });

  it("says a file too short to be a zip is exactly that", async () => {
    const p = path.join(dir, "tiny.ehcoll");
    fs.writeFileSync(p, Buffer.from([0x50, 0x4b]));
    await expect(listZipEntries(p)).rejects.toThrow(/too small to be a ZIP/);
  });

  it("names a missing file rather than failing obscurely", async () => {
    await expect(listZipEntries(path.join(dir, "nope.ehcoll"))).rejects.toThrow(
      /No file at/,
    );
  });

  it("throws ZipReadError, never a raw zlib or fs error", async () => {
    // Callers above this layer turn these into user-facing text. A raw
    // Z_DATA_ERROR reaching the UI is how "the file may be corrupt" gets
    // printed for a file that is fine.
    const p = sevenZip("z.ehcoll", (b) => {
      b[1000] = b[1000] ^ 0xff;
    });
    await expect(readZipEntry(p, "stored.bin")).rejects.toBeInstanceOf(
      ZipReadError,
    );
  });
});

describe("crc32", () => {
  it("matches the published check value for the standard test vector", async () => {
    // "123456789" -> 0xCBF43926 is the documented CRC-32 check value. A value
    // from outside this codebase is the only way to know the table is right
    // rather than merely self-consistent.
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });

  it("agrees with the CRC .NET independently computed and stored", async () => {
    const entries = await listZipEntries(dotnet());
    const manifest = entries.find((e) => e.name === "manifest.json");
    expect(crc32(Buffer.from(MANIFEST_TEXT))).toBe(manifest?.crc32);
  });

  it("agrees with the CRC 7-Zip independently computed and stored", async () => {
    const entries = await listZipEntries(sevenZip());
    const manifest = entries.find((e) => e.name === "manifest.json");
    expect(crc32(Buffer.from(MANIFEST_TEXT))).toBe(manifest?.crc32);
  });
});
