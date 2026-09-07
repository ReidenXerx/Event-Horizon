/**
 * ──────────────────────────────────────────────────────────────────────
 * "The curator picked nothing" — measured, not assumed.
 *
 * An empty `fomodSelections` is ambiguous, and both readings are wrong some
 * of the time:
 *
 *   - The curator ticked nothing and pressed Finish. Ordinary: FOMOD groups
 *     are frequently optional. Replaying that is correct and silent.
 *   - Vortex never kept the answers. Creating a mod variant without
 *     "Pre-populate installer options from existing mod" discards
 *     `installerChoices` outright — and all three zero-choice mods in a real
 *     1,755-mod collection are variants.
 *
 * Guessing the first installs LESS than the curator has. Guessing the second
 * stops a stranger's install with a dialog nobody can answer — which is what
 * happened, and answering it the curator's way made Vortex fail with ENOENT.
 *
 * So it is measured: replay the script with NO choices — which yields the
 * required files plus whatever holds with no flags set, i.e. exactly "picked
 * nothing" — and compare against the curator's folder BOTH ways.
 * ──────────────────────────────────────────────────────────────────────
 */
import { describe, expect, it } from "vitest";

import type { SevenZipApi, SevenZipListEntry } from "./sevenZip";
import { fakeSevenZip } from "./testing/fakeSevenZip";
import { selfCheckMod } from "./selfCheckMod";

const sevenZip = (entries: SevenZipListEntry[]): SevenZipApi =>
  fakeSevenZip({ entries });

/**
 * One required file, and one that only appears if an option is picked. That
 * split is what makes the two readings distinguishable at all.
 */
const SCRIPT = `<config>
  <requiredInstallFiles>
    <folder source="core" destination=""/>
  </requiredInstallFiles>
  <installSteps order="Explicit">
    <installStep name="Extras">
      <optionalFileGroups order="Explicit">
        <group name="Patches" type="SelectAny">
          <plugins order="Explicit">
            <plugin name="Optional Patch">
              <files><folder source="optional" destination=""/></files>
            </plugin>
          </plugins>
        </group>
      </optionalFileGroups>
    </installStep>
  </installSteps>
</config>`;

const ENTRIES: SevenZipListEntry[] = [
  { name: "fomod/ModuleConfig.xml", size: 10, crc: "0000000a" },
  { name: "core/base.esp", size: 100, crc: "11111111" },
  { name: "optional/patch.esp", size: 200, crc: "22222222" },
];

const readScript = async (): Promise<Buffer> => Buffer.from(SCRIPT, "utf8");

const check = (staged: Array<{ path: string; size: number; crc: string }>) =>
  selfCheckMod({
    sevenZip: sevenZip(ENTRIES),
    modId: "m1",
    modName: "A FOMOD With Options",
    archivePath: "a.7z",
    staged,
    // The whole point: NOTHING recorded.
    recordedChoices: [],
    readEntry: readScript,
  });

describe("emptySelectionVerified", () => {
  it("PROVES nothing was picked when the folder holds only the required files", async () => {
    const r = await check([{ path: "base.esp", size: 100, crc: "11111111" }]);

    expect(r.promptsUser).toBe(true);
    expect(r.emptySelectionVerified).toBe(true);
    expect(r.notes.join(" ")).toMatch(/reproduces your staging folder exactly/i);
  });

  it("REFUSES when the curator has a file no-choice cannot produce", async () => {
    /**
     * They picked the optional patch and Vortex forgot. Replaying "nothing"
     * here would install a thinner mod than the curator has — silently, with
     * every file verifying, because the files that ARE there are correct.
     */
    const r = await check([
      { path: "base.esp", size: 100, crc: "11111111" },
      { path: "patch.esp", size: 200, crc: "22222222" },
    ]);

    expect(r.emptySelectionVerified).toBeUndefined();
    expect(r.notes.join(" ")).toMatch(/does NOT reproduce your folder/i);
    // And it says what to do about it, because the curator can fix this.
    expect(r.notes.join(" ")).toMatch(/reinstall this mod, or bundle it/i);
  });

  it("REFUSES when a required file is absent from the curator's folder", async () => {
    // The other direction. Their folder is missing something a no-choice
    // install would create, so "nothing was picked" does not explain it.
    const r = await check([{ path: "patch.esp", size: 200, crc: "22222222" }]);

    expect(r.emptySelectionVerified).toBeUndefined();
    expect(r.notes.join(" ")).toMatch(/does NOT reproduce your folder/i);
  });

  it("says nothing about a mod whose archive has no installer", async () => {
    // The 1,454 mods in a real collection with an empty selection list and no
    // FOMOD at all. Claiming a verified empty selection for those would be
    // meaningless, and would put an empty options bag on every one of them.
    const r = await selfCheckMod({
      sevenZip: sevenZip([{ name: "base.esp", size: 100, crc: "11111111" }]),
      modId: "m2",
      modName: "A Plain Archive",
      archivePath: "a.7z",
      staged: [{ path: "base.esp", size: 100, crc: "11111111" }],
      recordedChoices: [],
      readEntry: readScript,
    });

    expect(r.promptsUser).toBeUndefined();
    expect(r.emptySelectionVerified).toBeUndefined();
  });
});
