/**
 * ──────────────────────────────────────────────────────────────────────
 * "It prompts me about the same mods every build."
 *
 * It did, and only for two of the three buttons. `postProcessed` closed the
 * question; `mirrored` and `bundled` wrote a config entry, said "saved", and
 * came back next build — the answer stuck everywhere except in the one place
 * that decides whether to ask.
 *
 * The other half is the opposite risk: an answer that never expires. "These
 * files are mine, users don't need them" is a statement about the files that
 * were there. Drop a patch into the same folder afterwards and the old answer
 * withholds it silently, with nothing to see in any report. So an answer is
 * recorded against a fingerprint of what it was about, and the question
 * reopens exactly when that moves.
 * ──────────────────────────────────────────────────────────────────────
 */
import { describe, expect, it } from "vitest";

import {
  choiceFromEntry,
  decidedPostProcessing,
  modsNewlyBundled,
  modsNoLongerBundled,
} from "./collectionConfig";
import { findPostProcessingCandidates } from "./runSelfChecks";
import { fingerprintUnexplained } from "./unexplainedFiles";
import type { CollectionConfig } from "./collectionConfig";
import type { SelfCheckReport } from "./selfCheckMod";

const config = (
  externalMods: CollectionConfig["externalMods"],
): CollectionConfig => ({ externalMods }) as CollectionConfig;

const report = (
  modId: string,
  over: Partial<SelfCheckReport> = {},
): SelfCheckReport =>
  ({
    modId,
    modName: modId,
    depth: "compared",
    notes: [],
    missing: [],
    unexplained: 3,
    unexplainedExamples: [],
    omissionLeads: [],
    stagedCount: 10,
    expectedCount: 10,
    unexplainedFingerprint: "fp-original",
    ...over,
  }) as SelfCheckReport;

describe("which answers count as answers", () => {
  it("counts all three buttons, not just declare", () => {
    // The bug, stated. Only `postProcessed` used to reach this.
    const decided = decidedPostProcessing(
      config({
        declared: { postProcessed: true },
        mirroredMod: { mirrored: true },
        bundledMod: { bundled: true },
      }),
    );
    expect([...decided.keys()].sort()).toEqual([
      "bundledMod",
      "declared",
      "mirroredMod",
    ]);
  });

  it("ignores an entry that carries no decision", () => {
    // A URL or instructions typed on the build form are not an answer to
    // "what happens to your diverged files".
    const decided = decidedPostProcessing(
      config({ justAUrl: { url: "https://example.invalid" } }),
    );
    expect(decided.size).toBe(0);
  });

  it("carries the fingerprint the answer was given against", () => {
    const decided = decidedPostProcessing(
      config({ m: { mirrored: true, postProcessingDecidedFor: "fp-original" } }),
    );
    expect(decided.get("m")).toEqual({
      choice: "mirror",
      fingerprint: "fp-original",
    });
  });
});

