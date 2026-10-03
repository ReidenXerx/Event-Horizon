/**
 * Which staged files a build leaves out as a tool's leftovers (owner,
 * 2026-10-03: "junk only"). Ivy 1.0.37 shipped `porcOverlays_en.txt.bak`,
 * which no archive produces, and two players were told PorcOverlays "could not
 * be reproduced".
 */
import { describe, expect, it } from "vitest";

import { findGeneratedFiles, hasGeneratedName } from "./generatedFiles";
import type { ArchiveListing } from "./archiveContents";

const archive = (...paths: string[]): ArchiveListing => ({
  entries: paths.map((path) => ({ path, size: 1, crc: "00000000" })),
  withCrc: paths.length,
  crcCoverage: 1,
});

describe("a tool's leftovers", () => {
  it("leaves out the .bak that started this, when the archive has no such file", () => {
    const listing = archive("Interface/Translations/porcOverlays_en.txt", "PorcOverlays.esl");
    expect(
      findGeneratedFiles(
        ["Interface/Translations/porcOverlays_en.txt", "Interface/Translations/porcOverlays_en.txt.bak", "PorcOverlays.esl"],
        listing,
      ),
    ).toEqual(["Interface/Translations/porcOverlays_en.txt.bak"]);
  });

  it("leaves out a .tmp, whatever its case", () => {
    expect(findGeneratedFiles(["F4SE/Plugins/Thing.TMP"], archive("F4SE/Plugins/Thing.dll"))).toEqual(["F4SE/Plugins/Thing.TMP"]);
  });

  it("KEEPS a .bak the author shipped, even where the installer moved it", () => {
    // volatileFiles.ts measured 18 shipped .bak files in one capture
    // (`00000D63.NIF.bak`, `settings.ini.bak`); FOMOD installers relocate them.
    const listing = archive("00 Core/meshes/facegen/00000D63.NIF.bak", "MCM/Config/X/settings.ini.bak");
    expect(
      findGeneratedFiles(["meshes/facegen/00000D63.nif.bak", "MCM/Config/X/settings.ini.bak"], listing),
    ).toEqual([]);
  });

  it("leaves everything else to the curator's question (NS-7: LOD, patches, BodySlide output ship)", () => {
    const listing = archive("Thing.esp");
    expect(
      findGeneratedFiles(["meshes/lod/tree.nif", "Thing - patch.esp", "CalienteTools/BodySlide/Config.xml", "MCM/Settings/Thing.ini"], listing),
    ).toEqual([]);
  });

  it("does not mistake a file named only '.bak' or a .bak folder for a leftover", () => {
    expect(hasGeneratedName(".bak")).toBe(false);
    expect(hasGeneratedName("backup.bak/readme.txt")).toBe(false);
    expect(hasGeneratedName("Data\\x.esp.bak")).toBe(true);
  });
});
