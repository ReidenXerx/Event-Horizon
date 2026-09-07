/**
 * The budgets exist because flat constants tuned on Windows with a small
 * collection failed a 954-mod install under Wine. The properties worth
 * pinning are the ones that made the old numbers wrong:
 *
 *  - they must GROW with the work, or a big collection is punished for
 *    being big;
 *  - they must grow under Wine, where the same work costs more;
 *  - they must stay BOUNDED, because a genuinely hung install that nobody
 *    reports for an hour is its own failure;
 *  - the extraction window must be sized from the archive, because that is
 *    the window where nothing observable moves and a flat number is a guess.
 */
import { describe, expect, it } from "vitest";

import {
  LEGACY_DEPLOY_TIMEOUT_MS,
  LEGACY_PROFILE_SWITCH_TIMEOUT_MS,
  LEGACY_STALL_WATCHDOG_MS,
  WINE_SLOWDOWN,
  countMods,
  deployBudgetMs,
  describeBudget,
  profileSwitchBudgetMs,
  stallBudgetMs,
} from "./timeBudgets";

const WIN = { wine: false };
const WINE = { wine: true };

describe("deployBudgetMs", () => {
  it("gives a 954-mod collection far more than the old flat 5 minutes", async () => {
    // The concrete case that failed. 5 min was the whole budget before,
    // regardless of size.
    const ms = deployBudgetMs(954, WIN);
    expect(ms).toBeGreaterThan(5 * 60_000);
  });

  it("grows with mod count", async () => {
    expect(deployBudgetMs(1000, WIN)).toBeGreaterThan(deployBudgetMs(10, WIN));
  });

  it("is more generous under Wine than on Windows", async () => {
    expect(deployBudgetMs(500, WINE)).toBeGreaterThan(deployBudgetMs(500, WIN));
  });

  it("stays bounded, so a real hang is still reported", async () => {
    // Without a cap, a large collection under Wine would produce a budget
    // measured in hours and a stuck deploy would never surface.
    expect(deployBudgetMs(100_000, WINE)).toBeLessThanOrEqual(30 * 60_000);
  });

  it("never drops below a floor, even for an empty collection", async () => {
    // A tiny collection on a cold spinning disk still needs room.
    expect(deployBudgetMs(0, WIN)).toBeGreaterThanOrEqual(120_000);
    expect(deployBudgetMs(-5, WIN)).toBeGreaterThanOrEqual(120_000);
  });
});

describe("profileSwitchBudgetMs", () => {
  it("grows with mod count and under Wine", async () => {
    expect(profileSwitchBudgetMs(954, WIN)).toBeGreaterThan(
      profileSwitchBudgetMs(0, WIN),
    );
    expect(profileSwitchBudgetMs(954, WINE)).toBeGreaterThan(
      profileSwitchBudgetMs(954, WIN),
    );
  });

  it("is bounded and never below the original 30s", async () => {
    expect(profileSwitchBudgetMs(0, WIN)).toBeGreaterThanOrEqual(30_000);
    expect(profileSwitchBudgetMs(100_000, WINE)).toBeLessThanOrEqual(10 * 60_000);
  });

  it("gives a big collection time to PURGE, not just to flip a flag", () => {
    /**
     * A switch makes Vortex unlink every deployed file of the profile being
     * left. A tester with ~1,100 mods deployed got 64s for that and lost the
     * install to "Profile switch did not complete within 64s. Check Vortex's
     * notifications for a stuck deployment." There was no stuck deployment.
     *
     * The number here is not sacred; being in the minutes for a collection
     * this size is. Sixty-four seconds was not.
     */
    expect(profileSwitchBudgetMs(1725, WIN)).toBeGreaterThan(5 * 60_000);
  });
});

