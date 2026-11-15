import { describe, expect, it, vi } from "vitest";

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

describe("a switch verb starts the window itself (Meridia slot B, 11-15)", () => {
  // Vortex's gamemode-activated came ~3 s after profile.switch returned; the
  // OPubes install sent in between saw no activation and did not wait.
  it("an install right after the switch waits, before Vortex's event arrives", async () => {
    const { noteGameActivation, _setLastActivationForTest, waitForActivationToSettle } = await import("./activationSettle");
    vi.useFakeTimers();
    try {
      _setLastActivationForTest(0);
      noteGameActivation(Date.now());
      let done = false;
      const p = waitForActivationToSettle("install").then((ms) => {
        done = true;
        return ms;
      });
      await vi.advanceTimersByTimeAsync(ACTIVATION_SETTLE_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await p).toBe(ACTIVATION_SETTLE_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a later activation event extends a wait already running", async () => {
    const { noteGameActivation, _setLastActivationForTest, waitForActivationToSettle } = await import("./activationSettle");
    vi.useFakeTimers();
    try {
      _setLastActivationForTest(0);
      const t0 = Date.now();
      noteGameActivation(t0);
      const p = waitForActivationToSettle("install");
      await vi.advanceTimersByTimeAsync(3_000);
      _setLastActivationForTest(t0 + 3_000); // gamemode-activated, 3 s late
      await vi.advanceTimersByTimeAsync(ACTIVATION_SETTLE_MS + 3_000);
      expect(await p).toBe(ACTIVATION_SETTLE_MS + 3_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
