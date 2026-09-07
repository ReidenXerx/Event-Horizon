/**
 * ──────────────────────────────────────────────────────────────────────
 * A mod whose ENTIRE staging the archive cannot produce.
 *
 * Found on a real 1,755-mod collection, by a tester rather than by us. One
 * mod staged a single 74-byte `placeholder_*.txt` and nothing else. Its Nexus
 * archive is a FOMOD, and no installer choices had been recorded for it — so
 * reproducing it meant a dialog the user could not answer. Answering it the
 * way the curator had, by selecting nothing, made Vortex fail with ENOENT,
 * because a FOMOD install that selects nothing creates no folder.
 *
 * The system had already asked about this mod and the curator had answered
 * "declare", which was RIGHT for the question posed: they are no worse off
 * without a placeholder. The gap is that "declare" settles what verification
 * should do and says nothing about whether the mod is worth installing at all.
 *
 * So the shape gets its own name. No size threshold and no filename pattern —
 * "every staged file is unexplained" is the honest statement of it, and it is
 * what separates this mod from the four other declared mods in the same
 * collection, which ship 12-24 MB each.
 * ──────────────────────────────────────────────────────────────────────
 */
import { describe, expect, it } from "vitest";

import {
  findModsThatPromptTheUser,
  findPostProcessingCandidates,
} from "./runSelfChecks";
import type { SelfCheckReport } from "./selfCheckMod";

function report(over: Partial<SelfCheckReport> = {}): SelfCheckReport {
  return {
    modId: "mod-1",
    modName: "BeastHHBB - Patches and Addons",
    depth: "replayed",
    notes: [],
    missing: [],
    unexplained: 1,
    unexplainedExamples: [],
    omissionLeads: [],
    stagedCount: 1,
    expectedCount: 1,
    ...over,
  } as SelfCheckReport;
}

const only = (r: SelfCheckReport) => findPostProcessingCandidates([r], new Map())[0]!;

describe("shipsNothing", () => {
  it("flags a mod whose every staged file is unexplained", () => {
    expect(only(report()).shipsNothing).toBe(true);
  });

  it("does NOT flag a mod that also ships content the archive explains", () => {
    // The other four declared mods in that collection: a couple of diverged
    // files apiece, and 12-24 MB of real content around them. Flagging those
    // would make the warning meaningless.
    expect(only(report({ unexplained: 2, stagedCount: 4 })).shipsNothing).toBe(
      false,
    );
  });

  it("does not flag a mod that stages nothing at all", () => {
    /**
     * A different, harmless shape: nothing staged means nothing diverged, and
     * `0 >= 0` would otherwise report every one of them. It also cannot be the
     * bug this exists for — there is no install to get wrong.
     */
    expect(
      only(report({ unexplained: 0, stagedCount: 0, unexplainedExamples: [] })),
    ).toBeUndefined();
  });

  it("still flags when more files are unexplained than staged", () => {
    // Defensive: the two counts come from different passes, and a mod that
    // ships nothing must not slip through on an off-by-one.
    expect(
      only(report({ unexplained: 3, stagedCount: 2 })).shipsNothing,
    ).toBe(true);
  });

  it("is independent of whether the curator already answered", () => {
    // "Declare" answers verification, not whether the mod is worth shipping —
    // which is the whole point. The flag must survive being answered, or it
    // disappears exactly when the curator has convinced themselves it is fine.
    const answered = findPostProcessingCandidates(
      [report()],
      new Map([["mod-1", { choice: "declare", fingerprint: undefined } as never]]),
    )[0]!;
    expect(answered.shipsNothing).toBe(true);
  });
});

/**
 * ──────────────────────────────────────────────────────────────────────
 * The other half: mods that will ask the USER a question.
 *
 * A FOMOD archive plus no recorded choices means the installer runs on the
 * user's machine with nobody able to answer it correctly. It is a different
 * population from the post-processing question — that one is about files the
 * archive cannot produce, and these two barely overlap.
 *
 * The mod that broke a real tester's install was in BOTH, which is why it went
 * unnoticed: the curator was asked the post-processing question, answered it
 * correctly, and nothing ever mentioned that the mod would still stop a
 * stranger's install dead.
 * ──────────────────────────────────────────────────────────────────────
 */
describe("findModsThatPromptTheUser", () => {
  const prompting = (over: Partial<SelfCheckReport> = {}): SelfCheckReport =>
    report({ promptsUser: true, ...over });

  it("lists a mod whose archive branches and whose answers were never recorded", () => {
    expect(
      findModsThatPromptTheUser([prompting({ modId: "a", stagedCount: 160, unexplained: 0 })]),
    ).toEqual([
      { modId: "a", modName: "BeastHHBB - Patches and Addons", stagedCount: 160, shipsNothing: false },
    ]);
  });

  it("ignores a mod whose choices WERE recorded", () => {
    // The 301 mods on the reference collection that replay cleanly. Listing
    // those would bury the three that matter.
    expect(findModsThatPromptTheUser([report({ promptsUser: undefined })])).toEqual([]);
  });

  it("puts the unanswerable ones first", () => {
    /**
     * A mod that prompts AND ships nothing obtainable cannot be fixed by the
     * user answering carefully — no combination of choices reproduces the
     * curator's folder. A curator scanning this list needs those at the top.
     */
    const out = findModsThatPromptTheUser([
      prompting({ modId: "big", stagedCount: 160, unexplained: 0 }),
      prompting({ modId: "empty", stagedCount: 1, unexplained: 1 }),
    ]);
    expect(out.map((m) => m.modId)).toEqual(["empty", "big"]);
  });

  it("orders the rest by how much of the build is at stake", () => {
    const out = findModsThatPromptTheUser([
      prompting({ modId: "small", stagedCount: 5, unexplained: 0 }),
      prompting({ modId: "large", stagedCount: 160, unexplained: 0 }),
    ]);
    expect(out.map((m) => m.modId)).toEqual(["large", "small"]);
  });
});
