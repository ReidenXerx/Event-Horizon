import { describe, expect, it } from "vitest";

import {
  changeSections,
  diffSnapshots,
  movedInOrder,
  recordBuild,
  renderChangelogBbcode,
  renderChangelogMarkdown,
  snapshotManifest,
  summarizeEntry,
  type ChangelogSnapshot,
  type SnapshotMod,
} from "./changelog";
import type { EhcollManifest } from "../../types/ehcoll";

const mod = (over: Partial<SnapshotMod> & { compareKey: string; name: string }): SnapshotMod => ({
  enabled: true,
  delivery: "download",
  fomodSelections: [],
  ...over,
});

const snapshot = (over: Partial<ChangelogSnapshot> = {}): ChangelogSnapshot => ({
  schema: 1,
  version: "1.0.0",
  game: { version: "1.10.163.0", versionPolicy: "exact" },
  requiredExtensions: [],
  mods: [],
  plugins: [],
  loadOrder: [],
  rules: [],
  iniTweaks: [],
  gameIni: [],
  externalDependencies: [],
  ...over,
});

describe("movedInOrder", () => {
  it("names only the plugin that moved, not every plugin it jumped over", () => {
    expect(movedInOrder(["a", "b", "c", "d", "e"], ["e", "a", "b", "c", "d"])).toEqual(["e"]);
  });

  it("ignores additions and removals, which are not moves", () => {
    expect(movedInOrder(["a", "b", "c"], ["a", "new", "c"])).toEqual([]);
  });

  it("reports one of two swapped neighbours, since one move explains the swap", () => {
    expect(movedInOrder(["a", "b", "c"], ["a", "c", "b"])).toHaveLength(1);
  });
});

describe("diffSnapshots — mods", () => {
  it("calls a new file from the same Nexus page an update, not an addition and a removal", () => {
    const prev = snapshot({ mods: [mod({ compareKey: "nexus:10:100", name: "SkyUI", version: "5.1" })] });
    const next = snapshot({ mods: [mod({ compareKey: "nexus:10:200", name: "SkyUI", version: "5.2" })] });
    const c = diffSnapshots(prev, next);
    expect(c.mods.updated).toEqual([{ name: "SkyUI", from: "5.1", to: "5.2" }]);
    expect(c.mods.added).toEqual([]);
    expect(c.mods.removed).toEqual([]);
  });

  it("pairs updates by name when one page ships several installs", () => {
    const prev = snapshot({
      mods: [
        mod({ compareKey: "nexus:7:1", name: "Bodypaints - CBBE", version: "1.0" }),
        mod({ compareKey: "nexus:7:2", name: "Bodypaints - Male", version: "1.0" }),
      ],
    });
    const next = snapshot({
      mods: [
        mod({ compareKey: "nexus:7:4", name: "Bodypaints - Male", version: "1.1" }),
        mod({ compareKey: "nexus:7:3", name: "Bodypaints - CBBE", version: "1.1" }),
      ],
    });
    expect(diffSnapshots(prev, next).mods.updated.map((u) => u.name)).toEqual([
      "Bodypaints - Male",
      "Bodypaints - CBBE",
    ]);
  });

  it("lists added and removed mods with their versions", () => {
    const prev = snapshot({ mods: [mod({ compareKey: "nexus:1:1", name: "Old", version: "1" })] });
    const next = snapshot({ mods: [mod({ compareKey: "nexus:2:2", name: "New", version: "2" })] });
    const c = diffSnapshots(prev, next);
    expect(c.mods.added).toEqual([{ name: "New", version: "2" }]);
    expect(c.mods.removed).toEqual([{ name: "Old", version: "1" }]);
  });

  it("sees a mod re-installed with other installer options, and does not also report its files", () => {
    const step = (choice: string) => [{ name: "s", groups: [{ name: "g", choices: [{ name: choice, idx: 0 }] }] }];
    const prev = snapshot({
      mods: [mod({ compareKey: "nexus:3:3", name: "Lux", fomodSelections: step("a") as never, stagingShape: "x" })],
    });
    const next = snapshot({
      mods: [mod({ compareKey: "nexus:3:3", name: "Lux", fomodSelections: step("b") as never, stagingShape: "y" })],
    });
    expect(diffSnapshots(prev, next).mods.reconfigured).toEqual([
      { name: "Lux", reason: "installer-options" },
    ]);
  });

  it("sees files changed inside a mod whose identity did not change", () => {
    const prev = snapshot({ mods: [mod({ compareKey: "nexus:4:4", name: "Patch", stagingShape: "x" })] });
    const next = snapshot({ mods: [mod({ compareKey: "nexus:4:4", name: "Patch", stagingShape: "y" })] });
    expect(diffSnapshots(prev, next).mods.reconfigured).toEqual([
      { name: "Patch", reason: "staged-files" },
    ]);
  });

  it("counts a missing file list as not compared rather than unchanged", () => {
    const prev = snapshot({ mods: [mod({ compareKey: "nexus:4:4", name: "Patch" })] });
    const next = snapshot({ mods: [mod({ compareKey: "nexus:4:4", name: "Patch", stagingShape: "y" })] });
    const c = diffSnapshots(prev, next);
    expect(c.mods.reconfigured).toEqual([]);
    expect(c.unknown.stagedFiles).toBe(1);
  });

  it("reports switching on or off and a change of delivery", () => {
    const prev = snapshot({ mods: [mod({ compareKey: "nexus:5:5", name: "AAF", delivery: "download" })] });
    const next = snapshot({
      mods: [mod({ compareKey: "nexus:5:5", name: "AAF", delivery: "mirrored", enabled: false })],
    });
    const c = diffSnapshots(prev, next);
    expect(c.mods.disabled).toEqual(["AAF"]);
    expect(c.mods.delivery).toEqual([{ name: "AAF", from: "download", to: "mirrored" }]);
  });

  it("bridges an external mod to its Nexus identity by name, and counts that it did", () => {
    const prev = snapshot({ mods: [mod({ compareKey: "external:abc", name: "Lost Record", delivery: "manual" })] });
    const next = snapshot({ mods: [mod({ compareKey: "nexus:9:9", name: "Lost Record" })] });
    const c = diffSnapshots(prev, next);
    expect(c.mods.added).toEqual([]);
    expect(c.mods.removed).toEqual([]);
    expect(c.unknown.matchedByName).toBe(1);
  });
});

