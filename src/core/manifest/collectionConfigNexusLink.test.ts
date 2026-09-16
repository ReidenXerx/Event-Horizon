/**
 * Where a collection's packages upload to on Nexus, remembered in its config.
 *
 * The config parser builds a fresh object from the fields it knows, so a field
 * it does not read is silently erased by the next build's save. The round trip
 * below is what proves the link survives that, not just that it was written.
 */
import { promises as fsp } from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  findNexusCollectionLink,
  loadOrCreateCollectionConfig,
  readNexusCollectionLink,
  rememberNexusCollectionLink,
  saveCollectionConfig,
} from "./collectionConfig";

const PACKAGE_ID = "fa6eb141-03b0-4847-bb12-e4c5fe4fa385";
const LINK = { id: 350133, slug: "tumkz9", gameDomain: "fallout4", name: "Ivy's Panties" };

let dir: string;
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "eh-nexus-link-"));
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

async function writeBuiltConfig(slug: string, extra: Record<string, unknown> = {}): Promise<void> {
  await fsp.writeFile(
    path.join(dir, `${slug}.json`),
    JSON.stringify({
      schemaVersion: 1,
      packageId: PACKAGE_ID,
      externalMods: {},
      lastBuiltAt: "2026-09-16T10:00:00.000Z",
      lastBuiltVersion: "1.0.29",
      ...extra,
    }),
    "utf8",
  );
}

describe("remembering the Nexus collection", () => {
  it("finds the link again by the package's id", async () => {
    await writeBuiltConfig("ivy-panties");
    expect(await rememberNexusCollectionLink(dir, PACKAGE_ID, LINK)).toBe(true);
    expect(await findNexusCollectionLink(dir, PACKAGE_ID)).toEqual(LINK);
  });

  it("survives the next build loading and saving the config", async () => {
    await writeBuiltConfig("ivy-panties");
    await rememberNexusCollectionLink(dir, PACKAGE_ID, LINK);
    // What a build does: load, change its own fields, save.
    const { config } = await loadOrCreateCollectionConfig({ configDir: dir, slug: "ivy-panties" });
    await saveCollectionConfig({ configDir: dir, slug: "ivy-panties", config: { ...config, lastBuiltVersion: "1.0.30" } });
    expect(await findNexusCollectionLink(dir, PACKAGE_ID)).toEqual(LINK);
  });

  it("reports nowhere to remember a package no built collection has", async () => {
    await writeBuiltConfig("ivy-panties");
    const before = await fsp.readFile(path.join(dir, "ivy-panties.json"), "utf8");
    expect(await rememberNexusCollectionLink(dir, "00000000-0000-4000-8000-000000000000", LINK)).toBe(false);
    expect(await fsp.readFile(path.join(dir, "ivy-panties.json"), "utf8")).toBe(before);
  });

  it("drops an unusable link and still loads the config, because no build depends on it", async () => {
    await writeBuiltConfig("ivy-panties", { nexusCollection: { id: "350133", slug: "tumkz9", gameDomain: "fallout4" } });
    const { config } = await loadOrCreateCollectionConfig({ configDir: dir, slug: "ivy-panties" });
    expect(config.nexusCollection).toBeUndefined();
    expect(config.lastBuiltVersion).toBe("1.0.29");
  });
});

describe("reading a link", () => {
  it("accepts a whole one and keeps the optional name only when present", () => {
    expect(readNexusCollectionLink(LINK)).toEqual(LINK);
    expect(readNexusCollectionLink({ id: 1, slug: "abc", gameDomain: "fallout4", name: "" })).toEqual({
      id: 1,
      slug: "abc",
      gameDomain: "fallout4",
    });
  });

  it("refuses ids that are not positive whole numbers", () => {
    for (const id of [0, -1, 1.5, "1", undefined]) {
      expect(readNexusCollectionLink({ ...LINK, id })).toBeUndefined();
    }
  });

  it("refuses a slug or domain that would change the page address", () => {
    // Both are pasted into a URL that gets opened in a browser.
    expect(readNexusCollectionLink({ ...LINK, slug: "../mods/1" })).toBeUndefined();
    expect(readNexusCollectionLink({ ...LINK, slug: "" })).toBeUndefined();
    expect(readNexusCollectionLink({ ...LINK, gameDomain: "evil.example/x" })).toBeUndefined();
    expect(readNexusCollectionLink(null)).toBeUndefined();
    expect(readNexusCollectionLink([LINK])).toBeUndefined();
  });
});
