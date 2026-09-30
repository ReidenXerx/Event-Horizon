import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { KEEP, loadRestorePoints, planRestore, saveRestorePoint, type RestorePoint } from "./restorePoints";

const point = (over: Partial<RestorePoint> = {}): RestorePoint => ({
  id: "rp-1",
  at: "2026-09-30T00:00:00.000Z",
  verb: "mods.setEnabled",
  gameId: "fallout4",
  profileId: "p1",
  mods: {
    a: { enabled: true, name: "A" },
    b: { enabled: false, name: "B" },
    gone: { enabled: true, name: "Gone", archiveId: "arch-9" },
  },
  modRules: { a: [{ type: "after", reference: { id: "b" } }] },
  plugins: [
    { name: "A.esp", enabled: true },
    { name: "B.esp", enabled: false },
    { name: "Gone.esp", enabled: true },
  ],
  userlist: [{ name: "A.esp", group: "Main", after: ["B.esp"], req: [], inc: [] }],
  ...over,
});

describe("what restoring a point would change", () => {
  it("puts enabled states back, disables what came after, and names what cannot come back", () => {
    const plan = planRestore(point(), {
      mods: { a: { enabled: false, name: "A" }, b: { enabled: true, name: "B" }, fresh: { enabled: true, name: "Fresh" } },
      modRules: { a: [{ type: "after", reference: { id: "b" } }] },
      plugins: [
        { name: "B.esp", enabled: true },
        { name: "A.esp", enabled: false },
      ],
      userlist: [{ name: "A.esp", group: "Main", after: ["B.esp"], req: [], inc: [] }],
    });
    expect(plan.enable).toEqual(["a"]);
    expect(plan.disable.sort()).toEqual(["b", "fresh"]);
    expect(plan.installedSince).toEqual([{ id: "fresh", name: "Fresh" }]);
    expect(plan.removedSince).toEqual([{ id: "gone", name: "Gone", archiveId: "arch-9" }]);
    // Only plugins that still exist, in the point's order and state.
    expect(plan.pluginOrder).toEqual([
      { name: "A.esp", enabled: true },
      { name: "B.esp", enabled: false },
    ]);
    expect(plan.modRulesToAdd).toEqual([]);
    expect(plan.modRulesToRemove).toEqual([]);
  });

  it("undoes mod rules both ways, whatever order the rule's keys come in", () => {
    const plan = planRestore(point(), {
      mods: { a: { enabled: true, name: "A" }, b: { enabled: false, name: "B" } },
      modRules: { a: [{ reference: { id: "b" }, type: "before" }], b: [{ reference: { id: "a" }, type: "after" }] },
      plugins: [],
      userlist: [],
    });
    expect(plan.modRulesToRemove).toEqual([
      { modId: "a", rule: { reference: { id: "b" }, type: "before" } },
      { modId: "b", rule: { reference: { id: "a" }, type: "after" } },
    ]);
    expect(plan.modRulesToAdd).toEqual([{ modId: "a", rule: { type: "after", reference: { id: "b" } } }]);
  });

  it("removes LOOT rules added since and puts back the ones and the group taken away, case-blind", () => {
    const plan = planRestore(point(), {
      mods: { a: { enabled: true, name: "A" }, b: { enabled: false, name: "B" } },
      modRules: {},
      plugins: [],
      userlist: [
        { name: "a.esp", group: "Late", after: [], req: ["X.esm"], inc: [] },
        { name: "C.esp", after: ["a.esp"], req: [], inc: [] },
      ],
    });
    expect(plan.userlistToRemove).toEqual([
      { pluginId: "a.esp", reference: "x.esm", type: "requires" },
      { pluginId: "c.esp", reference: "a.esp", type: "after" },
    ]);
    expect(plan.userlistToAdd).toEqual([{ name: "A.esp", group: "Main", after: ["B.esp"], req: [], inc: [] }]);
  });

  it("changes nothing when nothing changed", () => {
    const p = point();
    const now = { mods: { a: p.mods.a!, b: p.mods.b!, gone: p.mods.gone! }, modRules: p.modRules, plugins: p.plugins, userlist: p.userlist };
    const plan = planRestore(p, now);
    expect([plan.enable, plan.disable, plan.modRulesToAdd, plan.modRulesToRemove, plan.userlistToAdd, plan.userlistToRemove]).toEqual([
      [],
      [],
      [],
      [],
      [],
      [],
    ]);
  });
});

describe("the restore-point file", () => {
  it(`keeps the newest ${KEEP}, newest first`, () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "eh-rp-")), "points.json");
    for (let i = 0; i < KEEP + 3; i++) saveRestorePoint(point({ id: `rp-${i}` }), file);
    const all = loadRestorePoints(file);
    expect(all).toHaveLength(KEEP);
    expect(all[0]!.id).toBe(`rp-${KEEP + 2}`);
  });

  it("reads a missing or broken file as no points", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-rp-"));
    expect(loadRestorePoints(path.join(dir, "none.json"))).toEqual([]);
    fs.writeFileSync(path.join(dir, "bad.json"), "{");
    expect(loadRestorePoints(path.join(dir, "bad.json"))).toEqual([]);
  });
});
