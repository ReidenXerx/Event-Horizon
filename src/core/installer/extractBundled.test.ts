/**
 * writeBundledArchive is on the CRITICAL path — the whole install driver
 * and the prefetch pool sit on it — and it is where a bundled mod stops being
 * loose files in a package and becomes the archive Vortex installs.
 *
 * Pinned: the archive it writes IS the bundle its folder is named after (its
 * sha256, checked here independently); the package's own compression does not
 * change it; it reads the folder it was asked for; each call works in its own
 * temp dir; and a package that is incomplete, damaged, re-packed or changed
 * after it was built is refused, with its temp dir removed — never handed to
 * Vortex.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bundleEntries,
  writePackage,
  type BundleContent,
} from "../manifest/bundlePackage.testutil";
import { listZipEntries } from "../manifest/readZip";
import { buildStoredZip } from "../manifest/storedZip.testutil";
import { writeBundledArchive, safeRmTempDir } from "./modInstall";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-bundled-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const MOD: BundleContent = {
  "SKSE/Plugins/mod.dll": Buffer.from([0x4d, 0x5a, 0x90, 0x00, 1, 2, 3]),
  "Textures/armor/cuirass.dds": "DDS texture bytes",
  "Plugin.esp": "TES4 plugin bytes",
};

const sha256Of = (p: string): string =>
  crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

/**
 * Run with os.tmpdir() pointed at a private, empty folder.
 *
 * Counting the SHARED temp folder cannot show a leak: other test files create
 * and remove install dirs there while this one counts. os.tmpdir() reads these
 * variables on every call, so the private count is exact.
 */
async function inPrivateTemp(run: (tmp: string) => Promise<void>): Promise<void> {
  const isolated = fs.mkdtempSync(path.join(dir, "tmp-"));
  const names = ["TMPDIR", "TEMP", "TMP"] as const;
  const saved = names.map((n) => [n, process.env[n]] as const);
  for (const n of names) process.env[n] = isolated;
  try {
    expect(os.tmpdir()).toBe(isolated); // the redirect must actually work
    await run(isolated);
  } finally {
    // Deleting, not assigning: process.env turns `undefined` into "undefined".
    for (const [n, v] of saved) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
  }
}

