/**
 * The zip a tester sends back has to open anywhere and hold exactly what was
 * promised: every EH log, Vortex's log rotations, EH's records, and a manifest
 * that says what could not be read. Read back with the project's own ZIP reader,
 * which was validated against real archives, and checked byte for byte.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listZipEntries, readZipEntry } from "../manifest/readZip";
import { collectLogSources, writeLogBundle } from "./logBundle";
import { crc32, writeZip } from "./zipWriter";

let tmp: string;
const write = (full: string, content: string | Buffer): void => {
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eh-logs-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("writeZip", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });

  it("writes an archive whose entries read back identically — deflated, stored and non-ASCII names", async () => {
    const zip = path.join(tmp, "a.zip");
    const log = Buffer.from("line\n".repeat(5000));
    const tiny = Buffer.from("x");
    const result = await writeZip(zip, [
      { name: "event-horizon/logs/event-horizon-2026-09-11.log", read: async () => log },
      { name: "tiny.txt", read: async () => tiny },
      { name: "records/Cópia 简体.json", read: async () => Buffer.from("{}") },
      { name: "gone.log", read: async () => Promise.reject(new Error("EBUSY")) },
    ]);
    expect(result.entries).toBe(3);
    expect(result.skipped).toEqual([{ name: "gone.log", error: "EBUSY" }]);
    expect((await readZipEntry(zip, "event-horizon/logs/event-horizon-2026-09-11.log")).equals(log)).toBe(true);
    expect((await readZipEntry(zip, "tiny.txt")).equals(tiny)).toBe(true);
    expect((await readZipEntry(zip, "records/Cópia 简体.json")).toString()).toBe("{}");
    // Flagged UTF-8, so every unzipper reads the name the same way instead of
    // through the machine's OEM codepage (see archive-name encoding, alpha.149).
    const entries = await listZipEntries(zip);
    expect(entries.find((e) => e.name === "records/Cópia 简体.json")?.nameEncodingKnown).toBe(true);
    // Deflate actually happened for the compressible file.
    expect(fs.statSync(zip).size).toBeLessThan(log.length);
  });
});

describe("collectLogSources + writeLogBundle", () => {
  const dirs = () => {
    const vortex = path.join(tmp, "Vortex");
    const eh = path.join(vortex, "event-horizon");
    return {
      vortexUserData: vortex,
      ehRoot: eh,
      recordDirs: [path.join(eh, "installs"), path.join(eh, "installs", "in-progress"), path.join(eh, "quarantine")],
    };
  };

  it("includes every EH log, Vortex's log rotations and EH's records — nothing else", async () => {
    const d = dirs();
    write(path.join(d.ehRoot, "logs", "event-horizon-2026-09-10.log"), "a");
    write(path.join(d.ehRoot, "logs", "event-horizon-2026-09-11.log"), "b");
    write(path.join(d.vortexUserData, "vortex.log"), "v0");
    write(path.join(d.vortexUserData, "vortex1.log"), "v1");
    write(path.join(d.vortexUserData, "state.v2"), "not a log");
    write(path.join(d.ehRoot, "installs", "ivy.json"), "{}");
    write(path.join(d.ehRoot, "installs", "in-progress", "ivy.json"), "{}");
    write(path.join(d.ehRoot, "quarantine", "fallout4-x.json"), "{}");
    write(path.join(d.ehRoot, "collections", "Ivy.ehcoll"), "huge package");

    const sources = await collectLogSources(d);
    expect(sources.map((s) => s.zipName).sort()).toEqual([
      "event-horizon/installs/in-progress/ivy.json",
      "event-horizon/installs/ivy.json",
      "event-horizon/logs/event-horizon-2026-09-10.log",
      "event-horizon/logs/event-horizon-2026-09-11.log",
      "event-horizon/quarantine/fallout4-x.json",
      "vortex/vortex.log",
      "vortex/vortex1.log",
    ]);

    const filePath = path.join(tmp, "out", "logs.zip");
    fs.mkdirSync(path.dirname(filePath));
    const result = await writeLogBundle({ filePath, extensionVersion: "0.1.151", sources, now: new Date("2026-09-11T12:00:00Z") });
    expect(result.files).toBe(8);
    expect(fs.existsSync(`${filePath}.partial`)).toBe(false);
    expect((await readZipEntry(filePath, "vortex/vortex1.log")).toString()).toBe("v1");
    const manifest = JSON.parse((await readZipEntry(filePath, "bundle.json")).toString());
    expect(manifest.extension.version).toBe("0.1.151");
    expect(manifest.files).toHaveLength(7);
    expect(manifest.unreadable).toEqual([]);
  });

  it("names a file that vanished before it could be read, and still saves the rest", async () => {
    const d = dirs();
    write(path.join(d.ehRoot, "logs", "event-horizon-2026-09-11.log"), "b");
    write(path.join(d.vortexUserData, "vortex.log"), "v0");
    const sources = await collectLogSources(d);
    fs.unlinkSync(path.join(d.vortexUserData, "vortex.log"));
    const filePath = path.join(tmp, "logs.zip");
    const result = await writeLogBundle({ filePath, extensionVersion: "t", sources });
    expect(result.skipped.map((s) => s.name)).toEqual(["vortex/vortex.log"]);
    const manifest = JSON.parse((await readZipEntry(filePath, "bundle.json")).toString());
    expect(manifest.unreadable.map((u: { name: string }) => u.name)).toEqual(["vortex/vortex.log"]);
  });

  it("removes the partial zip when the final rename fails", async () => {
    // A folder where the zip should go: the partial is fully written, then the rename refuses.
    const filePath = path.join(tmp, "taken");
    fs.mkdirSync(filePath);
    fs.writeFileSync(path.join(filePath, "keep.txt"), "x");
    await expect(writeLogBundle({ filePath, extensionVersion: "t", sources: [] })).rejects.toThrow();
    expect(fs.existsSync(`${filePath}.partial`)).toBe(false);
  });

  it("leaves nothing behind when the zip cannot be written", async () => {
    const filePath = path.join(tmp, "no-such-folder", "logs.zip");
    await expect(writeLogBundle({ filePath, extensionVersion: "t", sources: [] })).rejects.toThrow();
    expect(fs.existsSync(`${filePath}.partial`)).toBe(false);
  });
});
