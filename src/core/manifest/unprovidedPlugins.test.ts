/**
 * Measured on Meridia 1.0.23, a published package: its load order names 1,597
 * plugins and three of them — `synthesis.esp`, `dynamiccontainerloot.esp` and
 * `meridia_addn_index_fixes.esp` — are shipped by no mod in the collection.
 * They are the curator's own output, handed out through links on the
 * collection page. Nothing in Event Horizon mentioned them to anyone, so a
 * player who skipped the links got a load order with holes and no message.
 */
import { describe, expect, it } from "vitest";

import {
  describeMissingFromPackage,
  describeUnprovidedPlugins,
  unprovidedPlugins,
} from "./unprovidedPlugins";
import type { EhcollManifest } from "../../types/ehcoll";

const manifest = (args: {
  gameId?: string;
  order: string[];
  staged: string[];
}): Pick<EhcollManifest, "game" | "mods" | "plugins"> =>
  ({
    game: { id: args.gameId ?? "skyrimse" },
    mods: [
      {
        name: "A mod",
        state: { stagingFiles: args.staged.map((p) => ({ path: p, size: 1 })) },
      },
    ],
    plugins: { order: args.order.map((name) => ({ name, enabled: true })) },
  }) as unknown as Pick<EhcollManifest, "game" | "mods" | "plugins">;

describe("plugins the order names and the package does not carry", () => {
  it("finds the curator's own output", () => {
    const found = unprovidedPlugins(
      manifest({
        order: ["Skyrim.esm", "SomeMod.esp", "Synthesis.esp", "meridia_addn_index_fixes.esp"],
        staged: ["meshes/x.nif", "SomeMod.esp"],
      }),
    );
    expect(found).toEqual(["synthesis.esp", "meridia_addn_index_fixes.esp"]);
  });

  it("does not blame the game for its own masters", () => {
    // The base game and Creation Club files come from the game, not the
    // collection; naming them would bury the three that matter.
    const found = unprovidedPlugins(
      manifest({
        order: ["Skyrim.esm", "Dawnguard.esm", "ccBGSSSE037-Curios.esl", "Mine.esp"],
        staged: ["Mine.esp"],
      }),
    );
    expect(found).toEqual([]);
  });

  it("matches regardless of case or folder depth", () => {
    const found = unprovidedPlugins(
      manifest({ order: ["MyPatch.ESP"], staged: ["some/deep/folder/mypatch.esp"] }),
    );
    expect(found).toEqual([]);
  });

  it("says nothing at all about a package that ships no load order", () => {
    expect(unprovidedPlugins(manifest({ order: [], staged: ["a.esp"] }))).toEqual([]);
  });

  it("tells the curator it is their own output, not a mistake", () => {
    const [line] = describeUnprovidedPlugins(["synthesis.esp"]);
    expect(line).toMatch(/not shipped by any mod/);
    expect(line).toMatch(/normal for output you distribute yourself/);
  });

  it("tells the player where the gap is, and that the page has the answer", () => {
    const [line] = describeMissingFromPackage(["synthesis.esp", "x.esp"]);
    expect(line).toMatch(/not part of the package/);
    expect(line).toMatch(/collection page says where to get them/);
    expect(line).toMatch(/those places are empty/);
  });

  it("caps a long list rather than printing a wall", () => {
    const many = Array.from({ length: 30 }, (_, i) => `p${i}.esp`);
    const [line] = describeMissingFromPackage(many);
    expect(line).toContain("and 22 more");
  });
});
