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

import { afterAll, describe, expect, it } from "vitest";

import { parseArgs, publish, refuseExtensionPage, UsageError } from "./nexus-collection-file.mjs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eh-collection-file-"));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
const pkgFile = path.join(tmpRoot, "Ivys-Panties-1.0.19.ehcoll");
fs.writeFileSync(pkgFile, "package bytes");

const EXTENSION = { gameDomain: "site", modId: 2235, fileName: "Event Horizon" };
const base = ["--file", pkgFile, "--game", "fallout4", "--mod", "108944", "--name", "Ivy's Panties", "--version", "1.0.19"];

function fakeClient({ files = [] } = {}) {
  const calls = [];
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
      calls.push(`createModFileVersion ${fileId} upload=${body.upload_id} primary=${body.primary_mod_manager_download}`);
      return { id: "v-1" };
    },
    createModFile: async (body) => {
      calls.push(`createModFile mod=${body.mod_id}`);
      return { id: "f-1" };
    },
  };
  return { client, calls };
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
  it("refuses the section and the mod id Event Horizon itself is published under", () => {
    expect(() => refuseExtensionPage({ game: "site", modScopedId: "999" }, EXTENSION)).toThrow(/where Event Horizon itself is published/);
    expect(() => refuseExtensionPage({ game: "fallout4", modScopedId: "2235" }, EXTENSION)).toThrow(/Event Horizon's own mod id/);
    expect(() => refuseExtensionPage({ game: "fallout4", modScopedId: "108944" }, EXTENSION)).not.toThrow();
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
      `upload Ivys-Panties-1.0.19.ehcoll concurrency=2 md5=${createHash("md5").update("package bytes").digest("hex")}`,
      "createModFileVersion 7906317 upload=u-9 primary=false",
    ]);
    expect(lines).toContain('target: a new version of "Ivy\'s Panties" (file 7906317)');
  });
});
