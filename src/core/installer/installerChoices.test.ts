/**
 * 114 of 954 mods in the curator's real collection carry FOMOD answers that
 * reached nobody: every archive went to Vortex's installer, which asked the
 * USER instead. The manifest then asserted the curator's staged hashes, so the
 * divergence was detected after the fact and could not be prevented.
 *
 * The signature these feed was observed, not guessed — see installerChoices.ts.
 */
import { describe, expect, it } from "vitest";

import { choicesFor, installOptions, replayArgs,
} from "./installerChoices";
import type { EhcollMod } from "../../types/ehcoll";

const entry = (install: Partial<EhcollMod["install"]>): EhcollMod =>
  ({ name: "m", install: { fomodSelections: [], ...install } }) as EhcollMod;

const step = (choiceName: string, idx: number) => ({
  name: "Choose Options",
  groups: [{ name: "Patches", choices: [{ name: choiceName, idx }] }],
});

describe("choicesFor", () => {
  it("hands back the recorded answers with their own type", () => {
    const out = choicesFor(
      entry({
        fomodSelections: [step("AFT Plus Ivy Patch", 2)] as never,
        installerChoicesType: "fomod",
      }),
    );
    expect(out).toEqual({
      type: "fomod",
      options: [step("AFT Plus Ivy Patch", 2)],
    });
  });

  it("assumes fomod only for manifests built before the type was captured", () => {
    // Old packages recorded `options` and dropped `type`. FOMOD is the only
    // Vortex installer that asks questions, so it is the right guess — but it
    // IS a guess, and a new manifest must never reach it.
    const out = choicesFor(entry({ fomodSelections: [step("A", 0)] as never }));
    expect(out!.type).toBe("fomod");
  });

  it("prefers the recorded type over the assumption", () => {
    const out = choicesFor(
      entry({
        fomodSelections: [step("A", 0)] as never,
        installerChoicesType: "something-else",
      }),
    );
    expect(out!.type).toBe("something-else");
  });

  it("returns undefined for a mod with no recorded answers", () => {
    // Load-bearing: undefined makes the caller take the ORIGINAL install path.
    // Replay must not change how the other 840 mods install.
    expect(choicesFor(entry({ fomodSelections: [] }))).toBeUndefined();
  });

  it("REPLAYS steps whose groups hold no chosen option", () => {
    /**
     * ─── THIS TEST USED TO ASSERT THE OPPOSITE ───────────────────────
     * It required `undefined` here, reasoning that sending such a step
     * "asserts a choice the curator never made". That reading was inverted,
     * and a tester found it: FOMOD groups are frequently optional, and
     * ticking nothing then pressing Finish is an ordinary way to install a
     * mod. The empty groups ARE the answer.
     *
     * Discarding it is what claimed something false — the installer then had
     * no answer, ran attended, and asked the player a question the curator
     * had already answered. Six mods on the reference profile do this, and
     * the tester had chosen "install automatically".
     *
     * The line between "no answer" and "answered nothing" is whether any
     * step was recorded at all, which the test above covers.
     */
    const replayed = choicesFor(
      entry({
        fomodSelections: [
          { name: "01. Examples", groups: [{ name: "A. Examples", choices: [] }] },
        ] as never,
      }),
    );
    expect(replayed).toBeDefined();
    expect(replayed?.options).toHaveLength(1);
    expect(replayed?.options[0]?.groups[0]?.choices).toEqual([]);
  });

  it("is undefined-safe for a mod that is not in the manifest", () => {
    expect(choicesFor(undefined)).toBeUndefined();
  });
});

describe("installOptions", () => {
  it("builds the bag Vortex was observed to pass", () => {
    // `unattended` joined the bag deliberately. Vortex's install manager
    // forwards options.unattended straight into the fomod installer, which
    // bypasses the dialog only when choices.type === "fomod" AND
    // unattended === true. This deep-equal is the record of what we send, so
    // it is meant to fail when that changes — which is what it just did.
    const choices = { type: "fomod", options: [] };
    expect(installOptions(choices)).toEqual({
      allowAutoEnable: true,
      choices,
      unattended: true,
    });
  });
});

