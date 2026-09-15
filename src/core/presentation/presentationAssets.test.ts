import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PresentationImageError,
  importPresentationImage,
  presentationAssetsDir,
  resolvePresentationForBuild,
} from "./presentationAssets";
import { MAX_IMAGE_BYTES } from "./presentation";

const PACKAGE_ID = "fa6eb141-03b0-4847-bb12-e4c5fe4fa385";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest of a png")]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("rest of a jpeg")]);

let dir: string;
let configDir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-presentation-"));
  configDir = path.join(dir, ".config");
  fs.mkdirSync(configDir);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const source = (name: string, bytes: Buffer): string => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
};

describe("importPresentationImage", () => {
  it("copies the picked image beside the config, named by its content and format", async () => {
    const picked = source("My Banner.PNG", PNG);
    const { file } = await importPresentationImage({ configDir, packageId: PACKAGE_ID, sourcePath: picked, role: "header" });
    expect(file).toMatch(/^header-[0-9a-f]{16}[.]png$/);
    const stored = path.join(presentationAssetsDir(configDir, PACKAGE_ID), file);
    expect(fs.readFileSync(stored)).toEqual(PNG);
    // The original can go; the collection keeps its copy.
    fs.rmSync(picked);
    expect(fs.existsSync(stored)).toBe(true);
  });

  it("names the format by the bytes, not by the extension it was given", async () => {
    const { file } = await importPresentationImage({
      configDir,
      packageId: PACKAGE_ID,
      sourcePath: source("photo.png", JPEG),
      role: "gallery",
    });
    expect(file.endsWith(".jpg")).toBe(true);
  });

  it("refuses a file that is not an image, whatever it is called", async () => {
    await expect(
      importPresentationImage({ configDir, packageId: PACKAGE_ID, sourcePath: source("evil.png", Buffer.from("<svg onload=x>")), role: "tile" }),
    ).rejects.toBeInstanceOf(PresentationImageError);
  });

  it("refuses an image over the size limit", async () => {
    const big = source("huge.png", Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]));
    await expect(
      importPresentationImage({ configDir, packageId: PACKAGE_ID, sourcePath: big, role: "header" }),
    ).rejects.toThrow(/at most/);
  });
});

describe("resolvePresentationForBuild", () => {
  it("measures and hashes every image once, and ships each file once", async () => {
    const assets = presentationAssetsDir(configDir, PACKAGE_ID);
    fs.mkdirSync(assets, { recursive: true });
    fs.writeFileSync(path.join(assets, "shared.png"), PNG);
    fs.writeFileSync(path.join(assets, "shot.jpg"), JPEG);
    const built = await resolvePresentationForBuild({
      configDir,
      packageId: PACKAGE_ID,
      config: {
        header: "shared.png",
        gallery: [{ file: "shared.png", caption: " Institute " }, { file: "shot.jpg" }],
        theme: { accent: "#ff6b3d" },
        about: "Hello",
        links: [{ label: "Nexus", url: "https://www.nexusmods.com" }],
      },
    });
    expect(built.warnings).toEqual([]);
    expect(built.files.map((f) => f.entry).sort()).toEqual(["presentation/shared.png", "presentation/shot.jpg"]);
    expect(built.presentation?.header?.size).toBe(PNG.length);
    expect(built.presentation?.header?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(built.presentation?.gallery.map((g) => g.caption)).toEqual(["Institute", undefined]);
    expect(built.presentation?.theme).toEqual({ accent: "#ff6b3d" });
  });

  it("leaves out an image that has gone, with a warning, and still builds", async () => {
    const built = await resolvePresentationForBuild({
      configDir,
      packageId: PACKAGE_ID,
      config: { header: "gone.png", about: "Still here" },
    });
    expect(built.presentation?.header).toBeUndefined();
    expect(built.presentation?.about).toBe("Still here");
    expect(built.files).toEqual([]);
    expect(built.warnings[0]).toContain("header image");
  });

  it("ships nothing when there is nothing to show", async () => {
    const built = await resolvePresentationForBuild({ configDir, packageId: PACKAGE_ID, config: {} });
    expect(built.presentation).toBeUndefined();
    expect(built.files).toEqual([]);
  });
});
