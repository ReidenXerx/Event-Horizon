/**
 * `game.userOwnedMasters` reaches the player.
 *
 * The install refuses a game missing one of these files, so a build that
 * writes them and a parser that drops them would be the sixth write-only field
 * in this format (see nativePluginsRoundTrip.test.ts) — and every player would
 * be told nothing, as before. Absent and empty must stay different: absent is
 * "never recorded", empty is "needs none".
 */
import { describe, expect, it } from "vitest";

import { buildManifest } from "./buildManifest";
import { parseManifest } from "./parseManifest";

const buildWith = (userOwnedMasters: string[] | undefined): string => {
  const { manifest } = buildManifest({
    snapshot: { exportedAt: "2026-09-24T00:00:00.000Z", gameId: "skyrimse", profileId: "p", count: 0, mods: [] },
    package: { id: "11111111-2222-4333-8444-555555555555", name: "Test Collection", version: "1.0.0", author: "A Curator" },
    game: { version: "1.6.1179.0", ...(userOwnedMasters !== undefined ? { userOwnedMasters } : {}) },
    vortex: { version: "1.13.7", deploymentMethod: "hardlink" },
  } as never);
  return JSON.stringify(manifest);
};

const rawWith = (game: Record<string, unknown>): string => {
  const manifest = JSON.parse(buildWith(undefined)) as { game: Record<string, unknown> };
  manifest.game = { ...manifest.game, ...game };
  return JSON.stringify(manifest);
};

describe("game.userOwnedMasters reaches the player", () => {
  it("survives build and parse, in the order the build wrote", () => {
    const files = ["_ResourcePack.esl", "ccBGSSSE001-Fish.esm", "ccQDRSSE001-SurvivalMode.esl"];
    expect(parseManifest(buildWith(files)).manifest.game.userOwnedMasters).toEqual(files);
  });

  it("keeps empty as empty and absent as absent", () => {
    expect(parseManifest(buildWith([])).manifest.game.userOwnedMasters).toEqual([]);
    expect("userOwnedMasters" in parseManifest(buildWith(undefined)).manifest.game).toBe(false);
  });

  it("reads a shape it does not know as not recorded, and skips entries it does not know, never failing the package", () => {
    const odd = parseManifest(rawWith({ userOwnedMasters: { files: ["ccBGSSSE001-Fish.esm"] } }));
    expect("userOwnedMasters" in odd.manifest.game).toBe(false);
    const mixed = parseManifest(rawWith({ userOwnedMasters: ["ccBGSSSE001-Fish.esm", { file: "x.esl" }, "", 7] }));
    expect(mixed.manifest.game.userOwnedMasters).toEqual(["ccBGSSSE001-Fish.esm"]);
  });
});
