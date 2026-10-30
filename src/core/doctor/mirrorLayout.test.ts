/**
 * Ivy 1.0.56, .frenchkiwi (2026-10-30): "Collection of textures and presets"
 * kept its archive's layout instead of the curator's Textures/CoTaP/..., and
 * Doctor had nothing to say about it.
 */
import { describe, expect, it } from "vitest";

import type { EhcollMod } from "../../types/ehcoll";
import { mirrorLayoutCheck } from "./health";
import { checkMirrorLayout, mirrorLayoutTargets } from "./mirrorLayout";

const file = (path: string, extra: Record<string, unknown> = {}) => ({ path, size: 1, sha256: "a", ...extra });

const cotap = {
  compareKey: "nexus:30019:122927",
  name: "Collection of textures and presets",
  state: {
    mirrored: true,
    stagingFiles: [
      file("Textures/CoTaP/actors/Character/FaceDetails/Bruising01_d.dds"),
      file("Textures/CoTaP/DLC03/TintMasks/FacePaint24.dds"),
      file("Textures/CoTaP/held.dds", { installerCondition: { needs: ["Other.esp"] } }),
    ],
  },
} as unknown as EhcollMod;
const plain = { compareKey: "nexus:1:1", name: "Plain", state: { stagingFiles: [file("a.esp")] } } as unknown as EhcollMod;

const receipt = [
  { compareKey: cotap.compareKey, vortexModId: "cotap-id", name: "CoTaP", ownership: "installed" },
  { compareKey: plain.compareKey, vortexModId: "plain-id", name: "Plain", ownership: "installed" },
];

describe("mirrored mods in the curator's layout", () => {
  it("the archive's own layout is reported, with the files that are not where the curator put them", async () => {
    const result = await checkMirrorLayout({
      targets: mirrorLayoutTargets([cotap, plain], receipt),
      stagingRootFor: (id) => `/staging/${id}`,
      list: async () => ["Data/Textures/actors/Character/FaceDetails/Bruising01_d.dds", "Data/Krisa.esp"],
    });
    expect(result).toEqual({
      kind: "checked",
      judged: 1,
      skipped: 0,
      findings: [
        {
          compareKey: cotap.compareKey,
          name: "CoTaP",
          missing: 2,
          of: 2,
          examples: ["Textures/CoTaP/actors/Character/FaceDetails/Bruising01_d.dds", "Textures/CoTaP/DLC03/TintMasks/FacePaint24.dds"],
        },
      ],
    });
    const check = mirrorLayoutCheck(result);
    expect(check.status).toBe("drifted");
    expect(check.heal?.action).toBe("reinstall-mods");
  });

  it("a mirrored folder holding every curator file is healthy (letter case and extra files aside)", async () => {
    const result = await checkMirrorLayout({
      targets: mirrorLayoutTargets([cotap], receipt),
      stagingRootFor: (id) => `/staging/${id}`,
      list: async () => [
        "textures/cotap/actors/character/facedetails/bruising01_d.dds",
        "Textures/CoTaP/DLC03/TintMasks/FacePaint24.dds",
        "BodySlide output.nif",
      ],
    });
    expect(mirrorLayoutCheck(result).status).toBe("healthy");
  });

  it("a mod the player already had is theirs: not judged, since the mirror never rewrites it", () => {
    expect(mirrorLayoutTargets([cotap], [{ ...receipt[0]!, ownership: "adopted" }])).toEqual([]);
  });

  it("a folder that could not be read in full is skipped, not reported", async () => {
    const result = await checkMirrorLayout({
      targets: mirrorLayoutTargets([cotap], receipt),
      stagingRootFor: () => "/staging/x",
      list: async () => undefined,
    });
    expect(result).toEqual({ kind: "checked", judged: 0, skipped: 1, findings: [] });
  });

  it("no package means not checked, never fine", () => {
    expect(mirrorLayoutCheck(undefined).status).toBe("unknown");
  });
});
