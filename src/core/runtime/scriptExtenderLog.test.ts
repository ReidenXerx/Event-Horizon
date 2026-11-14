/**
 * ──────────────────────────────────────────────────────────────────────
 * Reading the one artefact that says whether a plugin loaded.
 *
 * Every excerpt below is copied from a real log on a real machine — F4SE
 * 0.6.23 with 92 plugins and SKSE64 with 237 — and the parser was validated
 * against both files in full before this test was written: 90 loaded / 2
 * skipped / 0 failed, and 236 / 1 / 0. The counts reconcile exactly with the
 * logs' own "checking plugin" lines.
 *
 * The failure case is the exception and says so: NEITHER real log contained a
 * failed plugin, so the shape here exercises the rule rather than a measured
 * line — anything checked that never reaches a known conclusion is failed,
 * and carries the log's own words instead of a category we invented.
 * ──────────────────────────────────────────────────────────────────────
 */
import { describe, expect, it } from "vitest";

import {
  parseScriptExtenderLog,
  scriptExtenderLogFor,
  summariseScriptExtenderLog,
} from "./scriptExtenderLog";

const F4SE = [
  "F4SE runtime: initialize (version = 0.6.23 010A0A30 01DD47A97F85B1D0, os = 6.2 (9200))",
  "imagebase = 00007FF69B170000",
  "plugin directory = D:\\GOGGames\\Fallout 4 GOTY\\Data\\F4SE\\Plugins\\",
  "checking plugin D:\\GOGGames\\Fallout 4 GOTY\\Data\\F4SE\\Plugins\\AAF_1_10_163.DLL",
  "registering plugin listener for F4SE at 1 of 2",
  "plugin D:\\GOGGames\\Fallout 4 GOTY\\Data\\F4SE\\Plugins\\AAF_1_10_163.DLL (00000001 AAF_1_10_163 00000001) loaded correctly",
  "checking plugin D:\\GOGGames\\Fallout 4 GOTY\\Data\\F4SE\\Plugins\\cbp.dll",
  "plugin D:\\GOGGames\\Fallout 4 GOTY\\Data\\F4SE\\Plugins\\cbp.dll (00000001 CBP 00000001) loaded correctly",
  "checking plugin D:\\GOGGames\\Fallout 4 GOTY\\Data\\F4SE\\Plugins\\msdia140.dll",
  "plugin D:\\GOGGames\\Fallout 4 GOTY\\Data\\F4SE\\Plugins\\msdia140.dll does not appear to be an F4SE plugin",
].join("\n");

describe("an F4SE log", () => {
  it("reads the runtime banner and the plugin folder", () => {
    const log = parseScriptExtenderLog(F4SE);
    expect(log.runtime).toContain("version = 0.6.23");
    expect(log.pluginDir).toContain("F4SE\\Plugins");
  });

  it("reports what loaded, with the plugin's own name and version", () => {
    const log = parseScriptExtenderLog(F4SE);
    const cbp = log.outcomes.find((o) => o.file.toLowerCase() === "cbp.dll");
    expect(cbp).toEqual({
      kind: "loaded",
      file: "cbp.dll",
      name: "CBP",
      version: "00000001",
    });
  });

  it("does NOT call a support DLL a failure", () => {
    /**
     * msdia140.dll is in both real logs. Crash loggers ship it into the same
     * folder and the extender dutifully checks and skips it. Reporting "2
     * plugins failed" for that would send someone hunting a problem that does
     * not exist — which is the way this feature would most easily do harm.
     */
    const s = summariseScriptExtenderLog(parseScriptExtenderLog(F4SE));
    expect(s.loaded).toBe(2);
    expect(s.skipped).toBe(1);
    expect(s.failed).toEqual([]);
    expect(s.lines[0]).toBe("All 2 script-extender plugins loaded.");
    expect(s.lines.join(" ")).toMatch(/not extender plugins/);
  });

  it("carries the log's own words for a plugin that never concluded", () => {
    const text = [
      // Synthetic, with forward slashes — see the note in the next test.
      "checking plugin C:/game/Data/F4SE/Plugins/physics.dll",
      "couldn't load plugin C:/game/Data/F4SE/Plugins/physics.dll (Error 126)",
      "checking plugin C:/game/Data/F4SE/Plugins/other.dll",
      "plugin C:/game/Data/F4SE/Plugins/other.dll (00000001 Other 00000001) loaded correctly",
    ].join("\n");
    const s = summariseScriptExtenderLog(parseScriptExtenderLog(text));
    expect(s.failed).toEqual([
      {
        file: "physics.dll",
        lines: ["couldn't load plugin C:/game/Data/F4SE/Plugins/physics.dll (Error 126)"],
      },
    ]);
    // Error 126 is "the specified module could not be found" — a dependency
    // the DLL links by name, which is how a missing VC++ runtime presents.
    // The line is quoted rather than translated: the parser has never
    // measured this shape and must not pretend to classify it.
    expect(s.lines[1]).toContain("Error 126");
    expect(s.lines[0]).toBe("1 of 2 script-extender plugins did not load.");
  });

  it("survives a log cut off mid-write, which is when people read one", () => {
    const text = [
      // Forward slashes here on purpose: these two cases are synthetic, and
      // the authentic Windows-path shape is covered by the F4SE and SKSE
      // excerpts above, which are copied from real logs.
      "checking plugin C:/g/a.dll",
      "plugin C:/g/a.dll (00000001 A 00000001) loaded correctly",
      "checking plugin C:/g/b.dll",
    ].join("\n");
    const s = summariseScriptExtenderLog(parseScriptExtenderLog(text));
    expect(s.loaded).toBe(1);
    // No "init complete" and nothing said about b.dll: not a failure, just
    // not reached yet.
    expect(s.failed).toEqual([]);
    expect(s.lines[0]).toBe("1 script-extender plugin loaded so far.");
    expect(s.lines[1]).toMatch(/stops before the script extender finished/);
  });
});

