/**
 * What a mirrored mod may leave to its own archive, and what it must carry.
 *
 * Every case that ships is a way the package could otherwise leave out a file
 * the user's archive does not have at that place: bytes the curator edited to
 * the same size, bytes the curator moved, an entry with no checksum, a file
 * that could not be read, an install that cannot be predicted.
 */
import * as path from "path";

import { describe, expect, it, vi } from "vitest";

import type { ArchiveListing } from "./archiveContents";
import {
  entrySitsAt,
  findFilesTheArchiveProvides,
  proveMirroredFilesFromArchives,
  unpredictableInstall,
} from "./mirrorPayload";
import { crc32 } from "./readZip";

const hex = (b: Buffer): string => (crc32(b) >>> 0).toString(16).padStart(8, "0");
const SHA = "a".repeat(64);

const PLUGIN = Buffer.from("the author's plugin");
// Same length as PLUGIN: a cleaned plugin often keeps its size.
const CLEANED = Buffer.from("the curator's plug!");

const listing = (
  entries: Array<{ path: string; data?: Buffer; size?: number; crc?: string }>,
): ArchiveListing => {
  const out = entries.map((e) => ({
    path: e.path,
    ...(e.size !== undefined || e.data !== undefined ? { size: e.size ?? e.data!.length } : {}),
    ...(e.crc !== undefined || e.data !== undefined ? { crc: e.crc ?? hex(e.data!) } : {}),
  }));
  return {
    entries: out,
    withCrc: out.filter((e) => e.crc !== undefined).length,
    crcCoverage: 1,
  };
};

const onDisk = (files: Record<string, Buffer>) => async (p: string): Promise<string> => {
  const data = files[p];
  if (data === undefined) throw new Error(`ENOENT: ${p}`);
  return hex(data);
};

describe("where an archive entry installs", () => {
  it("is the staged path itself, or that path under a wrapper folder", () => {
    expect(entrySitsAt("Data/x.esp", "Data/x.esp")).toBe(true);
    expect(entrySitsAt("My Mod v1/Data/x.esp", "Data/x.esp")).toBe(true);
  });

  it("only at a folder boundary", () => {
    expect(entrySitsAt("MyTextures/a.dds", "Textures/a.dds")).toBe(false);
  });

  it("whatever the case", () => {
    expect(entrySitsAt("Mod/TEXTURES/A.dds", "textures/a.DDS")).toBe(true);
  });
});

describe("which files the archive provides", () => {
  it("leaves a file to the archive when an entry at its path has its size and checksum", async () => {
    const r = await findFilesTheArchiveProvides({
      staged: [{ path: "Data/x.esp", size: PLUGIN.length, sha256: SHA }],
      listing: listing([{ path: "Wrapper/Data/x.esp", data: PLUGIN }]),
      crcOf: onDisk({ "Data/x.esp": PLUGIN }),
    });
    expect(r).toEqual({
      provided: ["Data/x.esp"],
      compared: 1,
      unreadable: 0,
      changed: [],
    });
  });

  it("ships a file the curator edited without changing its size", async () => {
    expect(CLEANED.length).toBe(PLUGIN.length);
    const r = await findFilesTheArchiveProvides({
      staged: [{ path: "Data/x.esp", size: CLEANED.length, sha256: SHA }],
      listing: listing([{ path: "Data/x.esp", data: PLUGIN }]),
      crcOf: onDisk({ "Data/x.esp": CLEANED }),
    });
    expect(r.provided).toEqual([]);
    expect(r.compared).toBe(1);
    /**
     * And it is REPORTED as changed, not merely left out of `provided`.
     *
     * This is the shape that broke a tester's game: same path, same size,
     * different checksum. The mirror only needs to know it must carry the
     * file; an EXTERNAL mod needs someone told, because players download the
     * archive and get the other bytes. `detectExternalContentDrift` reads
     * exactly this field.
     */
    expect(r.changed).toEqual(["Data/x.esp"]);
  });

  it("ships a file whose bytes the archive holds at another path", async () => {
    // The curator moved it. Nothing says an install puts those bytes here.
    const r = await findFilesTheArchiveProvides({
      staged: [{ path: "Data/x.esp", size: PLUGIN.length, sha256: SHA }],
      listing: listing([{ path: "Optional/y.esp", data: PLUGIN }]),
      crcOf: onDisk({ "Data/x.esp": PLUGIN }),
    });
    expect(r.provided).toEqual([]);
  });

  it("ships a file the archive gives no checksum for", async () => {
    const r = await findFilesTheArchiveProvides({
      staged: [{ path: "Data/x.esp", size: PLUGIN.length, sha256: SHA }],
      listing: listing([{ path: "Data/x.esp", size: PLUGIN.length }]),
      crcOf: onDisk({ "Data/x.esp": PLUGIN }),
    });
    expect(r.provided).toEqual([]);
  });

  it("never leaves a file with no recorded hash to the archive", async () => {
    const crcOf = vi.fn(onDisk({ "Data/x.esp": PLUGIN }));
    const r = await findFilesTheArchiveProvides({
      staged: [{ path: "Data/x.esp", size: PLUGIN.length }],
      listing: listing([{ path: "Data/x.esp", data: PLUGIN }]),
      crcOf,
    });
    expect(r.provided).toEqual([]);
    expect(crcOf).not.toHaveBeenCalled();
  });

  it("ships a file it could not read, and counts it", async () => {
    const r = await findFilesTheArchiveProvides({
      staged: [{ path: "Data/x.esp", size: PLUGIN.length, sha256: SHA }],
      listing: listing([{ path: "Data/x.esp", data: PLUGIN }]),
      crcOf: onDisk({}),
    });
    // Unreadable is NOT changed: we learned nothing about the archive.
    expect(r).toEqual({
      provided: [],
      compared: 1,
      unreadable: 1,
      changed: [],
    });
  });

  it("reads only the files an entry could explain", async () => {
    const crcOf = vi.fn(onDisk({ "Data/x.esp": PLUGIN, "Data/mine.esp": CLEANED }));
    await findFilesTheArchiveProvides({
      staged: [
        { path: "Data/x.esp", size: PLUGIN.length, sha256: SHA },
        { path: "Data/mine.esp", size: CLEANED.length + 1, sha256: SHA },
      ],
      listing: listing([{ path: "Data/x.esp", data: PLUGIN }]),
      crcOf,
    });
    expect(crcOf).toHaveBeenCalledTimes(1);
    expect(crcOf).toHaveBeenCalledWith("Data/x.esp");
  });
});

