import { describe, expect, it } from "vitest";

import type { CuratorMod } from "../../../core/curator/profileActions";
import type { RequirementsReport } from "../../../core/curator/requirements";
import { buildRows, describeRowState, rowsForView, viewCounts, visibleViews } from "./workbench";

const mod = (over: Partial<CuratorMod> & { id: string; name: string }): CuratorMod => ({
  enabled: true,
  modType: "",
  source: "nexus",
  ...over,
});

const mods: CuratorMod[] = [
  mod({ id: "a", name: "A", nexusModId: 1, nexusFileId: 10, version: "1.0", newestVersion: "1.1", newestFileId: 11 }),
  mod({ id: "b", name: "B", nexusModId: 2, nexusFileId: 20, version: "2.0", newestVersion: "2.1", newestFileUnknown: true }),
  mod({ id: "c", name: "C", nexusModId: 3, nexusFileId: 30, version: "3.0", frozenAtVersion: "3.0" }),
  mod({ id: "d", name: "D", enabled: false, modType: "dinput" }),
  mod({ id: "e", name: "E", nexusModId: 3, nexusFileId: 30, version: "3.0" }),
  mod({ id: "f", name: "F", source: "user-generated" }),
];

const report: RequirementsReport = {
  byMod: new Map([
    [
      "a",
      {
        modId: "a",
        truncatedBy: 0,
        unfetched: false,
        requirements: [
          { source: "nexus", status: "missing", name: "Gone", satisfiedBy: [] },
          { source: "nexus", status: "satisfied", name: "C", satisfiedBy: ["c"] },
        ],
      },
    ],
    ["b", { modId: "b", truncatedBy: 0, unfetched: true, requirements: [] }],
  ]),
  requiredBy: new Map([["c", ["a"]]]),
  noUid: [],
};

describe("workbench rows", () => {
  const rows = buildRows(mods, report);

  it("derives every per-row fact once", () => {
    const byId = new Map(rows.map((r) => [r.mod.id, r]));
    expect(byId.get("a")!.update).toEqual({ from: "1.0", to: "1.1", toFileId: 11 });
    expect(byId.get("b")!.manual).toMatchObject({ from: "2.0", to: "2.1" });
    expect(byId.get("c")!.frozen).toEqual({ at: "3.0", updateWithheld: false });
    expect(byId.get("c")!.duplicateOf?.others).toEqual(["E"]);
    expect(byId.get("a")!.requirementCell).toBe("1 missing");
    expect(byId.get("b")!.requirementCell).toBe("not checked");
    expect(byId.get("c")!.requiredBy).toEqual(["a"]);
  });

  it("filters each view from the same rows", () => {
    const ids = (v: Parameters<typeof rowsForView>[1]): string[] => rowsForView(rows, v).map((r) => r.mod.id);
    expect(ids("all")).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(ids("updates")).toEqual(["a"]);
    expect(ids("manual")).toEqual(["b"]);
    expect(ids("frozen")).toEqual(["c"]);
    expect(ids("requirements")).toEqual(["a"]);
    expect(ids("dependants")).toEqual(["c"]);
    expect(ids("duplicates")).toEqual(["c", "e"]);
    expect(ids("disabled")).toEqual(["d"]);
    expect(ids("outside-data")).toEqual(["d"]);
    expect(ids("not-nexus")).toEqual(["d", "f"]);
  });

  it("shows only the chips that have something, and always All", () => {
    const counts = viewCounts(rows);
    expect(counts.all).toBe(6);
    expect(visibleViews(counts).map((v) => v.id)).toEqual([
      "all",
      "updates",
      "manual",
      "frozen",
      "requirements",
      "dependants",
      "duplicates",
      "disabled",
      "outside-data",
      "not-nexus",
    ]);
    const none = viewCounts(buildRows([mod({ id: "z", name: "Z" })], undefined));
    expect(visibleViews(none).map((v) => v.id)).toEqual(["all", "not-nexus"]);
  });

  it("says a row's state in one phrase, most important first", () => {
    const byId = new Map(rows.map((r) => [r.mod.id, r]));
    expect(describeRowState(byId.get("a")!)).toBe("update 1.1");
    expect(describeRowState(byId.get("c")!)).toBe("frozen");
    expect(describeRowState(byId.get("d")!)).toBe("disabled");
    expect(describeRowState({ ...byId.get("c")!, frozen: { at: "3.0", driftedTo: "3.1", updateWithheld: false } })).toBe(
      "frozen, drifted to 3.1",
    );
  });
});
