/**
 * cloud_16493, Ivy 1.0.64 (2026-11-19): 39 of 41 curator reports said
 * "Reinstalled from the archive and verified again" and "Checked against the
 * mod's own archive" while the archive was gone and neither had happened. The
 * report has to say what the repair actually did.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeRepairAttempt } from "./runInstall";

describe("curator report: what was already tried", () => {
  it("says no reinstall happened when there was no archive", () => {
    const line = describeRepairAttempt({ kind: "not-eligible", why: "no archive to reinstall from" });
    expect(line).toBe("Not reinstalled: no archive to reinstall from");
    expect(line).not.toContain("Reinstalled from the archive");
  });

  it("claims a reinstall only when one ran", () => {
    expect(describeRepairAttempt({ kind: "retry-failed", installEntry: {} as never })).toBe(
      "Reinstalled from the archive and verified again",
    );
    expect(describeRepairAttempt({ kind: "errored", modRemoved: true })).toContain("reinstall failed");
    expect(describeRepairAttempt({ kind: "not-ours" })).toContain("Not reinstalled");
  });

  it("names the archive as checked only when it was consulted", () => {
    const src = readFileSync(new URL("./runInstall.ts", import.meta.url), "utf8");
    const at = src.indexOf("`Checked against the mod's own archive:");
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at - 200, at)).toContain("judgement.archiveConsulted");
  });
});
