/**
 * A file the curator declared generated for ONE mod (state.volatileFiles) is
 * that mod's alone: the mirror neither restores nor removes it there, and a
 * mod that did not declare it is still mirrored exactly (Meridia, 2026-10-09:
 * four mods ship the same OBody config path, one the curator's tuned copy).
 */
import { describe, expect, it } from "vitest";

import { planMirror } from "./mirrorStaging";
import { declaredSet } from "../volatileFiles";

const SHA = (c: string): string => c.repeat(64);
const OBODY = "SKSE/Plugins/OBody_presetDistributionConfig.json";

describe("the mirror and a declared generated file", () => {
  const target = [{ path: "SKSE/Plugins/GTSoftbody.dll", size: 10, sha256: SHA("a") }];
  const current = [...target, { path: OBODY, size: 391000, sha256: SHA("b") }];

  it("leaves it in place in the mod that declared it", () => {
    const plan = planMirror({ target, current, declaredVolatile: declaredSet([OBODY]) });
    expect(plan.remove).toEqual([]);
    expect(plan.restore).toEqual([]);
  });

  it("still removes the same path from a mod that did not declare it", () => {
    expect(planMirror({ target, current }).remove).toEqual([OBODY]);
  });
});
