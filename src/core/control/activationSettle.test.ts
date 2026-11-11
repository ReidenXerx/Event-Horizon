import { describe, expect, it } from "vitest";

import { ACTIVATION_SETTLE_MS, settleWaitMs } from "./activationSettle";

describe("settleWaitMs", () => {
  it("waits out the rest of the window after a recent activation (SMIM, 11-11: install 6 s after the switch)", () => {
    expect(settleWaitMs(1_006_000, 1_000_000)).toBe(ACTIVATION_SETTLE_MS - 6_000);
  });
  it("does not wait when no activation was seen or the window has passed", () => {
    expect(settleWaitMs(1_000_000, 0)).toBe(0);
    expect(settleWaitMs(1_000_000 + ACTIVATION_SETTLE_MS + 1, 1_000_000)).toBe(0);
  });
});
