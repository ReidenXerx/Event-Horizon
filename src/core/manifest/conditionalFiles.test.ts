/**
 * Reapers RobCo Munitions Patches (69882:409332), Ivy 1.0.36, reported by
 * alasdairn 2026-09-28: a leveled-list file its installer creates only when a
 * 5.45mm weapon plugin is present. Ivy ships none, the curator's staging still
 * had the file, and the player was told the mod "could not be reproduced".
 */
import { describe, expect, it } from "vitest";

import {
  describeNeeds,
  evaluateCondition,
  installerConditionUnmet,
  pluginsWanted,
  type PluginState,
} from "./conditionalFiles";
import { parseModuleConfig } from "./parseModuleConfig";
import { parseManifest } from "./parseManifest";
import { stagedButConditionUnmet } from "./selfCheckMod";
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