describe("diffSnapshots — the rest of the package", () => {
  it("covers plugins, load order, rules, game settings, prerequisites and requirements", () => {
    const prev = snapshot({
      mods: [
        mod({ compareKey: "nexus:1:1", name: "A" }),
        mod({ compareKey: "nexus:2:2", name: "B" }),
        mod({ compareKey: "nexus:3:3", name: "C" }),
      ],
      plugins: [
        { name: "A.esp", enabled: true, light: false },
        { name: "B.esp", enabled: true },
        { name: "Gone.esp", enabled: true },
      ],
      loadOrder: ["nexus:1:1", "nexus:2:2", "nexus:3:3"],
      rules: ["nexus:1:1|after|nexus:2"],
      gameIni: [{ file: "Fallout4.ini", section: "Display", key: "iShadowMapResolution", value: "2048" }],
      externalDependencies: [{ id: "f4se", name: "F4SE", version: "0.6.21" }],
    });
    const next = snapshot({
      game: { version: "1.10.984.0", versionPolicy: "exact" },
      requiredExtensions: ["loot"],
      mods: prev.mods,
      plugins: [
        { name: "b.esp", enabled: false },
        { name: "A.esp", enabled: true, light: true },
        { name: "New.esp", enabled: true },
      ],
      loadOrder: ["nexus:3:3", "nexus:1:1", "nexus:2:2"],
      rules: ["nexus:3:3|before|nexus:1:1"],
      gameIni: [{ file: "fallout4.ini", section: "display", key: "iShadowMapResolution", value: "4096" }],
      externalDependencies: [{ id: "f4se", name: "F4SE", version: "0.7.2" }],
    });
    const c = diffSnapshots(prev, next);
    expect(c.plugins.added).toEqual(["New.esp"]);
    expect(c.plugins.removed).toEqual(["Gone.esp"]);
    // Plugin names are matched without case, as the game matches them.
    expect(c.plugins.disabled).toEqual(["b.esp"]);
    expect(c.plugins.madeLight).toEqual(["A.esp"]);
    expect(c.plugins.moved).toHaveLength(1);
    expect(c.loadOrderMoved).toEqual(["C"]);
    expect(c.rules.added).toEqual([{ mod: "C", type: "before", other: "A" }]);
    // A rule pinning a whole Nexus page still names the mod.
    expect(c.rules.removed).toEqual([{ mod: "A", type: "after", other: "B" }]);
    expect(c.gameIni.changed).toEqual([
      { file: "fallout4.ini", section: "display", key: "iShadowMapResolution", value: "4096", from: "2048" },
    ]);
    expect(c.prerequisites.updated).toEqual([{ name: "F4SE", from: "0.6.21", to: "0.7.2" }]);
    expect(c.requirements.game).toEqual({ from: "1.10.163.0 (exact)", to: "1.10.984.0 (exact)" });
    expect(c.requirements.extensionsAdded).toEqual(["loot"]);
  });
});

