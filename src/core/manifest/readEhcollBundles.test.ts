/**
 * How a package's bundled mods are read, in the layout with no archive inside.
 *
 * Built from the real pieces — a manifest from buildManifest, a bundle identity
 * from bundleZip.ts, a package zip from an independent writer — so what is
 * pinned is the chain, not one link:
 *  - each bundled mod's folder is found, counted, and matched to its manifest
 *    entry, and the installer writes from it exactly the archive the manifest
 *    names;
 *  - anything else under bundled/ — an archive in the old layout above all —
 *    refuses the package, as do a bundled mod with no folder and a folder no
 *    mod claims;
 *  - a schema-1 package is refused with what to do about it.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeBundledArchive, safeRmTempDir } from "../installer/modInstall";
import { buildManifest, type BuildManifestInput } from "./buildManifest";
import {
  bundleEntries,
  writePackage,
  type BundleContent,
  type PackageEntry,
} from "./bundlePackage.testutil";
import { readEhcoll } from "./readEhcoll";
import { buildStoredZip } from "./storedZip.testutil";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-read-bundles-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const FILES: BundleContent = {
  "Data/Settings.esp": "TES4 settings plugin",
  "Data/MCM/Config/Settings/settings.ini": "[General]\nbEnabled=1\n",
};

const sha256 = (body: string | Buffer): string =>
  crypto.createHash("sha256").update(body).digest("hex");

/** The manifest a build writes for one mod bundled from staging, as the package's manifest.json. */
function manifestEntry(bundleSha: string, over: Record<string, unknown> = {}): PackageEntry {
  const { manifest } = buildManifest({
    snapshot: {
      gameId: "fallout4",
      mods: [
        {
          id: "settings",
          name: "Ivy Settings",
          enabled: true,
          modType: "",
          installOrder: 0,
          rules: [],
          fileOverrides: [],
          enabledINITweaks: [],
          fomodSelections: [],
          hasInstallerChoices: false,
          hasDetailedInstallerChoices: false,
          archiveSha256: bundleSha,
          stagingFiles: Object.entries(FILES).map(([p, body]) => ({
            path: p,
            size: Buffer.byteLength(body),
            sha256: sha256(body),
          })),
        },
      ],
    },
    package: {
      id: "00000000-0000-4000-8000-000000000000",
      name: "P",
      version: "1.0.0",
      author: "a",
      verificationLevel: "thorough",
    },
    game: { version: "1.10.163.0", versionPolicy: "exact" },
    vortex: { version: "2.6.0", deploymentMethod: "hardlink" },
    externalMods: { settings: { bundled: true } },
    bundledModIds: new Set(["settings"]),
  } as unknown as BuildManifestInput);
  return { name: "manifest.json", data: Buffer.from(JSON.stringify({ ...manifest, ...over })) };
}

describe("reading a package's bundled mods", () => {
  it("finds each mod's folder, and the installer writes from it the very archive the manifest names", async () => {
    const bundle = await bundleEntries(FILES);
    const pkg = writePackage(dir, "p.ehcoll", [manifestEntry(bundle.sha256), ...bundle.entries]);

    const read = await readEhcoll(pkg);

    expect(read.bundledArchives).toEqual([
      { sha256: bundle.sha256, bundleFolder: bundle.folder, files: 2, size: expect.any(Number) },
    ]);
    const mod = read.manifest.mods[0]!;
    expect(mod.source).toMatchObject({ kind: "external", bundled: true, sha256: bundle.sha256 });

    const { extractedPath, tempDir } = await writeBundledArchive(
      pkg,
      read.bundledArchives[0]!.bundleFolder,
      mod.name,
    );
    try {
      expect(sha256(fs.readFileSync(extractedPath))).toBe(bundle.sha256);
    } finally {
      await safeRmTempDir(tempDir);
    }
  });

  it("refuses an archive left under bundled/, in the layout this version no longer reads", async () => {
    const bundle = await bundleEntries(FILES);
    const pkg = writePackage(dir, "p.ehcoll", [
      manifestEntry(bundle.sha256),
      ...bundle.entries,
      { name: `bundled/${"c".repeat(64)}.zip`, data: Buffer.from([0x50, 0x4b, 0x03, 0x04]) },
    ]);
    await expect(readEhcoll(pkg)).rejects.toThrow(/not a file inside a bundled mod's folder/);
  });

  it("refuses a package with no folder for a mod the manifest says is bundled", async () => {
    const bundle = await bundleEntries(FILES);
    const pkg = writePackage(dir, "p.ehcoll", [manifestEntry(bundle.sha256)]);
    await expect(readEhcoll(pkg)).rejects.toThrow(
      new RegExp(`no folder bundled/${bundle.sha256}/ holding its files`),
    );
  });

  it("refuses a folder that no bundled mod claims", async () => {
    const bundle = await bundleEntries(FILES);
    const stray = await bundleEntries({ "Stray.esp": "nobody's mod" });
    const pkg = writePackage(dir, "p.ehcoll", [
      manifestEntry(bundle.sha256),
      ...bundle.entries,
      ...stray.entries,
    ]);
    await expect(readEhcoll(pkg)).rejects.toThrow(
      /does not correspond to any external mod with bundled=true/,
    );
  });

  it("refuses a schema-1 package, and says what to do about it", async () => {
    const bundle = await bundleEntries(FILES);
    const pkg = writePackage(dir, "old.ehcoll", [manifestEntry(bundle.sha256, { schemaVersion: 1 })]);
    await expect(readEhcoll(pkg)).rejects.toThrow(
      /built by an older Event Horizon[\s\S]*Download the collection's current package/,
    );
  });

  it("refuses bundled files whose names do not say how they are encoded, before anything installs", async () => {
    // What 7-Zip left to its defaults writes for a name that fits the machine's
    // code page. Found here, the whole collection is refused up front — rather
    // than part of it installing and one mod failing half way through.
    const bundle = await bundleEntries({ "Textures/Cópia.dds": "copy", "Plugin.esp": "TES4" });
    const pkg = path.join(dir, "unflagged.ehcoll");
    fs.writeFileSync(
      pkg,
      buildStoredZip([
        { name: "manifest.json", body: manifestEntry(bundle.sha256).data },
        ...bundle.entries.map((e) => ({ name: e.name, body: e.data })),
      ]),
    );
    await expect(readEhcoll(pkg)).rejects.toThrow(
      new RegExp(
        `holds 1 file whose name does not say how it is encoded: "${bundle.folder}Textures/Cópia\\.dds"`,
      ),
    );
  });
});
