/**
 * What a script-extender plugin declares about the game versions it runs on.
 *
 * Validated first against real DLLs, not fixtures: every SKSE and F4SE plugin
 * in two real profiles, read by this parser and by an independent Python
 * reader. Skyrim agreed exactly (241 independent, 10 pinned, 1 support DLL,
 * 0 unreadable). Fallout 4 differed by one DLL — `F4SE/Plugins/noAVX/…`, an
 * alternative build in a subfolder, which F4SE does not load and which the
 * Python reader wrongly counted. These fixtures pin the shapes that
 * measurement found.
 */
import { describe, expect, it } from "vitest";

import { buildPe } from "./fixtures.testutil";
import { parsePeImage } from "./peImage";
import {
  extenderForPath,
  formatRuntime,
  readNativePluginDeclaration,
} from "./scriptExtenderVersion";

const pack = (major: number, minor: number, build: number, sub = 0): number =>
  ((major << 24) | (minor << 16) | (build << 4) | sub) >>> 0;

/** An SKSE version block: email present, so independence at 776, runtimes at 780. */
const skseBlock = (args: { name: string; independence: number; runtimes: number[] }): Buffer => {
  const b = Buffer.alloc(848);
  b.writeUInt32LE(1, 0);
  b.write(args.name, 8, "latin1");
  b.writeUInt32LE(args.independence, 776);
  args.runtimes.forEach((r, i) => b.writeUInt32LE(r, 780 + i * 4));
  return b;
};

/** An F4SE version block: NO email, so independence at 520, runtimes at 528. */
const f4seBlock = (args: { name: string; independence: number; runtimes: number[] }): Buffer => {
  const b = Buffer.alloc(596);
  b.writeUInt32LE(1, 0);
  b.write(args.name, 8, "latin1");
  b.writeUInt32LE(args.independence, 520);
  args.runtimes.forEach((r, i) => b.writeUInt32LE(r, 528 + i * 4));
  return b;
};

describe("formatRuntime", () => {
  it("prints the sub-version only when it is set", () => {
    expect(formatRuntime(pack(1, 6, 1170))).toBe("1.6.1170");
    // `.1` is how SKSE marks the GOG build; the executable itself says `.0`.
    expect(formatRuntime(pack(1, 6, 1179, 1))).toBe("1.6.1179.1");
    expect(formatRuntime(pack(1, 10, 163))).toBe("1.10.163");
  });
});

describe("SKSE plugins", () => {
  it("reads an Address-Library plugin as version-independent", () => {
    const dll = buildPe({
      exportData: {
        SKSEPlugin_Version: skseBlock({ name: "EngineFixes", independence: 1, runtimes: [] }),
      },
      exports: ["SKSEPlugin_Load"],
    });
    expect(readNativePluginDeclaration(dll, "skse")).toEqual({
      kind: "declares",
      name: "EngineFixes",
      versionIndependent: true,
      runtimes: [],
      hasQuery: false,
    });
  });

  it("reads a pinned plugin and the exact runtimes it names", () => {
    const dll = buildPe({
      exportData: {
        SKSEPlugin_Version: skseBlock({
          name: "fiss",
          independence: 0,
          runtimes: [pack(1, 6, 640)],
        }),
      },
    });
    const r = readNativePluginDeclaration(dll, "skse");
    expect(r).toMatchObject({ kind: "declares", versionIndependent: false, runtimes: ["1.6.640"] });
  });

  it("reads every runtime a multi-version plugin lists, stopping at the terminator", () => {
    const dll = buildPe({
      exportData: {
        SKSEPlugin_Version: skseBlock({
          name: "FasterCellLookup",
          independence: 0,
          runtimes: [pack(1, 5, 97), pack(1, 6, 1170), pack(1, 6, 1179, 1)],
        }),
      },
    });
    expect(readNativePluginDeclaration(dll, "skse")).toMatchObject({
      runtimes: ["1.5.97", "1.6.1170", "1.6.1179.1"],
    });
  });

  it("treats signature scanning as independent too", () => {
    const dll = buildPe({
      exportData: { SKSEPlugin_Version: skseBlock({ name: "x", independence: 1 << 1, runtimes: [] }) },
    });
    expect(readNativePluginDeclaration(dll, "skse")).toMatchObject({ versionIndependent: true });
  });
});