describe("writeBundledArchive", () => {
  it("writes the archive its folder is named after, under the mod's name", async () => {
    const { sha256, folder, entries } = await bundleEntries(MOD);
    const { extractedPath, tempDir } = await writeBundledArchive(
      writePackage(dir, "p.ehcoll", entries),
      folder,
      "Armor Retexture SE-12345",
    );
    try {
      expect(extractedPath).toBe(path.join(tempDir, "bundled", "Armor Retexture SE-12345.zip"));
      expect(sha256Of(extractedPath)).toBe(sha256);
      expect((await listZipEntries(extractedPath)).map((e) => e.name).sort()).toEqual(
        Object.keys(MOD).sort(),
      );
    } finally {
      await safeRmTempDir(tempDir);
    }
  });

  it("writes the same archive whether the package stored or deflated the files", async () => {
    const { sha256, folder, entries } = await bundleEntries(MOD);
    for (const method of ["store", "deflate"] as const) {
      const { extractedPath, tempDir } = await writeBundledArchive(
        writePackage(dir, `${method}.ehcoll`, entries, method),
        folder,
      );
      try {
        expect(sha256Of(extractedPath), method).toBe(sha256);
      } finally {
        await safeRmTempDir(tempDir);
      }
    }
  });

  it("reads the folder it was asked for, not merely some folder", async () => {
    const mine = await bundleEntries(MOD);
    const other = await bundleEntries({ "Other.esp": "another mod entirely" });
    const pkg = writePackage(dir, "two.ehcoll", [...mine.entries, ...other.entries]);
    const { extractedPath, tempDir } = await writeBundledArchive(pkg, other.folder);
    try {
      expect(sha256Of(extractedPath)).toBe(other.sha256);
    } finally {
      await safeRmTempDir(tempDir);
    }
  });

  it("gives each call its own temp dir, so concurrent writes cannot collide", async () => {
    // The prefetch pool runs these in parallel by design.
    const { folder, entries } = await bundleEntries(MOD);
    const pkg = writePackage(dir, "p.ehcoll", entries);
    const [a, b] = await Promise.all([
      writeBundledArchive(pkg, folder, "Same Name"),
      writeBundledArchive(pkg, folder, "Same Name"),
    ]);
    try {
      expect(a.tempDir).not.toBe(b.tempDir);
      expect(fs.existsSync(a.extractedPath)).toBe(true);
      expect(fs.existsSync(b.extractedPath)).toBe(true);
    } finally {
      await safeRmTempDir(a.tempDir);
      await safeRmTempDir(b.tempDir);
    }
  });

  it("refuses a package changed after it was built, and leaves no temp dir", async () => {
    // A file added to the folder: every entry reads back intact, and the mod is
    // still not the curator's. Only the identity can see it.
    const { folder, entries } = await bundleEntries(MOD);
    const pkg = writePackage(dir, "edited.ehcoll", [
      ...entries,
      { name: `${folder}Extra.esp`, data: Buffer.from("not in the build") },
    ]);
    await inPrivateTemp(async (tmp) => {
      await expect(writeBundledArchive(pkg, folder, "Armor")).rejects.toThrow(
        /do not make the mod the collection names/,
      );
      expect(fs.readdirSync(tmp)).toEqual([]);
    });
  });

  it("refuses a damaged entry rather than writing its bytes into the archive", async () => {
    const { folder } = await bundleEntries(MOD);
    const bytes = buildStoredZip(
      Object.entries(MOD).map(([p, body]) => ({ name: `${folder}${p}`, body })),
    );
    // A flipped byte in a STORED entry: nothing but the CRC can see it.
    bytes[bytes.indexOf(Buffer.from("TES4 plugin bytes")) + 3] ^= 0xff;
    const pkg = path.join(dir, "damaged.ehcoll");
    fs.writeFileSync(pkg, bytes);
    await inPrivateTemp(async (tmp) => {
      await expect(writeBundledArchive(pkg, folder)).rejects.toThrow(
        /did not survive reading|is not the file that was listed/,
      );
      expect(fs.readdirSync(tmp)).toEqual([]);
    });
  });

  it("refuses when the package holds no files for that mod", async () => {
    const { folder, entries } = await bundleEntries(MOD);
    const pkg = writePackage(dir, "p.ehcoll", entries);
    const absent = `bundled/${"f".repeat(64)}/`;
    expect(absent).not.toBe(folder);
    await inPrivateTemp(async (tmp) => {
      await expect(writeBundledArchive(pkg, absent, "Gone")).rejects.toThrow(
        /holds no files for the bundled mod "Gone"/,
      );
      expect(fs.readdirSync(tmp)).toEqual([]);
    });
  });

  it("refuses names whose encoding the package does not state", async () => {
    const files: BundleContent = { "Текстуры/броня.dds": "cyrillic path" };
    const { folder } = await bundleEntries(files);
    const pkg = path.join(dir, "repacked.ehcoll");
    // UTF-8 name bytes with no UTF-8 flag: what a tool that re-packs a package leaves.
    fs.writeFileSync(
      pkg,
      buildStoredZip([{ name: `${folder}Текстуры/броня.dds`, body: "cyrillic path" }]),
    );
    await expect(writeBundledArchive(pkg, folder)).rejects.toThrow(
      /does not say how its name is encoded/,
    );
  });

  it("refuses anything but a bundled mod's folder", async () => {
    const { sha256, entries } = await bundleEntries(MOD);
    const pkg = writePackage(dir, "p.ehcoll", entries);
    await expect(writeBundledArchive(pkg, `bundled/${sha256}.zip`)).rejects.toThrow(
      /is not a bundled mod's folder/,
    );
  });

  it("never blames 7z, which it does not use", async () => {
    // A message pointing at 7z on a machine where no 7z ran sends the reader to
    // check something irrelevant — exactly what happened to a tester.
    const { folder, entries } = await bundleEntries(MOD);
    const pkg = writePackage(dir, "short.ehcoll", entries.slice(1));
    const message = await writeBundledArchive(pkg, folder).then(
      () => "<no error>",
      (err: Error) => err.message,
    );
    expect(message).not.toBe("<no error>");
    expect(message).not.toMatch(/7z|7-zip/i);
  });
});
