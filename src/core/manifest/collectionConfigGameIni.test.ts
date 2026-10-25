/** The curator's gameIni trim lives in the collection config and survives a build's save. */
import { promises as fsp } from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadOrCreateCollectionConfig, saveCollectionConfig } from "./collectionConfig";

const PACKAGE_ID = "0456490d-525b-49e3-92d2-5c6e617990be";

let dir: string;
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "eh-config-gameini-"));
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

const write = (extra: Record<string, unknown>) =>
  fsp.writeFile(
    path.join(dir, "ivy.json"),
    JSON.stringify({ schemaVersion: 1, packageId: PACKAGE_ID, externalMods: {}, ...extra }),
    "utf8",
  );

describe("gameIni in the collection config", () => {
  it("loads, and survives the next build loading and saving the config", async () => {
    const gameIni = { exclude: ["Fallout4Prefs.ini:AudioMenu:*"], include: ["*:Interface:iHUDColor*"] };
    await write({ gameIni });
    const { config } = await loadOrCreateCollectionConfig({ configDir: dir, slug: "ivy" });
    expect(config.gameIni).toEqual(gameIni);
    await saveCollectionConfig({ configDir: dir, slug: "ivy", config: { ...config, lastBuiltVersion: "1.0.58" } });
    const again = await loadOrCreateCollectionConfig({ configDir: dir, slug: "ivy" });
    expect(again.config.gameIni).toEqual(gameIni);
  });

  it("refuses a pattern that is not File:Section:Key, naming it", async () => {
    await write({ gameIni: { exclude: ["AudioMenu:*"] } });
    await expect(loadOrCreateCollectionConfig({ configDir: dir, slug: "ivy" })).rejects.toThrow(/AudioMenu:\*/);
  });
});
