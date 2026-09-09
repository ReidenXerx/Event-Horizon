/**
 * The curator re-installed mods through the FOMOD wizard with different
 * options, and the dashboard said:
 *
 *     Your profile still matches the published version — 1755 mod(s),
 *     nothing added, removed, updated or toggled.
 *
 * All four of those axes are about a mod's IDENTITY, and a re-install changes
 * none of them. The contents changed and a rebuild would have shipped the new
 * files under the old version number.
 */
import { describe, expect, it } from "vitest";

import {
  canonicalSelections,
  compareSelections,
  hasChoices,
  selectionEvidence,
} from "./fomodSelectionDiff";

import { diffCollectionAgainstProfile } from "./collectionDiff";

import type { FomodSelectionStep } from "../getModsListForProfile";

const pick = (...choices: string[]): FomodSelectionStep[] => [
  {
    name: "Main",
    groups: [{ name: "Options", choices: choices.map((name) => ({ name })) }],
  },
];

describe("comparing two answer sets", () => {
  it("sees a different choice as a reconfiguration", () => {
    expect(compareSelections(pick("2K"), pick("4K"))).toBe("differ");
  });

  it("sees the same choices as unchanged", () => {
    expect(compareSelections(pick("2K", "ENB"), pick("2K", "ENB"))).toBe("same");
  });

  it("is not fooled by a REORDER", () => {
    /**
     * Vortex emits steps, groups and choices in the installer's own order, and
     * that order is not part of the answer. Reporting a reorder as a
     * reconfiguration would send a curator rebuilding for nothing — and a
     * dashboard that cries wolf is one they stop reading.
     */
    expect(compareSelections(pick("A", "B"), pick("B", "A"))).toBe("same");
  });

  it("tells apart two options that share a display name", () => {
    const a: FomodSelectionStep[] = [
      { name: "S", groups: [{ name: "G", choices: [{ name: "Opt", idx: 0 }] }] },
    ];
    const b: FomodSelectionStep[] = [
      { name: "S", groups: [{ name: "G", choices: [{ name: "Opt", idx: 3 }] }] },
    ];
    expect(compareSelections(a, b)).toBe("differ");
  });

  it("notices a choice ADDED in a second group", () => {
    const before: FomodSelectionStep[] = [
      { name: "S", groups: [{ name: "G1", choices: [{ name: "A" }] }] },
    ];
    const after: FomodSelectionStep[] = [
      {
        name: "S",
        groups: [
          { name: "G1", choices: [{ name: "A" }] },
          { name: "G2", choices: [{ name: "B" }] },
        ],
      },
    ];
    expect(compareSelections(before, after)).toBe("differ");
  });
});

describe("an empty answer set, which is an absence and not a value (NS-8)", () => {
  it("refuses to judge when only ONE side saw no installer", () => {
    // Vortex records nothing both when a mod HAS no installer AND when the
    // answers were lost — creating a variant without "Pre-populate installer
    // options" discards them. Guessing either way invents a finding.
    expect(compareSelections(pick("2K"), [])).toBe("unknown");
    expect(compareSelections([], pick("2K"))).toBe("unknown");
  });

  it("compares confidently when the build PROVED the empty set", () => {
    /**
     * `emptySelectionVerified` means the build replayed the installer with no
     * choices and matched the curator's staging folder. Empty is a value then,
     * so both directions are answerable.
     */
    expect(compareSelections([], [], true)).toBe("same");
    expect(compareSelections([], pick("2K"), true)).toBe("differ");
  });

  it("says 'same' when NEITHER side has answers", () => {
    // Most mods have no FOMOD installer at all. Calling every one of those
    // indeterminate would bury the real ambiguities under sixteen hundred
    // lines of noise, and an unknown nobody can act on is a broken signal.
    expect(compareSelections([], [])).toBe("same");
  });

  it("does not throw on ragged or absent data", () => {
    // It runs in a dashboard over whatever Vortex state holds. A diff that
    // throws tells the curator nothing, which is worse than the gap.
    expect(hasChoices(undefined)).toBe(false);
    expect(canonicalSelections(undefined)).toBe("");
    expect(compareSelections(undefined, undefined)).toBe("same");
    // Ragged input still produces a verdict rather than an exception. WHICH
    // verdict is the subject of the next describe block, not this one.
    expect(["same", "differ", "unknown"]).toContain(
      compareSelections([{ name: "S" }] as never, pick("A")),
    );
  });
});

/**
 * ─── AN OBSERVED INSTALLER WITH NOTHING TICKED IS AN ANSWER ─────────────────
 * The distinction this module got wrong, and the one `installerChoices.ts` had
 * already drawn in the opposite direction:
 *
 *   "Steps PRESENT with every `choices` array empty is a different thing
 *    entirely: the build watched the curator go through the installer and
 *    recorded what they did, which was tick nothing and press Finish. That is
 *    an answer."
 *
 * That module REPLAYS this shape unattended, and names six real mods on the
 * reference profile that carry it — iWant Status Bars, iWant Widgets, Rock
 * Traps Trigger Fixes among them. `hasChoices` returned `false` for the same
 * shape, so the diff called it an absence and answered "unknown", which meant
 * the mods Event Horizon replays MOST confidently were the ones it could never
 * detect drift on.
 *
 * NS-8 is about REPLAY, where an empty set is handed to an installer. Its
 * absence case is "no installer was ever observed" — not "an installer was
 * observed and the curator chose nothing".
 */