describe("whether the question comes back", () => {
  it("stops ASKING about a mirrored mod whose files have not changed", () => {
    // The exact case the curator hit: every card answered "Reproduce my
    // version", every card asked again on the next build.
    const decided = decidedPostProcessing(
      config({ m: { mirrored: true, postProcessingDecidedFor: "fp-original" } }),
    );
    const [found] = findPostProcessingCandidates([report("m")], decided);
    expect(found!.needsAnswer).toBe(false);
    expect(found!.reopened).toBe(false);
  });

  it("still SHOWS it, with the verdict, so it can be reviewed", () => {
    // Settled mods used to vanish from the list, which made a verdict given
    // once unreachable for ever — there was no screen anywhere that could
    // tell you what you had decided, let alone change it.
    const decided = decidedPostProcessing(
      config({ m: { mirrored: true, postProcessingDecidedFor: "fp-original" } }),
    );
    const [found] = findPostProcessingCandidates([report("m")], decided);
    expect(found!.decision).toBe("mirror");
  });

  it("stops asking about a bundled mod too, and says so", () => {
    const decided = decidedPostProcessing(
      config({ m: { bundled: true, postProcessingDecidedFor: "fp-original" } }),
    );
    const [found] = findPostProcessingCandidates([report("m")], decided);
    expect(found!.needsAnswer).toBe(false);
    expect(found!.decision).toBe("bundle");
  });

  it("puts what still needs an answer first", () => {
    // A settled mod is on the list to be reviewed, not to be waded through.
    const decided = decidedPostProcessing(
      config({ settled: { mirrored: true } }),
    );
    const found = findPostProcessingCandidates(
      [report("settled", { unexplained: 900 }), report("open", { unexplained: 2 })],
      decided,
    );
    expect(found.map((c) => c.modId)).toEqual(["open", "settled"]);
  });

  it("REOPENS when the diverged files have changed since", () => {
    // A file added to the same folder after the answer. Reapplying "users
    // don't need them" here would withhold it with nothing to see.
    const decided = decidedPostProcessing(
      config({ m: { postProcessed: true, postProcessingDecidedFor: "fp-original" } }),
    );
    const found = findPostProcessingCandidates(
      [report("m", { unexplainedFingerprint: "fp-something-else" })],
      decided,
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.reopened).toBe(true);
  });

  it("marks a first-time question as NOT a re-ask", () => {
    const found = findPostProcessingCandidates([report("m")], new Map());
    expect(found).toHaveLength(1);
    expect(found[0]!.reopened).toBe(false);
  });

  it("honours an answer written before fingerprints existed", () => {
    // Upgrading must not re-open every decision the curator ever made. An
    // answer with nothing recorded about it simply never expires.
    const decided = decidedPostProcessing(config({ m: { mirrored: true } }));
    const [found] = findPostProcessingCandidates([report("m")], decided);
    expect(found!.needsAnswer).toBe(false);
  });

  it("honours an answer when the report cannot produce a fingerprint", () => {
    const decided = decidedPostProcessing(
      config({ m: { mirrored: true, postProcessingDecidedFor: "fp-original" } }),
    );
    const noFp = report("m", {});
    delete (noFp as { unexplainedFingerprint?: string }).unexplainedFingerprint;
    expect(findPostProcessingCandidates([noFp], decided)[0]!.needsAnswer).toBe(
      false,
    );
  });

  it("hands the current fingerprint to the UI, so the answer records it", () => {
    const [candidate] = findPostProcessingCandidates([report("m")], new Map());
    expect(candidate!.fingerprint).toBe("fp-original");
  });

  it("says nothing about a mod with no diverged files at all", () => {
    expect(
      findPostProcessingCandidates([report("m", { unexplained: 0 })], new Map()),
    ).toEqual([]);
  });
});

describe("the fingerprint itself", () => {
  const files = [
    { path: "b.esp", sha256: "bbb" },
    { path: "a/x.nif", sha256: "aaa" },
  ];

  it("does not change when the files come back in another order", () => {
    // The walk's order is an implementation detail. Reporting it as a change
    // would reopen every question on every build.
    expect(fingerprintUnexplained(files)).toBe(
      fingerprintUnexplained([...files].reverse()),
    );
  });

  it("changes when a file is added", () => {
    expect(
      fingerprintUnexplained([...files, { path: "c.esp", sha256: "ccc" }]),
    ).not.toBe(fingerprintUnexplained(files));
  });

  it("changes when a file's CONTENT changes under the same path", () => {
    // The case a path list cannot see, and the one that matters most: an
    // edit in place to a file the curator already answered about.
    const edited = [{ path: "b.esp", sha256: "different" }, files[1]!];
    expect(fingerprintUnexplained(edited)).not.toBe(
      fingerprintUnexplained(files),
    );
  });

  it("falls back to size when a file has no hash", () => {
    expect(fingerprintUnexplained([{ path: "a", size: 1 }])).not.toBe(
      fingerprintUnexplained([{ path: "a", size: 2 }]),
    );
  });

  it("is empty-stable", () => {
    expect(fingerprintUnexplained([])).toBe(fingerprintUnexplained([]));
  });
});


