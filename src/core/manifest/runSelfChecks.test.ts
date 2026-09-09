/**
 * Which mods the build ASKS the curator about.
 *
 * The screenshot that produced this file said "All 9 answered" while two mods
 * that badly needed an answer were not on the list at all — so the curator
 * answered everything they were shown and still shipped two mods nobody could
 * reproduce.
 */
import { describe, expect, it } from "vitest";

import { findPostProcessingCandidates } from "./runSelfChecks";


describe("a mod whose archive cannot be read", () => {
  /**
   * Two mods reached testers as "could not be reproduced" and the curator was
   * certain they had answered the mirror question for them. They had not —
   * because they had never been ASKED.
   *
   * `unexplained` is produced by comparing staging against the ARCHIVE. When
   * the archive cannot be listed — never kept, purged, unreadable — the
   * self-check returns `depth: "skipped"` with nothing counted, the candidate
   * filter scored the mod zero, and it never appeared on the list.
   *
   * Exactly backwards: a mod whose archive is gone is the one that MOST needs
   * mirroring, because there is no archive for anyone else to reproduce it
   * from.
   */
  const skipped = (over: Record<string, unknown> = {}) =>
    ({
      modId: "porcTattoos_2c",
      modName: "porcTattoos_2c",
      depth: "skipped",
      notes: ["Could not list archive: ENOENT"],
      missing: [],
      unexplained: 0,
      unexplainedExamples: [],
      stagedCount: 6,
      ...over,
    }) as never;

  it("is offered even though nothing could be counted", () => {
    const out = findPostProcessingCandidates([skipped()], new Map());
    expect(out).toHaveLength(1);
    expect(out[0]?.modId).toBe("porcTattoos_2c");
    expect(out[0]?.archiveUnavailable).toBe(true);
    // No invented evidence: nothing was compared, so the count stays 0.
    expect(out[0]?.unexplained).toBe(0);
    expect(out[0]?.needsAnswer).toBe(true);
  });

  it("outranks a mod that merely has unexplained files", () => {
    // One ships something wrong; the other cannot be reproduced at all.
    const out = findPostProcessingCandidates(
      [
        {
          modId: "other",
          modName: "Other",
          depth: "containment",
          notes: [],
          missing: [],
          unexplained: 99,
          unexplainedExamples: [],
          stagedCount: 200,
        } as never,
        skipped(),
      ],
      new Map(),
    );
    expect(out[0]?.modId).toBe("porcTattoos_2c");
  });

  it("is NOT offered when the mod stages nothing", () => {
    // A mod with no staged files has nothing to mirror, so asking about it
    // would be a question with no useful answer.
    expect(
      findPostProcessingCandidates([skipped({ stagedCount: 0 })], new Map()),
    ).toEqual([]);
  });

  it("still leaves a checked-and-clean mod off the list", () => {
    // The whole point of `archiveUnavailable` being separate from
    // `unexplained: 0`: one means "could not check", the other means
    // "checked, all accounted for". Only the first is a question.
    expect(
      findPostProcessingCandidates(
        [
          {
            modId: "clean",
            modName: "Clean",
            depth: "containment",
            notes: [],
            missing: [],
            unexplained: 0,
            unexplainedExamples: [],
            stagedCount: 40,
          } as never,
        ],
        new Map(),
      ),
    ).toEqual([]);
  });
});
