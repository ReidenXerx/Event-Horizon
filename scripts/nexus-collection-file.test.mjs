/**
 * The collection uploader's guards, which all have to fire BEFORE a package
 * of several GB is uploaded: a wrong argument used to surface only when the
 * file was created after the upload, and a --file-id from another page (the
 * extension's own, site/2235) was never checked at all.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";

import { afterAll, describe, expect, it } from "vitest";

import { parseArgs, publish, refuseExtensionPage, uploadNaming, UsageError } from "./nexus-collection-file.mjs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eh-collection-file-"));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
const pkgFile = path.join(tmpRoot, "Ivys-Panties-1.0.19.ehcoll");
fs.writeFileSync(pkgFile, "package bytes");

const EXTENSION = { gameDomain: "site", modId: 2235, fileName: "Event Horizon" };
const base = ["--file", pkgFile, "--game", "fallout4", "--mod", "108944", "--name", "Ivy's Panties", "--version", "1.0.19"];

/** A stored zip of one-byte files with these names; `zip64` writes the ZIP64 end records a package over 4 GB has. */
function zipWith(names, { zip64 = false } = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const n of names) {
    const data = Buffer.from("x");
    const name = Buffer.from(n, "utf8");
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(1, 18);
    local.writeUInt32LE(1, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x800, 8);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(1, 20);
    header.writeUInt32LE(1, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += 30 + name.length + 1;
  }
  const cd = Buffer.concat(central);
  const records = [];
  if (zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(names.length), 24);
    record.writeBigUInt64LE(BigInt(names.length), 32);
    record.writeBigUInt64LE(BigInt(cd.length), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + cd.length), 8);
    locator.writeUInt32LE(1, 16);
    records.push(record, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64 ? 0xffff : names.length, 8);
  end.writeUInt16LE(zip64 ? 0xffff : names.length, 10);
  end.writeUInt32LE(zip64 ? 0xffffffff : cd.length, 12);
  end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  return Buffer.concat([...parts, cd, ...records, end]);
}

function fakeClient({ files = [] } = {}) {
  const calls = [];
  const bodies = [];
  const client = {
    getMod: async (game, id) => {
      calls.push(`getMod ${game} ${id}`);
      return { id: 9001, name: "Ivy's Panties", game_scoped_id: Number(id), status: "published" };
    },
    getModFiles: async (id) => {
      calls.push(`getModFiles ${id}`);
      return { mod_files: files };
    },
    uploadArchiveFromDisk: async (o) => {
      calls.push(`upload ${o.filename} concurrency=${o.concurrency} md5=${o.digests?.md5}`);
      return "u-9";
    },
    createModFileVersion: async (fileId, body) => {
      bodies.push(body);
      calls.push(
        `createModFileVersion ${fileId} upload=${body.upload_id} primary=${body.primary_mod_manager_download} ` +
          `mm=${body.allow_mod_manager_download} updates=${body.update_mod_version}`,
      );
      return { id: "v-1" };
    },
    createModFile: async (body) => {
      bodies.push(body);
      calls.push(`createModFile mod=${body.mod_id} primary=${body.primary_mod_manager_download} mm=${body.allow_mod_manager_download}`);
      return { id: "f-1" };
    },
  };
  return { client, calls, bodies };
}

describe("parseArgs", () => {
  it("never takes the next option as a value", () => {
    expect(() => parseArgs([...base, "--file-id", "--primary"])).toThrow(/--file-id needs a value, and the next argument is the option --primary/);
    expect(() => parseArgs(["--file", "--game", "fallout4"])).toThrow(UsageError);
  });

  it("validates numbers and the category before anything runs", () => {
    for (const bad of ["abc", "0", "2.5", "-1", ""]) {
      expect(() => parseArgs([...base, "--concurrency", bad])).toThrow(/--concurrency .* must be a whole number of at least 1/);
    }
    expect(() => parseArgs([...base.slice(0, 4), "--mod", "108944abc", ...base.slice(6)])).toThrow(/is not a mod id/);
    expect(() => parseArgs([...base, "--category", "Main"])).toThrow(/is not one of main, optional, miscellaneous/);
    expect(() => parseArgs([...base, "--prmary"])).toThrow(/Unknown option --prmary/);
  });

  it("reads a correct command line", () => {
    expect(parseArgs([...base, "--primary", "--file-id", "7906317", "--concurrency", "4"])).toMatchObject({
      filePath: pkgFile,
      game: "fallout4",
      modScopedId: "108944",
      category: "main",
      primary: true,
      fileId: "7906317",
      concurrency: 4,
    });
  });
});

