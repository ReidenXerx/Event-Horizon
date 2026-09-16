/**
 * The mod list a Nexus collection page shows for an Event Horizon package.
 *
 * Owner decision 2026-09-16: the page lists the REAL mods, so authors get the
 * credit and moderators see what is bundled, while the file's own
 * collection.json lists none. These tests hold the list to the manifest, and
 * the last block holds the two lists apart.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  NEXUS_COLLECTION_NAME_MAX,
  UNKNOWN_MOD_VERSION,
  countNexusCollectionMods,
  describeNexusPointer,
  nexusCollectionProblems,
  toNexusCollectionInfo,
} from "./collectionPayload";
import { packageEhcoll } from "../manifest/packageZip";
import { buildStoredZip } from "../manifest/storedZip.testutil";
import type { EhcollManifest, EhcollMod, SupportedGameId } from "../../types/ehcoll";
import type { SevenZipApi } from "../manifest/sevenZip";

const SHA = "a".repeat(64);

function nexusMod(name: string, modId: number, fileId: number, extra: Partial<EhcollMod> = {}, gameDomain = "skyrimspecialedition"): EhcollMod {
  return {
    compareKey: `nexus:${modId}:${fileId}`,
    name,
    version: "5.2",
    install: {},
    state: { enabled: true, installOrder: 0, deploymentPriority: 0 },
    source: { kind: "nexus", gameDomain, modId, fileId, archiveName: `${name}.7z`, sha256: SHA },
    ...extra,
  } as unknown as EhcollMod;
}

function externalMod(name: string, source: Record<string, unknown>, extra: Partial<EhcollMod> = {}): EhcollMod {
  return {
    compareKey: `external:${name}`,
    name,
    version: "1.0",
    install: {},
    state: { enabled: true, installOrder: 0, deploymentPriority: 0 },
    source: { kind: "external", expectedFilename: `${name}.zip`, sha256: SHA, bundled: false, ...source },
    ...extra,
  } as unknown as EhcollMod;
}

function manifestWith(mods: EhcollMod[], overrides: { gameId?: SupportedGameId; name?: string; author?: string } = {}): EhcollManifest {
  return {
    schemaVersion: 2,
    package: {
      id: "11111111-2222-4333-8444-555555555555",
      name: overrides.name ?? "Meridia's Panties",
      version: "1.0.18",
      author: overrides.author ?? "DuduPhudu",
      createdAt: "2026-09-16T00:00:00.000Z",
      strictMissingMods: false,
      verificationLevel: "thorough",
    },
    game: { id: overrides.gameId ?? "skyrimse", version: "1.6.1170.0", versionPolicy: "exact" },
    vortex: { version: "2.6.3", deploymentMethod: "hardlink", requiredExtensions: [] },
    mods,
    rules: [],
    fileOverrides: [],
    plugins: { order: [], enabled: [] },
    loadOrder: [],
    iniTweaks: [],
    externalDependencies: [],
    userlist: { plugins: [], groups: [] },
  } as unknown as EhcollManifest;
}

describe("the collection's own details", () => {
  it("names the author, the collection, the game's Nexus site and the game version", () => {
    const info = toNexusCollectionInfo(manifestWith([]));
    expect(info.info).toEqual({
      author: "DuduPhudu",
      authorUrl: "",
      name: "Meridia's Panties",
      domainName: "skyrimspecialedition",
      gameVersions: ["1.6.1170.0"],
    });
  });

  it("leaves the game version out when the package could not detect one", () => {
    const manifest = manifestWith([]);
    (manifest.game as { version: string }).version = "unknown";
    expect(toNexusCollectionInfo(manifest).info.gameVersions).toEqual([]);
  });

  it("sends no description or summary, so the text written on Nexus stays", () => {
    const info = toNexusCollectionInfo(manifestWith([])).info as Record<string, unknown>;
    expect(info).not.toHaveProperty("description");
    expect(info).not.toHaveProperty("summary");
    expect(info).not.toHaveProperty("installInstructions");
  });
});

describe("the mod list", () => {
  it("lists every mod in the manifest, in order", () => {
    const mods = [nexusMod("SkyUI", 12604, 35407), externalMod("Patches", { bundled: true }), nexusMod("USSEP", 266, 999)];
    const info = toNexusCollectionInfo(manifestWith(mods));
    expect(info.mods.map((m) => m.name)).toEqual(["SkyUI", "Patches", "USSEP"]);
  });

  it("names a Nexus mod by its page and the exact file the curator built with", () => {
    const [mod] = toNexusCollectionInfo(manifestWith([nexusMod("SkyUI", 12604, 35407)])).mods;
    expect(mod!.source).toEqual({ type: "nexus", modId: 12604, fileId: 35407, updatePolicy: "exact" });
    expect(mod!.domainName).toBe("skyrimspecialedition");
    expect(mod!.version).toBe("5.2");
  });

  it("keeps a Nexus mod's own game site when it differs from the collection's", () => {
    // A Skyrim SE collection can use a file hosted on the Skyrim page.
    const [mod] = toNexusCollectionInfo(manifestWith([nexusMod("Old Tool", 1, 2, {}, "skyrim")])).mods;
    expect(mod!.domainName).toBe("skyrim");
  });

  it("marks a bundled mod as bundled, on the collection's site", () => {
    const [mod] = toNexusCollectionInfo(manifestWith([externalMod("Frozen USSEP", { bundled: true })])).mods;
    expect(mod!.source).toEqual({ type: "bundle" });
    expect(mod!.domainName).toBe("skyrimspecialedition");
  });

  it("lists an external link as a download only when Vortex recorded it as one", () => {
    const mods = toNexusCollectionInfo(
      manifestWith([
        externalMod("Direct", { url: "https://example.com/a.zip", downloadMode: "direct" }),
        externalMod("Page", { url: "https://example.com/page", downloadMode: "browse" }),
        externalMod("Unknown", { url: "https://example.com/what" }),
        externalMod("Hand", {}),
      ]),
    ).mods;
    expect(mods.map((m) => m.source)).toEqual([
      { type: "direct", url: "https://example.com/a.zip" },
      { type: "browse", url: "https://example.com/page" },
      { type: "browse", url: "https://example.com/what" },
      { type: "manual" },
    ]);
  });

  it("uses Vortex's own fallback when a mod has no version", () => {
    const mods = toNexusCollectionInfo(
      manifestWith([nexusMod("NoVersion", 1, 1, { version: undefined }), nexusMod("Blank", 2, 2, { version: "  " })]),
    ).mods;
    expect(mods.map((m) => m.version)).toEqual([UNKNOWN_MOD_VERSION, UNKNOWN_MOD_VERSION]);
  });

  it("marks no mod optional, a disabled one included, because Event Horizon installs them all", () => {
    const disabled = nexusMod("Disabled", 3, 3, {
      state: { enabled: false, installOrder: 1, deploymentPriority: 0 },
    } as Partial<EhcollMod>);
    const [mod] = toNexusCollectionInfo(manifestWith([disabled])).mods;
    expect(mod!.optional).toBe(false);
  });

  it("counts Nexus, bundled and elsewhere mods for the confirmation", () => {
    const info = toNexusCollectionInfo(
      manifestWith([
        nexusMod("A", 1, 1),
        nexusMod("B", 2, 2),
        externalMod("C", { bundled: true }),
        externalMod("D", { url: "https://example.com/d" }),
      ]),
    );
    expect(countNexusCollectionMods(info)).toEqual({ nexus: 2, bundled: 1, elsewhere: 1 });
  });
});

describe("what Nexus would refuse, checked before the upload", () => {
  it("accepts a name of Nexus's longest length", () => {
    const info = toNexusCollectionInfo(manifestWith([], { name: "x".repeat(NEXUS_COLLECTION_NAME_MAX) }));
    expect(nexusCollectionProblems(info)).toEqual([]);
  });

  it("refuses a name one character too long, and says how long it is", () => {
    const info = toNexusCollectionInfo(manifestWith([], { name: "x".repeat(NEXUS_COLLECTION_NAME_MAX + 1) }));
    const problems = nexusCollectionProblems(info);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/37/);
  });

  it("refuses a name too short and a package with no author", () => {
    const info = toNexusCollectionInfo(manifestWith([], { name: "Iv", author: " " }));
    expect(nexusCollectionProblems(info)).toHaveLength(2);
  });
});

describe("Nexus's validation pointers", () => {
  const info = toNexusCollectionInfo(manifestWith([nexusMod("SkyUI", 12604, 1), nexusMod("Removed Mod", 777, 2)]));

  it("names the mod a pointer is about, and the field", () => {
    expect(describeNexusPointer("/collection_data/collection_manifest/mods/1/source/file_id", info)).toBe(
      '"Removed Mod" (source/file_id)',
    );
  });

  it("names the mod alone when the pointer ends at it", () => {
    expect(describeNexusPointer("/collection_data/collection_manifest/mods/0", info)).toBe('"SkyUI"');
  });

  it("passes through a pointer it cannot place", () => {
    expect(describeNexusPointer("/collection_data/collection_manifest/info/name", info)).toBe(
      "/collection_data/collection_manifest/info/name",
    );
    expect(describeNexusPointer("/collection_data/collection_manifest/mods/9/source", info)).toBe(
      "/collection_data/collection_manifest/mods/9/source",
    );
    expect(describeNexusPointer(undefined, info)).toBe("The collection");
  });
});

describe("the page and the file list different things on purpose", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-payload-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function walk(root: string, rel = ""): Array<{ name: string; body: Buffer }> {
    const out: Array<{ name: string; body: Buffer }> = [];
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) out.push(...walk(root, childRel));
      else out.push({ name: childRel, body: fs.readFileSync(path.join(root, childRel)) });
    }
    return out;
  }

  it("the upload lists the mods while the package's collection.json lists none", async () => {
    /**
     * The whole design in one assertion. If the page list leaked into the
     * file, a user without Event Horizon would get Vortex's bulk installer,
     * which loses files. If the file's emptiness leaked into the page, authors
     * would lose the credit the owner chose to give them.
     */
    const manifest = manifestWith([nexusMod("SkyUI", 12604, 35407), nexusMod("USSEP", 266, 999)]);
    const stagingDir = path.join(dir, "staging");
    const sevenZip = {
      add: async (archive: string, sources: readonly string[]) => {
        fs.writeFileSync(archive, buildStoredZip(walk(path.dirname(sources[0]!))));
        return { code: 0 };
      },
      list: async () => ({}),
      extractFull: async () => ({ code: 0 }),
    } as unknown as SevenZipApi;
    await packageEhcoll({
      manifest,
      bundles: [],
      outputPath: path.join(dir, "out.zip"),
      sevenZip,
      stagingDir,
      cleanupOnSuccess: false,
    });
    const fileList = JSON.parse(fs.readFileSync(path.join(stagingDir, "collection.json"), "utf8")).mods;
    expect(fileList).toEqual([]);
    expect(toNexusCollectionInfo(manifest).mods).toHaveLength(2);
  });
});
