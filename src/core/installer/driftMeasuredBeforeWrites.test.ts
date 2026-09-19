/**
 * ──────────────────────────────────────────────────────────────────────
 * Drift must be MEASURED before anything in the run can erase it.
 *
 * It used to be measured at the very end, one step before the receipt, on
 * this reasoning: "these mods are resolved as already-installed and are
 * therefore NOT touched by this run: the drift survives it."
 *
 * The premise is false for exactly the mods drift detection is about. Three
 * passes rewrite an already-installed mod's folder — the MIRROR restores the
 * curator's file set over whatever the player changed, the REPAIR uninstalls
 * and reinstalls a mod that failed verification, and phase 4 removes mods
 * outright — and all three are gated on `ownedByUs`, which is seeded from the
 * PREVIOUS RECEIPT precisely so revision N's mods count as ours.
 *
 * So it hashed a folder the mirror had already corrected and reported
 * nothing, while `describeStagingDrift` exists to say "reinstall or keep,
 * Event Horizon has changed nothing".
 *
 * A source-order test because that is exactly what broke: not a wrong
 * computation, a right one at the wrong point in a 7,600-line pipeline.
 * ──────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const src = (): string =>
  readFileSync(new URL("./runInstall.ts", import.meta.url), "utf8");

describe("drift is measured before the passes that rewrite a folder", () => {
  it("measures before phase 4, the mirror and the repair", () => {
    const body = src();
    const measured = body.indexOf("const driftNoticeEarly = await detectDrift(");
    expect(measured, "the early measurement must exist").toBeGreaterThan(-1);

    const removals = body.indexOf("// ── 4. remove replaced");
    const mirror = body.indexOf("applyMirrorPlan({");
    expect(removals).toBeGreaterThan(-1);
    expect(mirror).toBeGreaterThan(-1);

    expect(measured).toBeLessThan(removals);
    expect(measured).toBeLessThan(mirror);
  });

  it("measures exactly once, and reports the value it measured", () => {
    const body = src();
    // Two calls would mean the late one silently wins again.
    const calls = body.split("await detectDrift(").length - 1;
    expect(calls).toBe(1);
    expect(body).toContain("const driftNotice = driftNoticeEarly;");
  });
});
