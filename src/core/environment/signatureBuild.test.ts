/**
 * Meridia 1.0.55 on alasdairn's Steam 1.6.1170 (2026-11-23): two SKSE plugins
 * built for GOG 1.6.1179 set the signatures flag, so SKSE loaded them and the
 * Steam check called them fine. PrivateProfileRedirector "RT 1.6.1179" lists
 * only 1.6.1179.1; Save and Load Accelerator's GOG option lists nothing and
 * embeds "1.6.1179.1".
 */
import { describe, expect, it } from "vitest";

import { buildPe } from "./fixtures.testutil";
import { judgePlugin } from "./nativePluginCompat";
import { readNativePluginDeclaration } from "./scriptExtenderVersion";

const pack = (major: number, minor: number, build: number, sub = 0): number =>
  ((major << 24) | (minor << 16) | (build << 4) | sub) >>> 0;

const skse = (name: string, independence: number, runtimes: number[]): Buffer => {
  const b = Buffer.alloc(848);
  b.writeUInt32LE(1, 0);
  b.write(name, 8, "latin1");
  b.writeUInt32LE(independence, 776);
  runtimes.forEach((r, i) => b.writeUInt32LE(r, 780 + i * 4));
  return buildPe({ exportData: { SKSEPlugin_Version: b } });
};

const judge = (dll: Buffer, runtime: string) => {
  const d = readNativePluginDeclaration(dll, "skse");
  if (d?.kind !== "declares") throw new Error("not declaring");
  return judgePlugin(
    { path: "SKSE/Plugins/x.dll", extender: "skse", kind: "declares", versionIndependent: d.versionIndependent, runtimes: d.runtimes, hasQuery: d.hasQuery, ...(d.signatureBuiltFor ? { signatureBuiltFor: d.signatureBuiltFor } : {}) },
    { runtime, api: "version" },
  ).kind;
};

const SIGNATURES = 1 << 1;
const ADDRESS_LIBRARY = 1 << 0;

describe("signature-flagged plugins built for one runtime", () => {
  it("a listed GOG runtime: works on GOG, not on Steam 1.6.1170", () => {
    const dll = skse("PrivateProfileRedirector", SIGNATURES, [pack(1, 6, 1179, 1)]);
    expect(readNativePluginDeclaration(dll, "skse")).toMatchObject({ signatureBuiltFor: ["1.6.1179.1"] });
    expect(judge(dll, "1.6.1170")).toBe("cannot-load");
    expect(judge(dll, "1.6.1179.1")).toBe("loads");
  });

  it("an empty list but the runtime written inside the DLL", () => {
    const dll = skse("Save and Load Accelerator 1.6.1179.1", SIGNATURES, []);
    expect(judge(dll, "1.6.1170")).toBe("cannot-load");
    expect(judge(dll, "1.6.1179.1")).toBe("loads");
  });

  it("a real signature scanner naming no runtime loads everywhere", () => {
    const dll = skse("Sound Fix for Large Sector Drives", SIGNATURES, []);
    expect(readNativePluginDeclaration(dll, "skse")).not.toHaveProperty("signatureBuiltFor");
    expect(judge(dll, "1.6.1170")).toBe("loads");
  });

  it("never applies to a plugin that also uses the Address Library", () => {
    const dll = skse("EngineFixes 1.6.1179.1", SIGNATURES | ADDRESS_LIBRARY, [pack(1, 6, 1179, 1)]);
    expect(readNativePluginDeclaration(dll, "skse")).not.toHaveProperty("signatureBuiltFor");
    expect(judge(dll, "1.6.1170")).toBe("loads");
  });

  it("does not read a plugin's own short version number as a runtime", () => {
    expect(readNativePluginDeclaration(skse("Thing 1.6.2", SIGNATURES, []), "skse")).not.toHaveProperty("signatureBuiltFor");
  });
});
