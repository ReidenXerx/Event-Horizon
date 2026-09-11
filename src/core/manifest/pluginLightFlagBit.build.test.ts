/**
 * The build writes which header bit its light values came from.
 *
 * Without `plugins.lightFlagBit` an installer has to assume the pre-per-game
 * 0x200, which is right for Skyrim SE and refuses a Starfield package — so a
 * correct Starfield build that forgot to write the bit would ship flags no
 * user ever gets.
 */
import { describe, expect, it } from "vitest";

import { buildManifest } from "./buildManifest";

function build(extra: Record<string, unknown>): { manifest: { plugins: { lightFlagBit?: number } } } {
  return buildManifest({
    snapshot: {
      gameId: "fallout4",
      mods: [],
      userlist: { plugins: [], groups: [] },
    } as never,
    package: {
      id: "00000000-0000-4000-8000-000000000000",
      name: "t",
      version: "1.0.0",
      author: "a",
    },
    game: { version: "1.10.163" },
    vortex: { version: "2.6.0", deploymentMethod: "hardlink" },
    pluginsTxtContent: "*A.esp\n",
    pluginLightFlags: { "a.esp": true },
    ...extra,
  } as never) as never;
}

describe("plugins.lightFlagBit", () => {
  it("is written when the capture said which bit it read", () => {
    expect(build({ pluginLightFlagBit: 0x200 }).manifest.plugins.lightFlagBit).toBe(0x200);
  });

  it("is absent when nothing said", () => {
    expect("lightFlagBit" in build({}).manifest.plugins).toBe(false);
  });
});
