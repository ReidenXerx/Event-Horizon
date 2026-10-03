/**
 * A tester's install stalled, he force-quit Vortex, reopened it, and Event
 * Horizon had no idea anything had been in flight — because a receipt is only
 * written on COMPLETION and a half-finished run has not earned one.
 *
 * The marker fills that gap without becoming a second receipt. The properties
 * that keep it honest:
 *
 *   - it survives a crash (that is its whole job);
 *   - it does NOT survive a run that ended, however it ended, or it would warn
 *     about interruptions that never happened;
 *   - it never throws, in either direction — it is a diagnostic, and failing
 *     an install over one would trade a real outcome for a convenience.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearInstallMarker,
  describeInterruptedInstall,
  getMarkerDir,
  listInterruptedInstalls,
  writeInstallMarker,
  type InstallMarker,
} from "./installMarker";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-marker-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const marker = (over: Partial<InstallMarker> = {}): InstallMarker => ({
  packageId: "11111111-2222-4333-8444-555555555555",
  packageName: "Ivy 2",
  startedAt: new Date().toISOString(),
  profileId: "prof-1",
  gameId: "fallout4",
  totalMods: 954,
  ...over,
});

describe("surviving a crash", () => {
  it("a written marker is still there afterwards", async () => {
    // The point of the whole file: the process died, nothing got to clean up.
    await writeInstallMarker(dir, marker());
    const found = await listInterruptedInstalls(dir);
    expect(found).toHaveLength(1);
    expect(found[0].packageName).toBe("Ivy 2");
    expect(found[0].totalMods).toBe(954);
  });

  it("remembers the package file, so 'Run the install again' can open it", async () => {
    // 2026-10-04: a player whose disk filled at 98% was sent to an empty
    // Install page and did not know where the package was.
    await writeInstallMarker(dir, marker({ packagePath: "D:\\Vortex\\downloads\\collection_dmt85e_8.zip" }));
    expect((await listInterruptedInstalls(dir))[0].packagePath).toBe("D:\\Vortex\\downloads\\collection_dmt85e_8.zip");
    // A marker from before the field existed reads back without one.
    await writeInstallMarker(dir, marker({ packageId: "older" }));
    const older = (await listInterruptedInstalls(dir)).find((m) => m.packageId === "older");
    expect(older?.packagePath).toBeUndefined();
  });

  it("records the profile the run left behind", async () => {
    // Without this the user cannot tell which of the profiles in their list
    // came from the interrupted run.
    await writeInstallMarker(dir, marker({ profileId: "prof-abc" }));
    expect((await listInterruptedInstalls(dir))[0].profileId).toBe("prof-abc");
  });

  it("lists the most recent first", async () => {
    await writeInstallMarker(
      dir,
      marker({ packageId: "old", startedAt: "2020-01-01T00:00:00.000Z" }),
    );
    await writeInstallMarker(
      dir,
      marker({ packageId: "new", startedAt: "2030-01-01T00:00:00.000Z" }),
    );
    expect((await listInterruptedInstalls(dir)).map((m) => m.packageId)).toEqual(
      ["new", "old"],
    );
  });
});

describe("not surviving a run that ended", () => {
  it("is gone after being cleared", async () => {
    // Whether the run succeeded, failed or was aborted, it ENDED. A marker
    // left behind would warn about an interruption that did not happen, and a
    // false warning teaches people to ignore the true one.
    const m = marker();
    await writeInstallMarker(dir, m);
    await clearInstallMarker(dir, m.packageId);
    expect(await listInterruptedInstalls(dir)).toEqual([]);
  });

  it("clearing one leaves the others alone", async () => {
    await writeInstallMarker(dir, marker({ packageId: "a" }));
    await writeInstallMarker(dir, marker({ packageId: "b" }));
    await clearInstallMarker(dir, "a");
    expect((await listInterruptedInstalls(dir)).map((m) => m.packageId)).toEqual(
      ["b"],
    );
  });

  it("clearing something that was never written is not an error", async () => {
    // It runs in a `finally`. Throwing here would replace the run's real
    // error with a cleanup one.
    await expect(clearInstallMarker(dir, "never")).resolves.toBeUndefined();
  });
});

describe("never throwing, in either direction", () => {
  it("reports nothing rather than failing when there is no directory", async () => {
    expect(await listInterruptedInstalls(path.join(dir, "nope"))).toEqual([]);
  });

  it("writing to an impossible location is silent", async () => {
    // A read-only or missing parent must not fail the install that is
    // starting. The marker is a convenience; the install is the product.
    const file = path.join(dir, "a-file");
    fs.writeFileSync(file, "not a directory");
    await expect(
      writeInstallMarker(path.join(file, "under-a-file"), marker()),
    ).resolves.toBeUndefined();
  });

  it("skips a corrupt marker instead of hiding the good ones", async () => {
    // Read at startup. One unparseable file must not blank the page or mask
    // a real interrupted install sitting next to it.
    await writeInstallMarker(dir, marker({ packageId: "good" }));
    fs.writeFileSync(path.join(getMarkerDir(dir), "bad.json"), "{ not json");
    const found = await listInterruptedInstalls(dir);
    expect(found.map((m) => m.packageId)).toEqual(["good"]);
  });

  it("rejects a structurally wrong marker rather than passing it on", async () => {
    // Written by a possibly-older build, or edited by hand. A half-object
    // reaching the UI as a plausible marker is how "undefined" ends up in a
    // user-facing sentence.
    fs.mkdirSync(getMarkerDir(dir), { recursive: true });
    fs.writeFileSync(
      path.join(getMarkerDir(dir), "partial.json"),
      JSON.stringify({ packageId: "x" }),
    );
    expect(await listInterruptedInstalls(dir)).toEqual([]);
  });

  it("does not treat a .tmp leftover as a marker", async () => {
    // write-then-rename can leave one if the crash landed mid-write.
    fs.mkdirSync(getMarkerDir(dir), { recursive: true });
    fs.writeFileSync(path.join(getMarkerDir(dir), "x.json.tmp"), "{}");
    expect(await listInterruptedInstalls(dir)).toEqual([]);
  });
});

describe("the driver actually writes and clears it", () => {
  // Enumerate-and-assert (GP-26). runInstall needs a live Vortex to exercise,
  // so the failure mode is that the marker is written and never cleared — or
  // cleared at twelve of thirteen return paths — and every test still passes
  // while users collect phantom "interrupted" warnings. Read the real source.
  const driver = async (): Promise<string> => {
    const fsm = await import("fs");
    const pathm = await import("path");
    return fsm.readFileSync(pathm.join(__dirname, "runInstall.ts"), "utf8");
  };

  it("writes the marker before the mod loop, not after it", async () => {
    const src = await driver();
    const write = src.indexOf("writeInstallMarker(");
    const loop = src.indexOf("for (let i = 0; i < total; i++)");
    expect(write).toBeGreaterThan(-1);
    expect(loop).toBeGreaterThan(-1);
    // Writing it after the loop would record only runs that already survived
    // the part most likely to be interrupted.
    expect(write).toBeLessThan(loop);
  });

  it("clears it in the finally, not at the return sites", async () => {
    // The load-bearing detail. Thirteen returns; clearing at each is a
    // guarantee that lasts until someone adds a fourteenth.
    const src = await driver();
    const finallyAt = src.lastIndexOf("} finally {");
    const clearAt = src.indexOf("clearInstallMarker(");
    expect(finallyAt).toBeGreaterThan(-1);
    expect(clearAt).toBeGreaterThan(finallyAt);
  });

  it("clears it exactly once, so no return path is special-cased", async () => {
    const src = await driver();
    const calls = src.match(/clearInstallMarker\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });
});

describe("what the user is told", () => {
  it("says the collection is not broken and that re-running resumes", async () => {
    // The reasonable and WRONG conclusion from "an install was interrupted"
    // is that something must be cleaned up by hand first. The tester's
    // re-run worked correctly; he just had no way to know it would.
    const text = describeInterruptedInstall(marker());
    expect(text).toContain("Ivy 2");
    expect(text).toMatch(/nothing is broken/i);
    expect(text).toMatch(/carry on|already made it/i);
  });

  it("tolerates an unparseable timestamp without printing garbage", async () => {
    const text = describeInterruptedInstall(marker({ startedAt: "whenever" }));
    expect(text).not.toMatch(/NaN|Invalid/i);
  });

  it("says how long ago, in units a person uses", async () => {
    const ago = (mins: number): string =>
      describeInterruptedInstall(
        marker({ startedAt: new Date(Date.now() - mins * 60_000).toISOString() }),
      );
    expect(ago(5)).toMatch(/5 minutes ago/);
    expect(ago(1)).toMatch(/1 minute ago/); // not "1 minutes"
    expect(ago(120)).toMatch(/2 hours ago/);
    expect(ago(60 * 24 * 3)).toMatch(/3 days ago/);
  });
});
