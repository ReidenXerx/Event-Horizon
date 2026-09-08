/**
 * Every case here is drawn from a real 354,819-file capture of a 1755-mod
 * collection. The exclusions and the KEEPS matter equally: an over-broad rule
 * silently stops verifying content, which is the failure this list is one
 * careless line away from.
 */
import { describe, expect, it } from "vitest";

import { isVolatileFile, volatileReason } from "./volatileFiles";

describe("files nothing installs", () => {
  it("excludes a script-extender plugin log", () => {
    // The file that started this: 460 bytes for the curator, 462 for the user,
    // and a healthy mod reported as needing repair because of it.
    expect(volatileReason("SKSE/Plugins/BugFixesSSE.log")).toBe("runtime-log");
    expect(volatileReason("skse/plugins/MuJointFix.log")).toBe("runtime-log");
  });

  it("excludes a runtime log that is NOT under SKSE/Plugins", () => {
    // The case a path-scoped rule would have missed, and the reason the rule
    // is by name rather than by directory.
    expect(volatileReason("textures/aatj/armor/debug.log")).toBe("runtime-log");
  });

  it("covers Fallout 4 by the same rule, with no per-game list", () => {
    expect(volatileReason("F4SE/Plugins/f4se.log")).toBe("runtime-log");
  });

  it("excludes Windows and macOS folder junk", () => {
    expect(volatileReason("textures/armor/mongol/thumbs.db")).toBe(
      "windows-thumbnail-cache",
    );
    expect(volatileReason("Textures/armor/Pink/Thumbs.db")).toBe(
      "windows-thumbnail-cache",
    );
    expect(volatileReason("Sound/Voice/Quest.esp/desktop.ini")).toBe(
      "windows-folder-metadata",
    );
    expect(volatileReason("meshes/.DS_Store")).toBe("macos-finder-metadata");
  });

  it("matches whichever separator the caller happens to use", () => {
    // Manifest paths arrive with "/", a Windows staging walk produces "\".
    // A rule that only handles one works on the build side and not the other.
    expect(isVolatileFile("SKSE\\Plugins\\BugFixesSSE.log")).toBe(true);
    expect(isVolatileFile("SKSE/Plugins/BugFixesSSE.log")).toBe(true);
  });

  describe("things that LOOK volatile and are shipped content", () => {
    it("keeps .bak files — mod authors ship them", () => {
      // 18 in the real capture, including a FaceGen mesh and an MCM settings
      // backup. Excluding these would stop verifying real content.
      expect(isVolatileFile("Meshes/actors/character/FaceGeom/00000D63.NIF.bak")).toBe(false);
      expect(isVolatileFile("MCM/config/BetterThirdPersonSelection/settings.ini.bak")).toBe(false);
      expect(isVolatileFile("textures/4uplod-t/Shifu.dds.bak")).toBe(false);
    });

    it("keeps .old files", () => {
      expect(
        isVolatileFile(
          "SKSE/Plugins/DynamicStringDistributor/ccBGSSSE001-Fish.esm/CCfishingacti10.json.old",
        ),
      ).toBe(false);
    });

    it("keeps numbered extensions — Nemesis ships OpenSSL CA files as .0", () => {
      // The guess that would have been wrong: `.1` reads like a rotated log
      // and is in fact `Nemesis_Engine/Lib/test/cfgparser.1`.
      expect(isVolatileFile("Nemesis_Engine/Lib/test/capath/0e4015b9.0")).toBe(false);
      expect(isVolatileFile("Nemesis_Engine/Lib/test/cfgparser.1")).toBe(false);
      expect(isVolatileFile("Nemesis_Engine/Lib/test/cfgparser.3")).toBe(false);
    });

    it("keeps StorageUtilData json — those are authored lists", () => {
      expect(
        isVolatileFile("SKSE/Plugins/StorageUtilData/CraftingAnimations/EnchantmentList.json"),
      ).toBe(false);
    });

    it("keeps a crash logger's own files — only its output would be a log", () => {
      expect(isVolatileFile("SKSE/plugins/CrashLogger.ini")).toBe(false);
      expect(isVolatileFile("SKSE/Plugins/CrashLogger.dll")).toBe(false);
      expect(isVolatileFile("SKSE/Plugins/CrashLogger.pdb")).toBe(false);
    });

    it("keeps ordinary mod content", () => {
      for (const p of [
        "meshes/actors/character/character assets/femalebody_1.nif",
        "SOSRaceMenu.esp",
        "Scripts/BYOH_TIF__01015D0E.pex",
        "textures/impactdecals/decalsparkburn01.dds",
        "readme.txt",
      ]) {
        expect(isVolatileFile(p)).toBe(false);
      }
    });
  });

  it("says nothing about an empty or directory-shaped path", () => {
    expect(volatileReason("")).toBeUndefined();
    expect(volatileReason("meshes/")).toBeUndefined();
  });
});
