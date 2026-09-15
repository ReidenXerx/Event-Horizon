/**
 * The purge that keeps Vortex's "External Changes" dialog away must run before
 * the mirror writes anything, and only where a deploy follows.
 *
 * ─── WHY THIS IS A TEST AND NOT A COMMENT ───────────────────────────────────
 * Players saw the dialog mid-install (Ivy page, 2026-09-15): the mirror had
 * changed staged files of mods Vortex had already deployed, and "Revert" in
 * that dialog undoes the mirror. Vortex's purge runs the same external-changes
 * check, so a purge moved below the first write asks the same question; and a
 * purge in a path with no deploy after it leaves the game with nothing linked.
 * Neither mistake fails a unit test of the purge itself, and a behavioural test
 * would need the whole driver; this pins the positions that make it right.
 */
import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.join(__dirname, "runInstall.ts"), "utf8");

describe("the purge before mirroring", () => {
  it("has its anchors, so a rename cannot make this test vacuous", () => {
    expect(source).toContain("const mirrorPlan = planMirror({");
    expect(source).toContain("await applyMirrorPlan({");
    expect(source).toContain("await purgeBeforeMirrorWrites();");
    expect(source).toContain("purgeGameDeployment(ctx.api).then(");
    expect(source).toContain("// ── 7. deploy");
  });

  it("runs after the mirror is planned and before anything is written", () => {
    const planned = source.indexOf("const mirrorPlan = planMirror({");
    const purge = source.indexOf("await purgeBeforeMirrorWrites();", planned);
    const applied = source.indexOf("await applyMirrorPlan({", planned);
    expect(planned).toBeGreaterThan(-1);
    expect(purge).toBeGreaterThan(planned);
    expect(purge).toBeLessThan(applied);
  });

  it("is asked for once, by the main mirror phase, which the deploy follows", () => {
    const main = source.indexOf("await mirrorOneMod(mod, { purgeFirst: true });");
    expect(main).toBeGreaterThan(-1);
    expect(source.split("purgeFirst: true").length - 1).toBe(1);
    expect(main).toBeLessThan(source.indexOf("// ── 7. deploy"));
  });

  it("is not asked for by the retry pass, which never redeploys", () => {
    expect(source).toContain("await mirrorOneMod(mod, { purgeFirst: false });");
  });
});