describe("steps recorded with no choices ticked", () => {
  /** An installer WAS observed. The curator ticked nothing. */
  const recordedEmpty: FomodSelectionStep[] = [{ name: "S", groups: [] }];

  it("is comparable against a side that DID tick something", () => {
    /**
     * The Val Serano failure, in the one shape where the manifest holds a
     * definite answer. The user re-installs through the wizard and ticks a
     * patch; the archive is unchanged so the compareKey is unchanged;
     * verification passes because every file the curator recorded is present
     * and the user's extra patch is an `extraFile`, informational by design.
     * This comparison is the only signal left, and it used to say "cannot
     * tell".
     */
    expect(compareSelections(recordedEmpty, pick("2K"))).toBe("differ");
    expect(compareSelections(pick("2K"), recordedEmpty)).toBe("differ");
  });

  it("is 'same' against another side that also ticked nothing", () => {
    // Two observations of the same answer, not two absences.
    expect(compareSelections(recordedEmpty, [{ name: "S", groups: [] }])).toBe(
      "same",
    );
  });

  it("is still NOT comparable against a side that saw no installer", () => {
    /**
     * The real NS-8 case survives. An empty `fomodSelections` means the build
     * never observed an installer — which is true of the 1,454 mods in a real
     * collection that simply have no FOMOD, and FALSE for the handful whose
     * answers Vortex discarded. Those two are indistinguishable and mean
     * opposite things, so this stays "unknown".
     */
    expect(compareSelections(recordedEmpty, [])).toBe("unknown");
    expect(compareSelections([], recordedEmpty)).toBe("unknown");
  });

  it("reads as a recorded answer, not as an absence", () => {
    // The predicate itself, stated directly — this is what the two consumers
    // were disagreeing about.
    expect(selectionEvidence(recordedEmpty)).toBe("recorded-empty");
    expect(selectionEvidence([])).toBe("absent");
    expect(selectionEvidence(undefined)).toBe("absent");
    expect(selectionEvidence(pick("2K"))).toBe("has-choices");
  });
});

describe("the whole diff, end to end", () => {
  const built = (fomodSelections: FomodSelectionStep[]) => [
    {
      compareKey: "nexus:100:200",
      name: "Skyland",
      version: "1.0",
      enabled: true,
      fomodSelections,
    },
  ];
  const live = (fomodSelections: FomodSelectionStep[]) =>
    [
      {
        id: "m1",
        name: "Skyland",
        version: "1.0",
        enabled: true,
        nexusModId: 100,
        nexusFileId: 200,
        fomodSelections,
      },
    ] as never;

  it("reports a re-install with different options as a change", () => {
    const diff = diffCollectionAgainstProfile({
      built: built(pick("2K")),
      current: live(pick("4K")),
    });
    // Every identity axis agrees — that is exactly why this was invisible.
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.updated).toEqual([]);
    expect(diff.toggled).toEqual([]);
    // And the fifth axis catches it.
    expect(diff.reconfigured.map((r) => r.name)).toEqual(["Skyland"]);
    expect(diff.unchanged).toBe(0);
  });

  it("still reports an untouched mod as unchanged", () => {
    const diff = diffCollectionAgainstProfile({
      built: built(pick("2K")),
      current: live(pick("2K")),
    });
    expect(diff.reconfigured).toEqual([]);
    expect(diff.unchanged).toBe(1);
  });

  it("counts a mod that is BOTH toggled and re-configured only once", () => {
    // The old branch was if/else, so a toggle hid a reconfiguration entirely.
    const diff = diffCollectionAgainstProfile({
      built: built(pick("2K")),
      current: [
        {
          id: "m1",
          name: "Skyland",
          version: "1.0",
          enabled: false,
          nexusModId: 100,
          nexusFileId: 200,
          fomodSelections: pick("4K"),
        },
      ] as never,
    });
    expect(diff.toggled.map((t) => t.name)).toEqual(["Skyland"]);
    expect(diff.reconfigured.map((r) => r.name)).toEqual(["Skyland"]);
    expect(diff.unchanged).toBe(0);
  });

  it("counts an unanswerable comparison rather than calling it a match", () => {
    const diff = diffCollectionAgainstProfile({
      built: built(pick("2K")),
      current: live([]),
    });
    expect(diff.reconfigured).toEqual([]);
    expect(diff.selectionsUnknown).toBe(1);
    // It is still "unchanged" for counting purposes — but the summary line
    // has to say the answer was incomplete. See collectionDiff's describer.
    expect(diff.unchanged).toBe(1);
  });
});
