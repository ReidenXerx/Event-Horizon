/**
 * The player's own preferences stay the player's (Ivy Rev 26, alasdairn,
 * 2026-10-25: an install set 15 of their Fallout4Prefs.ini values to the
 * curator's — difficulty, crosshair, every volume slider, bFreebiesSeen 1→0).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import {
  captureGameIni,
  describeMachineKept,
  iniPatternProblem,
  isPersonalSetting,
  matchesIniPattern,
  parseIni,
  PERSONAL_RULES_VERSION,
  splitByOwnership,
} from "./gameIni";
import { applyGameIni } from "../installer/applyGameIni";

/** The 15 keys alasdairn's receipt shows, in their sections. */
const REV26 = [
  ["MAIN", "bCrosshairEnabled"],
  ["General", "bFreebiesSeen"],
  ["GamePlay", "iDifficulty"],
  ["AudioMenu", "fAudioMasterVolume"],
  ["AudioMenu", "fVal7"],
  ["AudioMenu", "uID7"],
] as const;

describe("isPersonalSetting", () => {
  it("names every key Rev 26 overwrote", () => {
    for (const [section, key] of REV26) expect(isPersonalSetting(section, key)).toBe(true);
  });

  it("judges the section too: the same name elsewhere is the collection's", () => {
    expect(isPersonalSetting("Archive", "bInvalidateOlderFiles")).toBe(false);
    expect(isPersonalSetting("General", "uGridsToLoad")).toBe(false);
    expect(isPersonalSetting("Papyrus", "fUpdateBudgetMS")).toBe(false);
    // iDifficulty is personal only under GamePlay.
    expect(isPersonalSetting("Display", "iDifficulty")).toBe(false);
  });

  it("matches prefixes and whole sections", () => {
    expect(isPersonalSetting("interface", "iHUDColorR")).toBe(true);
    expect(isPersonalSetting("VATS", "fModMenuEffectHighlightColorB")).toBe(true);
    expect(isPersonalSetting("Controls", "fMouseHeadingSensitivity")).toBe(true);
    expect(isPersonalSetting("Bethesda.net", "uPersistentUuidData0")).toBe(true);
    expect(isPersonalSetting("MAIN", "bSaveOnTravel")).toBe(true);
  });
});

describe("the curator's patterns", () => {
  it("match File:Section:Key with * anywhere, case-insensitively", () => {
    expect(matchesIniPattern("Fallout4Prefs.ini:AudioMenu:*", "fallout4prefs.ini", "AudioMenu", "fVal7")).toBe(true);
    expect(matchesIniPattern("*:General:bFreebiesSeen", "Fallout4Prefs.ini", "general", "BFREEBIESSEEN")).toBe(true);
    expect(matchesIniPattern("*:Display:f*", "Fallout4.ini", "Display", "fShadowDistance")).toBe(true);
    expect(matchesIniPattern("Fallout4.ini:General:*", "Fallout4Prefs.ini", "General", "x")).toBe(false);
    // A dot is a dot, not any character.
    expect(matchesIniPattern("Fallout4.ini:*:*", "Fallout4xini", "General", "x")).toBe(false);
  });

  it("say what is wrong with a malformed pattern", () => {
    expect(iniPatternProblem("AudioMenu:*")).toMatch(/File:Section:Key/);
    expect(iniPatternProblem("a::b")).toMatch(/File:Section:Key/);
    expect(iniPatternProblem("*:General:bFreebiesSeen")).toBeUndefined();
  });
});

