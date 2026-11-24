/**
 * Skyrim-collection, 11-24 (Meridia 1.0.56): CBPC 21224 and S.L.A.C.K. 163969
 * each have ONE Nexus file whose FOMOD holds both the GOG 1.6.1179 and the
 * Steam 1.6.1170 DLL. The curator installs it twice and tags a store pair; the
 * build refused 'Duplicate compareKey "nexus:21224:814665"'.
 */
import { describe, expect, it } from "vitest";

import { buildManifest, BuildManifestError } from "./buildManifest";
import { parseCompareKey } from "../identity/compareKey";
import { nexusIdsOfKey } from "../installer/playerVariants";
import { neededEventHorizon } from "./minEventHorizon";
import type { AuditorMod } from "../getModsListForProfile";

const mod = (over: Partial<AuditorMod> & { id: string }): AuditorMod =>
  ({
    name: over.id,
    enabled: true,
    collectionIds: [],
    hasInstallerChoices: false,
    hasDetailedInstallerChoices: false,
    fomodSelections: [],
    rules: [],
    modType: "",
    fileOverrides: [],
    enabledINITweaks: [],
    installOrder: 0,
    ...over,
  }) as AuditorMod;

function build(mods: AuditorMod[]) {
  return buildManifest({
    snapshot: { gameId: "skyrimse", mods } as never,
    package: { id: "00000000-0000-4000-8000-000000000000", name: "t", version: "1.0.0", author: "a" },
    game: { version: "1.6.1170" },
    vortex: { version: "2.6.0", deploymentMethod: "hardlink" },
  } as never);
}

const cbpc = (id: string, store: "gog" | "steam", installOrder: number, group = "CBPC"): AuditorMod =>
  mod({
    id,
    installOrder,
    source: "nexus",
    nexusModId: 21224,
    nexusFileId: 814665,
    archiveSha256: "c".repeat(64),
    optional: true,
    variant: { group, label: store === "gog" ? "GOG" : "Steam", store },
  });

describe("one Nexus file installed twice as a Steam/GOG pair", () => {
  it("gives the later install the store suffix; the earlier keeps its key", () => {
    const { manifest } = build([cbpc("steam-copy", "steam", 2), cbpc("gog-main", "gog", 1)]);
    const keys = manifest.mods.map((m) => [m.name, m.compareKey]);
    expect(keys).toEqual([
      ["gog-main", "nexus:21224:814665"],
      ["steam-copy", "nexus:21224:814665#steam"],
    ]);
    // Both still download and install the same Nexus file.
    for (const m of manifest.mods) {
      expect(m.source).toMatchObject({ kind: "nexus", modId: 21224, fileId: 814665 });
    }
    expect(neededEventHorizon(manifest)?.version).toBe("0.2.139");
  });

  it("still refuses two installs that are not a store pair", () => {
    expect(() => build([cbpc("a", "gog", 1, "One"), cbpc("b", "steam", 2, "Other")])).toThrow(BuildManifestError);
    expect(() => build([cbpc("a", "gog", 1), cbpc("b", "gog", 2)])).toThrow(/Duplicate compareKey "nexus:21224:814665"/);
    const plain = mod({ id: "p", installOrder: 2, source: "nexus", nexusModId: 21224, nexusFileId: 814665, archiveSha256: "c".repeat(64) });
    expect(() => build([cbpc("a", "gog", 1), plain])).toThrow(/Duplicate compareKey/);
  });
});

describe("the twin key reads back as the same Nexus file", () => {
  it("parses the ids and the store", () => {
    expect(parseCompareKey("nexus:21224:814665#steam")).toEqual({
      kind: "nexus",
      nexusModId: "21224",
      nexusFileId: "814665",
      storeTwin: "steam",
    });
    expect(parseCompareKey("nexus:21224:814665")).toEqual({ kind: "nexus", nexusModId: "21224", nexusFileId: "814665" });
    expect(parseCompareKey("nexus:1:2#").kind).toBe("unrecognised");
    expect(parseCompareKey("nexus:1:2#a#b").kind).toBe("unrecognised");
    expect(nexusIdsOfKey("nexus:21224:814665#steam")).toEqual({ modId: 21224, fileId: 814665 });
  });
});