describe("silent FOMOD replay", () => {
  it("asks Vortex to bypass the dialog by default", () => {
    // Vortex's installer bypasses only when all three hold:
    //   choices !== undefined && choices.type === "fomod" && unattended === true
    // We supply the first two already; this is the third.
    const opts = installOptions({ type: "fomod", options: [] });
    expect(opts.unattended).toBe(true);
    expect(opts.choices.type).toBe("fomod");
  });

  it("can be told to show the dialog instead", () => {
    // Observability is a legitimate preference, so the automation is a
    // parameter rather than a hard-coded truth.
    expect(installOptions({ type: "fomod", options: [] }, false).unattended)
      .toBe(false);
  });

  it("keeps allowAutoEnable, which is a different thing entirely", () => {
    // allowAutoEnable is about enabling the mod in the profile; unattended is
    // about showing a dialog. Conflating them would silently change what gets
    // enabled while trying to change what gets shown.
    const opts = installOptions({ type: "fomod", options: [] }, false);
    expect(opts.allowAutoEnable).toBe(true);
  });
});

describe("the mod that stopped a tester mid-install", () => {
  /**
   * Captured verbatim from the curator's shipped package. The curator went
   * through this installer, ticked nothing in either group, and pressed
   * Finish — so both `choices` arrays are empty, and that IS what they chose.
   *
   * Kept as a fixture rather than a synthetic one because the shape is the
   * whole point: two groups, both empty, inside a step that was definitely
   * observed.
   */
  const IWANT_STATUS_BARS = [
    {
      name: "01. Examples",
      groups: [
        { name: "A. Examples", choices: [] },
        { name: "Z. Legacy Edition", choices: [] },
      ],
    },
  ];

  it("replays instead of asking", () => {
    const choices = choicesFor(
      entry({ fomodSelections: IWANT_STATUS_BARS as never }),
    );
    expect(choices).toBeDefined();
    expect(choices?.type).toBe("fomod");
  });

  it("goes out with unattended set, which is what stops the dialog", () => {
    // choicesFor returning something is only half of it: `replayArgs` sends
    // `unattended` alongside, and without the pair Vortex still asks.
    const args = replayArgs(
      entry({ fomodSelections: IWANT_STATUS_BARS as never }),
      "silent",
    );
    expect(args.choices).toBeDefined();
    expect(args.unattended).toBe(true);
  });

  it("still sends nothing at all for a mod with no recorded installer", () => {
    // The other side of the line, restated here so the pair cannot drift:
    // never observed is not the same as answered nothing.
    expect(replayArgs(entry({ fomodSelections: [] }), "silent")).toEqual({});
  });
});

/**
 * The replay half of `emptySelectionVerified`: a proven "nothing was picked"
 * is an answer like any other, and must reach Vortex as one.
 */
describe("a verified empty selection is replayed, not asked", () => {
  const mod = (install: Record<string, unknown>) =>
    ({ install } as never);

  it("hands Vortex an empty fomod answer when the build proved it", () => {
    /**
     * Vortex runs an installer unattended only when `choices !== undefined`
     * and `choices.type === "fomod"`. It says nothing about the options being
     * non-empty — so an empty list IS a sendable answer, and it is the one
     * that reproduces a curator who ticked nothing.
     */
    expect(
      choicesFor(mod({ fomodSelections: [], emptySelectionVerified: true })),
    ).toEqual({ type: "fomod", options: [] });
  });

  it("still refuses for an empty list the build did NOT prove", () => {
    // The 1,454 mods with no installer at all, and the ones whose answers
    // Vortex lost. Sending an empty answer for those would claim a
    // measurement nobody made — and for the lost-answers case it would
    // install less than the curator has.
    expect(choicesFor(mod({ fomodSelections: [] }))).toBeUndefined();
  });

  it("keeps the recorded installer type when there is one", () => {
    expect(
      choicesFor(
        mod({
          fomodSelections: [],
          emptySelectionVerified: true,
          installerChoicesType: "fomod-v2",
        }),
      ),
    ).toEqual({ type: "fomod-v2", options: [] });
  });
});