describe("F4SE plugins — a different struct", () => {
  it("reads the runtimes at F4SE's offsets, not SKSE's", () => {
    /**
     * The first measurement read F4SE plugins with SKSE's offsets and got
     * zero runtimes from every one: F4SE's block has no supportEmail field,
     * so everything after `author` sits 252 bytes earlier.
     */
    const dll = buildPe({
      exportData: {
        F4SEPlugin_Version: f4seBlock({
          name: "crafting_highlight_fix",
          independence: 0,
          runtimes: [pack(1, 10, 984)],
        }),
      },
    });
    expect(readNativePluginDeclaration(dll, "f4se")).toMatchObject({
      kind: "declares",
      name: "crafting_highlight_fix",
      versionIndependent: false,
      runtimes: ["1.10.984"],
    });
  });

  it("notes when a plugin also exports Query, which old-gen F4SE loads instead", () => {
    // 62 of 64 declaring F4SE plugins on a real profile export both. Old-gen
    // F4SE calls Query and ignores the block, so this changes the verdict.
    const dll = buildPe({
      exports: ["F4SEPlugin_Query", "F4SEPlugin_Load"],
      exportData: {
        F4SEPlugin_Version: f4seBlock({ name: "wsfw", independence: 0, runtimes: [pack(1, 11, 240)] }),
      },
    });
    expect(readNativePluginDeclaration(dll, "f4se")).toMatchObject({ hasQuery: true });
  });
});

describe("plugins that declare nothing", () => {
  it("calls a Query-only plugin exactly that, rather than guessing", () => {
    // 40 of the F4SE plugins on a real profile: they decide at load time,
    // and nothing in the file says what they will decide.
    const dll = buildPe({ exports: ["F4SEPlugin_Query", "F4SEPlugin_Load"] });
    expect(readNativePluginDeclaration(dll, "f4se")).toEqual({ kind: "query-only" });
  });

  it("recognises a support DLL that is not a plugin at all", () => {
    const dll = buildPe({ exports: ["SomeHelper"] });
    expect(readNativePluginDeclaration(dll, "skse")).toEqual({ kind: "not-a-plugin" });
  });

  it("says nothing about a file that is not an image", () => {
    expect(readNativePluginDeclaration(Buffer.from("not a dll"), "skse")).toBeUndefined();
  });
});

describe("a plugin with very long C++ export names", () => {
  it("is still readable", () => {
    /**
     * Immersive Equipment Displays exports a mangled C++ symbol of 1,458
     * characters. The name cap was 1,024, so the whole image came back
     * undefined — a perfectly valid plugin reported as unreadable. The cap is
     * now the compiler's own (4,096).
     */
    const longName = `?${"x".repeat(1457)}`;
    const dll = buildPe({
      exports: [longName],
      exportData: { SKSEPlugin_Version: skseBlock({ name: "IED", independence: 1, runtimes: [] }) },
    });
    expect(parsePeImage(dll)?.exports.has(longName)).toBe(true);
    expect(readNativePluginDeclaration(dll, "skse")).toMatchObject({ kind: "declares", name: "IED" });
  });
});

describe("extenderForPath", () => {
  it("recognises plugins that sit directly in the Plugins folder", () => {
    expect(extenderForPath("SKSE/Plugins/fiss.dll")).toBe("skse");
    expect(extenderForPath("F4SE\\Plugins\\mcm.dll")).toBe("f4se");
    expect(extenderForPath("skse/plugins/lower.DLL")).toBe("skse");
  });

  it("ignores a DLL in a SUBFOLDER, which the extender does not load", () => {
    // FO4FasterHdtSMP ships `F4SE/Plugins/noAVX/…` as an alternative build.
    expect(extenderForPath("F4SE/Plugins/noAVX/FO4FasterHdtSMP.dll")).toBeUndefined();
  });

  it("ignores DLLs elsewhere and non-DLLs in Plugins", () => {
    expect(extenderForPath("d3d11.dll")).toBeUndefined();
    expect(extenderForPath("SKSE/Plugins/fiss.ini")).toBeUndefined();
  });
});

/**
 * Version independence short-circuits BEFORE the runtime list is read, so a
 * bit this reader does not recognise must never be taken as "runs anywhere":
 * the plugin would drop out of the swap list and do nothing in the player's
 * game, which is the worst direction to be wrong in.
 */
describe("an independence dword with an unrecognised bit", () => {
  it("does not read a pinned F4SE plugin as version-independent", () => {
    const dll = buildPe({
      exportData: {
        F4SEPlugin_Version: f4seBlock({ name: "Pinned", independence: 0b100, runtimes: [pack(1, 10, 984)] }),
      },
      exports: ["F4SEPlugin_Query"],
    });
    const read = readNativePluginDeclaration(dll, "f4se");
    expect(read?.kind).toBe("declares");
    if (read?.kind !== "declares") return;
    expect(read.versionIndependent).toBe(false);
    expect(read.runtimes).toEqual(["1.10.984"]);
  });

  it("reads the two address-independence bits as before", () => {
    for (const bit of [0b01, 0b10, 0b11]) {
      const dll = buildPe({
        exportData: { F4SEPlugin_Version: f4seBlock({ name: "Indep", independence: bit, runtimes: [] }) },
        exports: ["F4SEPlugin_Query"],
      });
      const read = readNativePluginDeclaration(dll, "f4se");
      expect(read?.kind === "declares" && read.versionIndependent).toBe(true);
    }
  });
});
