/**
 * ──────────────────────────────────────────────────────────────────────
 * A SHRINKING DENOMINATOR IS NOT A HEALTH SCORE.
 *
 * The ring's fill was `healthy / graded`, and `graded` dropped every
 * `unknown` — so it got FULLER as the Doctor learned less, and drew a
 * complete 100% on a panel where most checks had not run. That is the common
 * case rather than a corner: `staging` is `unknown` on every visit until the
 * opt-in deep scan, and a receipt from an older Event Horizon adds
 * `plugin-light-flags`, `plugin-order`, `mod-rules`, `userlist` and
 * `userlist-groups` to it — a ten-check panel reading "3/3 passing", full.
 *
 * `overallHealth` was already honest ("Healthy so far — some checks have not
 * run", neutral rather than green). The ring is the largest element on the
 * card, and a full ring is the strongest pass this UI can draw, against a
 * project law that `unknown` must never render as a pass.
 *
 * `not-applicable` is different and stays out of both halves: a check that
 * does not apply to this collection is not a gap in what we know.
 * ──────────────────────────────────────────────────────────────────────
 */
import { describe, expect, it } from "vitest";

import { verdictTally } from "./DoctorPanel";
import type { HealthCheck, HealthStatus } from "../../../core/doctor/health";

const check = (status: HealthStatus): HealthCheck => ({
  id: "staging",
  title: "t",
  status,
  summary: "s",
  detail: [],
  affectedCount: 0,
});

describe("what the verdict ring counts", () => {
  it("does not fill for checks that never ran", () => {
    // The shape that drew a full ring: three passes, seven unknowns.
    const tally = verdictTally([
      ...Array.from({ length: 3 }, () => check("healthy")),
      ...Array.from({ length: 7 }, () => check("unknown")),
    ]);
    expect(tally).toEqual({ of: 10, good: 3, unknown: 7, fill: 0.3 });
  });

  it("fills completely only when everything applicable passed", () => {
    const tally = verdictTally([check("healthy"), check("healthy")]);
    expect(tally.fill).toBe(1);
    expect(tally.unknown).toBe(0);
  });

  it("keeps a failure out of the numerator, as it always did", () => {
    const tally = verdictTally([check("healthy"), check("broken"), check("drifted")]);
    expect(tally).toEqual({ of: 3, good: 1, unknown: 0, fill: 1 / 3 });
  });

  it("leaves `not-applicable` out of both halves", () => {
    /**
     * Not the same as `unknown`. A check that cannot apply to this collection
     * is not something we failed to establish, so counting it would make a
     * complete verdict look partial — the opposite error, and just as wrong.
     */
    const tally = verdictTally([
      check("healthy"),
      check("not-applicable"),
      check("not-applicable"),
    ]);
    expect(tally).toEqual({ of: 1, good: 1, unknown: 0, fill: 1 });
  });

  it("does not divide by zero when nothing applies", () => {
    expect(verdictTally([check("not-applicable")])).toEqual({
      of: 0,
      good: 0,
      unknown: 0,
      fill: 0,
    });
    expect(verdictTally([])).toEqual({ of: 0, good: 0, unknown: 0, fill: 0 });
  });
});
