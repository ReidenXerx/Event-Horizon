/**
 * The store warning, from what each DLL declared rather than where it sits.
 *
 * The heuristic named every mod with a script-extender DLL — 245 on a real
 * Skyrim collection whose true answer is 6. Where the package recorded plugin
 * data and the store is one the judgement can see (Skyrim, Steam or GOG), the
 * list is the judged one; everywhere else the heuristic stays.
 */
import { describe, expect, it } from "vitest";

import { resolveCompatibility } from "./resolveInstallPlan";
import type { EhcollManifest, EhcollNativePlugin } from "../../types/ehcoll";
import type { UserSideState } from "../../types/installPlan";

const gogOnly: EhcollNativePlugin = {
  path: "SKSE/Plugins/JContainersGOG.dll",
  extender: "skse",
  kind: "declares",
  versionIndependent: false,
  runtimes: ["1.6.1179.1"],
  hasQuery: false,
};
const independent: EhcollNativePlugin = {
  path: "SKSE/Plugins/EngineFixes.dll",
  extender: "skse",
  kind: "declares",
  versionIndependent: true,
  runtimes: [],
  hasQuery: false,
};

const mod = (name: string, compareKey: string, dll: string, plugins?: EhcollNativePlugin[]) => ({
  name,
  compareKey,
  state: {
    enabled: true,
    // Staged whether or not the package recorded plugin data: the heuristic reads these.
    stagingFiles: [{ path: dll, size: 1 }],
    ...(plugins ? { nativePlugins: plugins } : {}),
  },
});

const manifest = (gameId: string, version: string, store: string, withData = true) =>
  ({
    game: { id: gameId, version, versionPolicy: "exact", store },
    vortex: { version: "2.6.0", deploymentMethod: "hardlink", requiredExtensions: [] },
    mods: [
      mod("JContainers GOG", "nexus:1:1", gogOnly.path, withData ? [gogOnly] : undefined),
      mod("Engine Fixes", "nexus:2:2", independent.path, withData ? [independent] : undefined),
    ],
    rules: [],
  }) as unknown as EhcollManifest;

const user = (gameId: string, gameVersion: string, store: string) =>
  ({
    gameId,
    gameVersion,
    store,
    enabledExtensions: [],
    vortexVersion: "2.6.0",
    deploymentMethod: "hardlink",
  }) as unknown as UserSideState;

const storeLines = (warnings: string[]) => warnings.filter((w) => /version of the game and/.test(w) || w.startsWith("  •"));

describe("a Steam player on a GOG-built Skyrim collection", () => {
  it("at the SAME version number: names only the GOG-only build", () => {
    const r = resolveCompatibility(manifest("skyrimse", "1.6.1179.0", "gog"), user("skyrimse", "1.6.1179.0", "steam"));
    expect(r.versionMismatch).toBeUndefined();
    const text = storeLines(r.warnings).join("\n");
    expect(text).toContain("JContainers GOG");
    expect(text).not.toContain("Engine Fixes");
  });

  it("at a different version: says it once, in the version panel, not again as a warning", () => {
    const r = resolveCompatibility(manifest("skyrimse", "1.6.1179.0", "gog"), user("skyrimse", "1.6.1170.0", "steam"));
    expect(r.versionMismatch?.plugins?.cannotLoad.map((f) => f.mod)).toEqual(["JContainers GOG"]);
    expect(storeLines(r.warnings)).toEqual([]);
  });

  it("with no recorded player version: still names only the GOG-only build", () => {
    const u = user("skyrimse", "1.6.1179.0", "steam") as unknown as Record<string, unknown>;
    delete u.gameVersion;
    const r = resolveCompatibility(manifest("skyrimse", "1.6.1179.0", "gog"), u as unknown as UserSideState);
    const text = storeLines(r.warnings).join("\n");
    expect(text).toContain("JContainers GOG");
    expect(text).not.toContain("Engine Fixes");
  });

  it("with no recorded player version: judges at Steam's own build, so a plugin listing 1.6.1170 is fine", () => {
    const both: EhcollNativePlugin = { ...gogOnly, path: "SKSE/Plugins/FasterCellLookup.dll", runtimes: ["1.6.1170", "1.6.1179.1"] };
    const m = manifest("skyrimse", "1.6.1179.0", "gog") as unknown as { mods: unknown[] };
    m.mods.push(mod("Faster Cell Lookup", "nexus:4:4", both.path, [both]));
    const u = user("skyrimse", "1.6.1179.0", "steam") as unknown as Record<string, unknown>;
    delete u.gameVersion;
    const r = resolveCompatibility(m as unknown as EhcollManifest, u as unknown as UserSideState);
    const text = storeLines(r.warnings).join("\n");
    expect(text).toContain("JContainers GOG");
    expect(text).not.toContain("Faster Cell Lookup");
  });

  it("falls back to the heuristic for a package with no plugin data", () => {
    const r = resolveCompatibility(
      manifest("skyrimse", "1.6.1179.0", "gog", false),
      user("skyrimse", "1.6.1179.0", "steam"),
    );
    const text = storeLines(r.warnings).join("\n");
    // The heuristic names both — it cannot tell them apart.
    expect(text).toContain("JContainers GOG");
    expect(text).toContain("Engine Fixes");
  });
});

describe("the script extender itself", () => {
  it("is named in the judged list: its loader is built per store and carries no plugin data", () => {
    const m = manifest("skyrimse", "1.6.1179.0", "gog") as unknown as { mods: unknown[] };
    m.mods.push({
      name: "SKSE64 GOG",
      compareKey: "nexus:3:3",
      state: {
        enabled: true,
        stagingFiles: [
          { path: "skse64_loader.exe", size: 1 },
          { path: "skse64_1_6_1179.dll", size: 1 },
        ],
      },
    });
    const r = resolveCompatibility(m as unknown as EhcollManifest, user("skyrimse", "1.6.1179.0", "steam"));
    const text = storeLines(r.warnings).join("\n");
    expect(text).toContain("SKSE64 GOG");
    expect(text).toContain("JContainers GOG");
    expect(text).not.toContain("Engine Fixes");
  });
});

describe("where the judgement cannot see the store", () => {
  it("keeps the heuristic on Fallout 4, whose plugins carry no store marker", () => {
    const r = resolveCompatibility(manifest("fallout4", "1.10.163.0", "gog"), user("fallout4", "1.10.163.0", "steam"));
    const text = storeLines(r.warnings).join("\n");
    expect(text).toContain("Engine Fixes");
  });
});