describe("an answer given while the build is paused", () => {
  // Bundling runs BEFORE the self-check, because a bundled mod's archive IS
  // its staging and comparing them is meaningless. So "ship my copy" —
  // the right answer for LOD output — arrives after its own repack has
  // already gone by, and needs a second pass to land in this build.
  it("names a mod that just gained the bundle flag", () => {
    expect(
      modsNewlyBundled(
        config({ lods: { postProcessed: true } }),
        config({ lods: { bundled: true } }),
      ),
    ).toEqual(["lods"]);
  });

  it("names a mod that had no entry at all before", () => {
    expect(modsNewlyBundled(config({}), config({ lods: { bundled: true } }))).toEqual([
      "lods",
    ]);
  });

  it("does NOT re-pack a mod that was already bundled", () => {
    // It was packed on the first pass. Repacking it would be minutes of
    // 7z for a file that already exists.
    expect(
      modsNewlyBundled(
        config({ m: { bundled: true } }),
        config({ m: { bundled: true } }),
      ),
    ).toEqual([]);
  });

  it("ignores answers that need no repack", () => {
    // `mirrored` and `postProcessed` are consumed after this point, so they
    // land in the same build with no extra work.
    expect(
      modsNewlyBundled(
        config({}),
        config({ a: { mirrored: true }, b: { postProcessed: true } }),
      ),
    ).toEqual([]);
  });

  it("returns them in a stable order", () => {
    expect(
      modsNewlyBundled(
        config({}),
        config({ zeta: { bundled: true }, alpha: { bundled: true } }),
      ),
    ).toEqual(["alpha", "zeta"]);
  });

  it("survives a config with no external mods at all", () => {
    expect(modsNewlyBundled({} as never, {} as never)).toEqual([]);
  });
});


describe("which of the three an entry is carrying", () => {
  it("reads each flag back as the button that wrote it", () => {
    expect(choiceFromEntry({ mirrored: true })).toBe("mirror");
    expect(choiceFromEntry({ postProcessed: true })).toBe("declare");
    expect(choiceFromEntry({ bundled: true })).toBe("bundle");
    expect(choiceFromEntry({})).toBeUndefined();
    expect(choiceFromEntry(undefined)).toBeUndefined();
  });

  it("shows the verdict the BUILD will act on when flags overlap", () => {
    // The flags are not exclusive — the build form can set `bundled` on its
    // own. Bundling ships the staging folder verbatim, which makes both the
    // others moot, and mirroring reconciles the files, which makes
    // `postProcessed` moot. So the shown verdict matches the outcome.
    expect(choiceFromEntry({ bundled: true, mirrored: true })).toBe("bundle");
    expect(choiceFromEntry({ mirrored: true, postProcessed: true })).toBe(
      "mirror",
    );
  });
});

describe("a verdict changed while the build is paused", () => {
  it("names a mod that stopped being bundled", () => {
    // Only reachable now that a verdict can be changed mid-build. It was
    // repacked on the first pass; shipping that archive would put a bundle
    // in the package for a mod no longer meant to have one.
    expect(
      modsNoLongerBundled(
        config({ m: { bundled: true } }),
        config({ m: { mirrored: true } }),
      ),
    ).toEqual(["m"]);
  });

  it("says nothing when the bundle stands", () => {
    expect(
      modsNoLongerBundled(
        config({ m: { bundled: true } }),
        config({ m: { bundled: true } }),
      ),
    ).toEqual([]);
  });

  it("says nothing about a mod that was never bundled", () => {
    expect(
      modsNoLongerBundled(config({ m: {} }), config({ m: { declared: true } as never })),
    ).toEqual([]);
  });
});

/**
 * ──────────────────────────────────────────────────────────────────────
 * An answer given while blind is not the same as an answer given long ago.
 *
 * A mod whose archive cannot be read at all scores `unexplained: 0` and
 * produces no fingerprint, because nothing was compared. Those mods became
 * candidates because an archive that is gone is precisely the case a plain
 * install cannot reproduce — but their answers are then given about NO
 * evidence, and `isSettled` treated a missing fingerprint as "answered before
 * fingerprints existed" and honoured it for ever.
 *
 * Both directions across that boundary went silent, and both matter:
 * "declare" withholds bytes from every user (NS-7), and a lost archive means
 * nobody can rebuild the mod from one.
 * ──────────────────────────────────────────────────────────────────────
 */