describe("an F4SE 0.7 log (AE 1.11), where every result comes at the end", () => {
  /**
   * Shape copied from two real 0.7.9 logs (110 DLLs each, game 1.11.240):
   * all "checking plugin" lines first, then preload and load passes, then
   * every "loaded correctly" line. Reading it as the 0.6 layout reported
   * "108 of 109 did not load" for a log where all 108 loaded (11-14).
   */
  const F4SE_07 = [
    "F4SE runtime: initialize (version = 0.7.9 010B0F00 01DD741E70165538, os = 6.2 (9200))",
    "plugin directory = C:\\Steam\\steamapps\\common\\Fallout 4\\Data\\F4SE\\Plugins\\",
    "checking plugin 0FastDecompress.dll",
    "checking plugin AAF_1_11_240.DLL",
    "checking plugin msdia140.dll",
    "plugin msdia140.dll (00000000  00000000) no version data 0 (handle 0)",
    "checking plugin XDI.dll",
    'preloading plugin "Addictol"',
    "registering plugin listener for F4SE at 17 of 110",
    "preinit complete",
    'loading plugin "FastDecompress"',
    'loading plugin "aaf_1_11_240"',
    "registering plugin listener for F4SE at 2 of 110",
    'loading plugin "XDI"',
    "plugin 0FastDecompress.dll (00000001 FastDecompress 01040020) loaded correctly (handle 1)",
    "plugin AAF_1_11_240.DLL (00000001 aaf_1_11_240 00000000) loaded correctly (handle 2)",
    "plugin XDI.dll (00000001 XDI 00000001) loaded correctly (handle 108)",
    "config path = C:\\Steam\\steamapps\\common\\Fallout 4\\Data\\F4SE\\f4se.ini",
    "init complete",
  ].join("\n");

  it("finds every result, wherever it sits", () => {
    const s = summariseScriptExtenderLog(parseScriptExtenderLog(F4SE_07));
    expect(s.loaded).toBe(3);
    expect(s.skipped).toBe(1);
    expect(s.failed).toEqual([]);
    expect(s.lines[0]).toBe("All 3 script-extender plugins loaded.");
  });

  it("names a DLL that never loaded, with the lines that mention it", () => {
    const text = F4SE_07.replace(
      "plugin XDI.dll (00000001 XDI 00000001) loaded correctly (handle 108)",
      "couldn't load plugin XDI.dll (Error 126)",
    );
    const s = summariseScriptExtenderLog(parseScriptExtenderLog(text));
    expect(s.failed).toEqual([
      { file: "XDI.dll", lines: ["couldn't load plugin XDI.dll (Error 126)"] },
    ]);
    expect(s.lines[0]).toBe("1 of 3 script-extender plugins did not load.");
  });

  it("calls a DLL with no result in a FINISHED log failed, not unfinished", () => {
    const text = F4SE_07.replace(
      "plugin XDI.dll (00000001 XDI 00000001) loaded correctly (handle 108)\n",
      "",
    );
    const s = summariseScriptExtenderLog(parseScriptExtenderLog(text));
    expect(s.failed.map((f) => f.file)).toEqual(["XDI.dll"]);
  });
});

describe("an SKSE log", () => {
  it("handles the handle suffix and plugin names containing spaces", () => {
    // Both measured in the real SKSE64 log.
    const text = [
      "checking plugin DisabledReferenceIntegrityFix.dll",
      'loading plugin "DisabledReferenceIntegrityFix"',
      "plugin DisabledReferenceIntegrityFix.dll (00000001 DisabledReferenceIntegrityFix 01050000) loaded correctly (handle 50)",
      "checking plugin Fuz Ro D'oh.dll",
      "plugin Fuz Ro D'oh.dll (00000001 Fuz Ro D'oh 00000001) loaded correctly (handle 51)",
    ].join("\n");
    const s = summariseScriptExtenderLog(parseScriptExtenderLog(text));
    expect(s.loaded).toBe(2);
    expect(s.failed).toEqual([]);
  });
});

describe("where the log lives", () => {
  it("knows the two that were verified against a real file", () => {
    expect(scriptExtenderLogFor("fallout4")).toEqual({ folder: "F4SE", file: "f4se.log" });
    expect(scriptExtenderLogFor("skyrimse")).toEqual({ folder: "SKSE", file: "skse64.log" });
  });

  it("says nothing for a game whose path was never checked", () => {
    // Guessing a path and reporting "no log" from the wrong place would be a
    // diagnosis about a file that was never looked for.
    expect(scriptExtenderLogFor("starfield")).toBeUndefined();
    expect(scriptExtenderLogFor("falloutnv")).toBeUndefined();
  });
});
