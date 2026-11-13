import { describe, expect, it } from "vitest";

import { vortexBusy } from "./vortexBusy";

const base = { activity: {}, activityNotices: [], waitingFor: [], lastChangeAt: undefined, now: 100_000 };

describe("vortexBusy", () => {
  it("is settled when nothing runs, nothing waits and nothing changed", () => {
    expect(vortexBusy(base)).toEqual({ settled: true, reasons: [], quietForMs: null, quietMs: 15_000 });
  });

  it("names every running activity, notice and question", () => {
    const b = vortexBusy({
      ...base,
      activity: { mods: ["deployment"], plugins: ["sorting"], idle: [] },
      activityNotices: ["Deploying"],
      waitingFor: ["External Changes"],
    });
    expect(b.settled).toBe(false);
    expect(b.reasons).toEqual(["mods: deployment", "plugins: sorting", "notice: Deploying", "waiting: External Changes"]);
  });

  it("is not settled until quiet long enough after the last change (Fo4-mcp launch race, 11-13)", () => {
    expect(vortexBusy({ ...base, lastChangeAt: 95_000 }).settled).toBe(false);
    const after = vortexBusy({ ...base, lastChangeAt: 80_000 });
    expect(after.settled).toBe(true);
    expect(after.quietForMs).toBe(20_000);
  });
});
