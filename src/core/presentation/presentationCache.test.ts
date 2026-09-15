import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { extractPresentation, loadCachedPresentation, presentationCacheDir } from "./presentationCache";
import type { PackagePresentation } from "./presentation";
import { extractZipEntryToFile } from "../manifest/readZip";
import { buildStoredZip } from "../manifest/storedZip.testutil";

const PACKAGE_ID = "11111111-2222-4333-8444-555555555555";
const HEADER = Buffer.from("header image bytes");
const SHOT = Buffer.from("screenshot bytes");
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

let dir: string;
let zip: string;
let cacheRoot: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-presentation-cache-"));
  cacheRoot = path.join(dir, "cache");
  zip = path.join(dir, "ivy-1.0.0.zip");
  fs.writeFileSync(
    zip,
    buildStoredZip([
      { name: "manifest.json", body: "{}" },
      { name: "presentation/header.png", body: HEADER },
      { name: "presentation/shot.png", body: SHOT },
    ]),
  );
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const presentation = (over: Partial<PackagePresentation> = {}): PackagePresentation => ({
  header: { file: "presentation/header.png", sha256: sha(HEADER), size: HEADER.length },
  gallery: [{ file: "presentation/shot.png", sha256: sha(SHOT), size: SHOT.length, caption: "Diamond City" }],
  theme: { accent: "#ff6b3d" },
  about: "Hello",
  links: [],
  ...over,
});

describe("extractPresentation", () => {
  it("extracts each image once into the cache and hands back URLs the screens can load", async () => {
    const { shown, warnings } = await extractPresentation({
      zipPath: zip,
      packageId: PACKAGE_ID,
      version: "1.0.0",
      presentation: presentation(),
      cacheRoot,
    });
    expect(warnings).toEqual([]);
    const headerFile = fileURLToPath(shown!.header!.url);
    expect(path.dirname(headerFile)).toBe(presentationCacheDir(cacheRoot, PACKAGE_ID, "1.0.0"));
    expect(fs.readFileSync(headerFile)).toEqual(HEADER);
    expect(shown!.gallery[0]!.caption).toBe("Diamond City");
    expect(shown!.images["presentation/shot.png"]).toBe(shown!.gallery[0]!.url);
    // The names a curator writes in the About page without knowing the storage.
    expect(shown!.images["screenshot-1"]).toBe(shown!.gallery[0]!.url);
    expect(shown!.images.header).toBe(shown!.header!.url);
    expect(shown!.images["screenshot-2"]).toBeUndefined();
  });

  it("does not extract an image that is already there with the right bytes", async () => {
    const args = { zipPath: zip, packageId: PACKAGE_ID, version: "1.0.0", presentation: presentation(), cacheRoot };
    await extractPresentation(args);
    const extract = vi.fn(extractZipEntryToFile);
    await extractPresentation({ ...args, extract });
    expect(extract).not.toHaveBeenCalled();
  });

  it("deletes and does not show an image whose bytes differ from the recorded hash", async () => {
    const { shown, warnings } = await extractPresentation({
      zipPath: zip,
      packageId: PACKAGE_ID,
      version: "1.0.0",
      presentation: presentation({
        header: { file: "presentation/header.png", sha256: "c".repeat(64), size: HEADER.length },
      }),
      cacheRoot,
    });
    expect(shown?.header).toBeUndefined();
    expect(shown?.gallery).toHaveLength(1);
    expect(warnings[0]).toContain("does not match");
    expect(fs.existsSync(path.join(presentationCacheDir(cacheRoot, PACKAGE_ID, "1.0.0"), "header.png"))).toBe(false);
  });

  it("says so when an image cannot be extracted, and shows the rest", async () => {
    const { shown, warnings } = await extractPresentation({
      zipPath: zip,
      packageId: PACKAGE_ID,
      version: "1.0.0",
      presentation: presentation({
        tile: { file: "presentation/missing.png", sha256: "d".repeat(64), size: 3 },
      }),
      cacheRoot,
    });
    expect(shown?.tile).toBeUndefined();
    expect(shown?.header).toBeDefined();
    expect(warnings[0]).toContain("could not be extracted");
  });
});

describe("loadCachedPresentation", () => {
  it("shows an installed collection after its package is gone", async () => {
    await extractPresentation({ zipPath: zip, packageId: PACKAGE_ID, version: "1.0.0", presentation: presentation(), cacheRoot });
    fs.rmSync(zip);
    const shown = await loadCachedPresentation(cacheRoot, PACKAGE_ID, "1.0.0");
    expect(shown?.header?.url).toMatch(/^file:/);
    expect(shown?.theme).toEqual({ accent: "#ff6b3d" });
  });

  it("leaves out an image that has since been removed, and has nothing for a version never shown", async () => {
    await extractPresentation({ zipPath: zip, packageId: PACKAGE_ID, version: "1.0.0", presentation: presentation(), cacheRoot });
    fs.rmSync(path.join(presentationCacheDir(cacheRoot, PACKAGE_ID, "1.0.0"), "shot.png"));
    const shown = await loadCachedPresentation(cacheRoot, PACKAGE_ID, "1.0.0");
    expect(shown?.gallery).toEqual([]);
    expect(await loadCachedPresentation(cacheRoot, PACKAGE_ID, "9.9.9")).toBeUndefined();
  });
});
