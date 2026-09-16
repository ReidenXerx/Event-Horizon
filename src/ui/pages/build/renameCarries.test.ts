/**
 * A rename on the Build form builds a NEW collection, and takes along what the
 * form set for the collection itself: the prerequisites and the presentation.
 *
 * The regression, 2026-09-16: Meridia was renamed to "Meridia's Panties - Event
 * Horizon" on the form, and 1.0.18 shipped with no header, card image or Discord
 * link, all three on screen when Build was pressed. They stayed with the config
 * and image folder of the old name.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configForBuildName } from "./engine";
import {
  loadOrCreateCollectionConfig,
  saveCollectionConfig,
  type CollectionConfig,
} from "../../../core/manifest/collectionConfig";
import {
  copyPresentationImages,
  presentationAssetsDir,
} from "../../../core/presentation/presentationAssets";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-rename-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const HEADER = "header-447150e547c5a0f6.png";
const TILE = "tile-1ffc89cf51023298.png";

/** The collection the form opened on: a header, a card image, a link and a prerequisite. */
async function meridia(): Promise<{ config: CollectionConfig; configPath: string }> {
  const { config: created } = await loadOrCreateCollectionConfig({ configDir: dir, slug: "meridia-panties" });
  const config: CollectionConfig = {
    ...created,
    presentation: {
      header: HEADER,
      tile: TILE,
      links: [{ label: "Discord", url: "https://discord.gg/example" }],
    },
    externalDependencies: { "skse64": { instructions: "Install SKSE first." } },
  };
  const configPath = await saveCollectionConfig({ configDir: dir, slug: "meridia-panties", config });
  const images = presentationAssetsDir(dir, config.packageId);
  fs.mkdirSync(images, { recursive: true });
  fs.writeFileSync(path.join(images, HEADER), "header bytes");
  fs.writeFileSync(path.join(images, TILE), "tile bytes");
  return { config, configPath };
}

const contextOf = (loaded: { config: CollectionConfig; configPath: string }) => ({
  collectionConfig: loaded.config,
  configPath: loaded.configPath,
  defaultName: "Meridia Panties",
  externalMods: [],
});

describe("building under a new name", () => {
  it("takes the header, card image and links along, with copies of the images", async () => {
    const old = await meridia();
    const built = await configForBuildName({
      configDir: dir,
      name: "Meridia's Panties - Event Horizon",
      context: contextOf(old),
    });

    expect(built.config.packageId).not.toBe(old.config.packageId);
    expect(built.config.presentation).toEqual(old.config.presentation);
    const images = presentationAssetsDir(dir, built.config.packageId);
    expect(fs.readFileSync(path.join(images, HEADER), "utf8")).toBe("header bytes");
    expect(fs.readFileSync(path.join(images, TILE), "utf8")).toBe("tile bytes");
    // Copied, not moved: the old name keeps its own.
    expect(fs.existsSync(path.join(presentationAssetsDir(dir, old.config.packageId), HEADER))).toBe(true);
  });

  it("takes the prerequisites along, and says a new collection was built", async () => {
    const old = await meridia();
    const built = await configForBuildName({
      configDir: dir,
      name: "Meridia's Panties - Event Horizon",
      context: contextOf(old),
    });
    expect(built.config.externalDependencies).toEqual(old.config.externalDependencies);
    expect(built.warnings.join(" ")).toMatch(/NEW collection called "Meridia's Panties - Event Horizon"/);
    expect(path.basename(built.configPath)).toBe("meridia-s-panties-event-horizon.json");
  });

  it("keeps the presentation of a collection that already has one", async () => {
    const old = await meridia();
    const { config: other } = await loadOrCreateCollectionConfig({ configDir: dir, slug: "meridia-lite" });
    await saveCollectionConfig({
      configDir: dir,
      slug: "meridia-lite",
      config: { ...other, presentation: { tile: "tile-0000000000000000.png" } },
    });
    const built = await configForBuildName({ configDir: dir, name: "Meridia Lite", context: contextOf(old) });
    expect(built.config.presentation).toEqual({ tile: "tile-0000000000000000.png" });
    expect(fs.existsSync(presentationAssetsDir(dir, other.packageId))).toBe(false);
  });

  it("changes nothing when the name still picks the same collection", async () => {
    const old = await meridia();
    const built = await configForBuildName({ configDir: dir, name: "meridia panties", context: contextOf(old) });
    expect(built.config).toBe(old.config);
    expect(built.warnings).toEqual([]);
  });
});

describe("copying the images", () => {
  it("reports an image it cannot find instead of failing the build", async () => {
    const result = await copyPresentationImages({
      configDir: dir,
      fromPackageId: "from",
      toPackageId: "to",
      presentation: { header: HEADER, gallery: [{ file: "gallery-1111111111111111.jpg" }] },
    });
    expect(result).toEqual({ copied: [], failed: [HEADER, "gallery-1111111111111111.jpg"] });
  });

  it("leaves an image already there alone, and never copies a name that could leave the folder", async () => {
    const from = presentationAssetsDir(dir, "from");
    const to = presentationAssetsDir(dir, "to");
    fs.mkdirSync(from, { recursive: true });
    fs.mkdirSync(to, { recursive: true });
    fs.writeFileSync(path.join(from, HEADER), "new");
    fs.writeFileSync(path.join(to, HEADER), "already there");
    const result = await copyPresentationImages({
      configDir: dir,
      fromPackageId: "from",
      toPackageId: "to",
      presentation: { header: HEADER, tile: "../../escape.png" },
    });
    expect(result).toEqual({ copied: [], failed: [] });
    expect(fs.readFileSync(path.join(to, HEADER), "utf8")).toBe("already there");
  });
});