describe("answers about an archive nobody could read", () => {
  /** What `selfCheckMod` returns when the archive cannot be listed. */
  const blind = (modId: string): SelfCheckReport =>
    report(modId, {
      depth: "skipped",
      unexplained: 0,
      // The whole point: nothing was compared, so there is nothing to hash.
      unexplainedFingerprint: undefined,
    });

  it("re-asks once the archive becomes readable again", () => {
    /**
     * The curator answers "declare" while the download is purged. Next month
     * they re-download it, the check runs, and it finds real unexplained
     * files with a real fingerprint. The standing answer was given against
     * none of that, so it must not decide what ships.
     */
    const answered = findPostProcessingCandidates(
      [blind("m1")],
      new Map([["m1", { choice: "declare" as const, fingerprint: "archive-unavailable" }]]),
    );
    expect(answered[0]?.needsAnswer).toBe(false);

    // Same mod, archive now readable and 1,608 files unaccounted for.
    const readable = findPostProcessingCandidates(
      [report("m1", { unexplained: 1608, unexplainedFingerprint: "fp-real" })],
      new Map([["m1", { choice: "declare" as const, fingerprint: "archive-unavailable" }]]),
    );
    expect(readable[0]?.needsAnswer).toBe(true);
    expect(readable[0]?.reopened).toBe(true);
  });

  it("re-asks when a mod that WAS answered loses its archive", () => {
    /**
     * The other direction. The answer was given about files the archive could
     * produce; now nobody can produce any of them, which is a different
     * question rather than the same one with less evidence.
     */
    const candidates = findPostProcessingCandidates(
      [blind("m1")],
      new Map([["m1", { choice: "declare" as const, fingerprint: "fp-original" }]]),
    );
    expect(candidates[0]?.needsAnswer).toBe(true);
  });

  it("records the sentinel so the answer knows what it was about", () => {
    // Without this the answer is written with NO fingerprint, and a missing
    // fingerprint already means something else.
    const candidates = findPostProcessingCandidates(
      [blind("m1")],
      new Map(),
    );
    expect(candidates[0]?.fingerprint).toBe("archive-unavailable");
  });

  it("still honours a legacy answer that predates fingerprints", () => {
    // The `undefined` branch is right for the case it was written for, and
    // this proves the fix did not take it away.
    const candidates = findPostProcessingCandidates(
      [report("m1")],
      new Map([["m1", { choice: "declare" as const, fingerprint: undefined }]]),
    );
    expect(candidates[0]?.needsAnswer).toBe(false);
  });
});

/**
 * ──────────────────────────────────────────────────────────────────────
 * An answer you cannot reach is an answer you cannot change.
 *
 * A mod answered "mirror" whose `unexplained` later drops to zero — the
 * curator reinstalled it cleanly — disappeared from this list while
 * `mirrored: true` stayed in the config. If one of its staged files then
 * could not be hashed, `packageZip` refused the ENTIRE build with "change
 * this mod's answer", after every expensive phase, about a mod the only
 * screen that can change that answer would not show.
 * ──────────────────────────────────────────────────────────────────────
 */
describe("a mod that is already answered", () => {
  it("stays on the list even when nothing is unexplained any more", () => {
    const clean = report("m1", {
      unexplained: 0,
      unexplainedFingerprint: undefined,
    });
    const candidates = findPostProcessingCandidates(
      [clean],
      new Map([["m1", { choice: "mirror" as const, fingerprint: undefined }]]),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.decision).toBe("mirror");
    // Settled, so it does not gate the build — it is there to be reviewed.
    expect(candidates[0]?.needsAnswer).toBe(false);
  });

  it("still leaves an UNANSWERED clean mod off the list", () => {
    // The filter must not become "show everything". A mod with nothing
    // unexplained and no standing answer has no question to ask.
    const candidates = findPostProcessingCandidates(
      [report("m1", { unexplained: 0, unexplainedFingerprint: undefined })],
      new Map(),
    );
    expect(candidates).toHaveLength(0);
  });
});
