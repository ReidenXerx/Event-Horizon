import { describe, expect, it } from "vitest";

import { enabledTimeOf, formatEnabledTime } from "./enabledTime";

describe("enabled time", () => {
  it("treats Vortex's 0 and anything that is not a timestamp as never recorded", () => {
    expect(enabledTimeOf(0)).toBeUndefined();
    expect(enabledTimeOf(-5)).toBeUndefined();
    expect(enabledTimeOf("1789235398091")).toBeUndefined();
    expect(enabledTimeOf(Number.NaN)).toBeUndefined();
    expect(enabledTimeOf(1789235398091)).toBe(1789235398091);
  });

  it("reads as a local date and minute", () => {
    const ts = new Date(2026, 8, 12, 9, 5).getTime();
    expect(formatEnabledTime(ts)).toBe("2026-09-12 09:05");
    expect(formatEnabledTime(undefined)).toBe("");
    expect(formatEnabledTime(0)).toBe("");
  });
});
