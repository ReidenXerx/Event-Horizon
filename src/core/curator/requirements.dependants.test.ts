import { describe, expect, it } from "vitest";

import type { CuratorMod } from "./profileActions";
import { dependantClosure, dependantsOf, type ModRequirement, type RequirementsReport } from "./requirements";

const mod = (id: string, enabled = true): CuratorMod => ({ id, name: id.toUpperCase(), enabled, modType: "", source: "nexus" });

const line = (name: string, satisfiedBy: string[], status: ModRequirement["status"] = "satisfied"): ModRequirement => ({
  source: "nexus",
  status,
  name,
  satisfiedBy,
});

/** A report from "mod → lines", with requiredBy derived the way the resolver builds it. */
function reportOf(lines: Record<string, ModRequirement[]>): RequirementsReport {
  const requiredBy = new Map<string, string[]>();
  for (const [modId, qs] of Object.entries(lines)) {
    for (const q of qs) for (const p of q.satisfiedBy) requiredBy.set(p, [...new Set([...(requiredBy.get(p) ?? []), modId])]);
  }
  return {
    byMod: new Map(Object.entries(lines).map(([modId, requirements]) => [modId, { modId, truncatedBy: 0, unfetched: false, requirements }])),
    requiredBy,
    noUid: [],
  };
}

describe("dependantsOf", () => {
  it("does not warn when another ENABLED provider still covers the line", () => {
    const mods = [mod("skyui-a"), mod("skyui-b"), mod("mcm")];
    const report = reportOf({ mcm: [line("SkyUI", ["skyui-a", "skyui-b"])] });
    expect(dependantsOf(report, mods, new Set(["skyui-a"]))).toEqual([]);
    // Both copies off: the line breaks, and each is named.
    expect(dependantsOf(report, mods, new Set(["skyui-a", "skyui-b"])).map((d) => [d.provider.id, d.dependants.map((m) => m.id)])).toEqual([
      ["skyui-a", ["mcm"]],
      ["skyui-b", ["mcm"]],
    ]);
  });

  it("does not count a DISABLED alternative as cover", () => {
    const mods = [mod("skyui-a"), mod("skyui-b", false), mod("mcm")];
    const report = reportOf({ mcm: [line("SkyUI", ["skyui-a", "skyui-b"])] });
    expect(dependantsOf(report, mods, new Set(["skyui-a"])).map((d) => d.dependants.map((m) => m.id))).toEqual([["mcm"]]);
  });

  it("warns when any one of the dependant's lines on this provider loses its last provider", () => {
    // A page line with an alternative, and a master line with none.
    const mods = [mod("ussep"), mod("ussep-copy"), mod("patch")];
    const report = reportOf({
      patch: [line("USSEP", ["ussep", "ussep-copy"]), { ...line("USSEP.esp", ["ussep"]), source: "master", master: "USSEP.esp" }],
    });
    expect(dependantsOf(report, mods, new Set(["ussep"])).map((d) => d.dependants.map((m) => m.id))).toEqual([["patch"]]);
  });
});

describe("dependantClosure", () => {
  it("offers the dependants of the dependants: disabling C breaks B, and disabling B breaks A", () => {
    const mods = [mod("a"), mod("b"), mod("c"), mod("d")];
    const report = reportOf({
      a: [line("B", ["b"])],
      b: [line("C", ["c"])],
      // D needs B too, but another enabled mod covers it.
      d: [line("B or E", ["b", "e"])],
    });
    const withE = [...mods, mod("e")];
    expect(dependantsOf(report, withE, new Set(["c"])).flatMap((x) => x.dependants.map((m) => m.id))).toEqual(["b"]);
    expect(dependantClosure(report, withE, new Set(["c"])).map((m) => m.id)).toEqual(["b", "a"]);
  });

  it("never includes the mods being disabled, a disabled mod, or loops on a cycle", () => {
    const mods = [mod("x"), mod("y"), mod("z", false)];
    const report = reportOf({ x: [line("Y", ["y"])], y: [line("X", ["x"])], z: [line("X", ["x"])] });
    expect(dependantClosure(report, mods, new Set(["x"])).map((m) => m.id)).toEqual(["y"]);
  });
});
