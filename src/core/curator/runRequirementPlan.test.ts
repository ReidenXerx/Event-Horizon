/**
 * "Make it work" enables the mod it was for only when the plan covered its
 * chain. A skipped step, an unread page or a cut chain is a gap, and the
 * curator declined "Enable anyway" when they chose this path.
 */
import { describe, expect, it } from "vitest";

import type { InstallPlan, PlannedFile, PlannedInstall } from "./installPlan";
import type { CuratorMod } from "./profileActions";
import { planBlockers, runRequirementPlan, type PlanStepOutcome } from "./runRequirementPlan";

const step = (name: string, over: Partial<PlannedInstall> = {}): PlannedInstall => ({
  key: `skyrimspecialedition:${name}`,
  name,
  nexusModId: name.length,
  gameDomain: "skyrimspecialedition",
  vortexGameId: "skyrimse",
  neededBy: ["Root"],
  depth: 1,
  ...over,
});
const withFile = (s: PlannedInstall): PlannedFile => ({ step: s, choice: { kind: "one", file: { file_id: 10, name: `${s.name} main` } } });
const noFile = (s: PlannedInstall): PlannedFile => ({ step: s, choice: { kind: "none" } });

const root: CuratorMod = { id: "root", name: "Root", enabled: false, modType: "" };
const provider: CuratorMod = { id: "prov", name: "Provider", enabled: false, modType: "" };

const planOf = (files: readonly PlannedFile[], over: Partial<InstallPlan> = {}): InstallPlan => ({
  steps: files.map((pf) => pf.step),
  toEnable: [provider],
  external: [],
  unfetched: [],
  truncated: false,
  ...over,
});

async function run(
  files: PlannedFile[],
  over: { plan?: Partial<InstallPlan>; installStep?: () => Promise<PlanStepOutcome>; signal?: AbortSignal } = {},
): Promise<{ lines: string[]; worked: boolean; enabled: string[] }> {
  const enabled: string[] = [];
  const report = await runRequirementPlan({
    rootName: "Root",
    plan: planOf(files, over.plan),
    files,
    picked: {},
    thenEnable: [root],
    signal: over.signal ?? new AbortController().signal,
    installStep: over.installStep ?? (async () => ({ ok: true, newModId: "new" })),
    enableMods: (mods) => enabled.push(...mods.map((m) => m.id)),
    onProgress: () => undefined,
  });
  return { lines: report.lines, worked: report.worked, enabled };
}

describe("the mod the plan was for", () => {
  it("comes on when every step installed and nothing was left out", async () => {
    const r = await run([withFile(step("A")), withFile(step("B"))]);
    expect(r.worked).toBe(true);
    expect(r.enabled).toEqual(["prov", "root"]);
  });

  it("stays off when a step had no file to install, and the report says so", async () => {
    // "none" is also what a failed file lookup produces: the requirement
    // was never installed, whatever the reason.
    const r = await run([withFile(step("A")), noFile(step("B"))]);
    expect(r.worked).toBe(false);
    expect(r.enabled).toEqual(["prov"]);
    expect(r.lines.join("\n")).toMatch(/Root left disabled: no file to install for B/);
  });

  it("stays off when a step is a page for a game this Vortex does not manage", async () => {
    const r = await run([withFile(step("A")), withFile(step("LE page", { vortexGameId: undefined }))]);
    expect(r.enabled).toEqual(["prov"]);
    expect(r.lines.join("\n")).toMatch(/LE page is a page for a game this Vortex is not managing/);
  });

  it("stays off when a page's own requirements were never read", async () => {
    const r = await run([withFile(step("A"))], { plan: { unfetched: ["A"] } });
    expect(r.enabled).toEqual(["prov"]);
    expect(r.lines.join("\n")).toMatch(/Nexus did not answer for A/);
  });

  it("stays off when the chain was cut at its depth cap", async () => {
    const r = await run([withFile(step("A"))], { plan: { truncated: true } });
    expect(r.enabled).toEqual(["prov"]);
    expect(r.lines.join("\n")).toMatch(/depth cap/);
  });

  it("stays off when a step did not install", async () => {
    const r = await run([withFile(step("A"))], { installStep: async () => ({ ok: false, why: "timed out", refused: false }) });
    expect(r.enabled).toEqual(["prov"]);
    expect(r.lines.join("\n")).toMatch(/1 requirement\(s\) did not install \(A\)/);
  });

  it("and nothing comes on when the run was stopped", async () => {
    const stop = new AbortController();
    stop.abort();
    const r = await run([withFile(step("A"))], { signal: stop.signal });
    expect(r.enabled).toEqual([]);
    expect(r.lines.join("\n")).toMatch(/Root left disabled: the run was stopped before A/);
  });
});

describe("planBlockers", () => {
  it("is empty for a plan that covers its chain", () => {
    const files = [withFile(step("A"))];
    expect(planBlockers(planOf(files), files, {})).toEqual([]);
  });

  it("names a choice the curator has not made", () => {
    const s = step("Two mains");
    const files: PlannedFile[] = [{ step: s, choice: { kind: "choose", candidates: [{ file_id: 1 }, { file_id: 2 }] } }];
    expect(planBlockers(planOf(files), files, {})).toEqual(["no file chosen for Two mains"]);
    expect(planBlockers(planOf(files), files, { [s.key]: 2 })).toEqual([]);
  });
});