describe("why a mirrored mod carries every file", () => {
  it("does not, when the self-check found its install predictable", () => {
    expect(unpredictableInstall({ depth: "replayed", reproducibleInstall: true })).toBeUndefined();
  });

  it("names the reason otherwise", () => {
    expect(unpredictableInstall(undefined)).toMatch(/did not examine/);
    expect(unpredictableInstall({ depth: "skipped" })).toMatch(/could not read its archive/);
    expect(unpredictableInstall({ depth: "containment", promptsUser: true })).toMatch(/users answer/);
    expect(unpredictableInstall({ depth: "replayed", readsPluginState: ["a.esm"] })).toMatch(/plugins are active/);
    expect(unpredictableInstall({ depth: "containment", installerUnexamined: true })).toMatch(/could not be read/);
    expect(unpredictableInstall({ depth: "containment" })).toMatch(/replayed with confidence/);
  });
});

describe("proving every mirrored mod", () => {
  const ROOT = path.join("C:", "staging", "mod");
  const base = {
    unpredictable: () => undefined,
    archiveFor: () => "mod.7z",
    stagingRootOf: () => ROOT,
    listArchive: async () => listing([{ path: "Data/x.esp", data: PLUGIN }]),
    crcFile: async (abs: string) => {
      if (abs !== path.join(ROOT, "Data", "x.esp")) throw new Error(`unexpected read of ${abs}`);
      return hex(PLUGIN);
    },
  };
  const mirrored = {
    id: "m",
    name: "Mod",
    mirrored: true,
    stagingFiles: [
      { path: "Data/x.esp", size: PLUGIN.length, sha256: SHA },
      { path: "Data/added.esp", size: 3, sha256: SHA },
    ],
  };

  it("records what the archive provides, reading the files from the mod's staging folder", async () => {
    const r = await proveMirroredFilesFromArchives({ ...base, mods: [mirrored] });
    expect(r.get("m")).toEqual({
      kind: "proven",
      staged: 2,
      provided: ["Data/x.esp"],
      compared: 1,
      unreadable: 0,
      changed: [],
    });
  });

  it("leaves mods that are not mirrored alone", async () => {
    const listArchive = vi.fn(base.listArchive);
    const r = await proveMirroredFilesFromArchives({
      ...base,
      listArchive,
      mods: [{ ...mirrored, mirrored: false }, { ...mirrored, id: "n", mirrored: undefined }],
    });
    expect(r.size).toBe(0);
    expect(listArchive).not.toHaveBeenCalled();
  });

  it("ships every file of a mod whose install cannot be predicted, and says why", async () => {
    const listArchive = vi.fn(base.listArchive);
    const r = await proveMirroredFilesFromArchives({
      ...base,
      listArchive,
      unpredictable: () => "its installer asks questions that users answer themselves",
      mods: [mirrored],
    });
    expect(r.get("m")).toEqual({
      kind: "ships-all",
      why: "its installer asks questions that users answer themselves",
    });
    expect(listArchive).not.toHaveBeenCalled();
  });

  it("ships every file when there is no archive, no staging folder, or no listing", async () => {
    const noArchive = await proveMirroredFilesFromArchives({ ...base, archiveFor: () => undefined, mods: [mirrored] });
    expect(noArchive.get("m")).toMatchObject({ kind: "ships-all", why: expect.stringMatching(/no archive/) });

    const noRoot = await proveMirroredFilesFromArchives({ ...base, stagingRootOf: () => undefined, mods: [mirrored] });
    expect(noRoot.get("m")).toMatchObject({ kind: "ships-all", why: expect.stringMatching(/staging folder/) });

    const unlisted = await proveMirroredFilesFromArchives({ ...base, listArchive: async () => undefined, mods: [mirrored] });
    expect(unlisted.get("m")).toMatchObject({ kind: "ships-all", why: expect.stringMatching(/could not be listed \(mod\.7z\)/) });
  });
});