describe("snapshotManifest", () => {
  it("reduces a manifest to what the changelog compares", () => {
    const manifest = {
      package: { version: "1.0.26" },
      game: { version: "1.10.163.0", versionPolicy: "exact" },
      vortex: { requiredExtensions: [{ id: "loot", minVersion: "1.0" }] },
      mods: [
        {
          compareKey: "nexus:1:1",
          name: "Nexus mod",
          version: "2.0",
          source: { kind: "nexus" },
          install: { fomodSelections: [] },
          state: { enabled: true, enabledINITweaks: ["b.ini", "a.ini"] },
        },
        {
          compareKey: "external:ab",
          name: "Bundled",
          source: { kind: "external", bundled: true },
          install: { fomodSelections: [], emptySelectionVerified: true },
          state: { enabled: false, stagingFiles: [{ path: "x.esp", size: 1 }] },
        },
        {
          compareKey: "nexus:3:3",
          name: "Mirrored",
          source: { kind: "nexus" },
          install: { fomodSelections: [] },
          state: { enabled: true, mirrored: true },
        },
      ],
      plugins: { order: [{ name: "x.esp", enabled: true, light: true }] },
      loadOrder: [
        { compareKey: "nexus:3:3", pos: 1, enabled: true },
        { compareKey: "nexus:1:1", pos: 0, enabled: true },
      ],
      rules: [
        { source: "nexus:1:1", type: "after", reference: "nexus:3:3" },
        { source: "nexus:1:1", type: "before", reference: "nexus:9", ignored: true },
      ],
      iniTweaks: [],
      gameIni: { files: [{ fileName: "Fallout4.ini", settings: [{ section: "General", key: "k", value: "v" }] }] },
      externalDependencies: [{ id: "f4se", name: "F4SE", version: "0.6.21" }],
    } as unknown as EhcollManifest;

    const s = snapshotManifest(manifest);
    expect(s.version).toBe("1.0.26");
    expect(s.requiredExtensions).toEqual(["loot 1.0"]);
    expect(s.mods.map((m) => m.delivery)).toEqual(["download", "bundled", "mirrored"]);
    expect(s.mods[0]!.iniTweaks).toEqual(["a.ini", "b.ini"]);
    expect(s.mods[1]!.enabled).toBe(false);
    expect(s.mods[1]!.emptySelectionVerified).toBe(true);
    expect(s.mods[1]!.stagingShape).toBeTypeOf("string");
    expect(s.loadOrder).toEqual(["nexus:1:1", "nexus:3:3"]);
    // An ignored rule is not part of what ships.
    expect(s.rules).toEqual(["nexus:1:1|after|nexus:3:3"]);
    expect(s.gameIni).toEqual([{ file: "Fallout4.ini", section: "General", key: "k", value: "v" }]);
  });
});

