/**
 * The repair path downloads executables from the internet and runs them on a
 * user's machine, so the logic deciding WHEN it does that has to be provable
 * without ever doing it. Every effect is injected; these tests are the reason.
 *
 * The properties that matter are about honesty, not mechanics:
 *   - 1638 is SUCCESS, not failure (a newer runtime is already installed)
 *   - an exit code alone never earns the word "fixed"
 *   - "installed but it still does not work" is its own outcome, distinct
 *     from both success and failure
 */
import { describe, expect, it, vi } from "vitest";

import {
  installPrerequisites,
  summarisePrereqResults,
  type InstallPrereqDeps,
} from "./installPrerequisites";
import {
  PREREQUISITES,
  classifyExitCode,
  planPrerequisites,
  verdictIsGood,
} from "./prerequisites";

const vcx64 = PREREQUISITES.find((p) => p.id === "vcredist-x64")!;
const vcx86 = PREREQUISITES.find((p) => p.id === "vcredist-x86")!;

const deps = (over: Partial<InstallPrereqDeps> = {}): InstallPrereqDeps => ({
  download: vi.fn().mockResolvedValue(undefined),
  run: vi.fn().mockResolvedValue(0),
  makeTempDir: vi.fn().mockResolvedValue("/tmp/eh"),
  removeTempDir: vi.fn().mockResolvedValue(undefined),
  joinPath: (...p: string[]) => p.join("/"),
  ...over,
});

describe("classifyExitCode", () => {
  it("treats 1638 as already-current, not as a failure", () => {
    // The single most likely code on a machine that has been modded before.
    // Calling it a failure tells a user with a working system it broke.
    expect(classifyExitCode(1638)).toEqual({ kind: "already-current" });
    expect(verdictIsGood(classifyExitCode(1638))).toBe(true);
  });

  it("treats 5100 (VC++ newer version present) as already-current", () => {
    expect(verdictIsGood(classifyExitCode(5100))).toBe(true);
  });

  it("treats 3010 as success that needs a reboot", () => {
    expect(classifyExitCode(3010)).toEqual({ kind: "needs-reboot" });
    expect(verdictIsGood(classifyExitCode(3010))).toBe(true);
  });

  it("treats a user cancel as cancelled, not failed", () => {
    expect(classifyExitCode(1602).kind).toBe("cancelled");
    expect(verdictIsGood(classifyExitCode(1602))).toBe(false);
  });

  it("explains 1603 in Proton terms rather than echoing the number", () => {
    const v = classifyExitCode(1603);
    expect(v.kind).toBe("failed");
    if (v.kind === "failed") expect(v.why).toMatch(/Proton/);
  });
});

describe("installPrerequisites", () => {
  it("never reports a fix from an exit code alone", async () => {
    // run() says 0, but no verify was supplied — so `verified` stays undefined
    // and the summary must not claim success.
    const results = await installPrerequisites([vcx64], deps());
    expect(results[0]?.verdict).toEqual({ kind: "installed" });
    expect(results[0]?.verified).toBeUndefined();
    expect(summarisePrereqResults(results, true).fixed).toBe(false);
  });

  it("reports a fix only when the probe says so afterwards", async () => {
    const verify = vi.fn().mockResolvedValue(true);
    const results = await installPrerequisites([vcx64], deps({ verify }));
    expect(verify).toHaveBeenCalledTimes(1);
    expect(results[0]?.verified).toBe(true);
    expect(summarisePrereqResults(results, true).fixed).toBe(true);
  });

  it("distinguishes 'installed but still broken' from success and failure", async () => {
    const results = await installPrerequisites(
      [vcx64],
      deps({ verify: vi.fn().mockResolvedValue(false) }),
    );
    // ON WINE the remaining suspect is the Proton build.
    const onWine = summarisePrereqResults(results, true);
    expect(onWine.fixed).toBe(false);
    expect(onWine.message).toMatch(/Proton version/);

    // ON WINDOWS it is not, and telling someone to change a Proton version
    // they do not have is worse than saying nothing.
    const onWindows = summarisePrereqResults(results, false);
    expect(onWindows.fixed).toBe(false);
    expect(onWindows.message).not.toMatch(/Proton/);
    expect(onWindows.message).toMatch(/Restarting Vortex/);
  });

  it("blames the reboot, not Proton, when a runtime needs one", async () => {
    /**
     * 3010 is what vc_redist returns when its files are in use — and Vortex
     * is running and holding them, so this is the common case. The verdict is
     * good, the probe legitimately still fails, and the old code read that as
     * "the install did not help" and sent Windows users after Proton.
     */
    const results = await installPrerequisites(
      [vcx64],
      deps({ run: vi.fn().mockResolvedValue(3010), verify: vi.fn().mockResolvedValue(false) }),
    );
    expect(results[0]?.verdict.kind).toBe("needs-reboot");
    for (const onWine of [true, false]) {
      const summary = summarisePrereqResults(results, onWine);
      expect(summary.fixed).toBe(false);
      expect(summary.message).toMatch(/restart/i);
      expect(summary.message).not.toMatch(/Proton/);
    }
  });

  it("names administrator rights when the elevation prompt was refused", async () => {
    // 1602 is a dismissed UAC dialog, which can appear behind Vortex. It had
    // no arm of its own, so the user was told "the installers did not
    // complete" with no hint at what to do about it.
    const results = await installPrerequisites(
      [vcx64],
      deps({ run: vi.fn().mockResolvedValue(1602) }),
    );
    expect(results[0]?.verdict.kind).toBe("cancelled");
    const summary = summarisePrereqResults(results, false);
    expect(summary.fixed).toBe(false);
    expect(summary.message).toMatch(/administrator/i);
  });

  it("stops once the problem is verified fixed", async () => {
    const run = vi.fn().mockResolvedValue(0);
    const results = await installPrerequisites(
      [vcx64, vcx86],
      deps({ run, verify: vi.fn().mockResolvedValue(true) }),
    );
    // Second runtime never installed: the problem was already solved.
    expect(run).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
  });

  it("keeps going when one download fails", async () => {
    const download = vi
      .fn()
      .mockRejectedValueOnce(new Error("ENOTFOUND"))
      .mockResolvedValue(undefined);
    const results = await installPrerequisites([vcx64, vcx86], deps({ download }));
    expect(results).toHaveLength(2);
    expect(results[0]?.verdict.kind).toBe("failed");
    expect(results[1]?.verdict.kind).toBe("installed");
  });

  it("reports a prefix that cannot run the installer distinctly", async () => {
    const results = await installPrerequisites(
      [vcx64],
      deps({ run: vi.fn().mockRejectedValue(new Error("spawn EACCES")) }),
    );
    const v = results[0]?.verdict;
    expect(v?.kind).toBe("failed");
    if (v?.kind === "failed") expect(v.why).toMatch(/Could not run/);
  });

  it("does not let a throwing probe read as a failed repair", async () => {
    const results = await installPrerequisites(
      [vcx64],
      deps({ verify: vi.fn().mockRejectedValue(new Error("probe exploded")) }),
    );
    // undefined, NOT false — we learned nothing, which is not the same as
    // learning it did not work.
    expect(results[0]?.verified).toBeUndefined();
  });

  it("always cleans up the scratch directory, even when everything fails", async () => {
    const removeTempDir = vi.fn().mockResolvedValue(undefined);
    await installPrerequisites(
      [vcx64],
      deps({
        removeTempDir,
        download: vi.fn().mockRejectedValue(new Error("nope")),
      }),
    );
    expect(removeTempDir).toHaveBeenCalledWith("/tmp/eh");
  });

  it("honours an abort before starting the next item", async () => {
    const signal = { aborted: false };
    const run = vi.fn().mockImplementation(() => {
      signal.aborted = true;
      return Promise.resolve(0);
    });
    const results = await installPrerequisites(
      [vcx64, vcx86],
      deps({ run }),
      { signal },
    );
    expect(results).toHaveLength(1);
  });
});

