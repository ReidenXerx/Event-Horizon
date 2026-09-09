/**
 * A mod whose FOMOD options the CURATOR narrowed, on a user who already has
 * the older, wider version.
 *
 * ─── THE RUN THIS COMES FROM ────────────────────────────────────────────────
 * The curator re-installed `Val Serano` excluding a patch and shipped v1.0.11.
 * The Nexus archive did not change, so the compareKey did not change:
 *
 *   Val Serano-103669-2-3-1735508600+SD
 *   decision: "nexus-already-installed"   compareKey: nexus:103669:767362
 *   ms: 0
 *
 * The tester kept v1.0.10's wider selection — including
 * `AX ValSerano-RaceCompatibility.esp`, whose master the collection does not
 * ship — and Vortex then refused to sort the load order.
 *
 * Verification could not see it either. It proves every file the curator
 * RECORDED is present with the recorded bytes; a file the user has that the
 * curator does not is an `extraFile`, deliberately informational, "because
 * they happen legitimately when the user picks different FOMOD options than
 * the curator did". True of a user who chose differently, false of a curator
 * who narrowed.
 *
 * So the ANSWERS are compared directly. Both sides carry them and it costs
 * nothing.
 */
import { describe, expect, it } from "vitest";

import { compareSelections } from "../curator/fomodSelectionDiff";
import { liveFomodSelections } from "../getModsListForProfile";

import type { FomodSelectionStep } from "../getModsListForProfile";

const picked = (...names: string[]): FomodSelectionStep[] => [
  {
    name: "Patches",
    groups: [{ name: "Optional", choices: names.map((name) => ({ name })) }],
  },
];

const stateWith = (choices: unknown): unknown => ({
  persistent: {
    mods: {
      skyrimse: {
        "val-serano": { attributes: { installerChoices: choices } },
      },
    },
  },
});

describe("reading what THIS machine picked", () => {
  it("normalises Vortex's installerChoices into comparable steps", () => {
    const live = liveFomodSelections(
      stateWith({
        options: [
          {
            name: "Patches",
            groups: [
              { name: "Optional", choices: [{ name: "RaceCompatibility" }] },
            ],
          },
        ],
      }),
      "skyrimse",
      "val-serano",
    );
    expect(live).toEqual(picked("RaceCompatibility"));
  });

  it("returns an empty list for a mod with no recorded choices", () => {
    // Not a throw and not undefined: the caller compares it, and NS-8 governs
    // what an empty list is allowed to mean.
    expect(liveFomodSelections(stateWith(undefined), "skyrimse", "val-serano"))
      .toEqual([]);
    expect(liveFomodSelections({}, "skyrimse", "nope")).toEqual([]);
  });
});

describe("the curator narrowing a mod the user already has", () => {
  it("is DETECTED, even though every recorded file verifies", () => {
    // The curator dropped the patch; the user still has it selected.
    const curator = picked("Core");
    const user = picked("Core", "RaceCompatibility");
    expect(compareSelections(curator, user)).toBe("differ");
  });

  it("says nothing when the two agree", () => {
    // The overwhelming majority. A false positive here reinstalls a correct
    // mod on every run, which is worse than the gap it closes.
    expect(compareSelections(picked("Core"), picked("Core"))).toBe("same");
  });

  it("stays silent when either side's answers are unknown (NS-8)", () => {
    // Vortex records nothing both when a user picked nothing AND when the
    // answers were lost. Reinstalling on a guess would install LESS than the
    // user has, silently.
    expect(compareSelections(picked("Core"), [])).toBe("unknown");
    expect(compareSelections([], picked("Core"))).toBe("unknown");
  });
});

describe("the driver acts on it", () => {
  it("routes a stale-options mod to the repair, not to a pass", () => {
    /**
     * The wiring, asserted as a PROPERTY rather than a spelling: the ok-branch
     * must be conditional on the options ALSO matching, or a mod that verifies
     * clean short-circuits before anything looks at its answers — which is
     * exactly how this shipped.
     */
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "runInstall.ts"),
      "utf8",
    ) as string;
    expect(src).toContain("staleInstallerOptions");
    expect(src).toMatch(
      /verifyResult\.kind === "ok" && !staleInstallerOptions/,
    );
    // And the detection has to consult BOTH sides.
    expect(src).toContain("liveFomodSelections(");
    expect(src).toContain("compareSelections(");
  });
});
