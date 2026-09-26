/**
 * The CRC moved onto Node's zlib.crc32 because the per-byte table loop crawled inside Vortex 2.7.1 (a 15.5 MB
 * manifest took about nine minutes to extract). Whatever runs it, the numbers must be the ones a zip's central
 * directory records: these hold the native path to the table loop and to known values.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";

import { describe, expect, it } from "vitest";

import { crc32, crc32File, crc32Update, crc32UpdateTable } from "./readZip";
import { crc32 as writerCrc32 } from "../diagnostics/zipWriter";

describe("CRC-32", () => {
  it("runs on Node's native zlib.crc32 in this runtime", () => {
    // If this fails the fallback loop is what ships, and inside Vortex that loop crawled.
    expect(typeof (zlib as unknown as { crc32?: unknown }).crc32).toBe("function");
  });

  it("matches the known check value and the empty input", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
    expect(writerCrc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });

  it("gives the table loop's value for random data, whole and chained in uneven chunks", () => {
    const data = crypto.randomBytes(300_001);
    const whole = crc32UpdateTable(0, data);
    expect(crc32(data)).toBe(whole);
    let chained = 0;
    let tableChained = 0;
    for (let at = 0; at < data.length; at += 65_537) {
      const part = data.subarray(at, at + 65_537);
      chained = crc32Update(chained, part);
      tableChained = crc32UpdateTable(tableChained, part);
    }
    expect(chained).toBe(whole);
    expect(tableChained).toBe(whole);
  });

  it("streams a file to the same 8-digit lowercase hex an archive listing shows", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-crc-"));
    const file = path.join(dir, "f.bin");
    const data = crypto.randomBytes(200_000);
    fs.writeFileSync(file, data);
    try {
      expect(await crc32File(file)).toBe(crc32UpdateTable(0, data).toString(16).padStart(8, "0"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
