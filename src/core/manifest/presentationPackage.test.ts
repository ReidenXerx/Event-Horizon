/**
 * A collection's presentation through the package format: the parser keeps what
 * is usable, the reader shows only images the package actually carries, and
 * the packager refuses to write a package whose images and manifest disagree.
 * None of it may stop a collection from installing.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { packageEhcoll } from "./packageZip";
import { parseManifest } from "./parseManifest";
import { readEhcoll } from "./readEhcoll";
import { buildStoredZip } from "./storedZip.testutil";
import type { EhcollManifest } from "../../types/ehcoll";

const SHA = "b".repeat(64);
const image = (file: string) => ({ file, sha256: SHA, size: 4 });

const manifestWith = (presentation: unknown): Record<string, unknown> => ({
  schemaVersion: 2,
  package: {
    id: "11111111-2222-4333-8444-555555555555",
    name: "Test",
    version: "1.0.0",
    author: "someone",
    createdAt: "2026-01-01T00:00:00.000Z",
    strictMissingMods: false,
    verificationLevel: "thorough",
    ...(presentation !== undefined ? { presentation } : {}),
  },
  game: { id: "fallout4", version: "1.10.163.0", versionPolicy: "exact" },
  vortex: { version: "1.9.0", deploymentMethod: "hardlink", requiredExtensions: [] },
  mods: [],
  rules: [],
  plugins: { order: [] },
  loadOrder: [],
  iniTweaks: [],
  externalDependencies: [],
});

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-presentation-pkg-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("parsing package.presentation", () => {
  it("is absent for a package built before presentations existed", () => {
    const { manifest } = parseManifest(JSON.stringify(manifestWith(undefined)));
    expect(manifest.package.presentation).toBeUndefined();
  });

  it("keeps the usable parts and warns about the rest, never refusing the package", () => {
    const { manifest, warnings } = parseManifest(
      JSON.stringify(
        manifestWith({
          header: image("presentation/header.png"),
          theme: { accent: "#ff6b3d" },
          links: [{ label: "Evil", url: "javascript:alert(1)" }],
        }),
      ),
    );
    expect(manifest.package.presentation?.header?.file).toBe("presentation/header.png");
    expect(manifest.package.presentation?.links).toEqual([]);
    expect(warnings.some((w) => w.startsWith("package.presentation: link 1"))).toBe(true);
  });
});

describe("reading a package with a presentation", () => {
  it("shows only the images the package carries, and says which are missing", async () => {
    const zip = path.join(dir, "test-1.0.0.zip");
    const manifest = manifestWith({
      header: image("presentation/header.png"),
      gallery: [image("presentation/shot.png")],
      about: "Hi",
    });
    fs.writeFileSync(
      zip,
      buildStoredZip([
        { name: "manifest.json", body: JSON.stringify(manifest) },
        { name: "presentation/shot.png", body: "shot" },
      ]),
    );
    const read = await readEhcoll(zip);
    expect(read.manifest.package.presentation?.header).toBeUndefined();
    expect(read.manifest.package.presentation?.gallery.map((g) => g.file)).toEqual(["presentation/shot.png"]);
    expect(read.manifest.package.presentation?.about).toBe("Hi");
    expect(read.warnings.some((w) => w.includes("presentation/header.png"))).toBe(true);
  });
});

describe("packaging a presentation", () => {
  // Shaped as the build hands it to the packager: already parsed, lists present.
  const base = manifestWith({
    header: image("presentation/header.png"),
    gallery: [],
    links: [],
  }) as unknown as EhcollManifest;

  it("refuses a manifest that names an image it was not given", async () => {
    await expect(
      packageEhcoll({ manifest: base, bundles: [], outputPath: path.join(dir, "out.zip"), presentationFiles: [] }),
    ).rejects.toThrow(/names "presentation\/header.png"/);
  });

  it("refuses an image the manifest does not name, and an unsafe entry name", async () => {
    await expect(
      packageEhcoll({
        manifest: base,
        bundles: [],
        outputPath: path.join(dir, "out.zip"),
        presentationFiles: [
          { entry: "presentation/header.png", sourcePath: path.join(dir, "h.png") },
          { entry: "presentation/../manifest.json", sourcePath: path.join(dir, "x") },
        ],
      }),
    ).rejects.toThrow(/not a plain image name/);
  });
});
