/**
 * What a player on another game version is told.
 *
 * Accepted on real data first: the real Meridia 1.0.22 manifest, with each
 * shipped mod's DLLs read from disk, judged for players on other versions.
 *   - Steam AE 1.6.1170: exactly 6 mods — the GOG-specific builds (CBPC, Fuz Ro
 *     D'oh GOG, Honed Metal +gog, JContainers GOG, PapyrusUtil GOG, Racemenu
 *     GOG Fix). The store warning it replaces named 245.
 *   - SE 1.5.97: 42 AE-only builds, plus 194 that decide at load time.
 * And Ivy 1.0.34 for a next-gen 1.10.984 player: 1 mod.
 */
import { describe, expect, it } from "vitest";

import type { EhcollManifest, EhcollNativePlugin } from "../../types/ehcoll";
import { assessVersionMismatch, describeVersionMismatch } from "./versionMismatch";

type Mod = EhcollManifest["mods"][number];

const mod = (name: string, compareKey: string, nativePlugins?: EhcollNativePlugin[]): Mod =>
  ({
    name,
    compareKey,
    state: { enabled: true, installOrder: 0, deploymentPriority: 0, ...(nativePlugins ? { nativePlugins } : {}) },
  }) as unknown as Mod;

const gogOnly = (path: string): EhcollNativePlugin => ({
  path,
  extender: "skse",
  kind: "declares",
  versionIndependent: false,
  runtimes: ["1.6.1179.1"],
  hasQuery: false,
});
const addressLibrary = (path: string): EhcollNativePlugin => ({
  path,
  extender: "skse",
  kind: "declares",
  versionIndependent: true,
  runtimes: [],
  hasQuery: false,
});

const meridiaLike = (mods: Mod[]): Pick<EhcollManifest, "game" | "mods" | "rules"> => ({
  game: { id: "skyrimse", version: "1.6.1179.0", versionPolicy: "exact", store: "gog" } as EhcollManifest["game"],
  mods,
  rules: [],
});

describe("a Steam player on a collection built on GOG", () => {
  const manifest = meridiaLike([
    mod("JContainers GOG", "nexus:1:1", [gogOnly("SKSE/Plugins/JContainersGOG.dll")]),
    mod("Racemenu GOG Fix", "nexus:2:2", [gogOnly("SKSE/Plugins/skee64.dll")]),
    mod("Engine Fixes", "nexus:3:3", [addressLibrary("SKSE/Plugins/EngineFixes.dll")]),
    mod("A texture pack", "nexus:4:4"),
  ]);

  it("names exactly the mods to swap — the GOG builds — and nothing else", () => {
    const m = assessVersionMismatch({ manifest, installed: "1.6.1170.0", store: "steam" });
    expect(m.plugins?.cannotLoad.map((f) => f.mod).sort()).toEqual(["JContainers GOG", "Racemenu GOG Fix"]);
    expect(m.plugins?.loads).toBe(1);
    const d = describeVersionMismatch(m);
    expect(d.swapLines).toHaveLength(2);
    expect(d.swapLines.join("\n")).toContain("JContainers GOG");
    expect(d.headline).toContain("1.6.1179.0");
    expect(d.headline).toContain("1.6.1170.0");
  });

  it("does not list the Address Library plugin, which works on both", () => {
    const d = describeVersionMismatch(assessVersionMismatch({ manifest, installed: "1.6.1170.0", store: "steam" }));
    expect(d.swapLines.join("\n")).not.toContain("Engine Fixes");
    expect(d.summary.join(" ")).toMatch(/Address Library for 1\.6\.1170/);
  });

  it("finds nothing to swap for another GOG player on the same version", () => {
    // The GOG runtime id carries SKSE's .1 marker; getting that wrong would
    // flag every GOG plugin here.
    const m = assessVersionMismatch({ manifest, installed: "1.6.1179.0", store: "gog" });
    expect(m.plugins?.cannotLoad).toEqual([]);
  });
});

describe("an SE player on an AE collection", () => {
  it("never reports '0 plugins work on any version' — the first version did", () => {
    const manifest = meridiaLike([
      mod("AE-only", "nexus:1:1", [gogOnly("SKSE/Plugins/ae.dll")]),
      mod("Dual", "nexus:2:2", [{ ...gogOnly("SKSE/Plugins/dual.dll"), hasQuery: true }]),
    ]);
    const d = describeVersionMismatch(assessVersionMismatch({ manifest, installed: "1.5.97.0", store: "steam" }));
    expect(d.summary.join(" ")).not.toMatch(/\b0 plugins? works?/);
    // The Query-bearing one is described as deciding at load time.
    expect(d.summary.join(" ")).toMatch(/checks your game version itself/);
    expect(d.swapLines).toHaveLength(1);
  });
});

describe("when there is no precise list", () => {
  it("says so for a package that predates plugin data, instead of inventing one", () => {
    const m = assessVersionMismatch({
      manifest: meridiaLike([mod("Old", "nexus:1:1")]),
      installed: "1.6.1170.0",
      store: "steam",
    });
    expect(m.noListReason).toBe("package-predates-plugin-data");
    const d = describeVersionMismatch(m);
    expect(d.swapLines).toEqual([]);
    expect(d.summary.join(" ")).toMatch(/built before Event Horizon recorded/);
  });

  it("says so when the player's runtime cannot be established", () => {
    const m = assessVersionMismatch({
      manifest: meridiaLike([mod("A", "nexus:1:1", [gogOnly("SKSE/Plugins/a.dll")])]),
      installed: "not-a-version",
      store: "steam",
    });
    expect(m.noListReason).toBe("runtime-unknown");
    expect(describeVersionMismatch(m).swapLines).toEqual([]);
  });
});

