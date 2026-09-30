import { describe, expect, it } from "vitest";
import { describeVariantAmbiguous } from "./variantReport";

const base = {
  name: "Optimized Vanilla Tree LODs",
  paths: [
    "Meshes/LOD/Landscape/Trees/GlowingSea/TreeGS01_lod_0.nif",
    "Meshes/LOD/Landscape/Trees/TreeMapleSmall01_lod_0.nif",
    "Meshes/LOD/Landscape/Trees/TreePineSmall01_lod_0.nif",
    "Meshes/LOD/Landscape/Trees/TreeBlasted01_lod_0.nif",
  ],
};

describe("describeVariantAmbiguous", () => {
  it("counts every differing file but quotes only three", () => {
    const msg = describeVariantAmbiguous({ ...base, recorded: true, attended: false });
    expect(msg).toContain("4 file(s) differ");
    expect(msg).toContain("TreeGS01_lod_0.nif");
    // The fourth is counted, not listed — a report that pastes forty paths
    // into one line is not read.
    expect(msg).not.toContain("TreeBlasted01_lod_0.nif");
  });

  it("tells the player a reinstall fixes it when answers are recorded", () => {
    const msg = describeVariantAmbiguous({ ...base, recorded: true, attended: false });
    expect(msg).toContain("ARE recorded");
    expect(msg).toContain("lands their version");
    // And does NOT blame them for a dialog they never saw.
    expect(msg).not.toContain("You answered this mod's installer yourself");
  });

  it("names the pre-ticked dialog when the player answered it themselves", () => {
    const msg = describeVariantAmbiguous({ ...base, recorded: true, attended: true });
    expect(msg).toContain("You answered this mod's installer yourself");
    expect(msg).toContain("pre-ticks the mod's own defaults");
  });

  it("tells the player NOT to reinstall when there is nothing to replay", () => {
    // NS-8: an empty selection is never guessed, so there is no answer to
    // apply and a reinstall lands the same variant. The old wording — "may or
    // may not change it" — sent people round that loop for nothing.
    const msg = describeVariantAmbiguous({ ...base, recorded: false, attended: true });
    expect(msg).toContain("would land this same version again");
    expect(msg).not.toContain("ARE recorded");
    // Attended is irrelevant with nothing recorded: there was no curator
    // answer to diverge from, so the dialog explanation would be a lie.
    expect(msg).not.toContain("You answered this mod's installer yourself");
  });

  it("always leads with the reassurance, because nothing is broken", () => {
    for (const recorded of [true, false]) {
      for (const attended of [true, false]) {
        const msg = describeVariantAmbiguous({ ...base, recorded, attended });
        expect(msg.startsWith(`"${base.name}" may be a different installer option`)).toBe(true);
        expect(msg).toContain("Nothing is damaged.");
      }
    }
  });
});
