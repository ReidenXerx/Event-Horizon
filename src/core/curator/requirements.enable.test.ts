import { describe, expect, it } from "vitest";

import type { CuratorMod } from "./profileActions";
import { describeEnableQuestion, disabledProvidersFor, planEnable, type ModRequirement, type RequirementsReport } from "./requirements";

const mod = (id: string, enabled = false, version?: string): CuratorMod => ({
  id,
  name: id.toUpperCase(),
  enabled,
  modType: "",
  source: "nexus",
  ...(version === undefined ? {} : { version }),
});

const disabledLine = (name: string, satisfiedBy: string[]): ModRequirement => ({ source: "nexus", status: "installed-disabled", name, satisfiedBy });
const missingPage = (name: string, nexusModId: number): ModRequirement => ({
  source: "nexus",
  status: "missing",
  name,
  nexusModId,
  gameDomain: "skyrimspecialedition",
  vortexGameId: "skyrimse",
  satisfiedBy: [],
});
const missingMaster = (master: string): ModRequirement => ({ source: "master", status: "missing", name: master, master, plugin: "T.esp", satisfiedBy: [] });

function reportOf(lines: Record<string, ModRequirement[]>): RequirementsReport {
  return {
    byMod: new Map(Object.entries(lines).map(([modId, requirements]) => [modId, { modId, truncatedBy: 0, unfetched: false, requirements }])),
    requiredBy: new Map(),
    noUid: [],
  };
}

describe("planEnable", () => {
  it("walks the installed-but-disabled chain: T needs disabled P, P needs disabled Q — both come on", () => {
    const mods = [mod("t"), mod("p"), mod("q")];
    const report = reportOf({ t: [disabledLine("P", ["p"])], p: [disabledLine("Q", ["q"])], q: [] });
    expect(planEnable(report, mods, new Set(["t"])).providers.map((m) => m.id)).toEqual(["p", "q"]);
    // The old one-level name answers the same question now.
    expect(disabledProvidersFor(report, mods, new Set(["t"])).map((m) => m.id)).toEqual(["p", "q"]);
  });

  it("does not loop on a cycle, and never lists a target as its own provider", () => {
    const mods = [mod("t"), mod("p")];
    const report = reportOf({ t: [disabledLine("P", ["p"])], p: [disabledLine("T", ["t"])] });
    expect(planEnable(report, mods, new Set(["t"])).providers.map((m) => m.id)).toEqual(["p"]);
  });

  it("collects what is still missing along the chain, split by whether it can be installed from here", () => {
    const mods = [mod("t"), mod("p")];
    const report = reportOf({
      t: [disabledLine("P", ["p"]), missingMaster("Gone.esm")],
      p: [missingPage("MCM Helper", 53000)],
    });
    const plan = planEnable(report, mods, new Set(["t"]));
    expect(plan.installable.map((g) => [g.requirement.name, g.neededBy])).toEqual([["MCM Helper", "P"]]);
    expect(plan.gaps.map((g) => [g.requirement.name, g.neededBy])).toEqual([["Gone.esm", "T"]]);
  });
});

describe("describeEnableQuestion", () => {
  it("asks before enabling when the only gaps are missing masters — which used to enable silently", () => {
    const mods = [mod("t"), mod("p"), mod("q")];
    const report = reportOf({ t: [disabledLine("P", ["p"]), missingMaster("Gone.esm")], p: [disabledLine("Q", ["q"])], q: [] });
    const q = describeEnableQuestion(planEnable(report, mods, new Set(["t"])), "T", true);
    expect(q.kind).toBe("confirm");
    if (q.kind === "none") return;
    expect(q.text).toContain("Gone.esm");
    // The dialog says which providers come on with it.
    expect(q.text).toContain("P");
    expect(q.text).toContain("Q");
  });

  it("offers Make it work when something can be installed, and names the providers in that dialog too", () => {
    const mods = [mod("t"), mod("p")];
    const report = reportOf({ t: [disabledLine("P", ["p"]), missingPage("SkyUI", 12604)], p: [] });
    const plan = planEnable(report, mods, new Set(["t"]));
    const withDownload = describeEnableQuestion(plan, "T", true);
    expect(withDownload.kind).toBe("make-it-work");
    if (withDownload.kind !== "none") expect(withDownload.text).toMatch(/\bP\b/);
    // Without a download surface an installable page is a gap like any other.
    expect(describeEnableQuestion(plan, "T", false).kind).toBe("confirm");
  });

  it("asks nothing when nothing is missing", () => {
    const mods = [mod("t"), mod("p")];
    const report = reportOf({ t: [disabledLine("P", ["p"])], p: [] });
    expect(describeEnableQuestion(planEnable(report, mods, new Set(["t"])), "T", true)).toEqual({ kind: "none" });
  });
});
