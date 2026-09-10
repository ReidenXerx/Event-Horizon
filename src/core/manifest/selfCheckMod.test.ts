import { describe, expect, it } from "vitest";

import type { SevenZipApi, SevenZipListEntry } from "./sevenZip";
import { fakeSevenZip } from "./testing/fakeSevenZip";
import { selfCheckMod, summarizeSelfChecks } from "./selfCheckMod";

function sevenZip(entries: SevenZipListEntry[], err?: Error): SevenZipApi {
  return fakeSevenZip({
    entries,
    ...(err !== undefined ? { listError: err } : {}),
  });
}

const SCRIPT = `<config>
  <installSteps order="Explicit">
    <installStep name="Theme">
      <optionalFileGroups order="Explicit">
        <group name="Body" type="SelectExactlyOne">
          <plugins order="Explicit">
            <plugin name="Atomic Muscle">
              <files><folder source="20 Bodies/00 AM" destination=""/></files>
            </plugin>
          </plugins>
        </group>
      </optionalFileGroups>
    </installStep>
  </installSteps>
</config>`;

const CHOICES = [
  { name: "Theme", groups: [{ name: "Body", choices: [{ name: "Atomic Muscle", idx: 0 }] }] },
];

const ARCHIVE_ENTRIES: SevenZipListEntry[] = [
  { name: "fomod/ModuleConfig.xml", size: 10, crc: "0000000a" },
  { name: "20 Bodies/00 AM/AAF/AM-actionData.xml", size: 430, crc: "11111111" },
  { name: "20 Bodies/00 AM/AAF/AM-otherData.xml", size: 431, crc: "22222222" },
];

const readScript = async (): Promise<Buffer> => Buffer.from(SCRIPT, "utf8");

/**
 * The same script, plus the one thing `SCRIPT` has never had: a question to
 * the game.
 *
 * A step's `<visible>` is the SILENT kind of dependency — it does not refuse
 * like `<moduleDependencies>` does, it just hides the step and installs a
 * different file set with no error for anything downstream to catch. It is
 * the reason `readsPluginState` exists, and no fixture in this file carried
 * one, so every test here agreed equally with code that kept the dependency
 * and code that threw it away.
 */
const SCRIPT_ASKING = `<config>
  <installSteps order="Explicit">
    <installStep name="Theme">
      <visible>
        <dependencies operator="And">
          <fileDependency file="AAF.esm" state="Active"/>
        </dependencies>
      </visible>
      <optionalFileGroups order="Explicit">
        <group name="Body" type="SelectExactlyOne">
          <plugins order="Explicit">
            <plugin name="Atomic Muscle">
              <files><folder source="20 Bodies/00 AM" destination=""/></files>
            </plugin>
          </plugins>
        </group>
      </optionalFileGroups>
    </installStep>
  </installSteps>
</config>`;

const readAskingScript = async (): Promise<Buffer> =>
  Buffer.from(SCRIPT_ASKING, "utf8");

