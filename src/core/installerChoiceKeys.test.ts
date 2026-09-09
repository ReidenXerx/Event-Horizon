/**
 * The build side and the installer side read the SAME attribute.
 *
 * ─── THE GAP ────────────────────────────────────────────────────────────────
 * Two functions answered "what did this machine pick", and they read different
 * data. `pickInstallerChoices` — which populates `AuditorMod.fomodSelections`,
 * and so both the manifest and the dashboard diff — tried seven attribute
 * keys. `liveFomodSelections`, the installer's only live read, tried two.
 *
 * For a mod whose answers Vortex stored under one of the other five, the
 * manifest recorded a real selection while the installer read `[]`. That is
 * exactly one side empty, so `compareSelections` returned `"unknown"` and the
 * stale-installer-options check could never fire for that mod — permanently,
 * and silently, because "unknown" is a legitimate verdict.
 *
 * Fail-safe in direction (no wrong reinstall), and still wrong: one of the two
 * was incorrect whichever way it resolved, and a diff whose halves read
 * different fields is not a diff.
 */
import { describe, expect, it } from "vitest";

import {
  liveFomodSelections,
  pickInstallerChoices,
} from "./getModsListForProfile";

const CHOICES = {
  type: "fomod",
  options: [
    { name: "Textures", groups: [{ name: "Res", choices: [{ name: "2K" }] }] },
  ],
};

const stateWith = (attributes: Record<string, unknown>): unknown => ({
  persistent: { mods: { skyrimse: { m1: { attributes } } } },
});

describe("where a mod's installer answers are read from", () => {
  it("reads the key Vortex actually uses", () => {
    expect(pickInstallerChoices({ installerChoices: CHOICES })).toBe(CHOICES);
    expect(liveFomodSelections(stateWith({ installerChoices: CHOICES }), "skyrimse", "m1"))
      .toHaveLength(1);
  });

  it("reads its one plausible sibling", () => {
    expect(pickInstallerChoices({ installerChoicesData: CHOICES })).toBe(CHOICES);
    expect(
      liveFomodSelections(
        stateWith({ installerChoicesData: CHOICES }),
        "skyrimse",
        "m1",
      ),
    ).toHaveLength(1);
  });

  it("gives the SAME answer on both sides for every key it accepts", () => {
    /**
     * The property that matters, stated directly. Whatever the accepted set
     * is, the build side and the installer side have to agree about it — a
     * key one reads and the other does not is a mod that can never be
     * compared.
     */
    for (const key of ["installerChoices", "installerChoicesData"]) {
      const attributes = { [key]: CHOICES };
      const built = pickInstallerChoices(attributes);
      const live = liveFomodSelections(stateWith(attributes), "skyrimse", "m1");
      expect(built, key).toBe(CHOICES);
      expect(live, key).toHaveLength(1);
    }
  });

  it("does not invent an answer from a key nobody has seen", () => {
    /**
     * The five speculative keys are gone rather than copied into the second
     * reader. None was ever observed on a real profile, and reading a key
     * whose SHAPE we have never seen would feed `normalizeFomodSelections`
     * something it cannot interpret — a guess about the user's choices, which
     * is what NS-8 exists to forbid.
     */
    for (const key of [
      "fomodChoices",
      "fomod",
      "choices",
      "installChoices",
      "installerOptions",
    ]) {
      expect(pickInstallerChoices({ [key]: CHOICES }), key).toBeUndefined();
    }
  });

  it("tolerates a mod with no attributes at all", () => {
    // It runs over whatever Vortex state happens to hold; throwing here would
    // take out the whole diff.
    expect(pickInstallerChoices(undefined)).toBeUndefined();
    expect(liveFomodSelections({}, "skyrimse", "m1")).toEqual([]);
  });
});
