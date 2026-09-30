/**
 * The numbers in these tests are measurements, not invented fixtures.
 *
 * They come from one tester's 967-mod run on 2026-08-31, where two failures
 * carrying the SAME error message ("returned no archiveId") turned out to be
 * completely different problems, and only the timing said so. A fixture with
 * round made-up numbers would not have caught the case that matters, because
 * the case that matters is that ~600ms and ~20s mean opposite things.
 */
import { describe, expect, it } from "vitest";

import {
  backoffMs,
  classifyAttempt,
  classifyModFailure,
  describeSystemicFailure,
} from "./downloadFailureShape";

describe("classifyAttempt", () => {
  it("reads the measured dead-file attempts as gone", () => {
    // modId 98669 and 82232 — failing identically in every run since the
    // first, in well under a second.
    for (const ms of [241, 564, 645, 699, 791]) {
      expect(classifyAttempt(ms)).toBe("gone");
    }
  });

  it("reads the measured hanging attempts as timed out", () => {
    // The eight consecutive mods, ~20s per attempt, after 113 downloads had
    // already succeeded in the same run.
    for (const ms of [20_040, 20_051, 20_056, 23_057, 28_000]) {
      expect(classifyAttempt(ms)).toBe("timed-out");
    }
  });

  it("does not force a verdict on the gap between them", () => {
    // A healthy download in that run took ~6.5s. Something failing at that
    // speed is neither shape, and guessing would be worse than admitting it.
    expect(classifyAttempt(6_500)).toBe("unclear");
    expect(classifyAttempt(10_000)).toBe("unclear");
  });
});

describe("backoffMs", () => {
  it("waits meaningfully longer when the attempt hung", () => {
    // The whole point. Three seconds cannot clear a rate limit — the observed
    // run retried three times inside 71 seconds and got the same answer each
    // time.
    expect(backoffMs(1, "timed-out")).toBeGreaterThanOrEqual(20_000);
    expect(backoffMs(2, "timed-out")).toBeGreaterThan(
      backoffMs(1, "timed-out"),
    );
  });

  it("keeps confirming a dead file cheap", () => {
    // A deleted file costs ~600ms to confirm; making the user wait a minute
    // between attempts to re-confirm it would be worse than not retrying.
    expect(backoffMs(1, "gone")).toBe(3_000);
    expect(backoffMs(2, "gone")).toBe(8_000);
  });

  it("never returns undefined for an attempt past the ladder", () => {
    expect(backoffMs(9, "gone")).toBeGreaterThan(0);
    expect(backoffMs(9, "timed-out")).toBeGreaterThan(0);
  });
});

describe("classifyModFailure", () => {
  it("separates the two measured whole-mod totals", () => {
    // A dead file cost ~11.9s all-in (3 fast attempts + short backoffs);
    // a hanging one cost ~71s. Nothing observed landed between.
    expect(classifyModFailure(11_890)).toBe("unclear");
    expect(classifyModFailure(11_653)).toBe("unclear");
    for (const ms of [71_149, 71_160, 71_174, 92_734]) {
      expect(classifyModFailure(ms)).toBe("timed-out");
    }
  });
});

describe("describeSystemicFailure", () => {
  const base = {
    streak: 8,
    lastModName: "Smooth Cell Loading - OG 107810",
    lastError: "Nexus download for modId=107810 returned no archiveId.",
    remaining: 23,
  };

  it("stops blaming the user's machine when everything hung", () => {
    // The message that shipped sent a tester looking for a broken extractor,
    // a broken connection or a full disk. None of those was wrong with his
    // machine — 931 mods had just installed on it.
    //
    // Asserting the words are ABSENT was the obvious test and the wrong one:
    // the fix names them in order to CLEAR them ("not a problem with these
    // mods, your extractor or your disk"), which is more useful than silence
    // to someone who already suspects their setup. So the property is that
    // they appear inside the negation, never as the accusation.
    const msg = describeSystemicFailure({ ...base, shape: "timed-out" });
    expect(msg).toMatch(/not a problem with[^.]*extractor/i);
    expect(msg).toMatch(/not a problem with[^.]*disk/i);
    expect(msg).not.toContain("something is wrong for every mod");
  });

  it("names the likely cause and the fact that it is probably not the mods", () => {
    const msg = describeSystemicFailure({ ...base, shape: "timed-out" });
    expect(msg.toLowerCase()).toContain("rate limit");
    expect(msg.toLowerCase()).toContain("not a problem with these mods");
  });

  it("tells them re-running is cheap, because that is the actual next step", () => {
    // Already-installed mods are skipped, so a re-run reaches the tail in
    // minutes. Without saying so, "run it again" reads like "redo the hour".
    const msg = describeSystemicFailure({ ...base, shape: "timed-out" });
    expect(msg.toLowerCase()).toContain("skipped");
  });

  it("gives the contrasting evidence, so the claim is checkable", () => {
    const msg = describeSystemicFailure({ ...base, shape: "timed-out" });
    expect(msg.toLowerCase()).toContain("under a second");
  });

  it("keeps the original wording when the shape is not a timeout", () => {
    // An unclear streak really could be the extractor or the disk, and
    // narrowing it to Nexus would be a confident wrong answer.
    const msg = describeSystemicFailure({ ...base, shape: "unclear" });
    expect(msg).toContain("extractor");
    expect(msg).toContain("disk space");
  });

  it("always names the mod, the error and what it declined to do", () => {
    for (const shape of ["timed-out", "unclear"] as const) {
      const msg = describeSystemicFailure({ ...base, shape });
      expect(msg).toContain("Smooth Cell Loading - OG 107810");
      expect(msg).toContain("8 mods in a row");
      expect(msg).toContain("23 more times");
    }
  });
});

describe("when the Nexus account is the cause (a free-account player, 2026-09-30)", () => {
  const base = { streak: 8, lastModName: "BakaFramework", lastError: "returned no archiveId", remaining: 957, shape: "unclear" as const };

  it("a free account is named as the cause, not the extractor or the disk", () => {
    const text = describeSystemicFailure({ ...base, account: "free" });
    expect(text).toMatch(/not Premium/);
    expect(text).toMatch(/Only available to premium users/);
    expect(text).toMatch(/Continue/);
    expect(text).not.toMatch(/extractor, the Nexus connection, or disk space/);
  });

  it("no sign-in says to sign in", () => {
    expect(describeSystemicFailure({ ...base, account: "logged-out" })).toMatch(/not signed in/);
  });

  it("without an account cause the old wording stands", () => {
    expect(describeSystemicFailure(base)).toMatch(/extractor, the Nexus connection, or disk space/);
  });
});
