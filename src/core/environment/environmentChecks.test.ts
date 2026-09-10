/**
 * The verdicts, from facts. Each case is a tester's machine: a game never
 * "Managed" in Vortex, a game never started, a GOG DLL in a Steam install, a
 * game under Program Files. What matters as much as blocking those is NOT
 * blocking when a probe merely could not run.
 */
import { describe, expect, it } from "vitest";

import {
  blockingChecks,
  decideBinaryImports,
  decideGameFolder,
  decideGameManaged,
  decideLauncherRan,
  decideProtectedLocation,
  describeBlockedChecks,
  protectedRootOf,
} from "./environmentChecks";
import type { GameFolderScan } from "./gameFolderScan";

const G = "Fallout 4";

describe("decideGameManaged", () => {
  const base = { gameName: G, discoveredPath: "E:/Games/Fallout 4", executable: "Fallout4.exe", dirExists: true, exeExists: true };

  it("blocks when Vortex has no folder for the game (never pressed Manage)", () => {
    const c = decideGameManaged({ ...base, discoveredPath: undefined, dirExists: false, exeExists: false });
    expect(c.status).toBe("blocked");
    expect(c.steps.join(" ")).toMatch(/Manage/);
  });

  it("blocks when the folder is gone or the executable is not in it", () => {
    expect(decideGameManaged({ ...base, dirExists: false, exeExists: false }).status).toBe("blocked");
    expect(decideGameManaged({ ...base, exeExists: false }).status).toBe("blocked");
  });

  it("does not block when the executable name cannot be determined", () => {
    expect(decideGameManaged({ ...base, executable: undefined, exeExists: false }).status).toBe("unknown");
  });

  it("passes a managed, installed game", () => {
    expect(decideGameManaged(base).status).toBe("ok");
  });
});

describe("protectedRootOf / decideProtectedLocation", () => {
  const roots = ["C:\\Program Files", "C:\\Program Files (x86)"];

  it("matches regardless of case and separator", () => {
    expect(protectedRootOf("c:/program files (x86)/Steam/steamapps/common/Fallout 4", roots)).toBe(
      "C:\\Program Files (x86)",
    );
    expect(protectedRootOf("C:\\Program Files\\Bethesda\\Fallout 4\\", roots)).toBe("C:\\Program Files");
  });

  it("does not treat a sibling with the same prefix as inside", () => {
    expect(protectedRootOf("C:\\Program Files Games\\Fallout 4", roots)).toBeUndefined();
    expect(protectedRootOf("E:\\SteamLibrary\\steamapps\\common\\Fallout 4", roots)).toBeUndefined();
  });

  it("blocks under Program Files, with store-specific steps", () => {
    const c = decideProtectedLocation({
      gameName: G,
      gameDir: "C:/Program Files (x86)/Steam/steamapps/common/Fallout 4",
      protectedRoots: roots,
      wine: false,
      store: "steam",
    });
    expect(c.status).toBe("blocked");
    expect(c.steps[0]).toMatch(/Steam → Settings → Storage/);
  });

  it("never blocks under Wine, where Windows folder protection does not exist", () => {
    const c = decideProtectedLocation({
      gameName: G,
      gameDir: "C:/Program Files (x86)/Steam/steamapps/common/Fallout 4",
      protectedRoots: roots,
      wine: true,
      store: "steam",
    });
    expect(c.status).toBe("ok");
  });

  it("ignores empty roots rather than matching everything", () => {
    expect(protectedRootOf("E:\\Games\\Fallout 4", ["", "  "])).toBeUndefined();
  });
});

describe("decideLauncherRan", () => {
  it("blocks when the launcher's Prefs file does not exist", () => {
    const c = decideLauncherRan({ gameName: G, prefsPath: "C:/Docs/My Games/Fallout4/Fallout4Prefs.ini", exists: false });
    expect(c.status).toBe("blocked");
    expect(c.lines[0]).toMatch(/Fallout4Prefs\.ini/);
  });

  it("is unknown, not blocked, when no layout is known", () => {
    expect(decideLauncherRan({ gameName: G, prefsPath: undefined, exists: false }).status).toBe("unknown");
  });

  it("passes when it exists", () => {
    expect(decideLauncherRan({ gameName: G, prefsPath: "x/Fallout4Prefs.ini", exists: true }).status).toBe("ok");
  });
});

describe("decideBinaryImports", () => {
  const finding = {
    exe: "Fallout4Launcher.exe",
    dll: "steam_api64.dll",
    missing: ["SteamInternal_CreateInterface"],
  };

  it("blocks when a store-installed DLL lacks what a store executable imports", () => {
    const c = decideBinaryImports({ gameName: G, checked: ["Fallout4Launcher.exe"], findings: [{ ...finding, dllIsVanilla: true }] });
    expect(c.status).toBe("blocked");
    expect(c.lines[0]).toMatch(/SteamInternal_CreateInterface/);
    expect(c.steps.join(" ")).toMatch(/Verify integrity/);
  });

  it("only warns for a DLL the store did not install — a mod or tool may replace it", () => {
    const c = decideBinaryImports({ gameName: G, checked: ["Fallout4.exe"], findings: [{ ...finding, dllIsVanilla: false }] });
    expect(c.status).toBe("warning");
  });

  it("passes with no findings", () => {
    expect(decideBinaryImports({ gameName: G, checked: ["Fallout4.exe"], findings: [] }).status).toBe("ok");
  });
});

const scan = (over: Partial<GameFolderScan["report"]>, deployedCount = 0): GameFolderScan => ({
  report: {
    vanilla: { kind: "known", source: "gog", detail: "list", files: 10 },
    counts: { deployed: 0, vanilla: 10, vortex: 0, declared: 0, creation: 0, "not-loaded": 0, volatile: 0, unmanaged: 0 },
    unmanaged: [],
    vanillaMissing: [],
    vanillaSizeMismatch: [],
    ...over,
  },
  manifests: [],
  deployedCount,
  unreadable: [],
  creationSources: [],
});

describe("decideGameFolder", () => {
  it("never blocks — a dirty folder is cleaned at Install, not refused", () => {
    const c = decideGameFolder({
      gameName: G,
      scan: scan({ unmanaged: [{ path: "Data/F4SE/Plugins/old.dll", size: 1, mtimeMs: 0 }] }, 12),
    });
    expect(c.status).toBe("warning");
    expect(c.lines.join("\n")).toMatch(/Data\/F4SE — 1 file/);
    expect(c.lines.join("\n")).toMatch(/12 mod files deployed/);
  });

  it("warns, with the reason, when there is no store record", () => {
    const c = decideGameFolder({ gameName: G, scan: scan({ vanilla: { kind: "unknown", reason: "no record" } }) });
    expect(c.status).toBe("warning");
    expect(c.lines).toEqual(["no record"]);
  });

  it("passes a clean game", () => {
    expect(decideGameFolder({ gameName: G, scan: scan({}) }).status).toBe("ok");
  });
});

describe("describeBlockedChecks", () => {
  it("lists only blocked checks, each with its steps", () => {
    const checks = [
      decideLauncherRan({ gameName: G, prefsPath: "x/Fallout4Prefs.ini", exists: false }),
      decideGameManaged({ gameName: G, discoveredPath: "x", executable: "Fallout4.exe", dirExists: true, exeExists: true }),
    ];
    expect(blockingChecks(checks).map((c) => c.id)).toEqual(["launcher-ran"]);
    const text = describeBlockedChecks(checks);
    expect(text).toMatch(/never been started/);
    expect(text).toMatch(/What to do:/);
    expect(text).not.toMatch(/Vortex manages/);
  });
});
