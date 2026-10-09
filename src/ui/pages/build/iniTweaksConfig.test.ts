/**
 * INI tweaks a curator lists in the collection config (`iniTweaks`) are
 * recorded for players without being ticked in the curator's Vortex, which
 * bakes a ticked tweak into the curator's own INIs even for a switched-off mod
 * (Meridia - Handheld Settings, 2026-10-09).
 */
import { describe, expect, it } from "vitest";

import { applyPostProcessedDeclarations } from "./engine";

describe("INI tweaks from the collection config", () => {
  it("are recorded with the curator's own ticks, once each", () => {
    const [m] = applyPostProcessedDeclarations(
      [{ id: "handheld", name: "Meridia - Handheld Settings", enabledINITweaks: ["Already [Skyrim].ini"] } as never],
      {
        externalMods: {
          handheld: {
            optional: true,
            iniTweaks: ["Handheld Grass and Trees [SkyrimPrefs].ini", "already [skyrim].ini"],
          },
        },
      } as never,
    );
    expect(m!.enabledINITweaks).toEqual(["Already [Skyrim].ini", "Handheld Grass and Trees [SkyrimPrefs].ini"]);
  });
});
