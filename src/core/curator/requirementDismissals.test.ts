import { describe, expect, it } from "vitest";

import type { CuratorMod } from "./profileActions";
import type { ModRequirement, RequirementsReport } from "./requirements";
import {
  EMPTY_DISMISSALS,
  applyDismissals,
  dependentPageKey,
  dismissRequirement,
  parseDismissals,
  pruneStale,
  requirementKey,
  restoreRequirement,
  serializeDismissals,
} from "./requirementDismissals";

const mod = (over: Partial<CuratorMod>): CuratorMod => ({ id: "m", name: "M", enabled: true, modType: "", ...over });

const author = mod({ id: "author-v1", name: "Author's Patch", nexusModId: 500 });
const provider = mod({ id: "skyui", name: "SkyUI", nexusModId: 12604 });

const pageLine = (over: Partial<ModRequirement> = {}): ModRequirement => ({
  source: "nexus",
  status: "missing",
  name: "Author's Other Mod",
  nexusModId: 777,
  gameDomain: "skyrimspecialedition",
  url: "https://www.nexusmods.com/skyrimspecialedition/mods/777",
  notes: "for the patch",
  satisfiedBy: [],
  ...over,
});
const skyuiLine: ModRequirement = { source: "nexus", status: "satisfied", name: "SkyUI", nexusModId: 12604, gameDomain: "skyrimspecialedition", url: "u", satisfiedBy: ["skyui"] };
const masterLine: ModRequirement = { source: "master", status: "missing", name: "Missing.esm", plugin: "Patch.esp", master: "Missing.esm", satisfiedBy: [] };

function reportFor(modId: string, lines: ModRequirement[], requiredBy: Array<[string, string[]]> = []): RequirementsReport {
  return { byMod: new Map([[modId, { modId, requirements: lines, truncatedBy: 0, unfetched: false }]]), requiredBy: new Map(requiredBy), noUid: [] };
}

const pageKeyOf = (m: CuratorMod): string | undefined => dependentPageKey(m, "skyrimse", () => "skyrimspecialedition");

describe("dismissed requirements", () => {
  it("hides a dismissed line from the report and lists it for the panel", () => {
    const line = pageLine();
    const store = dismissRequirement(EMPTY_DISMISSALS, pageKeyOf(author)!, line, new Date("2026-09-12T10:00:00Z"));
    const applied = applyDismissals({ report: reportFor(author.id, [line, skyuiLine]), mods: [author], store, pageKeyOf });
    expect(applied.report.byMod.get(author.id)!.requirements).toEqual([skyuiLine]);
    expect(applied.dismissedByMod.get(author.id)).toEqual([line]);
    expect(applied.stale).toEqual([]);
  });

  it("survives the mod being updated into a new Vortex install of the same page", () => {
    const line = pageLine();
    const store = dismissRequirement(EMPTY_DISMISSALS, pageKeyOf(author)!, line);
    const updated = mod({ id: "author-v2", name: "Author's Patch", nexusModId: 500 });
    const applied = applyDismissals({ report: reportFor(updated.id, [line]), mods: [updated], store, pageKeyOf });
    expect(applied.report.byMod.get(updated.id)!.requirements).toEqual([]);
  });

  it("stays dismissed when only this machine changes: installed, enabled, a different provider", () => {
    const store = dismissRequirement(EMPTY_DISMISSALS, pageKeyOf(author)!, pageLine());
    const nowInstalledDisabled = pageLine({ status: "installed-disabled", satisfiedBy: ["other"], name: "Installed copy name" });
    const applied = applyDismissals({ report: reportFor(author.id, [nowInstalledDisabled]), mods: [author], store, pageKeyOf });
    expect(applied.report.byMod.get(author.id)!.requirements).toEqual([]);
  });

  it("comes back when the requirement changes on Nexus, and that dismissal is marked to forget", () => {
    const store = dismissRequirement(EMPTY_DISMISSALS, pageKeyOf(author)!, pageLine());
    const edited = pageLine({ notes: "now actually required for the MCM" });
    const applied = applyDismissals({ report: reportFor(author.id, [edited]), mods: [author], store, pageKeyOf });
    expect(applied.report.byMod.get(author.id)!.requirements).toEqual([edited]);
    expect(applied.stale).toEqual([{ pageKey: "skyrimspecialedition:500", requirementKey: requirementKey(edited) }]);
    expect(pruneStale(store, applied.stale)).toEqual(EMPTY_DISMISSALS);
  });

  it("never dismisses a plugin master", () => {
    const store = dismissRequirement(EMPTY_DISMISSALS, pageKeyOf(author)!, masterLine);
    expect(store).toBe(EMPTY_DISMISSALS);
    const forged = { version: 1 as const, pages: { "skyrimspecialedition:500": { [requirementKey(masterLine)]: { fingerprint: "x", name: "x", dismissedAt: "" } } } };
    const applied = applyDismissals({ report: reportFor(author.id, [masterLine]), mods: [author], store: forged, pageKeyOf });
    expect(applied.report.byMod.get(author.id)!.requirements).toEqual([masterLine]);
  });

  it("a provider stops counting the mod as a dependant only when no remaining line points at it", () => {
    const dismissedSkyui = dismissRequirement(EMPTY_DISMISSALS, pageKeyOf(author)!, skyuiLine);
    const report = reportFor(author.id, [skyuiLine, pageLine()], [["skyui", [author.id, "someone-else"]]]);
    const applied = applyDismissals({ report, mods: [author, provider], store: dismissedSkyui, pageKeyOf });
    expect(applied.report.requiredBy.get("skyui")).toEqual(["someone-else"]);
    // The input report is not mutated.
    expect(report.requiredBy.get("skyui")).toEqual([author.id, "someone-else"]);
  });

  it("returns the same report when nothing is dismissed", () => {
    const report = reportFor(author.id, [pageLine()]);
    expect(applyDismissals({ report, mods: [author], store: EMPTY_DISMISSALS, pageKeyOf }).report).toBe(report);
  });

  it("restores one line and drops a page with nothing left", () => {
    const line = pageLine();
    const store = dismissRequirement(EMPTY_DISMISSALS, pageKeyOf(author)!, line);
    expect(restoreRequirement(store, "skyrimspecialedition:500", requirementKey(line))).toEqual(EMPTY_DISMISSALS);
  });

  it("reads its file back, and a damaged file costs the dismissals, not the page", () => {
    const store = dismissRequirement(EMPTY_DISMISSALS, pageKeyOf(author)!, pageLine(), new Date("2026-09-12T10:00:00Z"));
    expect(parseDismissals(serializeDismissals(store))).toEqual(store);
    expect(parseDismissals("{broken")).toEqual(EMPTY_DISMISSALS);
    expect(parseDismissals('{"pages":{"a:1":{"k":{"name":"no fingerprint"}},"b:2":[]}}')).toEqual(EMPTY_DISMISSALS);
  });

  it("keeps a dismissal per page, so a mod with no Nexus page has none", () => {
    expect(dependentPageKey(mod({ id: "loose" }), "skyrimse")).toBeUndefined();
  });
});
