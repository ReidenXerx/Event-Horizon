/**
 * Reapers RobCo Munitions Patches (69882:409332), Ivy 1.0.36, reported by
 * alasdairn 2026-09-28: a leveled-list file its installer creates only when a
 * 5.45mm weapon plugin is present. Ivy ships none, the curator's staging still
 * had the file, and the player was told the mod "could not be reproduced".
 */
import { describe, expect, it } from "vitest";

import {
  activePluginsFromState,
  describeNeeds,
  evaluateCondition,
  installerConditionUnmet,
  pluginsGatedOff,
  pluginWillBeActive,
  pluginsWanted,
  withGatedPluginsOff,
  type PluginState,
} from "./conditionalFiles";
import { parseModuleConfig } from "./parseModuleConfig";
import { parseManifest } from "./parseManifest";
import { stagedButConditionUnmet, stagedByPluginCondition } from "./selfCheckMod";
import type { FomodConditionalPattern } from "./fomodReplay";

const FILE = "F4SE/Plugins/RobCo_Patcher/LeveledList/Munitions - An Ammo Expansion.esl/5.45mm/Munitions - An Ammo Expansion.esl.ini";

const XML = `<config>
  <moduleName>Reapers RobCo Munitions Patches</moduleName>
  <requiredInstallFiles><file source="Base.ini" destination="F4SE/Plugins/RobCo_Patcher/base.ini"/></requiredInstallFiles>
  <conditionalFileInstalls><patterns>
    <pattern>
      <dependencies operator="Or">
        <fileDependency file="AK74M.esp" state="Active"/>
        <fileDependency file="SKS.esp" state="Active"/>
      </dependencies>
      <files><file source="545/545.ini" destination="${FILE}"/></files>
    </pattern>
    <pattern>
      <dependencies><gameDependency version="1.10"/></dependencies>
      <files><file source="game.ini" destination="game.ini"/></files>
    </pattern>
  </patterns></conditionalFileInstalls>
</config>`;

const states =
  (active: string[]): ((f: string) => PluginState) =>
  (f) =>
    active.includes(f.toLowerCase()) ? "Active" : "Missing";

describe("plugin-file conditions in a FOMOD", () => {
  it("parses an Or of plugin files into a condition, and leaves a game-version test unevaluated", async () => {
    const { script } = await parseModuleConfig(XML);
    const [p545, pGame] = script.conditionalPatterns;
    expect(p545!.condition).toEqual({
      kind: "any",
      terms: [
        { kind: "file", file: "ak74m.esp", state: "Active" },
        { kind: "file", file: "sks.esp", state: "Active" },
      ],
    });
    expect(pGame!.condition).toBeUndefined();
    // The replay's own view is unchanged: it still cannot use this pattern.
    expect(p545!.unsupportedDependencies).toContain("fileDependency");
  });

  it("evaluates And/Or over plugin states and flags", () => {
    const c = { kind: "any" as const, terms: [{ kind: "file" as const, file: "a.esp", state: "Active" }, { kind: "flag" as const, flag: "X", value: "On" }] };
    expect(evaluateCondition(c, {}, states([]))).toBe(false);
    expect(evaluateCondition(c, {}, states(["a.esp"]))).toBe(true);
    expect(evaluateCondition(c, { X: "on" }, states([]))).toBe(true);
    expect(pluginsWanted(c)).toEqual(["a.esp"]);
  });

  it("finds the staged file only an unmet plugin condition creates (the Reapers case)", async () => {
    const { script } = await parseModuleConfig(XML);
    const run = (active: string[], staged = ["F4SE/Plugins/RobCo_Patcher/base.ini", FILE]) =>
      stagedButConditionUnmet({
        patterns: script.conditionalPatterns,
        flags: {},
        pluginState: states(active),
        expanded: (specs) => specs.map((s) => ({ path: s.destination ?? s.source })),
        expectedKeys: new Set(["f4se/plugins/robco_patcher/base.ini"]),
        staged,
        key: (p) => p.toLowerCase(),
      });
    expect(run([])).toEqual([{ path: FILE, needs: ["ak74m.esp", "sks.esp"] }]);
    // With a 5.45mm plugin the installer DOES create it: nothing to explain.
    expect(run(["sks.esp"])).toEqual([]);
    // Not staged: nothing to explain either.
    expect(run([], ["F4SE/Plugins/RobCo_Patcher/base.ini"])).toEqual([]);
  });

  it("does not blame a file another, satisfied pattern also creates", () => {
    const file = (f: string) => ({ source: f, destination: f, priority: 0, isFolder: false });
    const pattern = (plugin: string): FomodConditionalPattern => ({
      flagDependencies: {},
      files: [file("x.ini")],
      unsupportedDependencies: ["fileDependency"],
      condition: { kind: "all", terms: [{ kind: "file", file: plugin, state: "Active" }] },
    });
    const out = stagedButConditionUnmet({
      patterns: [pattern("a.esp"), pattern("b.esp")],
      flags: {},
      pluginState: states(["b.esp"]),
      expanded: (specs) => specs.map((s) => ({ path: s.destination ?? s.source })),
      expectedKeys: new Set(),
      staged: ["x.ini"],
      key: (p) => p.toLowerCase(),
    });
    expect(out).toEqual([]);
  });

  it("tells the player's side when none of the needed plugins is active", () => {
    expect(installerConditionUnmet(["ak74m.esp", "sks.esp"], () => false)).toBe(true);
    expect(installerConditionUnmet(["ak74m.esp", "sks.esp"], (p) => p === "sks.esp")).toBe(false);
    expect(installerConditionUnmet([], () => false)).toBe(false);
    expect(describeNeeds(["a.esp"])).toBe("needs a.esp");
    expect(describeNeeds(["a.esp", "b.esp", "c.esp", "d.esp", "e.esp"])).toBe("needs one of a.esp, b.esp, c.esp and 2 more");
  });
});

