/**
 * ──────────────────────────────────────────────────────────────────────
 * A FILE THE CURATOR DELETED IS A DIVERGENCE TOO.
 *
 * The post-processing question was only ever asked about files the curator
 * HAS that the archive cannot produce. The opposite — files the archive
 * installs that the curator removed — produced a warning to REINSTALL the
 * mod, which undoes the deletion, and mirroring was never offered. So no
 * tester could receive a deletion, although `planMirror` removes exactly
 * those files whenever a mod is mirrored.
 *
 * Asked rather than decided, by the curator's call: "missing" is also what
 * Vortex's concurrent-install file loss looks like, and mirroring that would
 * delete the file from every user. Only the curator knows which it was.
 * ──────────────────────────────────────────────────────────────────────
 */
import { describe, expect, it } from "vitest";

import { findPostProcessingCandidates } from "./runSelfChecks";
import type { SelfCheckReport } from "./selfCheckMod";
import { describeChoice } from "../../ui/pages/build/postProcessingDecision";

function report(over: Partial<SelfCheckReport> = {}): SelfCheckReport {
  return {
    modId: "mod-1",
    modName: "A Texture Pack",
    depth: "replayed",
    notes: [],
    missing: [],
    unexplained: 0,
    unexplainedExamples: [],
    omissionLeads: [],
    stagedCount: 40,
    expectedCount: 41,
    ...over,
  } as SelfCheckReport;
}

const lead = (path: string, confidence: "high" | "medium") => ({
  path,
  dir: "textures",
  dirTotal: 10,
  dirMissing: 1,
  confidence,
  reason: "9 of 10 files in textures are installed",
});

const none = new Map();

describe("a mod the curator deleted files from", () => {
  it("IS offered, when a replayed FOMOD proves files are missing", () => {
    const [c] = findPostProcessingCandidates(
      [report({ missing: ["textures/ugly.dds"] })],
      none,
    );
    expect(c).toBeDefined();
    expect(c!.needsAnswer).toBe(true);
    expect(c!.removed).toEqual(["textures/ugly.dds"]);
    expect(c!.removedCount).toBe(1);
  });

  it("IS offered for a high-confidence omission lead on a mod with no FOMOD", () => {
    const [c] = findPostProcessingCandidates(
      [report({ depth: "containment", omissionLeads: [lead("textures/b.dds", "high")] })],
      none,
    );
    expect(c?.removed).toEqual(["textures/b.dds"]);
  });

  it("is NOT offered for a medium lead — more likely a file the installer skips", () => {
    expect(
      findPostProcessingCandidates(
        [report({ depth: "containment", omissionLeads: [lead("x.txt", "medium")] })],
        none,
      ),
    ).toEqual([]);
  });

  it("is still NOT offered when nothing diverges either way", () => {
    expect(findPostProcessingCandidates([report()], none)).toEqual([]);
  });
});

describe("answers already given are not disturbed", () => {
  it("keeps an existing answer settled for a mod with nothing removed", () => {
    /**
     * Every answer recorded before this existed was fingerprinted against
     * `unexplainedFingerprint` alone. If the fingerprint changed for mods with
     * no deletions, every one of those answers would reopen at once.
     */
    const [c] = findPostProcessingCandidates(
      [report({ unexplained: 3, unexplainedFingerprint: "fp-1" })],
      new Map([["mod-1", { choice: "declare", fingerprint: "fp-1" }]]) as never,
    );
    expect(c!.fingerprint).toBe("fp-1");
    expect(c!.needsAnswer).toBe(false);
  });

  it("REOPENS an answered mod when a further file goes missing", () => {
    const first = findPostProcessingCandidates(
      [report({ missing: ["a.dds"] })],
      none,
    )[0]!;
    const [again] = findPostProcessingCandidates(
      [report({ missing: ["a.dds", "b.dds"] })],
      new Map([["mod-1", { choice: "mirror", fingerprint: first.fingerprint }]]) as never,
    );
    expect(again!.needsAnswer).toBe(true);
  });

  it("stays settled when the missing set has not changed", () => {
    const first = findPostProcessingCandidates(
      [report({ missing: ["a.dds"] })],
      none,
    )[0]!;
    const [same] = findPostProcessingCandidates(
      [report({ missing: ["a.dds"] })],
      new Map([["mod-1", { choice: "mirror", fingerprint: first.fingerprint }]]) as never,
    );
    expect(same!.needsAnswer).toBe(false);
  });
});

describe("the copy says what each answer does to a deletion", () => {
  it("mirror names the removal and the Vortex-lost-it risk", () => {
    const copy = describeChoice("mirror", 0, undefined, 2);
    expect(copy.label).toMatch(/deletion/i);
    expect(copy.consequence).toMatch(/removes the 2 files/);
    expect(copy.consequence).toMatch(/Vortex lost them/);
    // The old copy, which no longer describes this case.
    expect(copy.consequence).not.toMatch(/0 files/);
  });

  it("declare says users KEEP the files, not that they go without", () => {
    const copy = describeChoice("declare", 0, undefined, 1);
    expect(copy.label).toMatch(/keep/i);
    expect(copy.consequence).not.toMatch(/0 files/);
  });

  it("an addition still gets the addition copy", () => {
    expect(describeChoice("mirror", 3).label).toMatch(/Reproduce my version/);
  });
});
