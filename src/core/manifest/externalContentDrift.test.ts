/**
 * ──────────────────────────────────────────────────────────────────────
 * The drift a path list cannot see.
 *
 * The real case, measured: a curator regenerated a BodySlide output AFTER
 * uploading its archive. 2,994 recorded files; every one of them kept its
 * name, and every one of them kept its SIZE, because rebuilding a mesh
 * changes vertices and not file layout. The name-level check reported
 * nothing. A tester downloaded the correct archive — its SHA-256 was the
 * collection's own identity for the mod — and 1,130 files still installed
 * different, which in game looked like broken body physics.
 *
 * So these tests are built the way that case actually was: identical paths,
 * identical sizes, different checksums. A fixture where sizes differ would
 * pass against a size check and prove nothing (GP-4).
 * ──────────────────────────────────────────────────────────────────────
 */
import { describe, expect, it } from "vitest";

import {
  describeExternalContentDrift,
  detectExternalContentDrift,
} from "./bundleFromStaging";
import type { ArchiveListing } from "./archiveContents";
import type { AuditorMod } from "../getModsListForProfile";
import type { CollectionConfig } from "./collectionConfig";

const SIZE = 97214;

const mod = (id: string, paths: string[]): AuditorMod =>
  ({
    id,
    name: id,
    installationPath: id,
    stagingFiles: paths.map((p) => ({
      path: p,
      size: SIZE,
      sha256: "a".repeat(64),
    })),
  }) as unknown as AuditorMod;

/** Every entry the same size as the staged file — only the CRC can decide. */
const listing = (entries: Array<[string, string]>): ArchiveListing => ({
  entries: entries.map(([p, crc]) => ({ path: p, size: SIZE, crc })),
  withCrc: entries.length,
  crcCoverage: 1,
});

const config = (over: Record<string, unknown> = {}): CollectionConfig =>
  ({ externalMods: over }) as unknown as CollectionConfig;

const run = (args: {
  mods: AuditorMod[];
  config?: CollectionConfig;
  archive: ArchiveListing | undefined;
  crcs: Record<string, string>;
  byteBudget?: number;
}) =>
  detectExternalContentDrift({
    mods: args.mods,
    config: args.config ?? config(),
    isExternal: () => true,
    archivePathFor: () => "C:/dl/mod.7z",
    stagingRootOf: () => "C:/staging/mod",
    listArchive: async () => args.archive,
    crcFile: async (abs) => {
      const rel = abs
        .split(String.fromCharCode(92))
        .join("/")
        .replace("C:/staging/mod/", "");
      const crc = args.crcs[rel];
      if (crc === undefined) throw new Error(`unreadable: ${rel}`);
      return crc;
    },
    ...(args.byteBudget !== undefined ? { byteBudget: args.byteBudget } : {}),
  });

describe("an archive that no longer makes what was staged", () => {
  it("catches a regenerated file: same path, same size, different bytes", async () => {
    const out = await run({
      mods: [mod("bodyslides", ["Meshes/F/ArmL.nif", "Meshes/F/ArmR.nif"])],
      archive: listing([
        ["Meshes/F/ArmL.nif", "aaaaaaaa"],
        ["Meshes/F/ArmR.nif", "bbbbbbbb"],
      ]),
      // ArmL was rebuilt; ArmR is untouched.
      crcs: { "Meshes/F/ArmL.nif": "cccccccc", "Meshes/F/ArmR.nif": "bbbbbbbb" },
    });

    expect(out).toHaveLength(1);
    expect(out[0]!.changed).toEqual(["Meshes/F/ArmL.nif"]);
    expect(out[0]!.checked).toBe(2);
    expect(out[0]!.partial).toBe(false);
  });

  it("says nothing when the archive still produces every staged file", async () => {
    const out = await run({
      mods: [mod("clean", ["Meshes/F/ArmL.nif"])],
      archive: listing([["Meshes/F/ArmL.nif", "aaaaaaaa"]]),
      crcs: { "Meshes/F/ArmL.nif": "aaaaaaaa" },
    });
    expect(out).toEqual([]);
  });

  it("is case-insensitive about the checksum's spelling", async () => {
    const out = await run({
      mods: [mod("case", ["Meshes/F/ArmL.nif"])],
      archive: listing([["Meshes/F/ArmL.nif", "AAAAAAAA"]]),
      crcs: { "Meshes/F/ArmL.nif": "aaaaaaaa" },
    });
    expect(out).toEqual([]);
  });

  it("skips a BUNDLED mod — the package carries its bytes, so nobody is affected", async () => {
    const out = await run({
      mods: [mod("packed", ["Meshes/F/ArmL.nif"])],
      config: config({ packed: { bundled: true } }),
      archive: listing([["Meshes/F/ArmL.nif", "aaaaaaaa"]]),
      crcs: { "Meshes/F/ArmL.nif": "cccccccc" },
    });
    expect(out).toEqual([]);
  });

  it("stays quiet when the archive cannot be listed — unknown is not changed", async () => {
    const out = await run({
      mods: [mod("nolist", ["Meshes/F/ArmL.nif"])],
      archive: undefined,
      crcs: { "Meshes/F/ArmL.nif": "cccccccc" },
    });
    expect(out).toEqual([]);
  });

  it("does not call a file unreadable-and-changed", async () => {
    // An unreadable staged file proves nothing about the archive.
    const out = await run({
      mods: [mod("locked", ["Meshes/F/ArmL.nif"])],
      archive: listing([["Meshes/F/ArmL.nif", "aaaaaaaa"]]),
      crcs: {},
    });
    expect(out).toEqual([]);
  });

  it("stops at the byte budget and admits the coverage", async () => {
    const paths = Array.from({ length: 10 }, (_, i) => `Meshes/F/${i}.nif`);
    const out = await run({
      mods: [mod("huge", paths)],
      archive: listing(paths.map((p) => [p, "aaaaaaaa"] as [string, string])),
      crcs: Object.fromEntries(paths.map((p) => [p, "cccccccc"])),
      byteBudget: SIZE * 3,
    });

    expect(out).toHaveLength(1);
    expect(out[0]!.partial).toBe(true);
    expect(out[0]!.checked).toBe(3);
    expect(out[0]!.staged).toBe(10);
  });
});

describe("what the curator is told", () => {
  it("names the mod, a file, and what it means for players", () => {
    const line = describeExternalContentDrift([
      {
        modId: "b",
        modName: "bodyslides_f4_sd",
        changed: ["Meshes/F/ArmL.nif", "Meshes/F/ArmR.nif"],
        checked: 2994,
        staged: 2994,
        partial: false,
        bundled: false,
      },
    ]).join("\n");

    expect(line).toContain("bodyslides_f4_sd");
    expect(line).toContain("Meshes/F/ArmL.nif");
    expect(line).toContain("2 file(s) differ");
    // The fact that makes it urgent rather than interesting.
    expect(line).toContain("same file names, same sizes, different contents");
    expect(line).not.toContain("checked 2994 of");
  });

  it("admits partial coverage rather than implying it looked at everything", () => {
    const line = describeExternalContentDrift([
      {
        modId: "b",
        modName: "facegen",
        changed: ["a.dds"],
        checked: 12,
        staged: 69,
        partial: true,
        bundled: false,
      },
    ]).join("\n");
    expect(line).toContain("checked 12 of 69 files, so there may be more");
  });

  it("says nothing at all when nothing drifted", () => {
    expect(describeExternalContentDrift([])).toEqual([]);
  });
});