describe("the manifest carries a staged file's installer condition", () => {
  const manifest = (stagingFiles: unknown[]) =>
    JSON.stringify({
      schemaVersion: 2,
      package: { id: "00000000-0000-4000-8000-000000000000", name: "t", version: "1.0.0", author: "a", createdAt: "2026-01-01T00:00:00.000Z", strictMissingMods: false },
      game: { id: "fallout4", version: "1.11.240", versionPolicy: "exact" },
      vortex: { version: "2.6.3", deploymentMethod: "hardlink", requiredExtensions: [] },
      mods: [
        {
          name: "t",
          compareKey: "nexus:1:2",
          source: { kind: "nexus", gameDomain: "fallout4", modId: 1, fileId: 2, archiveName: "t.zip", sha256: "a".repeat(64) },
          install: { fomodSelections: [] },
          state: { enabled: true, installOrder: 0, deploymentPriority: 0, stagingFiles },
        },
      ],
      rules: [],
      plugins: { order: [] },
      loadOrder: [],
      userlist: { plugins: [], groups: [] },
      iniTweaks: [],
      gameIni: { files: [] },
      externalDependencies: [],
    });

  it("keeps it through a parse, and drops a malformed one without failing", () => {
    const { manifest: m } = parseManifest(
      manifest([
        { path: "a.ini", size: 1, installerCondition: { needs: ["sks.esp"] } },
        { path: "b.ini", size: 1, installerCondition: { needs: "sks.esp" } },
        { path: "c.ini", size: 1 },
      ]),
    );
    const files = m.mods[0]!.state!.stagingFiles!;
    expect(files[0]).toEqual({ path: "a.ini", size: 1, installerCondition: { needs: ["sks.esp"] } });
    expect(files[1]).toEqual({ path: "b.ini", size: 1 });
    expect(files[2]).toEqual({ path: "c.ini", size: 1 });
  });
});

/**
 * Ivy CC patches (Fallout-collection, 2026-10-05): one installer, a patch per
 * Creation, each created only when that Creation is active. The curator owns
 * them all, so every condition HOLDS at build — and a player who owns none
 * must still not be told the mod could not be reproduced.
 */
