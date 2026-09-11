import { describe, expect, it } from "vitest";

import { statusToSend, waitForEndorseOutcome } from "./endorseOutcome";

/** A scripted attribute: each read returns the next value, then the last forever. */
const scripted = (values: (string | undefined)[]): (() => string | undefined) => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
};
const noSleep = async (): Promise<void> => undefined;

describe("statusToSend", () => {
  it("hands Vortex the CURRENT status, which its handler toggles into an endorsement", () => {
    expect(statusToSend(undefined)).toBe("Undecided");
    expect(statusToSend("")).toBe("Undecided");
    expect(statusToSend("Undecided")).toBe("Undecided");
    // Never the wanted state: "Endorsed" would make Vortex abstain.
    expect(statusToSend("Abstained")).toBe("Abstained");
  });
});

describe("waitForEndorseOutcome", () => {
  it("reads the answer Vortex writes into the attribute", async () => {
    expect(await waitForEndorseOutcome({ read: scripted(["Undecided", "pending", "pending", "Endorsed"]), before: "Undecided", sleep: noSleep })).toBe("endorsed");
    expect(await waitForEndorseOutcome({ read: scripted([undefined, "pending", "Abstained"]), before: undefined, sleep: noSleep })).toBe("abstained");
  });

  it("tells Vortex's error path (back to Undecided after pending) from no answer yet", async () => {
    expect(await waitForEndorseOutcome({ read: scripted(["Undecided", "pending", "Undecided"]), before: "Undecided", sleep: noSleep })).toBe("failed");
  });

  it("times out honestly when nothing ever changes", async () => {
    expect(await waitForEndorseOutcome({ read: scripted(["Undecided"]), before: "Undecided", timeoutMs: 30, intervalMs: 5 })).toBe("timeout");
  });
});