describe("the message stays readable", () => {
  it("caps the list of plugins it could not judge", () => {
    const many = Array.from({ length: 33 }, (_, i) => ({
      path: `F4SE/Plugins/p${i}.dll`,
      extender: "f4se" as const,
      kind: "query-only" as const,
    }));
    const manifest = {
      game: { id: "fallout4", version: "1.10.163.0", versionPolicy: "exact" } as EhcollManifest["game"],
      mods: [mod("Many", "nexus:1:1", many)],
      rules: [],
    };
    const d = describeVersionMismatch(assessVersionMismatch({ manifest, installed: "1.10.984.0", store: "steam" }));
    const line = d.summary.find((s) => s.includes("could not be judged"))!;
    expect(line).toContain("and 28 more");
    expect(line.match(/\.dll/g)).toHaveLength(5);
  });

  it("groups several dead DLLs of one mod into one line", () => {
    const manifest = meridiaLike([
      mod("Two DLLs", "nexus:1:1", [gogOnly("SKSE/Plugins/a.dll"), gogOnly("SKSE/Plugins/b.dll")]),
    ]);
    const d = describeVersionMismatch(assessVersionMismatch({ manifest, installed: "1.6.1170.0", store: "steam" }));
    expect(d.swapLines).toHaveLength(1);
    expect(d.swapLines[0]).toContain("a.dll");
    expect(d.swapLines[0]).toContain("b.dll");
  });
});

/**
 * The second compatibility axis. Steam and GOG both ship Skyrim 1.6.1179, so
 * a store difference can arrive with or without a version difference — and it
 * was being carried inside a script-extender runtime id, where the player
 * could not see it and the advice could not fix it.
 */
describe("when the STORE is what differs", () => {
  const gogManifest = meridiaLike([
    mod("JContainers GOG", "nexus:1:1", [gogOnly("SKSE/Plugins/JContainersGOG.dll")]),
    mod("Engine Fixes", "nexus:2:2", [addressLibrary("SKSE/Plugins/EngineFixes.dll")]),
  ]);

  it("names the store in words, and says changing the version will not fix it", () => {
    const d = describeVersionMismatch(
      assessVersionMismatch({ manifest: gogManifest, installed: "1.6.1170.0", store: "steam" }),
    );
    expect(d.headline).toContain("gog");
    expect(d.headline).toContain("steam");
    expect(d.summary.join(" ")).toMatch(/different executables/);
    expect(d.summary.join(" ")).toMatch(/changing the version alone will not/);
  });

  it("never prints the script extender's runtime id at the player", () => {
    // "1.6.1179.1" is how SKSE spells the GOG build; no Nexus file, no
    // changelog and no executable ever shows it, so a player sent to look
    // for it finds nothing.
    const d = describeVersionMismatch(
      assessVersionMismatch({ manifest: gogManifest, installed: "1.6.1170.0", store: "steam" }),
    );
    expect(d.summary.join(" ")).not.toMatch(/1\.6\.1170\.1/);
    // The version Vortex reports, spelled as Vortex spells it.
    expect(d.summary.join(" ")).toContain("1.6.1170.0 (steam)");
  });
});

describe("the sentence the player ticks", () => {
  it("counts the mods when there are mods to count", () => {
    const m = assessVersionMismatch({
      manifest: meridiaLike([mod("GOG build", "nexus:1:1", [gogOnly("SKSE/Plugins/a.dll")])]),
      installed: "1.6.1170.0",
      store: "steam",
    });
    expect(describeVersionMismatch(m).acknowledgement).toMatch(/1 mod will not load on 1\.6\.1170\.0/);
  });

  it("says what it could not check when it could not check", () => {
    const m = assessVersionMismatch({
      manifest: meridiaLike([mod("Old", "nexus:1:1")]),
      installed: "1.6.1170.0",
      store: "steam",
    });
    expect(describeVersionMismatch(m).acknowledgement).toMatch(/could not check/);
  });
});

describe("a game nobody has measured", () => {
  it("says so, instead of blaming the player's install", () => {
    const starfield = {
      game: { id: "starfield", version: "1.14.70.0", versionPolicy: "exact" } as EhcollManifest["game"],
      mods: [mod("A", "nexus:1:1", [gogOnly("SFSE/Plugins/a.dll")])],
      rules: [],
    };
    const m = assessVersionMismatch({ manifest: starfield, installed: "1.15.216.0", store: "steam" });
    expect(m.noListReason).toBe("game-not-measured");
    expect(describeVersionMismatch(m).summary.join(" ")).toMatch(/has not measured/);
  });
});

describe("a file two mods ship with no rule deciding", () => {
  it("is said on the panel, not only counted in the receipt", () => {
    const manifest = meridiaLike([
      mod("A", "nexus:1:1", [gogOnly("SKSE/Plugins/fiss.dll")]),
      mod("B", "nexus:2:2", [gogOnly("SKSE/Plugins/fiss.dll")]),
    ]);
    const m = assessVersionMismatch({ manifest, installed: "1.6.1170.0", store: "steam" });
    expect(m.plugins?.undetermined).toHaveLength(1);
    expect(describeVersionMismatch(m).summary.join(" ")).toMatch(/no rule deciding which wins/);
  });
});
