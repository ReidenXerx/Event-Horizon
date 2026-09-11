import { describe, expect, it } from "vitest";

import type { CuratorMod } from "./profileActions";
import { compareVersions, pickProvider } from "./requirements";

const mod = (over: Partial<CuratorMod> & { id: string }): CuratorMod => ({
  name: over.id,
  enabled: false,
  modType: "",
  source: "nexus",
  nexusModId: 1,
  ...over,
});

describe("compareVersions", () => {
  it("reads numeric segments as numbers and ignores a leading v", () => {
    expect(compareVersions("1.10", "1.9")).toBeGreaterThan(0);
    expect(compareVersions("v1.2", "1.10")).toBeLessThan(0);
    expect(compareVersions("V2.0", "2.0")).toBe(0);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.1", "1.0")).toBeGreaterThan(0);
  });

  it("puts a prerelease below its release", () => {
    expect(compareVersions("2.0.0-beta", "2.0.0")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "2.0.0-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0-beta.2", "2.0.0-beta.10")).toBeLessThan(0);
    expect(compareVersions("2.0.0-alpha", "2.0.0-beta")).toBeLessThan(0);
    // Build metadata says nothing about order.
    expect(compareVersions("1.2.3+gog", "1.2.3")).toBe(0);
  });

  it("ranks a missing version below any version", () => {
    expect(compareVersions(undefined, "0.0.1")).toBeLessThan(0);
    expect(compareVersions("", undefined)).toBe(0);
  });
});

describe("pickProvider", () => {
  it("chooses the release over its prerelease, and 1.10 over v1.2", () => {
    expect(pickProvider([mod({ id: "beta", version: "2.0.0-beta" }), mod({ id: "rel", version: "2.0.0" })])?.id).toBe("rel");
    expect(pickProvider([mod({ id: "new", version: "1.10" }), mod({ id: "old", version: "v1.2" })])?.id).toBe("new");
  });

  it("keeps the first of equal candidates, so the choice is stable", () => {
    expect(pickProvider([mod({ id: "a", version: "1.0" }), mod({ id: "b", version: "1.0.0" })])?.id).toBe("a");
  });

  it("prefers copies of the file it was asked about over a newer different file on the same page", () => {
    const main = mod({ id: "main", version: "5.2", logicalFileName: "SkyUI" });
    const patch = mod({ id: "patch", version: "9.0", logicalFileName: "SkyUI - Survival patch" });
    const oldMain = mod({ id: "old-main", version: "5.1", logicalFileName: "SkyUI" });
    expect(pickProvider([patch, oldMain, main], "skyui")?.id).toBe("main");
    // No copy of that file: the page's newest is still better than nothing.
    expect(pickProvider([patch, main], "something else")?.id).toBe("patch");
  });
});