describe("stallBudgetMs", () => {
  it("keeps the download window tight, because a stalled download is common", async () => {
    // We get frequent signals here, so silence really is suspicious. Making
    // this as generous as the extraction window would mean a dead download
    // sits unreported for many minutes.
    expect(stallBudgetMs({ phase: "downloading" }, WIN)).toBe(90_000);
  });

  it("gives extraction of a large archive much longer than 90s", async () => {
    // The blind spot: once the download completes, the download entry stops
    // changing and the mod record has not appeared, so NOTHING resets the
    // watchdog until Vortex finishes unpacking. A 2 GB archive under Wine
    // legitimately exceeds 90 seconds of silence.
    const twoGb = 2 * 1024 * 1024 * 1024;
    expect(stallBudgetMs({ phase: "extracting", bytes: twoGb }, WIN)).toBeGreaterThan(
      10 * 60_000,
    );
  });

  it("sizes the extraction window from the archive, not from a guess", async () => {
    const small = stallBudgetMs({ phase: "extracting", bytes: 5 * 1024 * 1024 }, WIN);
    const large = stallBudgetMs(
      { phase: "extracting", bytes: 900 * 1024 * 1024 },
      WIN,
    );
    expect(large).toBeGreaterThan(small);
  });

  it("gives a SMALL archive a large window, because bytes are not the work", () => {
    // This assertion used to read `toBe(90_000)`, on the reasoning that "a 1 MB
    // mod that goes quiet for ten minutes IS hung". A tester's log disproved
    // it: mods of 535 KB, 2.2 MB, 6.2 MB and 28 MB were all killed at the 270s
    // floor while extracting perfectly well.
    //
    // Byte size does not predict extraction time. A small archive can hold
    // thousands of loose files, and each one costs a filesystem round trip -
    // three of them, inside a Proton prefix.
    const small = stallBudgetMs({ phase: "extracting", bytes: 1024 * 1024 }, WIN);
    expect(small).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it("costs nothing when work is happening, because the timer resets", () => {
    // The reason a generous window is safe rather than reckless: this budget is
    // an IDLE timeout. It is only ever spent in full when nothing at all is
    // observable, so raising it delays noticing a true hang and does not slow
    // down a single healthy install.
    const win = stallBudgetMs({ phase: "extracting", bytes: 1024 * 1024 }, WIN);
    const wine = stallBudgetMs({ phase: "extracting", bytes: 1024 * 1024 }, WINE);
    expect(wine).toBeGreaterThan(win);
  });

  it("falls back generously when the size is unknown", async () => {
    // Guessing small with no information is the expensive mistake: it fails
    // a correct install. Guessing large only delays a hang report.
    const unknown = stallBudgetMs({ phase: "extracting" }, WIN);
    expect(unknown).toBeGreaterThan(90_000);
  });

  it("stays bounded even for an absurd archive under Wine", async () => {
    const huge = stallBudgetMs(
      { phase: "extracting", bytes: 500 * 1024 * 1024 * 1024 },
      WINE,
    );
    // Still bounded — a backstop has to exist — but the bound is now two hours
    // rather than twenty minutes. The old ceiling was a cap on how patient the
    // tool was willing to be, and that is the user's hardware to decide.
    expect(huge).toBeLessThanOrEqual(2 * 60 * 60_000);
    expect(huge).toBeGreaterThan(20 * 60_000);
  });

  it("is at least as generous under Wine as on Windows, never less", async () => {
    // The whole point. A budget that shrank under Wine would be worse than
    // the flat constant it replaced.
    const cases: { bytes?: number }[] = [
      { bytes: 1024 * 1024 },
      { bytes: 100 * 1024 * 1024 },
      { bytes: undefined },
    ];
    for (const c of cases) {
      const win = stallBudgetMs({ phase: "extracting", ...c }, WIN);
      const wine = stallBudgetMs({ phase: "extracting", ...c }, WINE);
      expect(wine).toBeGreaterThanOrEqual(win);
    }
  });
});

describe("no budget may be smaller than the constant it replaced", () => {
  // The invariant that matters most, and the one a plausible-looking formula
  // broke: a first draft floored deploy at 2 minutes, so a 10-mod collection
  // came out at 2.1m where it previously had 5m. A change whose entire purpose
  // is to stop failing slow machines must not fail a machine that used to pass.
  //
  // Caught by printing the table and reading it as NUMBERS. The formula read
  // perfectly well as an expression.
  it("holds for deploy, at every size, in both environments", async () => {
    for (const n of [0, 1, 5, 10, 50, 100, 954, 5000, 100_000]) {
      for (const env of [WIN, WINE]) {
        expect(deployBudgetMs(n, env)).toBeGreaterThanOrEqual(
          LEGACY_DEPLOY_TIMEOUT_MS,
        );
      }
    }
  });

  it("holds for profile switch", async () => {
    for (const n of [0, 1, 954, 100_000]) {
      for (const env of [WIN, WINE]) {
        expect(profileSwitchBudgetMs(n, env)).toBeGreaterThanOrEqual(
          LEGACY_PROFILE_SWITCH_TIMEOUT_MS,
        );
      }
    }
  });

  it("holds for the stall watchdog, in every phase and at every size", async () => {
    for (const env of [WIN, WINE]) {
      expect(stallBudgetMs({ phase: "downloading" }, env)).toBeGreaterThanOrEqual(
        LEGACY_STALL_WATCHDOG_MS,
      );
      for (const bytes of [undefined, 0, 1, 1024, 5 * 1024 * 1024, 9e12]) {
        expect(
          stallBudgetMs({ phase: "extracting", bytes }, env),
        ).toBeGreaterThanOrEqual(LEGACY_STALL_WATCHDOG_MS);
      }
    }
  });
});

describe("every budget is finite and positive", () => {
  it("holds across a wide sweep of inputs", async () => {
    // A NaN or Infinity here becomes a setTimeout that never fires, which
    // turns a guard into a hang — the exact opposite of its job.
    for (const n of [0, 1, 10, 954, 100_000]) {
      for (const env of [WIN, WINE]) {
        for (const ms of [deployBudgetMs(n, env), profileSwitchBudgetMs(n, env)]) {
          expect(Number.isFinite(ms)).toBe(true);
          expect(ms).toBeGreaterThan(0);
        }
      }
    }
    for (const bytes of [0, 1, 1024, 5 * 1024 * 1024 * 1024, undefined]) {
      for (const env of [WIN, WINE]) {
        const ms = stallBudgetMs({ phase: "extracting", bytes }, env);
        expect(Number.isFinite(ms)).toBe(true);
        expect(ms).toBeGreaterThan(0);
      }
    }
  });
});

describe("countMods", () => {
  it("totals mods across every game", async () => {
    expect(
      countMods({
        persistent: { mods: { fallout4: { a: {}, b: {} }, skyrimse: { c: {} } } },
      }),
    ).toBe(3);
  });

  it("returns 0 rather than throwing on any shape it does not recognise", async () => {
    // This runs on the install's critical path purely to SIZE a timeout.
    // Throwing here would fail an install over a state shape we do not
    // control -- 0 just floors the budget at the legacy constant.
    const junk: unknown[] = [
      undefined,
      null,
      "not state",
      42,
      {},
      { persistent: null },
      { persistent: {} },
      { persistent: { mods: null } },
      { persistent: { mods: "no" } },
      { persistent: { mods: { game: null } } },
      { persistent: { mods: { game: "no" } } },
    ];
    for (const s of junk) {
      expect(() => countMods(s)).not.toThrow();
      expect(countMods(s)).toBe(0);
    }
  });
});

describe("the budgets are actually WIRED to the call sites", () => {
  // Enumerate-and-assert (GP-26). None of deployAndWait, switchToProfile or
  // waitForInstallCompletion has a behavioural test -- they need Vortex event
  // mocking -- so the failure mode is that someone reinstates a flat constant
  // and every test still passes. Read the real source.
  const read = async (rel: string): Promise<string> => {
    const fs = await import("fs");
    const path = await import("path");
    return fs.readFileSync(path.join(__dirname, rel), "utf8");
  };

  it("deployAndWait sizes its ceiling instead of hard-coding one", async () => {
    const src = await read("runInstall.ts");
    expect(src).toMatch(/deployBudgetMs\(countMods\(state\)/);
    // The constant it replaced must be gone, not merely unused: a leftover
    // `5 * 60_000` next to a budget call is the next reader's trap.
    expect(src).not.toMatch(/DEPLOY_TIMEOUT_MS/);
  });

  it("switchToProfile sizes its ceiling instead of hard-coding one", async () => {
    const src = await read("profile.ts");
    expect(src).toMatch(/profileSwitchBudgetMs\(countMods\(state\)/);
    expect(src).not.toMatch(/PROFILE_SWITCH_TIMEOUT_MS/);
  });

  it("the stall watchdog is armed per phase, not from a constant", async () => {
    const src = await read("modInstall.ts");
    expect(src).toMatch(/stallBudgetMs\(phase, budgetEnv\)/);
    expect(src).not.toMatch(/INSTALL_STALL_WATCHDOG_MS/);
    // The absolute cap is deliberately NOT scaled -- it is a livelock
    // backstop, not a performance budget. If it ever gains a budget call,
    // that was a misunderstanding worth catching.
    expect(src).toMatch(/INSTALL_ABSOLUTE_CAP_MS/);
  });

  it("the watchdog can tell downloading from extracting", async () => {
    // The whole point of the change: a flat window called a large mod's
    // legitimate unpacking a hang, because none of the progress signals move
    // during extraction.
    const src = await read("modInstall.ts");
    expect(src).toMatch(/phase: "extracting"/);
    expect(src).toMatch(/phase: "downloading"/);
  });
});

describe("describeBudget", () => {
  it("says the Wine multiplier, so a timeout in the wild can be explained", async () => {
    // When a remote tester hits a timeout, the log has to say which budget
    // was in force and why. Without it we are back to guessing.
    expect(describeBudget("deploy", 90_000, WINE)).toContain(
      `x${WINE_SLOWDOWN}`,
    );
    expect(describeBudget("deploy", 90_000, WIN)).not.toContain("Wine");
  });
});
