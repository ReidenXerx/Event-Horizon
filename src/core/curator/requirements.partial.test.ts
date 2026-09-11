import { describe, expect, it } from "vitest";

import type { CuratorMod } from "./profileActions";
import {
  describeRequirementCell,
  makeModUid,
  parseGameList,
  partialProvidersToEnable,
  requirementCellCategory,
  resolveNexusRequirements,
  summarizeRequirements,
  uidsFor,
  type NexusModRequirements,
} from "./requirements";
import { buildRows, rowsForView } from "../../ui/pages/curator/workbench";

const GAMES = parseGameList(JSON.stringify([{ id: 1704, domain_name: "skyrimspecialedition" }]));

const mod = (over: Partial<CuratorMod> & { id: string }): CuratorMod => ({
  name: over.id,
  enabled: true,
  modType: "",
  source: "nexus",
  ...over,
});

/** "needs" requires Nexus page 500 on SSE; `providers` are the pool's installs of that page. */
function resolve(providers: CuratorMod[]) {
  const needs = mod({ id: "needs", nexusModId: 1 });
  const mods = [needs, ...providers];
  const { uidByMod } = uidsFor(mods, GAMES, "skyrimspecialedition");
  const fetched = new Map<string, Partial<NexusModRequirements>>([
    [makeModUid(1704, 1), { nexusRequirements: { totalCount: 1, nodes: [{ gameId: 1704, modId: 500, modName: "Bodypaints" }] } }],
  ]);
  const report = resolveNexusRequirements({ mods, activeGame: "skyrimspecialedition", games: GAMES, uidByMod, fetched });
  return { report, mods, entry: report.byMod.get("needs")!, line: report.byMod.get("needs")!.requirements[0]! };
}

describe("a required page with several files, some enabled", () => {
  const cbbe = mod({ id: "cbbe", nexusModId: 500, logicalFileName: "Barbarian Bodypaints - CBBE", version: "1.0" });
  const maleOld = mod({ id: "male-old", nexusModId: 500, logicalFileName: "Barbarian Bodypaints - Male", version: "1.0", enabled: false });
  const maleNew = mod({ id: "male-new", nexusModId: 500, logicalFileName: "Barbarian Bodypaints - Male", version: "1.1", enabled: false });

  it("is partly enabled — not missing, not plainly satisfied — with how many files are on", () => {
    const { line, entry, report } = resolve([cbbe, maleOld]);
    expect(line.status).toBe("partial");
    expect(line.files).toEqual({ enabled: 1, total: 2 });
    expect(requirementCellCategory(entry)).toBe("partial");
    expect(describeRequirementCell(entry)).toBe("1 partly enabled");
    expect(summarizeRequirements(report)).toMatchObject({ missing: 0, modsWithMissing: 0, installedDisabled: 0, partial: 1 });
  });

  it("does not put a partly enabled mod in the missing-requirements view", () => {
    const { report, mods } = resolve([cbbe, maleOld]);
    expect(rowsForView(buildRows(mods, report), "requirements").map((r) => r.mod.id)).toEqual([]);
  });

  it("enables one copy — the newest — of each file that has none enabled", () => {
    const { line, mods } = resolve([cbbe, maleOld, maleNew]);
    expect(partialProvidersToEnable(line, mods).map((m) => m.id)).toEqual(["male-new"]);
  });

  it("is satisfied when the only disabled installs are other copies of an enabled file", () => {
    const v51 = mod({ id: "v51", nexusModId: 500, logicalFileName: "SkyUI", version: "5.1" });
    const v52 = mod({ id: "v52", nexusModId: 500, logicalFileName: "SkyUI", version: "5.2", enabled: false });
    expect(resolve([v51, v52]).line.status).toBe("satisfied");
  });

  it("claims nothing about files it cannot tell apart", () => {
    const named = mod({ id: "named", nexusModId: 500, logicalFileName: "Main" });
    const anonymous = mod({ id: "anon", nexusModId: 500, enabled: false });
    expect(resolve([named, anonymous]).line.status).toBe("satisfied");
  });
});
