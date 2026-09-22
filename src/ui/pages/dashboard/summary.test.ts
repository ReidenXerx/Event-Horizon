/**
 * The dashboard's numbers, and the one rule that matters on a screen this
 * loud: a check that could not run is never counted as a pass.
 *
 * `unknown` is a real `HealthStatus` and it means "this receipt predates the
 * feature, so we cannot say". Folding it into the green figure would turn
 * "not checked" into "fine" in the single largest number in the app.
 */
import { describe, expect, it } from "vitest";

import { collectionFigures, healthRollup, since } from "./summary";
import type { HealthCheck } from "../../../core/doctor/health";
import type { InstallReceipt } from "../../../types/installLedger";

const check = (status: HealthCheck["status"]): HealthCheck =>
  ({ id: "mods", title: "t", status, summary: "s", detail: [], affectedCount: 0 }) as HealthCheck;

describe("the health ring", () => {
  it("counts only what could be judged, and says how much could not", () => {
    const r = healthRollup([check("healthy"), check("healthy"), check("unknown"), check("not-applicable")]);
    expect(r.percent).toBe(100);
    expect(r.judged).toBe(2);
    expect(r.unknown).toBe(1);
    expect(r.caption).toContain("1 not checked");
  });

  it("is undefined — not 0, not 100 — when nothing could be judged", () => {
    const r = healthRollup([check("unknown"), check("unknown")]);
    expect(r.percent).toBeUndefined();
    expect(r.caption).toMatch(/nothing could be checked/);
  });

  it("goes red on a broken check and amber on a drifted one", () => {
    expect(healthRollup([check("healthy"), check("broken")]).tone).toBe("bad");
    expect(healthRollup([check("healthy"), check("drifted")]).tone).toBe("warn");
    expect(healthRollup([check("healthy")]).tone).toBe("good");
  });

  it("rounds without ever showing 100% while something is broken", () => {
    // 199 healthy of 200 rounds to 100 by any ordinary rule; the tone is what
    // stops that reading as "all good", so it must not be green.
    const checks = [...Array.from({ length: 199 }, () => check("healthy")), check("broken")];
    const r = healthRollup(checks);
    expect(r.percent).toBe(100);
    expect(r.tone).toBe("bad");
    expect(r.caption).toContain("1 broken");
  });
});

describe("a collection's figures", () => {
  const receipt = {
    mods: [
      { source: "nexus" }, { source: "nexus" }, { source: "external" },
    ],
    verifications: [
      { kind: "ok", verifiedFileCount: 120 },
      { kind: "ok", verifiedFileCount: 80 },
      { kind: "fail" },
    ],
    failedMods: [{ name: "x" }],
    rulesApplication: {
      appliedRuleCount: 291,
      baselineLightFlagBit: 512,
      baselinePluginOrder: [{ name: "a", enabled: true, light: true }, { name: "b", enabled: true }],
    },
    userlistApplication: { appliedRuleCount: 500 },
    nativePluginSummary: { loads: 236, unverified: 0, cannotLoad: 0, unknown: 0 },
  } as unknown as InstallReceipt;

  it("reads the counts off the receipt", () => {
    const f = collectionFigures(receipt);
    expect(f).toMatchObject({
      mods: 3, fromNexus: 2, supplied: 1, failed: 1,
      verifiedFiles: 200, verifiedMods: 2, unverifiedMods: 1,
      plugins: 2, esl: 1, rules: 291, userlist: 500,
    });
    expect(f.nativePlugins).toEqual({ loads: 236, unverified: 0, cannotLoad: 0, unknown: 0 });
  });

  it("refuses to report ESL flags the package could not record correctly", () => {
    // Without `baselineLightFlagBit` the flags came from a bit that is not the
    // light bit on every game — Doctor will not judge them, and neither will
    // a dashboard that would otherwise print a confident number.
    const { baselineLightFlagBit: _drop, ...rules } = receipt.rulesApplication!;
    const f = collectionFigures({ ...receipt, rulesApplication: rules } as InstallReceipt);
    expect(f.esl).toBeUndefined();
    expect(f.plugins).toBe(2);
  });

  it("says nothing about plugins for a package that shipped none", () => {
    const f = collectionFigures({ ...receipt, rulesApplication: undefined } as InstallReceipt);
    expect(f.plugins).toBeUndefined();
    expect(f.esl).toBeUndefined();
  });
});

describe("relative time", () => {
  const now = Date.parse("2026-09-22T12:00:00Z");
  it("reads the way a person would say it", () => {
    expect(since("2026-09-22T11:59:30Z", now)).toBe("just now");
    expect(since("2026-09-22T09:00:00Z", now)).toBe("3 hours ago");
    expect(since("2026-09-20T12:00:00Z", now)).toBe("2 days ago");
    expect(since("2026-09-01T12:00:00Z", now)).toBe("3 weeks ago");
  });
  it("says nothing rather than something wrong", () => {
    expect(since(undefined, now)).toBeUndefined();
    expect(since("not a date", now)).toBeUndefined();
  });
});
