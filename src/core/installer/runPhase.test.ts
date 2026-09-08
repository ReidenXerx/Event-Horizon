import { describe, expect, it, vi } from "vitest";

import * as vortexApi from "@nexusmods/vortex-api";

import {
  describeSkippedFinishing,
  isAbort,
  runFinishing,
  runPhase,
} from "./runPhase";

const spy = () => {
  const s = vi.spyOn(vortexApi, "log").mockImplementation(() => undefined);
  s.mockClear();
  return s;
};
const events = (s: ReturnType<typeof spy>): string[] =>
  s.mock.calls.map((c) => String(c[1]));

describe("runPhase", () => {
  it("runs the work and merges its result", async () => {
    spy();
    let merged: number | undefined;
    const outcome = await runPhase({
      phase: "x",
      work: () => 7,
      merge: (n) => {
        merged = n;
      },
      consequence: "nothing",
    });
    expect(outcome).toBe("ok");
    expect(merged).toBe(7);
  });

  it("skips entirely when there is nothing to do", async () => {
    let ran = false;
    const outcome = await runPhase({
      phase: "x",
      when: false,
      work: () => {
        ran = true;
      },
      consequence: "nothing",
    });
    expect(outcome).toBe("ok");
    expect(ran).toBe(false);
  });

  it("is NON-FATAL on a throw, and says what that costs", async () => {
    // The whole point of the combinator: the run continues, and the log
    // carries the sentence a person can act on rather than just "it threw".
    const s = spy();
    let merged = false;
    const outcome = await runPhase({
      phase: "rules.apply",
      work: () => {
        throw new Error("vortex said no");
      },
      merge: () => {
        merged = true;
      },
      consequence: "the curator's conflict order is NOT reproduced",
    });
    expect(outcome).toBe("failed");
    // `merge` must NOT run on a throw — a half-merged result is worse than none.
    expect(merged).toBe(false);
    const call = s.mock.calls.find((c) =>
      String(c[1]).includes("rules.apply.threw"),
    );
    expect(call).toBeDefined();
    expect(call![2]).toMatchObject({
      consequence: "the curator's conflict order is NOT reproduced",
    });
  });

  it("tells an abort apart from a failure", async () => {
    spy();
    const err = new Error("stopped");
    err.name = "AbortError";
    const outcome = await runPhase({
      phase: "x",
      work: () => {
        throw err;
      },
      consequence: "nothing",
    });
    expect(outcome).toBe("aborted");
  });

  it("treats an already-aborted signal as an abort without running the work", async () => {
    const c = new AbortController();
    c.abort();
    let ran = false;
    const outcome = await runPhase(
      {
        phase: "x",
        work: () => {
          ran = true;
        },
        consequence: "nothing",
      },
      c.signal,
    );
    expect(outcome).toBe("aborted");
    expect(ran).toBe(false);
  });
});

describe("runFinishing — a stop past the point of no return", () => {
  it("skips the work but NAMES what it skipped", async () => {
    /**
     * The hole this closes: five phases after the deploy had no signal check
     * at all, so pressing Stop in the last quarter did nothing and said
     * nothing. Unwinding instead would leave a fully-deployed collection with
     * no receipt, which is worse. So: stop working, keep going to the
     * receipt, and say which steps were skipped.
     */
    const s = spy();
    const c = new AbortController();
    c.abort();
    const skipped: string[] = [];
    let ran = false;
    const outcome = await runFinishing(
      {
        phase: "plugin-order",
        work: () => {
          ran = true;
        },
        consequence: "the curator's plugin order is not pinned",
      },
      c.signal,
      skipped,
    );
    expect(outcome).toBe("skipped-after-stop");
    expect(ran).toBe(false);
    expect(skipped).toEqual(["plugin-order"]);
    expect(events(s)).toContain("[Event Horizon] plugin-order.skipped-after-stop");
  });

  it("runs normally when nothing was stopped", async () => {
    spy();
    const skipped: string[] = [];
    let ran = false;
    const outcome = await runFinishing(
      {
        phase: "game-ini",
        work: () => {
          ran = true;
        },
        consequence: "settings not written",
      },
      undefined,
      skipped,
    );
    expect(outcome).toBe("ok");
    expect(ran).toBe(true);
    expect(skipped).toEqual([]);
  });

  it("still records a phase that aborts MID-work", async () => {
    spy();
    const skipped: string[] = [];
    const err = new Error("stopped");
    err.name = "AbortError";
    await runFinishing(
      {
        phase: "esl-flags",
        work: () => {
          throw err;
        },
        consequence: "flags not restored",
      },
      undefined,
      skipped,
    );
    expect(skipped).toEqual(["esl-flags"]);
  });

  it("does NOT swallow an ordinary failure as a stop", async () => {
    // A phase that genuinely broke must not be reported to the user as
    // "you stopped it" — that sends them looking for something they did.
    spy();
    const skipped: string[] = [];
    const outcome = await runFinishing(
      {
        phase: "game-ini",
        work: () => {
          throw new Error("disk full");
        },
        consequence: "settings not written",
      },
      undefined,
      skipped,
    );
    expect(outcome).toBe("failed");
    expect(skipped).toEqual([]);
  });
});

describe("isAbort", () => {
  it("believes the signal even when the error says otherwise", () => {
    // Vortex's pipeline can surface a cancel as a plain Error, so the signal
    // is the more reliable of the two.
    const c = new AbortController();
    c.abort();
    expect(isAbort(new Error("something else"), c.signal)).toBe(true);
  });

  it("is false for an ordinary error with no signal", () => {
    expect(isAbort(new Error("disk full"))).toBe(false);
    expect(isAbort(undefined)).toBe(false);
  });
});

describe("what the user is told", () => {
  it("names the skipped steps and how to finish them", () => {
    const msg = describeSkippedFinishing(["plugin-order", "game-ini"]);
    expect(msg).toContain("plugin-order");
    expect(msg).toContain("game-ini");
    expect(msg).toMatch(/again/);
    // The reason re-running is cheap is the reason this advice is honest.
    expect(msg).toMatch(/recognised rather than re-downloaded/);
  });
});