describe("a patch hub for Creations the player may not own", () => {
  const file = (f: string) => ({ source: f, destination: f, priority: 0, isFolder: false });
  const pattern = (plugin: string, out: string): FomodConditionalPattern => ({
    flagDependencies: {},
    files: [file(out)],
    unsupportedDependencies: ["fileDependency"],
    condition: { kind: "all", terms: [{ kind: "file", file: plugin, state: "Active" }] },
  });
  const patterns = [
    pattern("ghoulification.esm", "Ivy - Ghoulification Patch.esp"),
    pattern("vchgs002fo4_bountyhunter.esl", "Ivy - Bounty Hunter Patch.esp"),
  ];
  const run = (active: string[]) =>
    stagedByPluginCondition({
      patterns,
      flags: {},
      pluginState: states(active),
      expanded: (specs) => specs.map((s) => ({ path: s.destination ?? s.source })),
      expectedKeys: new Set(),
      staged: ["Ivy - Ghoulification Patch.esp", "Ivy - Bounty Hunter Patch.esp"],
      key: (p) => p.toLowerCase(),
    });

  it("records the condition on a file the curator's plugins DO create", () => {
    const out = run(["ghoulification.esm", "vchgs002fo4_bountyhunter.esl"]);
    expect(out.unmet).toEqual([]);
    expect(out.held).toEqual([
      { path: "Ivy - Bounty Hunter Patch.esp", needs: ["vchgs002fo4_bountyhunter.esl"] },
      { path: "Ivy - Ghoulification Patch.esp", needs: ["ghoulification.esm"] },
    ]);
  });

  it("keeps the stale-file case exactly as it was", () => {
    const out = run(["ghoulification.esm"]);
    expect(out.unmet).toEqual([{ path: "Ivy - Bounty Hunter Patch.esp", needs: ["vchgs002fo4_bountyhunter.esl"] }]);
    expect(out.held).toEqual([{ path: "Ivy - Ghoulification Patch.esp", needs: ["ghoulification.esm"] }]);
  });

  const mods = [
    {
      source: { kind: "nexus" },
      state: {
        stagingFiles: [
          { path: "Ivy - Ghoulification Patch.esp", installerCondition: { needs: ["ghoulification.esm"] } },
          { path: "Ivy - Bounty Hunter Patch.esp", installerCondition: { needs: ["vchgs002fo4_bountyhunter.esl"] } },
          { path: "Textures/x.dds", installerCondition: { needs: ["ghoulification.esm"] } },
        ],
      },
    },
    {
      // Bundled: the curator's files ship whole, so its plugins are always there.
      source: { kind: "bundled", bundled: true },
      state: { stagingFiles: [{ path: "Bundled Patch.esp", installerCondition: { needs: ["ghoulification.esm"] } }] },
    },
  ];

  it("switches off, in the order compared, only the patches this player's installer correctly did not create", () => {
    const active = activePluginsFromState({ loadOrder: { "Ghoulification.esm": { enabled: true } } });
    const gated = pluginsGatedOff(mods, active);
    expect([...gated]).toEqual(["ivy - bounty hunter patch.esp"]);
    const order = [
      { name: "Fallout4.esm", enabled: true },
      { name: "Ivy - Ghoulification Patch.esp", enabled: true },
      { name: "Ivy - Bounty Hunter Patch.esp", enabled: true },
    ];
    expect(withGatedPluginsOff(order, gated)).toEqual([
      { name: "Fallout4.esm", enabled: true },
      { name: "Ivy - Ghoulification Patch.esp", enabled: true },
      { name: "Ivy - Bounty Hunter Patch.esp", enabled: false },
    ]);
  });
});

/**
 * Ivy's Creation Club Patches, BUNDLED (Nexus removed the page, 2026-10-06):
 * the Bounty patch needs the Creation AND Interesting NPCs; the Ghoul patch
 * needs Ghoulification. The install applies these to the bundled files.
 */