describe("planPrerequisites", () => {
  it("preselects the VC++ runtimes and nothing exotic", () => {
    const plan = planPrerequisites({ onWine: false });
    const on = plan.filter((p) => p.preselected).map((p) => p.id);
    expect(on).toContain("vcredist-x64");
    expect(on).toContain("vcredist-x86");
    expect(on).not.toContain("dotnet48");
  });

  it("does not preselect Wine-hostile installers inside a prefix", () => {
    const plan = planPrerequisites({ onWine: true, aggressive: true });
    const dotnet = plan.find((p) => p.id === "dotnet48");
    expect(dotnet?.preselected).toBe(false);
    // Offered, not hidden: the caveat is information, and the user may insist.
    expect(dotnet).toBeDefined();
    expect(dotnet?.wineCaveat).toMatch(/protontricks/);
  });

  it("keeps every entry offered on Windows", () => {
    expect(planPrerequisites({ onWine: false })).toHaveLength(
      PREREQUISITES.length,
    );
  });
});

describe("the catalogue itself", () => {
  /**
   * These are downloads this tool runs as executables on someone's machine,
   * so where they come from is not a detail. Every URL in the catalogue was
   * verified by fetching it — ranged GET, HTTP 206, MZ magic, Microsoft-owned
   * host — and this test keeps the HOST half of that true for free.
   */
  it("fetches every runtime from a Microsoft host over https", async () => {
    const { PREREQUISITES } = await import("./prerequisites");
    expect(PREREQUISITES.length).toBeGreaterThan(0);
    for (const p of PREREQUISITES) {
      const url = new URL(p.url);
      expect(url.protocol).toBe("https:");
      expect(
        url.hostname === "aka.ms" ||
          url.hostname.endsWith(".microsoft.com") ||
          url.hostname === "go.microsoft.com",
      ).toBe(true);
    }
  });

  it("ships the CURRENT 14.x package, not the one named after 2022", async () => {
    /**
     * Measured 2026-09-18 by downloading both and reading the version
     * resource — not remembered:
     *
     *   aka.ms/vs/17 -> 14.44.35211  "Visual C++ 2015-2022 Redistributable"
     *   aka.ms/vs/18 -> 14.51.36247  "Visual C++ v14 Redistributable"
     *   aka.ms/vs/19 -> does not exist
     *
     * Same binary-compatible ABI, newer, and a smaller download. This test
     * exists so nobody "corrects" it back to the familiar vs/17 link.
     */
    const { PREREQUISITES } = await import("./prerequisites");
    const vc = PREREQUISITES.filter((p) => p.id === "vcredist-x64" || p.id === "vcredist-x86");
    expect(vc).toHaveLength(2);
    for (const p of vc) {
      expect(p.url).toContain("/vs/18/release/");
      expect(p.recommended).toBe(true);
    }
  });

  it("keeps the older runtimes off by default", async () => {
    // 2013 and 2012 are real link-by-name dependencies for some plugins, and
    // dead weight for most collections. Detected, never pushed.
    const { PREREQUISITES } = await import("./prerequisites");
    for (const id of ["vcredist2013-x64", "vcredist2013-x86", "vcredist2012-x86"] as const) {
      const p = PREREQUISITES.find((x) => x.id === id);
      expect(p, id).toBeDefined();
      expect(p!.recommended, id).toBe(false);
      expect(p!.silentArgs).toContain("/quiet");
    }
  });
});
