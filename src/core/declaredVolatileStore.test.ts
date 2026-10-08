/**
 * Files a curator declares generated for each machine (owner, 2026-10-09: a
 * per-mod list in the collection config instead of names hard-coded in
 * volatileFiles.ts). Addictol 1.7.1 ships F4SE/Plugins/Addictol_SNCT.ini empty
 * and fills it at runtime; Ivy Rev 13 recorded the curator's copy.
 */
import { promises as fsp } from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadDeclaredVolatileFiles, rememberDeclaredVolatileFiles, volatileFilesOf } from "./declaredVolatileStore";
import { loadOrCreateCollectionConfig } from "./manifest/collectionConfig";
import { neededEventHorizon } from "./manifest/minEventHorizon";
import { clearDeclaredVolatileFilesForTests, isVolatileFile } from "./volatileFiles";
import { applyPostProcessedDeclarations } from "../ui/pages/build/engine";

const SNCT = "F4SE/Plugins/Addictol_SNCT.ini";
let dir: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "eh-volatile-"));
  clearDeclaredVolatileFilesForTests();
});
afterEach(async () => {
  clearDeclaredVolatileFilesForTests();
  await fsp.rm(dir, { recursive: true, force: true });
});

describe("the curator's list", () => {
  it("is read from the collection config", async () => {
    await fsp.writeFile(
      path.join(dir, "ivy.json"),
      JSON.stringify({ schemaVersion: 1, packageId: "fa6eb141-03b0-4847-bb12-e4c5fe4fa385", externalMods: { addictol: { volatileFiles: ["F4SE\\Plugins\\Addictol_SNCT.ini"] } } }),
    );
    const { config } = await loadOrCreateCollectionConfig({ configDir: dir, slug: "ivy" });
    expect(config.externalMods["addictol"]?.volatileFiles).toEqual([SNCT]);
  });

  it("keeps the file out of what the build records, and says so in the mod", () => {
    const [mod] = applyPostProcessedDeclarations(
      [
        {
          id: "addictol",
          name: "Addictol",
          stagingFiles: [
            { path: "F4SE/Plugins/Addictol.dll", size: 10 },
            { path: "f4se/plugins/addictol_snct.ini", size: 545 },
          ],
        } as never,
      ],
      { externalMods: { addictol: { volatileFiles: [SNCT] } } } as never,
    );
    expect(mod!.stagingFiles!.map((f) => f.path)).toEqual(["F4SE/Plugins/Addictol.dll"]);
    expect(mod!.volatileFiles).toEqual([SNCT]);
  });
});

describe("on the player's side", () => {
  it("is skipped once a package declares it, and in the next session too", () => {
    const store = path.join(dir, "volatile-files.json");
    const manifest = { mods: [{ state: { volatileFiles: [SNCT] } }, { state: {} }] } as never;
    expect(isVolatileFile(SNCT)).toBe(false);
    expect(rememberDeclaredVolatileFiles(volatileFilesOf(manifest), store)).toBe(1);
    expect(isVolatileFile("F4SE\\Plugins\\Addictol_SNCT.ini")).toBe(true);

    clearDeclaredVolatileFilesForTests(); // a new session
    expect(isVolatileFile(SNCT)).toBe(false);
    expect(loadDeclaredVolatileFiles(store)).toBe(1);
    expect(isVolatileFile(SNCT)).toBe(true);
  });

  it("tells a player on an older Event Horizon to update", () => {
    const needs = neededEventHorizon({
      mods: [{ compareKey: "k", name: "Addictol", source: { kind: "nexus" }, install: {}, state: { volatileFiles: [SNCT] } }],
      game: { id: "fallout4" },
    } as never);
    expect(needs).toEqual({ version: "0.2.61", why: ["mod files the game writes for your own setup"] });
  });
});
