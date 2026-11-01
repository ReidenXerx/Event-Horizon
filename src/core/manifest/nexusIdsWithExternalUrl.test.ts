/**
 * Meridia 1.0.34 (11-01): a DynDOLOD output installed from a local zip carried
 * Nexus ids 6502:16394 that Vortex had attached by itself (an unrelated 2016
 * file), while its config entry held the curator's pixeldrain link. The build
 * shipped the Nexus ids, dropped the link without a word, and the mod failed
 * to install for every player. Two sources for one mod is the curator's call.
 */
import { describe, expect, it } from "vitest";

import { buildManifest } from "./buildManifest";
import type { BuildManifestInput } from "./buildManifest";

const build = (spec: Record<string, unknown>): ReturnType<typeof buildManifest> =>
  buildManifest({
    snapshot: {
      gameId: "skyrimse",
      mods: [
        {
          id: "DynDOLOD_Output-2026-10-25",
          name: "DynDOLOD_Output-2026-10-25",
          enabled: true,
          modType: "",
          installOrder: 0,
          rules: [],
          fileOverrides: [],
          enabledINITweaks: [],
          fomodSelections: [],
          hasInstallerChoices: false,
          hasDetailedInstallerChoices: false,
          source: "nexus",
          nexusModId: 6502,
          nexusFileId: 16394,
          archiveSha256: "2".repeat(64),
          stagingFiles: [{ path: "meshes/lod.nif", size: 3, sha256: "a".repeat(64) }],
        },
      ],
    },
    package: {
      id: "00000000-0000-4000-8000-000000000000",
      name: "P",
      version: "1.0.0",
      author: "a",
      verificationLevel: "thorough",
    },
    game: { version: "1.6.1170.0", versionPolicy: "exact" },
    vortex: { version: "2.6.0", deploymentMethod: "hardlink" },
    externalMods: { "DynDOLOD_Output-2026-10-25": spec },
  } as unknown as BuildManifestInput);

describe("a Nexus-identified mod whose config gives a download link off Nexus", () => {
  it("refuses the build and names both sources", () => {
    expect(() =>
      build({ bundled: false, url: "https://pixeldrain.com/api/file/eagUAWd8?download", mode: "direct", instructions: "x" }),
    ).toThrow(/Nexus ids 6502:16394.*pixeldrain\.com.*treatAsExternal/s);
  });

  it("ships it external when the curator says the Nexus ids are wrong", () => {
    const built = build({
      bundled: false,
      treatAsExternal: true,
      url: "https://pixeldrain.com/api/file/eagUAWd8?download",
      mode: "direct",
      instructions: "x",
    });
    expect(built.manifest.mods[0]!.source.kind).toBe("external");
  });

  it("leaves a Nexus page link alone: that is the same source", () => {
    const built = build({ url: "https://www.nexusmods.com/skyrimspecialedition/mods/6502", mode: "browse" });
    expect(built.manifest.mods[0]!.source.kind).toBe("nexus");
  });
});