describe("a bundled patch hub's conditions", () => {
  const file = (f: string) => ({ source: f, destination: f, priority: 0, isFolder: false });
  const patterns: FomodConditionalPattern[] = [
    {
      flagDependencies: {},
      files: [file("Ivy - CC Bounty Hunter Patch.esp")],
      unsupportedDependencies: ["fileDependency"],
      condition: {
        kind: "all",
        terms: [
          { kind: "file", file: "vchgs002fo4_bountyhunter.esl", state: "Active" },
          { kind: "file", file: "3DNPC_FO4.esp", state: "Active" },
        ],
      },
    },
    {
      flagDependencies: {},
      files: [file("Ivy - CC Ghoulification Patch.esp")],
      unsupportedDependencies: ["fileDependency"],
      condition: { kind: "all", terms: [{ kind: "file", file: "ghoulification.esm", state: "Active" }] },
    },
  ];

  it("records an And of two plugins as all, and a single plugin as any", () => {
    const out = stagedByPluginCondition({
      patterns,
      flags: {},
      pluginState: states(["vchgs002fo4_bountyhunter.esl", "3dnpc_fo4.esp", "ghoulification.esm"]),
      expanded: (specs) => specs.map((s) => ({ path: s.destination ?? s.source })),
      expectedKeys: new Set(),
      staged: ["Ivy - CC Bounty Hunter Patch.esp", "Ivy - CC Ghoulification Patch.esp"],
      key: (p) => p.toLowerCase(),
    });
    expect(out.held).toEqual([
      { path: "Ivy - CC Bounty Hunter Patch.esp", needs: ["3DNPC_FO4.esp", "vchgs002fo4_bountyhunter.esl"], all: true },
      { path: "Ivy - CC Ghoulification Patch.esp", needs: ["ghoulification.esm"] },
    ]);
  });

  it("is unmet for an And when one plugin is missing, and for an Or only when all are", () => {
    const has = (p: string): boolean => p === "vchgs002fo4_bountyhunter.esl";
    expect(installerConditionUnmet(["3dnpc_fo4.esp", "vchgs002fo4_bountyhunter.esl"], has, true)).toBe(true);
    expect(installerConditionUnmet(["3dnpc_fo4.esp", "vchgs002fo4_bountyhunter.esl"], has)).toBe(false);
  });

  it("knows a plugin will be active from the collection itself, not Vortex's state mid-install", () => {
    const willBe = pluginWillBeActive({
      order: [
        { name: "3DNPC_FO4.esp", enabled: true },
        { name: "vchgs002fo4_bountyhunter.esl", enabled: true },
        { name: "ghoulification.esm", enabled: true },
        { name: "Off.esp", enabled: false },
      ],
      mods: [
        { compareKey: "nexus:1:1", state: { stagingFiles: [{ path: "3DNPC_FO4.esp" }] } },
        { compareKey: "nexus:2:2", state: { stagingFiles: [{ path: "Off.esp" }] } },
      ],
      notInstalled: () => new Set(),
      inData: (n) => n === "vchgs002fo4_bountyhunter.esl",
    });
    expect(willBe("3DNPC_FO4.esp")).toBe(true); // a collection mod ships it, installed later or not
    expect(willBe("vchgs002fo4_bountyhunter.esl")).toBe(true); // owned
    expect(willBe("ghoulification.esm")).toBe(false); // not owned
    expect(willBe("Off.esp")).toBe(false); // the curator had it off
  });

  it("a plugin only an uninstalled optional mod ships will not be active", () => {
    const out = new Set(["nexus:1:1"]);
    const willBe = pluginWillBeActive({
      order: [{ name: "3DNPC_FO4.esp", enabled: true }],
      mods: [{ compareKey: "nexus:1:1", state: { stagingFiles: [{ path: "3DNPC_FO4.esp" }] } }],
      notInstalled: () => out,
      inData: () => true,
    });
    expect(willBe("3DNPC_FO4.esp")).toBe(false);
  });

  it("gates a BUNDLED mod's patch whose condition this player does not meet", () => {
    const mods = [
      {
        source: { kind: "external", bundled: true },
        state: {
          stagingFiles: [
            { path: "Ivy - CC Bounty Hunter Patch.esp", installerCondition: { needs: ["3dnpc_fo4.esp", "vchgs002fo4_bountyhunter.esl"], all: true as const } },
            { path: "Ivy - CC Ghoulification Patch.esp", installerCondition: { needs: ["ghoulification.esm"] } },
          ],
        },
      },
    ];
    const active = (p: string): boolean => p === "3dnpc_fo4.esp" || p === "ghoulification.esm";
    expect([...pluginsGatedOff(mods, active)]).toEqual(["ivy - cc bounty hunter patch.esp"]);
  });

  it("carries all through a parse", () => {
    const m = JSON.parse(manifestWith([{ path: "a.esp", size: 1, installerCondition: { needs: ["x.esp", "y.esp"], all: true } }]));
    const { manifest } = parseManifest(JSON.stringify(m));
    expect(manifest.mods[0]!.state!.stagingFiles![0]!.installerCondition).toEqual({ needs: ["x.esp", "y.esp"], all: true });
  });
});

function manifestWith(stagingFiles: unknown[]): string {
  return JSON.stringify({
    schemaVersion: 2,
    package: { id: "00000000-0000-4000-8000-000000000000", name: "t", version: "1.0.0", author: "a", createdAt: "2026-01-01T00:00:00.000Z", strictMissingMods: false },
    game: { id: "fallout4", version: "1.11.240", versionPolicy: "exact" },
    vortex: { version: "2.6.3", deploymentMethod: "hardlink", requiredExtensions: [] },
    mods: [
      {
        name: "t",
        compareKey: "nexus:1:2",
        source: { kind: "nexus", gameDomain: "fallout4", modId: 1, fileId: 2, archiveName: "t.zip", sha256: "a".repeat(64) },
        install: { fomodSelections: [] },
        state: { enabled: true, installOrder: 0, deploymentPriority: 0, stagingFiles },
      },
    ],
    rules: [],
    plugins: { order: [] },
    loadOrder: [],
    userlist: { plugins: [], groups: [] },
    iniTweaks: [],
    gameIni: { files: [] },
    externalDependencies: [],
  });
}
