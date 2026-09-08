/**
 * The three ways a mirror could destroy a mod and then certify it as perfect.
 *
 * Mirroring is the only pass in Event Horizon that DELETES files from a mod
 * folder, and `mirrorProvesTarget` is the only thing that decides whether the
 * receipt records the result as a proven reproduction. Every case here is one
 * where the old code deleted, or certified, or both — and reported success.
 *
 * These are deliberately separate from `mirrorStaging.test.ts`, which covers
 * what the planner is FOR. This file covers what it must never do.
 */
import { describe, expect, it } from "vitest";

import { mirrorProvesTarget, planMirror } from "./mirrorStaging";

import type { EhcollStagingFile } from "../../types/ehcoll";

const f = (path: string, sha256?: string): EhcollStagingFile =>
  ({ path, size: 10, ...(sha256 !== undefined ? { sha256 } : {}) }) as EhcollStagingFile;

describe("a file that differs only by letter case is never deleted", () => {
  /**
   * ─── THE BUG ───────────────────────────────────────────────────────────
   * `wanted` is keyed with the caller's `caseMode`. Under `"sensitive"` the
   * curator's `scripts/foo.pex` and this machine's `Scripts/foo.pex` are two
   * different keys, so the SAME PHYSICAL FILE became both a `restore`
   * ("missing") and a `remove` ("extra") — and `applyMirrorPlan` deletes
   * last. It wrote the curator's bytes and then removed them, with an empty
   * failure list, so `mirrorProvesTarget` returned true and the receipt
   * recorded a drift reference for a folder that had just been emptied.
   *
   * The mode CAN be wrong in that direction: the probe falls back to
   * `"sensitive"` whenever it cannot answer, which is the safe guess for a
   * comparison and the unsafe one for a deletion.
   */
  it("does not plan to delete the very file it is restoring", () => {
    const plan = planMirror({
      target: [f("scripts/foo.pex", "aaa")],
      current: [f("Scripts/foo.pex", "bbb")],
      caseMode: "sensitive",
    });

    // It still restores — the bytes on disk really are the wrong ones.
    expect(plan.restore.map((r) => r.path)).toEqual(["scripts/foo.pex"]);
    // But the delete list must not contain the file we are about to write.
    expect(plan.remove).toEqual([]);
  });

  it("still deletes a file that is genuinely extra under the same mode", () => {
    // Without this, the test above would pass against a planner that simply
    // never deletes anything — which is not the fix, it is a different bug.
    const plan = planMirror({
      target: [f("scripts/foo.pex", "aaa")],
      current: [f("scripts/foo.pex", "aaa"), f("scripts/junk.pex", "ccc")],
      caseMode: "sensitive",
    });
    expect(plan.remove).toEqual(["scripts/junk.pex"]);
  });

  it("is unchanged under the insensitive mode, where the filter is a no-op", () => {
    const plan = planMirror({
      target: [f("scripts/foo.pex", "aaa")],
      current: [f("Scripts/foo.pex", "bbb")],
      caseMode: "insensitive",
    });
    // Folded, so it is the same file: a hash mismatch to restore, nothing extra.
    expect(plan.restore.map((r) => r.reason)).toEqual(["different"]);
    expect(plan.remove).toEqual([]);
  });
});

describe("mirrorProvesTarget refuses to certify a run that did not finish", () => {
  const cleanPlan = planMirror({
    target: [f("a.txt", "aaa")],
    current: [f("a.txt", "zzz")],
  });

  it("certifies a plan that completed with no failures", () => {
    expect(mirrorProvesTarget(cleanPlan, { failures: [] })).toBe(true);
  });

  it("refuses an ABORTED run, whose failure list is empty because nothing failed", () => {
    /**
     * The dangerous shape: a stop twelve files into a four-hundred-file mirror
     * returns `{restored: 12, failures: []}`. Nothing went wrong — it simply
     * never happened — and every other condition passes, so the receipt would
     * assert the folder equals the curator's.
     */
    expect(mirrorProvesTarget(cleanPlan, { failures: [], aborted: true })).toBe(
      false,
    );
  });

  it("still refuses on a real failure", () => {
    expect(
      mirrorProvesTarget(cleanPlan, { failures: [{ path: "a", why: "x" }] }),
    ).toBe(false);
  });
});