describe("refuseExtensionPage", () => {
  it("refuses the section Event Horizon itself is published in, and only that section", () => {
    expect(() => refuseExtensionPage({ game: "site", modScopedId: "999" }, EXTENSION)).toThrow(/where Event Horizon itself is published/);
    // Mod ids are per game: fallout4/2235 is somebody else's page, not the extension's.
    expect(() => refuseExtensionPage({ game: "fallout4", modScopedId: "2235" }, EXTENSION)).not.toThrow();
    expect(() => refuseExtensionPage({ game: "fallout4", modScopedId: "108944" }, EXTENSION)).not.toThrow();
  });
});

describe("uploadNaming", () => {
  it("calls a .zip a package only when manifest.json sits at its root, in a ZIP64 archive too", () => {
    const pkgZip = path.join(tmpRoot, "meridia-panties-1.0.16.zip");
    fs.writeFileSync(pkgZip, zipWith(["bundled/abc/x.nif", "manifest.json"]));
    expect(uploadNaming(pkgZip)).toEqual({ filename: "meridia-panties-1.0.16.zip", isPackage: true, modManagerDownload: false });
    const big = path.join(tmpRoot, "big-package.zip");
    fs.writeFileSync(big, zipWith(["bundled/abc/x.nif", "manifest.json"], { zip64: true }));
    expect(uploadNaming(big).isPackage).toBe(true);
    const bigOutput = path.join(tmpRoot, "big-output.zip");
    fs.writeFileSync(bigOutput, zipWith(["grass/x.cgid"], { zip64: true }));
    expect(uploadNaming(bigOutput).isPackage).toBe(false);
    const grass = path.join(tmpRoot, "Grass_Cache_Default_LOD.zip");
    fs.writeFileSync(grass, zipWith(["data/grass/x.cgid", "data/manifest.json"]));
    expect(uploadNaming(grass)).toEqual({ filename: "Grass_Cache_Default_LOD.zip", isPackage: false, modManagerDownload: true });
    const notZip = path.join(tmpRoot, "not-a-zip.zip");
    fs.writeFileSync(notZip, "these bytes are not a zip archive at all, and nothing here ends one");
    expect(uploadNaming(notZip).isPackage).toBe(false);
    expect(uploadNaming(path.join(tmpRoot, "unread.ehcoll")).isPackage).toBe(true);
  });
});