describe("selfCheckMod", () => {
  it("detects a file the FOMOD says should exist but the curator lacks", async () => {
    // The real shape of the bug: a folder partially extracted on the curator's
    // machine, which would otherwise ship as the etalon.
    const r = await selfCheckMod({
      sevenZip: sevenZip(ARCHIVE_ENTRIES),
      modId: "m1", modName: "UAP",
      archivePath: "a.7z",
      staged: [{ path: "AAF/AM-actionData.xml", size: 430, crc: "11111111" }],
      recordedChoices: CHOICES,
      readEntry: readScript,
    });
    expect(r.depth).toBe("replayed");
    expect(r.missing).toEqual(["AAF/AM-otherData.xml"]);
  });

  it("reports nothing missing when staging is complete", async () => {
    const r = await selfCheckMod({
      sevenZip: sevenZip(ARCHIVE_ENTRIES),
      modId: "m1", modName: "UAP",
      archivePath: "a.7z",
      staged: [
        { path: "AAF/AM-actionData.xml", size: 430, crc: "11111111" },
        { path: "AAF/AM-otherData.xml", size: 431, crc: "22222222" },
      ],
      recordedChoices: CHOICES,
      readEntry: readScript,
    });
    expect(r.depth).toBe("replayed");
    expect(r.missing).toEqual([]);
  });

  it("matches staged paths case-insensitively", async () => {
    const r = await selfCheckMod({
      sevenZip: sevenZip(ARCHIVE_ENTRIES),
      modId: "m1", modName: "UAP",
      archivePath: "a.7z",
      staged: [
        { path: "aaf/am-actiondata.xml", size: 430, crc: "11111111" },
        { path: "AAF/AM-otherData.xml", size: 431, crc: "22222222" },
      ],
      recordedChoices: CHOICES,
      readEntry: readScript,
    });
    expect(r.missing).toEqual([]);
  });

  it("falls back to containment when there are no recorded choices", async () => {
    // Deriving a set we are not sure of would produce false "missing" claims.
    const r = await selfCheckMod({
      sevenZip: sevenZip(ARCHIVE_ENTRIES),
      modId: "m1", modName: "x",
      archivePath: "a.7z",
      staged: [{ path: "AAF/AM-actionData.xml", size: 430, crc: "11111111" }],
      recordedChoices: [],
      readEntry: readScript,
    });
    expect(r.depth).toBe("containment");
    expect(r.missing).toEqual([]);
    expect(r.notes.join(" ")).toMatch(/recorded FOMOD choices/i);
  });

  it("never reports a runtime log or desktop.ini as missing", async () => {
    /**
     * Four of six "missing files" findings on a real Skyrim build were a
     * `.log` a plugin writes beside itself or a `desktop.ini` Explorer drops
     * into a folder — each one telling the curator to reinstall a healthy mod.
     * Both are `isVolatileFile`, which the install side already skips.
     */
    const r = await selfCheckMod({
      sevenZip: sevenZip([
        ...ARCHIVE_ENTRIES,
        { name: "20 Bodies/00 AM/SKSE/Plugins/cbpc.log", size: 9, crc: "33333333" },
        { name: "20 Bodies/00 AM/AAF/desktop.ini", size: 9, crc: "44444444" },
      ]),
      modId: "m1", modName: "x",
      archivePath: "a.7z",
      staged: [
        { path: "AAF/AM-actionData.xml", size: 430, crc: "11111111" },
        { path: "AAF/AM-otherData.xml", size: 431, crc: "22222222" },
      ],
      recordedChoices: CHOICES,
      readEntry: readScript,
    });

    expect(r.depth).toBe("replayed");
    expect(r.missing).toEqual([]);
  });

  it("does NOT claim missing files when replay confidence is low", async () => {
    const r = await selfCheckMod({
      sevenZip: sevenZip(ARCHIVE_ENTRIES),
      modId: "m1", modName: "x",
      archivePath: "a.7z",
      staged: [{ path: "AAF/AM-actionData.xml", size: 430, crc: "11111111" }],
      // A step the script does not contain ⇒ low confidence.
      recordedChoices: [{ name: "Ghost Step", groups: [] }],
      readEntry: readScript,
    });
    expect(r.depth).toBe("containment");
    expect(r.missing).toEqual([]);
    expect(r.notes.join(" ")).toMatch(/confidence low/i);
  });

  it("KEEPS the plugin dependency when replay confidence is low", async () => {
    /**
     * ─── THE ONE THAT SHIPPED A TESTER THE WRONG FILES ─────────────────
     * Two questions, one return, and it used to answer both with silence:
     *
     *   "which files should be here?"  — a replay result, genuinely unsafe
     *                                    to report when confidence is low
     *   "does this installer ask the   — read straight off the parsed
     *    game about a plugin?"           script, and not a replay result
     *                                    at all
     *
     * Confidence is `warnings.length === 0 ? "high" : "low"`, so a single
     * warning lands here — and a script complex enough to warn is exactly
     * the kind that asks about plugins. On a real Skyrim collection `Helios`
     * (1292 dependency elements, 763 flagDependencys, 59 plugins named) and
     * `Better Animals` (names BSHeartland.esm) were both parsed correctly,
     * both dropped here, both installed in the first epoch, and both handed
     * a tester a silently wrong file set: `Helios_Obsidian.esp` and a
     * SkyPatcher ini simply absent, with nothing reporting an error.
     */
    const r = await selfCheckMod({
      sevenZip: sevenZip(ARCHIVE_ENTRIES),
      modId: "m1", modName: "x",
      archivePath: "a.7z",
      staged: [{ path: "AAF/AM-actionData.xml", size: 430, crc: "11111111" }],
      // A step the script does not contain ⇒ low confidence.
      recordedChoices: [{ name: "Ghost Step", groups: [] }],
      readEntry: readAskingScript,
    });

    expect(r.notes.join(" ")).toMatch(/confidence low/i);
    // Still refuses to accuse the folder — that half was always right.
    expect(r.missing).toEqual([]);
    // And now says what the script asked.
    expect(r.readsPluginState).toEqual(["aaf.esm"]);
  });

  it("reports an unreadable FOMOD script as unexamined, not as silence", async () => {
    /**
     * The archive opened and the script did not. Nothing was parsed, so
     * `readsPluginState` is absent — and absent reads as "asks nothing" to
     * the epoch planner unless something says otherwise. Same unanswered
     * question as a missing archive, reached a different way.
     */
    const r = await selfCheckMod({
      sevenZip: sevenZip(ARCHIVE_ENTRIES),
      modId: "m1", modName: "x",
      archivePath: "a.7z",
      staged: [{ path: "AAF/AM-actionData.xml", size: 430, crc: "11111111" }],
      recordedChoices: CHOICES,
      readEntry: async (): Promise<Buffer> => {
        throw new Error("archive entry is corrupt");
      },
    });

    expect(r.installerUnexamined).toBe(true);
    expect(r.readsPluginState).toBeUndefined();
  });

  it("degrades to containment when the archive has no FOMOD script", async () => {
    const r = await selfCheckMod({
      sevenZip: sevenZip([{ name: "a.esp", size: 1, crc: "aaaaaaaa" }]),
      modId: "m1", modName: "plain",
      archivePath: "a.7z",
      staged: [{ path: "a.esp", size: 1, crc: "aaaaaaaa" }],
      recordedChoices: CHOICES,
      readEntry: readScript,
    });
    expect(r.depth).toBe("containment");
    expect(r.notes.join(" ")).toMatch(/No FOMOD script/i);
  });

  it("skips, without throwing, when the archive cannot be listed", async () => {
    const r = await selfCheckMod({
      sevenZip: sevenZip([], new Error("corrupt")),
      modId: "m1", modName: "x",
      archivePath: "a.7z",
      staged: [{ path: "a", size: 1 }],
      recordedChoices: [],
      readEntry: readScript,
    });
    expect(r.depth).toBe("skipped");
    expect(r.notes.join(" ")).toMatch(/corrupt/);
  });

  it("skips when there is no archive or no staging", async () => {
    const noArchive = await selfCheckMod({
      sevenZip: sevenZip([]), modId: "m", modName: "n",
      archivePath: undefined, staged: [{ path: "a", size: 1 }],
      recordedChoices: [], readEntry: readScript,
    });
    expect(noArchive.depth).toBe("skipped");

    const noStaging = await selfCheckMod({
      sevenZip: sevenZip([]), modId: "m", modName: "n",
      archivePath: "a.7z", staged: [], recordedChoices: [], readEntry: readScript,
    });
    expect(noStaging.depth).toBe("skipped");
  });

  it("survives a readEntry that throws", async () => {
    const r = await selfCheckMod({
      sevenZip: sevenZip(ARCHIVE_ENTRIES),
      modId: "m1", modName: "x", archivePath: "a.7z",
      staged: [{ path: "AAF/AM-actionData.xml", size: 430, crc: "11111111" }],
      recordedChoices: CHOICES,
      readEntry: async () => { throw new Error("temp dir gone"); },
    });
    expect(r.depth).toBe("containment");
    expect(r.notes.join(" ")).toMatch(/temp dir gone/);
  });
});