describe("splitByOwnership with a file and the curator's trim", () => {
  const settings = parseIni(
    [
      "[Display]",
      "iSize W=1920",
      "fShadowDistance=3000",
      "[General]",
      "uGridsToLoad=5",
      "bFreebiesSeen=1",
      "[AudioMenu]",
      "fVal7=0.1",
      "[Interface]",
      "iHUDColorR=255",
    ].join("\n"),
  );

  it("leaves personal keys out by default", () => {
    const r = splitByOwnership(settings, { fileName: "Fallout4Prefs.ini" });
    expect(r.collection.map((s) => s.key)).toEqual(["fShadowDistance", "uGridsToLoad"]);
    expect(r.personal.map((s) => s.key)).toEqual(["bFreebiesSeen", "fVal7", "iHUDColorR"]);
    expect(r.machine.map((s) => s.key)).toEqual(["iSize W"]);
  });

  it("include ships a personal key, exclude drops any key, exclude wins, hardware never ships", () => {
    const r = splitByOwnership(settings, {
      fileName: "Fallout4Prefs.ini",
      filter: {
        include: ["*:Interface:iHUDColor*", "*:General:bFreebiesSeen", "*:Display:iSize W"],
        exclude: ["*:Display:fShadowDistance", "*:General:bFreebiesSeen"],
      },
    });
    expect(r.collection.map((s) => s.key)).toEqual(["uGridsToLoad", "iHUDColorR"]);
    expect(r.excluded.map((s) => s.key)).toEqual(["fShadowDistance", "bFreebiesSeen"]);
    expect(r.machine.map((s) => s.key)).toEqual(["iSize W"]);
  });
});

describe("a build and an install, on real files", () => {
  const setup = () => {
    const docs = fs.mkdtempSync(path.join(os.tmpdir(), "eh-ini-personal-"));
    const dir = path.join(docs, "My Games", "Fallout4");
    fs.mkdirSync(dir, { recursive: true });
    return { docs, dir };
  };

  it("the build ships uGridsToLoad, not the curator's difficulty, and says so", async () => {
    const { docs, dir } = setup();
    fs.writeFileSync(
      path.join(dir, "Fallout4Prefs.ini"),
      ["[General]", "uGridsToLoad=5", "bFreebiesSeen=0", "[GamePlay]", "iDifficulty=3"].join("\r\n"),
    );
    const capture = await captureGameIni({ gameId: "fallout4", documentsPath: docs });
    const prefs = capture.files.find((f) => f.fileName === "Fallout4Prefs.ini")!;
    expect(prefs.settings.map((s) => s.key)).toEqual(["uGridsToLoad"]);
    expect(describeMachineKept(capture).join(" ")).toMatch(/2 INI setting\(s\) are your own preferences.*\[GamePlay\] iDifficulty/);
    fs.rmSync(docs, { recursive: true, force: true });
  });

  it("an install of a package built before the list leaves the player's preferences alone", async () => {
    const { docs, dir } = setup();
    const file = path.join(dir, "Fallout4Prefs.ini");
    fs.writeFileSync(file, ["[General]", "uGridsToLoad=5", "bFreebiesSeen=1", "[GamePlay]", "iDifficulty=4"].join("\n"));
    const receipt = await applyGameIni({
      gameId: "fallout4",
      documentsPath: docs,
      gameIni: {
        files: [
          {
            fileName: "Fallout4Prefs.ini",
            settings: [
              { section: "General", key: "uGridsToLoad", value: "7" },
              { section: "General", key: "bFreebiesSeen", value: "0" },
              { section: "GamePlay", key: "iDifficulty", value: "3" },
            ],
          },
        ],
      },
    });
    expect(receipt.appliedCount).toBe(1);
    const written = fs.readFileSync(file, "utf8");
    expect(written).toContain("uGridsToLoad=7");
    expect(written).toContain("bFreebiesSeen=1");
    expect(written).toContain("iDifficulty=4");
    fs.rmSync(docs, { recursive: true, force: true });
  });

  it("a package built with the list applies what the curator included", async () => {
    const { docs, dir } = setup();
    const file = path.join(dir, "Fallout4Prefs.ini");
    fs.writeFileSync(file, ["[Interface]", "iHUDColorR=10"].join("\n"));
    const receipt = await applyGameIni({
      gameId: "fallout4",
      documentsPath: docs,
      gameIni: {
        personalRules: PERSONAL_RULES_VERSION,
        files: [{ fileName: "Fallout4Prefs.ini", settings: [{ section: "Interface", key: "iHUDColorR", value: "255" }] }],
      },
    });
    expect(receipt.appliedCount).toBe(1);
    expect(fs.readFileSync(file, "utf8")).toContain("iHUDColorR=255");
    fs.rmSync(docs, { recursive: true, force: true });
  });
});