describe("publish", () => {
  const log = () => undefined;

  it("refuses a --file-id that is not a file on this mod, before uploading anything", async () => {
    const { client, calls } = fakeClient({ files: [{ id: "111", name: "Ivy's Panties link" }] });
    await expect(publish({ argv: [...base, "--file-id", "7906317", "--primary"], extension: EXTENSION, makeClient: () => client, log })).rejects.toThrow(
      /--file-id 7906317 is not a file on fallout4\/mods\/108944 \("Ivy's Panties"\)\. Its files: Ivy's Panties link \(111\)\. Nothing was uploaded\./,
    );
    expect(calls).toEqual(["getMod fallout4 108944", "getModFiles 9001"]);
  });

  it("refuses Event Horizon's own page without creating a client", async () => {
    let made = false;
    const makeClient = () => {
      made = true;
      return fakeClient().client;
    };
    const argv = ["--file", pkgFile, "--game", "site", "--mod", "2235", "--name", "x", "--version", "1.0.0"];
    await expect(publish({ argv, extension: EXTENSION, makeClient, log })).rejects.toThrow(UsageError);
    expect(made).toBe(false);
  });

  it("refuses a file name the upload header cannot carry, without creating a client", async () => {
    const odd = path.join(tmpRoot, "Meridia’s Panties.ehcoll");
    fs.writeFileSync(odd, "x");
    let made = false;
    const argv = ["--file", odd, ...base.slice(2)];
    await expect(publish({ argv, extension: EXTENSION, makeClient: () => ((made = true), fakeClient().client), log })).rejects.toThrow(/U\+2019/);
    expect(made).toBe(false);
  });

  it("uploads with the hashed digests and adds a version to the verified file", async () => {
    const { client, calls } = fakeClient({ files: [{ id: "7906317", name: "Ivy's Panties" }] });
    const lines = [];
    await publish({ argv: [...base, "--file-id", "7906317", "--concurrency", "2"], extension: EXTENSION, makeClient: () => client, log: (m) => lines.push(m) });
    expect(calls).toEqual([
      "getMod fallout4 108944",
      "getModFiles 9001",
      `upload Ivys-Panties-1.0.19.zip concurrency=2 md5=${createHash("md5").update("package bytes").digest("hex")}`,
      "createModFileVersion 7906317 upload=u-9 primary=false mm=false updates=false",
    ]);
    expect(lines).toContain('target: a new version of "Ivy\'s Panties" (file 7906317)');
  });

  it("puts a package up as .zip without a mod manager download, even as the page's primary file", async () => {
    // Nexus quarantined every .ehcoll within minutes; the same bytes named .zip passed.
    const { client, calls } = fakeClient({ files: [{ id: "7906317", name: "Ivy's Panties" }] });
    const lines = [];
    await publish({ argv: [...base, "--file-id", "7906317", "--primary"], extension: EXTENSION, makeClient: () => client, log: (m) => lines.push(m) });
    expect(calls.find((c) => c.startsWith("upload "))).toMatch(/^upload Ivys-Panties-1\.0\.19\.zip /);
    expect(calls).toContain("createModFileVersion 7906317 upload=u-9 primary=false mm=false updates=true");
    expect(lines).toContain("goes up as Ivys-Panties-1.0.19.zip: Nexus quarantines files named .ehcoll, and a package is a zip");
  });

  it("keeps a package already named .zip without a mod manager download, and any other file as it is", async () => {
    const zipped = path.join(tmpRoot, "ivy-panties-1.0.26.zip");
    fs.writeFileSync(zipped, zipWith(["manifest.json", "bundled/abc/meshes/x.nif"]));
    const zipRun = fakeClient();
    await publish({ argv: ["--file", zipped, ...base.slice(2), "--primary"], extension: EXTENSION, makeClient: () => zipRun.client, log });
    expect(zipRun.calls.find((c) => c.startsWith("upload "))).toMatch(/^upload ivy-panties-1\.0\.26\.zip /);
    expect(zipRun.calls).toContain("createModFile mod=9001 primary=false mm=false");
    expect(zipRun.bodies[0].description).toMatch(/^Event Horizon package\. SHA-256 [0-9a-f]{64}$/);

    const lod = path.join(tmpRoot, "DynDOLOD_Output.zip");
    fs.writeFileSync(lod, zipWith(["meshes/terrain/tamriel/objects/x.bto", "textures/manifest.json"]));
    const lodRun = fakeClient();
    await publish({ argv: ["--file", lod, ...base.slice(2), "--category", "optional"], extension: EXTENSION, makeClient: () => lodRun.client, log });
    expect(lodRun.calls.find((c) => c.startsWith("upload "))).toMatch(/^upload DynDOLOD_Output\.zip /);
    expect(lodRun.calls).toContain("createModFile mod=9001 primary=false mm=true");
    expect(lodRun.bodies[0].description).toMatch(/^SHA-256 [0-9a-f]{64}$/);

    const seven = path.join(tmpRoot, "facegen_v1.0.7z");
    fs.writeFileSync(seven, "7z bytes");
    const sevenRun = fakeClient();
    await publish({ argv: ["--file", seven, ...base.slice(2), "--category", "optional", "--primary"], extension: EXTENSION, makeClient: () => sevenRun.client, log });
    expect(sevenRun.calls.find((c) => c.startsWith("upload "))).toMatch(/^upload facegen_v1\.0\.7z /);
    expect(sevenRun.calls).toContain("createModFile mod=9001 primary=true mm=true");
  });
});