describe("no-archive reporting", () => {
  // Three different problems used to share one sentence, and it sent the
  // curator to re-download files that were not the issue. Measured on a real
  // profile: 5 mods with no archiveId, 10 whose file is still on disk, 225
  // genuinely missing.
  const base = {
    sevenZip: fakeSevenZip({}),
    modId: "m", modName: "x",
    archivePath: undefined,
    staged: [{ path: "a.esp", size: 1 }],
    recordedChoices: [],
    readEntry: async () => undefined,
  };

  it("says re-downloading will not help when Vortex tracks no archive", async () => {
    const r = await selfCheckMod({ ...base, hasArchiveRecord: false });
    expect(r.depth).toBe("skipped");
    expect(r.notes[0]).toMatch(/no source archive recorded/i);
    expect(r.notes[0]).toMatch(/Re-downloading will not help/i);
  });

  it("points at the download record when the archive id does not resolve", async () => {
    const r = await selfCheckMod({ ...base, hasArchiveRecord: true });
    expect(r.depth).toBe("skipped");
    expect(r.notes[0]).toMatch(/no download record/i);
    // Leads with re-downloading, because that is the common case: 225 of the
    // 226 skips on the real profile land here and the file is usually gone.
    expect(r.notes[0]).toMatch(/needs\s+re-downloading/i);
  });
});

describe("summarizeSelfChecks", () => {
  it("counts depths and missing files across mods", () => {
    const lead = {
      path: "Textures/c.dds", dir: "Textures", dirTotal: 4, dirMissing: 1,
      confidence: "high" as const, reason: "3 of 4 installed",
    };
    const s = summarizeSelfChecks([
      { unexplainedExamples: [], modId: "1", modName: "a", depth: "replayed", notes: [], missing: ["x", "y"], unexplained: 0, omissionLeads: [], stagedCount: 5, expectedCount: 7 },
      { unexplainedExamples: [], modId: "2", modName: "b", depth: "containment", notes: [], missing: [], unexplained: 3, omissionLeads: [lead], stagedCount: 2, expectedCount: 0 },
      { unexplainedExamples: [], modId: "3", modName: "c", depth: "skipped", notes: [], missing: [], unexplained: 0, omissionLeads: [], stagedCount: 0, expectedCount: 0 },
    ]);
    expect(s).toEqual({
      replayed: 1, containment: 1, skipped: 1, modsWithMissing: 1, missingFiles: 2,
      modsWithOmissionLeads: 1, highConfidenceLeads: 1,
    });
  });
});
