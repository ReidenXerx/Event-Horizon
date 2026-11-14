/**
 * Ivy 1.0.59's first build (11-14) shipped 14 external mods with no bundle,
 * no url and no instructions, and reported success. One was a Vortex
 * reinstall ("...-1+2") whose old config entry held a LoversLab url the new
 * id never got. Two fixes: the reinstall inherits its predecessor's entry,
 * and the build warns about any external a player has no way to get.
 */
import { describe, expect, it } from "vitest";

import { buildManifest } from "./buildManifest";
import type { BuildManifestInput } from "./buildManifest";
import { reconcileExternalModsConfig, reinstallPredecessor } from "./collectionConfig";
import type { CollectionConfig } from "./collectionConfig";

const build = (spec: Record<string, unknown>): ReturnType<typeof buildManifest> =>
  buildManifest({
    snapshot: {
      gameId: "fallout4",
      mods: [
        {
          id: "1387286231_UAPv2.6.64-1+2",
          name: "UAP",
          enabled: true,
          modType: "",
          installOrder: 0,
          rules: [],
          fileOverrides: [],
          enabledINITweaks: [],
          fomodSelections: [],
          hasInstallerChoices: false,
          hasDetailedInstallerChoices: false,
          source: "external",
          archiveSha256: "3".repeat(64),
          stagingFiles: [{ path: "meshes/a.nif", size: 3, sha256: "a".repeat(64) }],
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
    game: { version: "1.11.240.0", versionPolicy: "exact" },
    vortex: { version: "2.6.0", deploymentMethod: "hardlink" },
    externalMods: { "1387286231_UAPv2.6.64-1+2": spec },
  } as unknown as BuildManifestInput);

describe("an external mod a player cannot get", () => {
  it("is named in a build warning", () => {
    const { warnings } = build({ bundled: false, instructions: "" });
    expect(warnings.join("\n")).toMatch(/1 external mod has no way for a player to get it.*UAP/s);
  });

  it("is fine with a url, with instructions, or bundled", () => {
    for (const spec of [
      { bundled: false, url: "https://www.loverslab.com/files/file/1", instructions: "" },
      { bundled: false, instructions: "Download from LoversLab" },
    ]) {
      expect(build(spec).warnings.join("\n")).not.toMatch(/no way for a player/);
    }
  });
});

describe("a Vortex reinstall (+N id)", () => {
  const config = {
    externalMods: {
      "1387286231_UAPv2.6.64-1": {
        name: "UAP",
        bundled: false,
        instructions: "",
        url: "https://www.loverslab.com/files/file/1",
        mode: "browse",
      },
      "Other-1": { name: "Other", bundled: true, instructions: "" },
    },
  } as unknown as CollectionConfig;

  it("takes over its old entry, url included, when the old id is gone", () => {
    const r = reconcileExternalModsConfig({
      config,
      externalMods: [{ id: "1387286231_UAPv2.6.64-1+2", name: "UAP v2" }],
    });
    expect(r.config.externalMods["1387286231_UAPv2.6.64-1+2"]).toMatchObject({
      name: "UAP v2",
      url: "https://www.loverslab.com/files/file/1",
      mode: "browse",
    });
    expect(r.inherited).toEqual([
      { from: "1387286231_UAPv2.6.64-1", to: "1387286231_UAPv2.6.64-1+2" },
    ]);
  });

  it("does not take over an entry whose mod is still installed", () => {
    const r = reconcileExternalModsConfig({
      config,
      externalMods: [
        { id: "1387286231_UAPv2.6.64-1", name: "UAP" },
        { id: "1387286231_UAPv2.6.64-1+2", name: "UAP" },
      ],
    });
    expect(r.config.externalMods["1387286231_UAPv2.6.64-1+2"]).toEqual({
      name: "UAP",
      bundled: false,
      instructions: "",
    });
  });

  it("picks the newest of several gone predecessors", () => {
    const entries = {
      "M-1": { name: "M", bundled: false, instructions: "" },
      "M-1+1": { name: "M", bundled: false, instructions: "" },
      "M-1+3": { name: "M", bundled: false, instructions: "" },
    } as unknown as CollectionConfig["externalMods"];
    expect(reinstallPredecessor("M-1+4", entries, new Set(["M-1+4"]))).toBe("M-1+3");
    expect(reinstallPredecessor("N-1+1", entries, new Set(["N-1+1"]))).toBeUndefined();
  });
});
