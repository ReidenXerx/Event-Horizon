import { describe, expect, it } from "vitest";

import {
  describeEndorseRun,
  endorseRefusal,
  pendingGameFor,
  statusToSend,
  waitForEndorseOutcome,
} from "./endorseOutcome";

/** A scripted attribute: each read returns the next value, then the last forever. */
const scripted = (values: (string | undefined)[]): (() => string | undefined) => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
};
const noSleep = async (): Promise<void> => undefined;
/** A clock that moves only when the waiter sleeps. */
const fakeClock = (): { now: () => number; sleep: (ms: number) => Promise<void> } => {
  let t = 0;
  return { now: () => t, sleep: async (ms) => void (t += ms) };
};

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

  it("calls a request whose marker never appeared NOT SENT, instead of one that may still land", async () => {
    // Logged out, no version, a mod Vortex cannot find: the handler writes
    // nothing at all. That is not a request in flight.
    const clock = fakeClock();
    const outcome = await waitForEndorseOutcome({
      read: scripted(["Undecided"]),
      readPending: scripted(["Undecided"]),
      before: "Undecided",
      ...clock,
    });
    expect(outcome).toBe("not-sent");
  });

  it("reads the marker where Vortex writes it, and the answer where it lands", async () => {
    // "pending" goes under the download game, the error's "Undecided" under
    // the active game. Watching only the active game, the error looked like
    // silence and ran out the clock.
    const clock = fakeClock();
    const outcome = await waitForEndorseOutcome({
      read: scripted(["Undecided"]),
      readPending: scripted(["pending"]),
      before: "Undecided",
      ...clock,
    });
    expect(outcome).toBe("failed");
  });

  it("does not guess 'not sent' when no marker can be read for the mod", async () => {
    const clock = fakeClock();
    expect(await waitForEndorseOutcome({ read: scripted(["Undecided"]), before: "Undecided", ...clock })).toBe("timeout");
  });
});

describe("pendingGameFor", () => {
  const mods = { skyrimse: { m1: {} }, skyrim: {} };
  it("is the download game when the mod is in that game's pool", () => {
    expect(pendingGameFor(mods, "skyrimse", "m1")).toBe("skyrimse");
  });
  it("is nothing when Vortex's reducer would drop the write", () => {
    expect(pendingGameFor(mods, "skyrim", "m1")).toBeUndefined();
    expect(pendingGameFor(mods, undefined, "m1")).toBeUndefined();
  });
});

describe("endorseRefusal", () => {
  const ok = { account: "premium" as const, activeGameId: "skyrimse", gameId: "skyrimse", attributes: { modId: 12, version: "1.0" } };

  it("sends for a Nexus mod with a version, logged in, in the managed game", () => {
    expect(endorseRefusal(ok)).toBeUndefined();
    expect(endorseRefusal({ ...ok, account: "unknown" })).toBeUndefined();
    expect(endorseRefusal({ ...ok, attributes: { modId: 12, modVersion: "2" } })).toBeUndefined();
  });

  it("refuses every case Vortex's handler drops without writing anything", () => {
    expect(endorseRefusal({ ...ok, account: "logged-out" })).toMatch(/not logged in/);
    expect(endorseRefusal({ ...ok, activeGameId: "fallout4" })).toMatch(/game it is managing/);
    expect(endorseRefusal({ ...ok, attributes: undefined })).toMatch(/no longer has/);
    expect(endorseRefusal({ ...ok, attributes: { version: "1.0" } })).toMatch(/no Nexus mod id/);
    expect(endorseRefusal({ ...ok, attributes: { modId: 12, version: "" } })).toMatch(/no version/);
  });
});

describe("describeEndorseRun", () => {
  it("keeps not-sent, may-still-land and unreadable apart", () => {
    const text = describeEndorseRun(
      {
        endorsed: 1,
        failed: [],
        timedOut: ["Slow"],
        unreadable: ["Cross-game"],
        notSent: [
          { name: "A", why: "it has no version recorded" },
          { name: "B", why: "it has no version recorded" },
        ],
        sent: 3,
      },
      5,
      false,
    );
    expect(text).toContain("Endorsed 1 of 5 mod(s)");
    expect(text).toContain("2 not sent because it has no version recorded (A, B)");
    expect(text).toContain("1 gave no answer within 15 seconds and may still land");
    expect(text).toContain("1 were sent but gave no readable answer (Cross-game)");
  });
});
