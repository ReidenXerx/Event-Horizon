/**
 * Ivy's Creation Club Patches, through the real self-check (2026-10-06).
 *
 * Every <fileDependency> pattern makes the replay "low confidence", and the
 * per-file conditions were computed only on the high-confidence path, so for
 * a real patch hub they were never recorded: Ivy 1.0.40 built with a plain
 * file list on both patches. The unit tests of the condition splitter passed
 * the whole time, because none of them went through `selfCheckMod`.
 */
import { describe, expect, it } from "vitest";

import { fakeSevenZip } from "./testing/fakeSevenZip";
import { selfCheckMod } from "./selfCheckMod";
import type { PluginState } from "./conditionalFiles";

const SCRIPT = `<config>
  <moduleName>Ivy - Creation Club Patches</moduleName>
  <conditionalFileInstalls><patterns>
    <pattern>
      <dependencies operator="And">
        <fileDependency file="vchgs002fo4_bountyhunter.esl" state="Active"/>
        <fileDependency file="3DNPC_FO4.esp" state="Active"/>
      </dependencies>
      <files><file source="Bounty/Ivy - CC Bounty Hunter Patch.esp" destination="Ivy - CC Bounty Hunter Patch.esp"/></files>
    </pattern>
    <pattern>
      <dependencies operator="And">
        <fileDependency file="ghoulification.esm" state="Active"/>
      </dependencies>
      <files><file source="Ghoul/Ivy - CC Ghoulification Patch.esp" destination="Ivy - CC Ghoulification Patch.esp"/></files>
    </pattern>
  </patterns></conditionalFileInstalls>
</config>`;

const entries = [
  { name: "fomod/ModuleConfig.xml", size: 10, crc: "0000000a" },
  { name: "Bounty/Ivy - CC Bounty Hunter Patch.esp", size: 100, crc: "11111111" },
  { name: "Ghoul/Ivy - CC Ghoulification Patch.esp", size: 200, crc: "22222222" },
];

const owned = new Set(["vchgs002fo4_bountyhunter.esl", "3dnpc_fo4.esp", "ghoulification.esm"]);
const pluginState = (f: string): PluginState => (owned.has(f.toLowerCase()) ? "Active" : "Missing");

const run = (scriptText: string) =>
  selfCheckMod({
    sevenZip: fakeSevenZip({ entries }),
    modId: "cc",
    modName: "Ivy - Creation Club Patches",
    archivePath: "cc.zip",
    staged: [
      { path: "Ivy - CC Bounty Hunter Patch.esp", size: 100, crc: "11111111" },
      { path: "Ivy - CC Ghoulification Patch.esp", size: 200, crc: "22222222" },
    ],
    recordedChoices: [],
    readEntry: async () => Buffer.from(scriptText, "utf8"),
    pluginState,
  });

describe("a patch hub's plugin conditions survive the low-confidence replay", () => {
  it("records both patches' conditions, the Bounty one as an And", async () => {
    const r = await run(SCRIPT);
    expect(r.installerConditionHeld).toEqual([
      { path: "Ivy - CC Bounty Hunter Patch.esp", needs: ["3dnpc_fo4.esp", "vchgs002fo4_bountyhunter.esl"], all: true },
      { path: "Ivy - CC Ghoulification Patch.esp", needs: ["ghoulification.esm"] },
    ]);
  });

  it("records nothing when something else the replay cannot evaluate could also place the files", async () => {
    const withGame = SCRIPT.replace(
      `<fileDependency file="ghoulification.esm" state="Active"/>`,
      `<fileDependency file="ghoulification.esm" state="Active"/><gameDependency version="1.10.163"/>`,
    );
    const r = await run(withGame);
    expect(r.installerConditionHeld ?? []).toEqual([]);
  });
});
