/**
 * Store builds (owner, 2026-10-18): Meridia is built on GOG Skyrim, and the
 * curator ships Steam builds of SKSE and five plugins beside the GOG ones.
 * The player's store picks the build; the build proves each one is what it
 * claims; the store warning stops naming what Event Horizon already swapped.
 */
import { describe, expect, it } from "vitest";

import type { EhcollManifest, EhcollNativePlugin } from "../../types/ehcoll";
import {
  defaultVariantPicks,
  modsForStore,
  storeGroupProblems,
  unpickedKeys,
  variantGroupsOf,
} from "../installer/variantGroups";
import { assessVersionMismatch } from "../resolver/versionMismatch";
import { checkStoreBuilds } from "./storeBuildCheck";
import { neededEventHorizon } from "./minEventHorizon";
import { skipsForStore } from "../../ui/pages/install/variantChoice";
import { computeVerdict } from "../../ui/pages/install/steps";
import type { InstallPlan } from "../../types/installPlan";

type Mod = EhcollManifest["mods"][number];

const declares = (path: string, runtimes: string[]): EhcollNativePlugin => ({
  path,
  extender: "skse",
  kind: "declares",
  versionIndependent: false,
  runtimes,
  hasQuery: false,
});
const GOG = "1.6.1179.1";
const STEAM = "1.6.1170";

const mod = (
  name: string,
  compareKey: string,
  extra: { store?: "steam" | "gog"; group?: string; dll?: EhcollNativePlugin } = {},
): Mod =>
  ({
    name,
    compareKey,
    state: {
      enabled: true,
      installOrder: 0,
      deploymentPriority: 0,
      ...(extra.group !== undefined
        ? {
            optional: true,
            variant: { group: extra.group, label: extra.store ?? name, ...(extra.store ? { store: extra.store } : {}) },
          }
        : {}),
      ...(extra.dll ? { nativePlugins: [extra.dll] } : {}),
    },
  }) as unknown as Mod;

const meridia = (mods: Mod[]): Pick<EhcollManifest, "game" | "mods" | "rules"> => ({
  game: { id: "skyrimse", version: "1.6.1179.0", versionPolicy: "exact", store: "gog" } as EhcollManifest["game"],
  mods,
  rules: [],
});

const JC_GOG = mod("JContainers GOG", "nexus:1:1", { store: "gog", group: "JContainers", dll: declares("SKSE/Plugins/JContainers64.dll", [GOG]) });
const JC_STEAM = mod("JContainers", "nexus:1:2", { store: "steam", group: "JContainers", dll: declares("SKSE/Plugins/JContainers64.dll", [STEAM]) });
const GOG_FIX = mod("Racemenu GOG Fix", "nexus:2:2", { store: "gog", group: "Racemenu GOG Fix" });
const TEXTURES = mod("A texture pack", "nexus:4:4");

describe("which build a player gets", () => {
  const mods = [JC_GOG, JC_STEAM, GOG_FIX, TEXTURES];
  const groups = variantGroupsOf(mods);
  const skips = (store?: "steam" | "gog"): string[] => unpickedKeys(groups, defaultVariantPicks(groups, new Map(), false, store)).sort();

  it("a Steam player gets the Steam build and no GOG-only fix", () => {
    expect(skips("steam")).toEqual(["nexus:1:1", "nexus:2:2"]);
  });

  it("a GOG player gets the GOG builds", () => {
    expect(skips("gog")).toEqual(["nexus:1:2"]);
  });

  it("an unknown store gets no store build until the player answers", () => {
    expect(skips(undefined)).toEqual(["nexus:1:1", "nexus:1:2", "nexus:2:2"]);
  });

  it("a remembered pick or low-end hardware never overrides the store", () => {
    const picks = defaultVariantPicks(groups, new Map([["JContainers", "gog"]]), true, "steam");
    expect(picks.get("JContainers")?.compareKey).toBe("nexus:1:2");
  });

  it("the player's answer re-decides only store builds", () => {
    const manifest = { mods: [...mods, mod("Unticked optional", "nexus:9:9")] };
    const answered = skipsForStore(manifest as never, ["nexus:1:1", "nexus:1:2", "nexus:2:2", "nexus:9:9"], "steam");
    expect(answered).toEqual(["nexus:1:1", "nexus:2:2", "nexus:9:9"]);
  });

  it("modsForStore drops the other store's builds and keeps everything on an unknown store", () => {
    expect(modsForStore(mods, "Steam").map((m) => m.name)).toEqual(["JContainers", "A texture pack"]);
    expect(modsForStore(mods, undefined)).toHaveLength(4);
  });

  it("an older Event Horizon is told it needs 0.2.82", () => {
    expect(neededEventHorizon(meridia(mods) as never)?.why).toContain("Steam and GOG builds picked for your game's store");
  });
});

