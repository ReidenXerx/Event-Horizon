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

  it("still PROVES it when the only extra is a file the archive cannot produce", async () => {
    /**
     * The tester report this exists for. `BeastHHBB - Patches and Addons`
     * staged ONE file, and the containment pass had already established the
     * archive cannot produce it at all (`shipsNothing: true` in the build
     * log). The curator had ticked nothing and pressed Finish.
     *
     * The proof used to refuse on any unpredicted staged file, so that single
     * stray file cost every user of the collection a FOMOD dialog they could
     * not answer. But selecting an option chooses among the ARCHIVE's files —
     * a file the archive does not contain cannot have arrived by ticking a
     * box, so it is silent on the question.
     *
     * It is still a real finding, reported by the containment pass under
     * `unexplained`, where the curator answers for it separately.
     */
    const r = await check([
      { path: "base.esp", size: 100, crc: "11111111" },
      // Nowhere in ENTRIES: cannot come from this archive by any selection.
      { path: "placeholder.txt", size: 74, crc: "deadbeef" },
    ]);

    expect(r.emptySelectionVerified).toBe(true);
    // And it says so, rather than quietly ignoring the file.
    expect(r.notes.join(" ")).toMatch(/cannot come from this archive at all/i);
    // The file is still reported as unexplained — two questions, two answers.
    expect(r.unexplained ?? 0).toBeGreaterThan(0);
  });

  it("REFUSES when a required file is absent from the curator's folder", async () => {
    // The other direction. Their folder is missing something a no-choice
    // install would create, so "nothing was picked" does not explain it.
    const r = await check([{ path: "patch.esp", size: 200, crc: "22222222" }]);

    expect(r.emptySelectionVerified).toBeUndefined();
    expect(r.notes.join(" ")).toMatch(/does NOT reproduce your folder/i);
  });

  /**
   * ─── AND THE CASE THAT EXCLUSION GOT WRONG ────────────────────────────
   * The rule above — "a file the archive cannot produce is silent on what was
   * ticked" — is true for a file the archive does not CONTAIN. It was applied
   * to every unexplained file, and that is a different set: `unexplained`
   * means "no archive entry with this CONTENT", which also covers a file the
   * archive contains and the curator then EDITED.
   *
   * That second kind is the opposite of silent. It shares a path with an
   * archive entry, so an installer option is exactly how it could have got
   * there — and editing the result of a ticked box is not exotic here, it is
   * the entire reason post-processing exists.
   *
   * These cases pass `{path, size}` with NO crc, which is what production
   * does (`runSelfChecks` builds staged refs from `mod.stagingFiles`, and
   * those carry sha256, never crc32). Containment then matches on size alone,
   * so any edit that changes a file's length lands in `unexplained`. The
   * fixtures above all supply a crc and therefore cannot reach this path at
   * all — GP-4, the case that cannot fail.
   */
  const checkNoCrc = (staged: Array<{ path: string; size: number }>) =>
    selfCheckMod({
      sevenZip: sevenZip(ENTRIES),
      modId: "m3",
      modName: "A FOMOD With Options",
      archivePath: "a.7z",
      staged,
      recordedChoices: [],
      readEntry: readScript,
    });

  it("REFUSES when the ticked file is present but EDITED", async () => {
    /**
     * The curator ticked "Optional Patch", then cleaned patch.esp in xEdit:
     * 200 bytes in the archive, 203 on disk. With no crc, containment cannot
     * match it, so it is `unexplained` — but the archive DOES hold a
     * `patch.esp`, so ticking the box is precisely how it got there.
     *
     * Excluding it made the proof vacuous: `extra` came back empty, the mod
     * shipped `emptySelectionVerified: true`, and every user replayed the
     * installer with nothing ticked and received a mod without the patch —
     * verified clean, because the files that ARE there are correct (NS-8).
     */
    const r = await checkNoCrc([
      { path: "base.esp", size: 100 },
      { path: "patch.esp", size: 203 },
    ]);

    expect(r.emptySelectionVerified).toBeUndefined();
    expect(r.notes.join(" ")).toMatch(/does NOT reproduce your folder/i);
  });

  it("still PROVES it when the edited file is one the archive never had", async () => {
    /**
     * The other half of the split, held at crc-less fidelity so it cannot
     * pass for the wrong reason. `placeholder.txt` shares neither a path nor
     * a basename with any archive entry, so no option could have placed it —
     * it stays excluded and the proof stands.
     */
    const r = await checkNoCrc([
      { path: "base.esp", size: 100 },
      { path: "placeholder.txt", size: 74 },
    ]);

    expect(r.emptySelectionVerified).toBe(true);
    expect(r.notes.join(" ")).toMatch(/cannot come from this archive at all/i);
  });

  it("REFUSES a proof that compared nothing at all", async () => {
    /**
     * Both `missing` and `extra` are empty when the two sets agree — and also
     * when there was nothing to compare. A mod whose archive holds only its
     * FOMOD script predicts no files, and a folder of purely foreign files is
     * entirely set aside, so `0 === 0` and the proof "succeeds" having
     * examined nothing.
     *
     * That is the "not checked read as a pass" shape, which this codebase has
     * now shipped under six different names. It is refused explicitly.
     */
    // No `requiredInstallFiles`: with nothing ticked this script installs
    // nothing at all, which is what makes `predicted` empty.
    const OPTIONAL_ONLY = `<config>
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
    const r = await selfCheckMod({
      sevenZip: sevenZip([
        { name: "fomod/ModuleConfig.xml", size: 10, crc: "0000000a" },
        { name: "optional/patch.esp", size: 200, crc: "22222222" },
      ]),
      modId: "m4",
      modName: "Nothing To Compare",
      archivePath: "a.7z",
      staged: [{ path: "hand-written.txt", size: 5 }],
      recordedChoices: [],
      readEntry: async () => Buffer.from(OPTIONAL_ONLY, "utf8"),
    });

    expect(r.emptySelectionVerified).toBeUndefined();
    expect(r.notes.join(" ")).toMatch(/nothing was compared/i);
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
