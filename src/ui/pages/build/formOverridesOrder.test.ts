/**
 * The curator's answers are read from the config WITH the form's changes in it.
 *
 * The regression, Meridia 1.0.19 on 2026-09-16: Dynamic Container Loot was
 * answered "reproduce my version" in an earlier build, its Nexus page went away,
 * and the curator marked it external and chose Bundled to freeze their copy.
 * The build overlaid the answers from the config as the form had loaded it
 * (mirrored), bundled from the config with the form's change (bundled), and
 * packaging refused the contradiction.
 */
import { describe, expect, it } from "vitest";

import { withFormOverrides } from "./engine";
import type { AuditorMod } from "../../../core/getModsListForProfile";
import type { CollectionConfig } from "../../../core/manifest/collectionConfig";

const DCL = "Dynamic Container Loot (SKSE)-172018-0-3a-1770705636";
const mod = (id: string): AuditorMod => ({ id, name: id }) as AuditorMod;
const config = (externalMods: Record<string, unknown>): CollectionConfig =>
  ({ schemaVersion: 1, packageId: "p", externalMods }) as CollectionConfig;

describe("a build's config and answers", () => {
  it("does not mark mirrored a mod the form has just switched to bundled", () => {
    const { config: merged, mods } = withFormOverrides({
      config: config({ [DCL]: { mirrored: true } }),
      overrides: {
        externalMods: { [DCL]: { mirrored: true, treatAsExternal: true, bundled: true } },
        readme: "",
        changelog: "",
      },
      mods: [mod(DCL)],
    });
    expect(merged.externalMods[DCL]).toMatchObject({ bundled: true, treatAsExternal: true });
    expect(mods[0]!.mirrored).not.toBe(true);
  });

  it("still carries a mirror answer the form did not change", () => {
    const { mods } = withFormOverrides({
      config: config({ [DCL]: { mirrored: true } }),
      overrides: { externalMods: {}, readme: "", changelog: "" },
      mods: [mod(DCL)],
    });
    expect(mods[0]!.mirrored).toBe(true);
  });

  it("drops a mod the form has just answered 'leave it out'", () => {
    const { mods } = withFormOverrides({
      config: config({}),
      overrides: { externalMods: { [DCL]: { dropped: true } }, readme: "", changelog: "" },
      mods: [mod(DCL), mod("kept")],
    });
    expect(mods.map((m) => m.id)).toEqual(["kept"]);
  });

  it("takes the readme and changelog from the form", () => {
    const { config: merged } = withFormOverrides({
      config: { ...config({}), readme: "old", changelog: "old" },
      overrides: { externalMods: {}, readme: "new readme", changelog: "new changelog" },
      mods: [],
    });
    expect(merged.readme).toBe("new readme");
    expect(merged.changelog).toBe("new changelog");
  });
});