describe("recordBuild", () => {
  const v = (version: string, names: string[]): ChangelogSnapshot =>
    snapshot({
      version,
      mods: names.map((n, i) => mod({ compareKey: `nexus:${i + 1}:${n.length}`, name: n })),
    });

  it("writes a first release when there is nothing to compare with", () => {
    const { entry, history } = recordBuild(undefined, v("1.0.0", ["A", "B"]), { date: "2026-09-15T10:00:00Z" });
    expect(entry.firstRelease).toEqual({ mods: 2, plugins: 0 });
    expect(entry.changes).toBeUndefined();
    expect(history.entries).toHaveLength(1);
    expect(history.last?.version).toBe("1.0.0");
  });

  it("compares a new version with the last build and keeps the history", () => {
    const first = recordBuild(undefined, v("1.0.0", ["A"]), { date: "2026-09-14T10:00:00Z" });
    const second = recordBuild(first.history, v("1.0.1", ["A", "B"]), {
      date: "2026-09-15T10:00:00Z",
      notes: "Added B.",
    });
    expect(second.entry.changes?.mods.added).toEqual([{ name: "B" }]);
    expect(second.entry.notes).toBe("Added B.");
    expect(second.history.entries.map((e) => e.version)).toEqual(["1.0.1", "1.0.0"]);
  });

  it("compares a rebuild of the same version with the version before it, keeping its notes", () => {
    const first = recordBuild(undefined, v("1.0.0", ["A"]), { date: "2026-09-13T10:00:00Z" });
    const second = recordBuild(first.history, v("1.0.1", ["A", "B"]), {
      date: "2026-09-14T10:00:00Z",
      notes: "Added B.",
    });
    const rebuild = recordBuild(second.history, v("1.0.1", ["A", "B", "C"]), {
      date: "2026-09-15T10:00:00Z",
      notes: "   ",
    });
    expect(rebuild.entry.changes?.mods.added.map((m) => m.name)).toEqual(["B", "C"]);
    expect(rebuild.entry.notes).toBe("Added B.");
    expect(rebuild.history.entries.map((e) => e.version)).toEqual(["1.0.1", "1.0.0"]);
    expect(rebuild.history.beforeLast?.version).toBe("1.0.0");
  });

  it("starts from the package already on disk when the history began after it", () => {
    const { entry } = recordBuild(undefined, v("1.0.27", ["A", "B"]), {
      date: "2026-09-15T10:00:00Z",
      previousPackage: v("1.0.26", ["A"]),
    });
    expect(entry.changes?.mods.added).toEqual([{ name: "B" }]);
  });
});

describe("rendering", () => {
  const prev = snapshot({ mods: [mod({ compareKey: "nexus:1:1", name: "SkyUI", version: "5.1" })] });
  const next = snapshot({
    version: "1.0.1",
    mods: [
      mod({ compareKey: "nexus:1:2", name: "SkyUI", version: "5.2" }),
      mod({ compareKey: "nexus:2:2", name: "Lux", version: "6.5" }),
    ],
  });
  const { entry } = recordBuild(
    { schema: 1, entries: [], last: prev },
    next,
    { date: "2026-09-15T10:00:00Z", notes: "Lighting pass." },
  );

  it("says what a lone figure counts, in the singular when there is one", () => {
    const only = recordBuild(
      {
        schema: 1,
        entries: [],
        last: snapshot({
          mods: [mod({ compareKey: "nexus:1:1", name: "A" }), mod({ compareKey: "nexus:2:2", name: "B" })],
          plugins: [{ name: "A.esp", enabled: true }],
          rules: ["nexus:1:1|after|nexus:2:2"],
        }),
      },
      snapshot({
        version: "1.0.1",
        mods: [mod({ compareKey: "nexus:1:1", name: "A" })],
        plugins: [],
        rules: [],
      }),
      { date: "2026-09-15T10:00:00Z" },
    ).entry;
    expect(summarizeEntry(only)).toBe("1 mod removed, 1 plugin added or removed, 1 rule change.");
  });

  it("summarises the totals and names every group", () => {
    expect(summarizeEntry(entry)).toBe("1 mod added, 1 updated.");
    expect(changeSections(entry.changes!).map((s) => s.title)).toEqual(["Mods added", "Mods updated"]);
  });

  it("writes markdown with the curator's words above the generated list", () => {
    const md = renderChangelogMarkdown("Ivy's Panties", [entry]);
    expect(md.indexOf("Lighting pass.")).toBeLessThan(md.indexOf("### Mods added"));
    expect(md).toContain("## 1.0.1 (2026-09-15)");
    expect(md).toContain("- SkyUI: 5.1 → 5.2");
  });

  it("writes BBCode for Nexus, cutting long groups with a count of the rest", () => {
    const bb = renderChangelogBbcode(entry, 1);
    expect(bb).toContain("[size=4][b]Version 1.0.1[/b][/size]");
    expect(bb).toContain("[*]Lux 6.5");
    const many = recordBuild(
      { schema: 1, entries: [], last: snapshot() },
      snapshot({ version: "1.0.1", mods: ["A", "B", "C"].map((n, i) => mod({ compareKey: `nexus:${i + 1}:1`, name: n })) }),
      { date: "2026-09-15T10:00:00Z" },
    ).entry;
    expect(renderChangelogBbcode(many, 2)).toContain("[*]…and 1 more");
  });
});
