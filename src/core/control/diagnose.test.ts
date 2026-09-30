/**
 * Read against excerpts of two real crash logs from the owner's machine (paths
 * and system sections cut, every other line verbatim): an Addictol Crash
 * Logger log from Fallout 4 AE that died executing memory no module owns, and
 * a Crash Logger SSE log from Skyrim that died under a Papyrus call.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { judgeCrash, parseCrashLog } from "./diagnose";

const fixture = (name: string): string =>
  fs.readFileSync(path.join(__dirname, "../../../test/fixtures/crash", name), "utf8");

const baseGame = (p: string): boolean =>
  /^(Fallout4|DLC\w+|Skyrim|Update|Dawnguard|HearthFires|Dragonborn)\.esm$/i.test(p) || /^cc\w+/i.test(p);

describe("reading a crash log", () => {
  it("Fallout 4: the game, the logger, an exception with no module, and the bones it was touching", () => {
    const log = parseCrashLog(fixture("buffout-ae-no-module.log"));
    expect(log.game).toEqual({ name: "Fallout 4", version: "1.11.240" });
    expect(log.logger).toEqual({ name: "Addictol Crash Logger", version: "1.6.0" });
    expect(log.exception).toEqual({ code: "EXCEPTION_ACCESS_VIOLATION" });
    expect(log.callStack[0]).toEqual({ module: "Fallout4.exe", probable: false });
    expect(log.objectNames["AnatAnus_L"]).toBeGreaterThanOrEqual(1);
    expect(log.objectTypes["NiNode"]).toBeGreaterThan(3);
    // The cell was modified by 30 plugins; only the one in use counts.
    expect(log.winningOverrides).toEqual({ "FallonsBasementOverhaul.esp": 1 });
    expect(log.pluginMentions["necessity.esp"]).toBeUndefined();
    expect(log.loadedPlugins.slice(0, 2)).toEqual(["Fallout4.esm", "DLCRobot.esm"]);
  });

  it("Fallout 4: says what executing unowned memory means and names the objects", () => {
    const v = judgeCrash(parseCrashLog(fixture("buffout-ae-no-module.log")), {
      dll: () => undefined,
      plugin: (p) => (p === "FallonsBasementOverhaul.esp" ? { modId: "fallon-1", modName: "Fallon's Basement" } : undefined),
      asset: () => undefined,
      isBaseGame: baseGame,
    });
    expect(v.summary).toMatch(/memory no module owns/);
    expect(v.meaning).toMatch(/dangling pointer/);
    expect(v.objects.names).toContain("AnatAnus_L");
    expect(v.suspects.find((s) => s.name === "FallonsBasementOverhaul.esp")?.mod?.modName).toBe("Fallon's Basement");
    // The game's own exe and Windows are never suspects.
    expect(v.suspects.some((s) => /Fallout4\.exe|KERNELBASE/i.test(s.name))).toBe(false);
  });

  it("Skyrim: the exception's module, the plugin on the player, and the script that was running", () => {
    const log = parseCrashLog(fixture("crashloggersse-papyrus.log"));
    expect(log.game).toEqual({ name: "Skyrim SSE", version: "1.6.1179" });
    expect(log.logger?.name).toBe("CrashLoggerSSE");
    expect(log.exception).toMatchObject({ code: "EXCEPTION_ACCESS_VIOLATION", module: "SkyrimSE.exe", offset: "1424010" });
    expect(log.callStack.every((f) => f.probable)).toBe(true);
    expect(log.pluginMentions["Apprentice.esp"]).toBe(1);
    expect(log.scripts).toMatchObject({ ecMCM: 1, SKI_PlayerLoadGameAlias: 1 });

    const v = judgeCrash(log, {
      dll: () => undefined,
      plugin: () => undefined,
      asset: (a) => (a.toLowerCase() === "scripts/ecmcm.pex" ? { modId: "wet", modName: "Wet Function Redux" } : undefined),
      isBaseGame: baseGame,
    });
    expect(v.meaning).toMatch(/game's own code/);
    expect(v.suspects[0]).toMatchObject({ kind: "asset", name: "Scripts/ecMCM.pex", mod: { modName: "Wet Function Redux" } });
  });

  it("a mod's DLL at the exception outranks everything, and a GPU driver is named as the driver", () => {
    const own = parseCrashLog(
      [
        "Fallout 4 v1.10.163",
        "Buffout 4 v1.28.6",
        'Unhandled exception "EXCEPTION_ACCESS_VIOLATION" at 0x7FF8AB123456 SomePhysics.dll+0012345',
        "PROBABLE CALL STACK:",
        "\t[0] 0x7FF8AB123456 SomePhysics.dll+0012345",
        "\t[1] 0x7FF6A1B2C3D4 Fallout4.exe+0123456",
      ].join("\n"),
    );
    const v = judgeCrash(own, {
      dll: (f) => (f === "SomePhysics.dll" ? { modId: "p", modName: "Some Physics" } : undefined),
      plugin: () => undefined,
      asset: () => undefined,
      isBaseGame: baseGame,
    });
    expect(v.suspects[0]).toMatchObject({ kind: "dll", name: "SomePhysics.dll", mod: { modName: "Some Physics" } });
    expect(v.meaning).toMatch(/built for another game version/);

    const gpu = judgeCrash(parseCrashLog('Unhandled exception "EXCEPTION_ACCESS_VIOLATION" at 0x7FF8 nvwgf2umx.dll+0A1B2C3'), {
      dll: () => undefined,
      plugin: () => undefined,
      asset: () => undefined,
      isBaseGame: baseGame,
    });
    expect(gpu.meaning).toMatch(/graphics driver/);
    expect(gpu.suspects).toEqual([]);
  });

  it("says so when the text is not a crash log", () => {
    const v = judgeCrash(parseCrashLog("hello"), { dll: () => undefined, plugin: () => undefined, asset: () => undefined, isBaseGame: baseGame });
    expect(v.summary).toMatch(/No exception line/);
  });
});
