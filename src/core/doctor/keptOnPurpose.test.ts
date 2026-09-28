import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";

import type { HealthCheck } from "./health";
import { applyKept, findingFingerprint, keptKey, loadKept, saveKept } from "./keptOnPurpose";

const missing = (mods: string[]): HealthCheck => ({
  id: "mods-present",
  title: "Mods present",
  status: "broken",
  summary: `${mods.length} mods are missing.`,
  detail: mods,
  affectedCount: mods.length,
  heal: { action: "reinstall-mods", label: "Reinstall" },
});

describe("findings a player keeps on purpose", () => {
  it("shows a kept finding as kept (healthy, no fix offered) while it is exactly the same", () => {
    const kept = { "mods-present": findingFingerprint(missing(["B", "A"])) };
    const [c] = applyKept([missing(["A", "B"])], kept);
    expect(c).toMatchObject({ status: "healthy", keptOnPurpose: true, affectedCount: 0 });
    expect(c!.summary).toMatch(/^Kept on purpose: /);
    expect(c!.heal).toBeUndefined();
  });

  it("shows it again the moment it changes", () => {
    const kept = { "mods-present": findingFingerprint(missing(["A"])) };
    const [c] = applyKept([missing(["A", "C"])], kept);
    expect(c).toMatchObject({ status: "broken", affectedCount: 2 });
    expect(c!.keptOnPurpose).toBeUndefined();
  });

  it("never touches a healthy or unknown check", () => {
    const healthy: HealthCheck = { id: "profile", title: "Profile", status: "healthy", summary: "ok", detail: [], affectedCount: 0 };
    const kept = { profile: findingFingerprint(healthy) };
    expect(applyKept([healthy], kept)[0]).toBe(healthy);
  });

  it("stores per collection version, and forgets a key with nothing kept", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-kept-"));
    const v1 = keptKey({ packageId: "pkg", packageVersion: "1.0.24" });
    saveKept(dir, v1, { "mods-present": "x" });
    expect(loadKept(dir, v1)).toEqual({ "mods-present": "x" });
    expect(loadKept(dir, keptKey({ packageId: "pkg", packageVersion: "1.0.25" }))).toEqual({});
    saveKept(dir, v1, {});
    expect(JSON.parse(fs.readFileSync(path.join(dir, "doctor-kept.json"), "utf8"))).toEqual({});
  });
});