describe("the build proves each store build", () => {
  it("passes when every build declares its own store's runtime", () => {
    const c = checkStoreBuilds(meridia([JC_GOG, JC_STEAM, GOG_FIX, TEXTURES]));
    expect(c.refusals).toEqual([]);
    expect(c.judged.map((j) => [j.store, j.runtime, j.cannotLoad])).toEqual([
      ["steam", STEAM, 0],
      ["gog", GOG, 0],
    ]);
  });

  it("refuses a 'Steam build' whose DLL only lists GOG's runtime", () => {
    const wrong = mod("JContainers", "nexus:1:2", { store: "steam", group: "JContainers", dll: declares("SKSE/Plugins/JContainers64.dll", [GOG]) });
    const c = checkStoreBuilds(meridia([JC_GOG, wrong]));
    expect(c.refusals).toEqual([expect.stringContaining('"JContainers" is marked as the Steam build')]);
  });

  it("checks the script extender itself by its runtime DLL's name", () => {
    const skse = (name: string, key: string, store: "steam" | "gog", file: string): Mod => {
      const m = mod(name, key, { store, group: "SKSE" });
      (m.state as { stagingFiles?: unknown }).stagingFiles = [{ path: file, size: 1 }, { path: "skse64_loader.exe", size: 1 }];
      return m;
    };
    const right = checkStoreBuilds(
      meridia([skse("SKSE GOG", "e:1", "gog", "skse64_1_6_1179.dll"), skse("SKSE", "e:2", "steam", "skse64_1_6_1170.dll")]),
    );
    expect(right.refusals).toEqual([]);
    const swapped = checkStoreBuilds(
      meridia([skse("SKSE GOG", "e:1", "gog", "skse64_1_6_1179.dll"), skse("SKSE", "e:2", "steam", "skse64_1_6_1179.dll")]),
    );
    expect(swapped.refusals).toEqual([expect.stringContaining("ships skse64_1_6_1179.dll, the script extender for 1.6.1179")]);
  });

  it("reports, without refusing, untagged plugins Steam players still swap by hand", () => {
    const papyrus = mod("PapyrusUtil GOG", "nexus:5:5", { dll: declares("SKSE/Plugins/PapyrusUtil.dll", [GOG]) });
    const c = checkStoreBuilds(meridia([JC_GOG, JC_STEAM, papyrus]));
    expect(c.refusals).toEqual([]);
    expect(c.warnings).toEqual([expect.stringContaining("PapyrusUtil.dll (PapyrusUtil GOG)")]);
  });

  it("refuses a group mixing store builds with untagged versions, or two builds for one store", () => {
    const untagged = mod("JContainers old", "nexus:1:3", { group: "JContainers" });
    const second = mod("JContainers again", "nexus:1:4", { store: "steam", group: "JContainers" });
    expect(storeGroupProblems(variantGroupsOf([JC_GOG, JC_STEAM, untagged, second]))).toEqual([
      expect.stringContaining("mixes store builds"),
      expect.stringContaining("2 steam builds"),
    ]);
  });

  it("says nothing for a collection without store builds", () => {
    expect(checkStoreBuilds(meridia([TEXTURES]))).toEqual({ refusals: [], warnings: [], judged: [] });
  });
});

describe("what a Steam player is told", () => {
  it("the GOG build of a mod with a Steam build is not a swap", () => {
    const m = assessVersionMismatch({ manifest: meridia([JC_GOG, JC_STEAM, TEXTURES]), installed: "1.6.1170.0", store: "steam" });
    expect(m.plugins?.cannotLoad).toEqual([]);
    expect(m.plugins?.loads).toBe(1);
  });

  it("an unanswered store holds Continue", () => {
    const plan = {
      modResolutions: [],
      compatibility: { errors: [], warnings: [] },
      summary: { canProceed: true, needsUserConfirmation: 0, orphans: 0 },
    } as unknown as InstallPlan;
    const v = computeVerdict(plan, [], [], false, true);
    expect(v.canProceed).toBe(false);
    expect(v.headline).toBe("Which store is your game from?");
    expect(computeVerdict(plan, [], [], false, false).canProceed).toBe(true);
  });
});
