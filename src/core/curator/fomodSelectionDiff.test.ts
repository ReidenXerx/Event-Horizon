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
  it("refuses to judge when only ONE side is empty", () => {
    // Vortex records nothing both when a user picked nothing AND when the
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
    expect(compareSelections([{ name: "S" }] as never, pick("A"))).toBe(
      "unknown",
    );
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
