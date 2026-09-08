/**
 * "HonedMetal.dll: disabled, incompatible with current version of the game" —
 * on a GOG install, from a collection built on Steam, at the SAME version
 * number. The exact-version check passed and said nothing.
 */
import { describe, expect, it } from "vitest";

import {
  describeStoreMismatch,
  isScriptExtenderPlugin,
  scriptExtenderMods,
} from "./storeCompatibility";

import type { EhcollMod } from "../../types/ehcoll";

const mod = (name: string, files: string[]): EhcollMod =>
  ({
    name,
    state: { stagingFiles: files.map((path) => ({ path, size: 1 })) },
  }) as unknown as EhcollMod;

describe("spotting a script-extender plugin", () => {
  it("recognises SKSE and F4SE plugin DLLs", () => {
    expect(isScriptExtenderPlugin("SKSE/Plugins/HonedMetal.dll")).toBe(true);
    expect(isScriptExtenderPlugin("F4SE/Plugins/x.dll")).toBe(true);
  });

  it("recognises them whatever the case or separator", () => {
    // Mod authors spell this both ways, and a Windows walk produces `\`.
    expect(isScriptExtenderPlugin("skse/plugins/honedmetal.dll")).toBe(true);
    expect(isScriptExtenderPlugin("SKSE\\Plugins\\HonedMetal.dll")).toBe(true);
    expect(isScriptExtenderPlugin("Data/SKSE/Plugins/Nested.DLL")).toBe(true);
  });

  it("is not fooled by a DLL somewhere else", () => {
    // A DLL that is not an extender plugin is not store-bound in this way,
    // and listing it would send the user re-downloading the wrong mods.
    expect(isScriptExtenderPlugin("bin/whatever.dll")).toBe(false);
    expect(isScriptExtenderPlugin("SKSE/Plugins/readme.txt")).toBe(false);
  });
});

describe("which mods the user has to re-download", () => {
  it("names the mods, not the files", () => {
    // You re-download a MOD from its page; the DLL is just how we found it.
    const mods = [
      mod("Honed Metal", ["SKSE/Plugins/HonedMetal.dll", "readme.txt"]),
      mod("Some Textures", ["textures/a.dds"]),
      mod("Address Library", ["SKSE/Plugins/versionlib.bin"]),
    ];
    expect(scriptExtenderMods(mods).map((m) => m.name)).toEqual(["Honed Metal"]);
  });

  it("sorts them, so two reports can be compared", () => {
    const mods = [
      mod("Zebra", ["SKSE/Plugins/z.dll"]),
      mod("Alpha", ["SKSE/Plugins/a.dll"]),
    ];
    expect(scriptExtenderMods(mods).map((m) => m.name)).toEqual([
      "Alpha",
      "Zebra",
    ]);
  });
});

describe("what the user is told", () => {
  const affected = [mod("Honed Metal", ["SKSE/Plugins/HonedMetal.dll"])];

  it("explains the same-version-different-executable trap and lists the mods", () => {
    const lines = describeStoreMismatch({
      curatorStore: "steam",
      userStore: "gog",
      mods: affected,
    }).join("\n");
    expect(lines).toContain("steam");
    expect(lines).toContain("gog");
    // The sentence that answers "but the version matches!"
    expect(lines).toMatch(/same version number but different executables/i);
    expect(lines).toContain("Honed Metal");
    // And the reassurance, so nobody reinstalls the whole collection.
    expect(lines).toMatch(/Everything else in the collection is unaffected/);
  });

  it("says NOTHING when the stores match", () => {
    expect(
      describeStoreMismatch({
        curatorStore: "gog",
        userStore: "GOG",
        mods: affected,
      }),
    ).toEqual([]);
  });

  it("says NOTHING when the package ships no extender plugins", () => {
    // A texture collection installs across stores perfectly well, and a
    // warning that is usually irrelevant is one people learn to skip.
    expect(
      describeStoreMismatch({
        curatorStore: "steam",
        userStore: "gog",
        mods: [mod("Some Textures", ["textures/a.dds"])],
      }),
    ).toEqual([]);
  });

  it("says NOTHING when either store is unknown", () => {
    /**
     * A collection built before the store was recorded has `undefined`, and
     * every existing package is in that state. Warning on those would train
     * users to ignore the one case that matters.
     */
    expect(
      describeStoreMismatch({
        curatorStore: undefined,
        userStore: "gog",
        mods: affected,
      }),
    ).toEqual([]);
    expect(
      describeStoreMismatch({
        curatorStore: "steam",
        userStore: undefined,
        mods: affected,
      }),
    ).toEqual([]);
  });
});

describe("the wiring, not just the helper", () => {
  /**
   * A helper nothing calls is the failure mode this codebase has shipped six
   * times — `knownModIds`, `classifyVerification`, `verifyHashes`, and three
   * more the driver's own preamble documents. The check has to be reachable
   * from a real plan, and the mode has to survive the round trip through the
   * manifest.
   */
  it("reaches the user through resolveCompatibility", async () => {
    const { resolveCompatibility } = await import(
      "../resolver/resolveInstallPlan"
    );
    const manifest = {
      game: { id: "skyrimse", version: "1.6.1179.0", versionPolicy: "exact", store: "steam" },
      vortex: { version: "2.6.3", deploymentMethod: "hardlink", requiredExtensions: [] },
      mods: [mod("Honed Metal", ["SKSE/Plugins/HonedMetal.dll"])],
    } as never;
    const userState = {
      gameId: "skyrimse",
      gameVersion: "1.6.1179.0",
      vortexVersion: "2.6.3",
      deploymentMethod: "hardlink",
      enabledExtensions: [],
      store: "gog",
    } as never;

    const report = resolveCompatibility(manifest, userState);
    const text = report.warnings.join("\n");
    // The version matches EXACTLY and the warning still fires — that is the
    // whole point of the axis.
    expect(report.errors).toEqual([]);
    expect(text).toMatch(/different executables/i);
    expect(text).toContain("Honed Metal");
  });

  it("stays silent for the same store, so the check is not just always-on", () => {
    // A test that only ever asserts the warning appears would pass against a
    // hard-coded `warnings.push(...)`.
    return import("../resolver/resolveInstallPlan").then(
      ({ resolveCompatibility }) => {
        const manifest = {
          game: { id: "skyrimse", version: "1.6.1179.0", versionPolicy: "exact", store: "gog" },
          vortex: { version: "2.6.3", deploymentMethod: "hardlink", requiredExtensions: [] },
          mods: [mod("Honed Metal", ["SKSE/Plugins/HonedMetal.dll"])],
        } as never;
        const userState = {
          gameId: "skyrimse",
          gameVersion: "1.6.1179.0",
          vortexVersion: "2.6.3",
          deploymentMethod: "hardlink",
          enabledExtensions: [],
          store: "gog",
        } as never;
        const report = resolveCompatibility(manifest, userState);
        expect(report.warnings.join("\n")).not.toMatch(/different executables/i);
      },
    );
  });
});
