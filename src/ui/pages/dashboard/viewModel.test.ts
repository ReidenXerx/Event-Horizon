/**
 * Which collection the dashboard puts on the hero, and what it says about it.
 *
 * The hero carries a Play button, so picking the wrong receipt is not a
 * cosmetic error: it would name one collection while starting the game set up
 * for another. The same mistake — taking `receipts[0]` — once had the Doctor
 * diagnosing a three-week-old collection and offering a profile switch that
 * undid a fresh install.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { __clearHealthCache, healthOf, toViewModel, type DashboardSources } from "./useDashboardView";
import type { InstallReceipt } from "../../../types/installLedger";

const receipt = (over: Partial<InstallReceipt>): InstallReceipt =>
  ({
    packageId: "pkg",
    packageName: "A collection",
    packageVersion: "1.0.0",
    gameId: "skyrimse",
    installedAt: "2026-09-20T00:00:00Z",
    vortexProfileId: "p1",
    vortexProfileName: "Profile",
    installTargetMode: "fresh-profile",
    mods: [],
    ...over,
  }) as InstallReceipt;

const sources = (over: Partial<DashboardSources> = {}): DashboardSources => ({
  data: {
    status: {
      gameId: "skyrimse",
      gameIsSupported: true,
      gameLabel: "Skyrim Special Edition",
      profileId: "p1",
      profileName: "Meridia",
      vortexVersion: "2.6.0",
      appDataPath: "C:/x",
    },
    receipts: [],
    receiptErrors: [],
    curatorConfigs: [],
    builtPackages: [],
    ...over.data,
  },
  // Vortex's answer about the active game, read once by the loader.
  game: { version: "1.6.1179.0", store: "gog" },
  health: new Map(),
  art: new Map(),
  played: new Map(),
  updates: new Map(),
  ...over,
} as DashboardSources);

const base = {
  mode: "player" as const,
  disk: undefined,
  diskBusy: false,
  curatorBusy: false,
  curatorStats: new Map(),
  now: Date.parse("2026-09-22T12:00:00Z"),
};

describe("which collection leads", () => {
  it("shows the ACTIVE game's collection, never another game's", () => {
    // `loadDashboardData` sorts newest first, so a Fallout install done today
    // sits ahead of the Skyrim one the player is actually standing in.
    const s = sources({
      data: {
        ...sources().data,
        receipts: [
          receipt({ packageId: "fo4", packageName: "Ivy", gameId: "fallout4", installedAt: "2026-09-22T00:00:00Z" }),
          receipt({ packageId: "sse", packageName: "Meridia", gameId: "skyrimse" }),
        ],
      },
    });
    const vm = toViewModel({ sources: s, ...base });
    expect(vm.hero?.name).toBe("Meridia");
    expect(vm.tiles).toEqual([]);
  });

  it("puts the rest of that game's collections in tiles", () => {
    const s = sources({
      data: {
        ...sources().data,
        receipts: [
          receipt({ packageId: "a", packageName: "New", installedAt: "2026-09-22T00:00:00Z" }),
          receipt({ packageId: "b", packageName: "Old", installedAt: "2026-09-01T00:00:00Z" }),
        ],
      },
    });
    const vm = toViewModel({ sources: s, ...base });
    expect(vm.hero?.name).toBe("New");
    expect(vm.tiles.map((t) => t.name)).toEqual(["Old"]);
  });

  it("has no hero at all on a machine with nothing installed", () => {
    const vm = toViewModel({ sources: sources(), ...base });
    expect(vm.hero).toBeUndefined();
    expect(vm.curatorEmpty).toBe(true);
  });

  it("reports health as unknown when the checks could not run", () => {
    const s = sources({ data: { ...sources().data, receipts: [receipt({})] } });
    const vm = toViewModel({ sources: s, ...base });
    // No checks gathered: not 0%, not 100%.
    expect(vm.hero?.health.percent).toBeUndefined();
  });
});

describe("the curator's side", () => {
  const configs = [
    {
      slug: "meridia-s-panties-event-horizon",
      configPath: "x",
      modifiedAt: 0,
      config: {
        nexusCollection: { id: 1, slug: "ecb76c", gameDomain: "skyrimspecialedition", name: "Meridia on Nexus" },
      },
    },
    // A config that was never published has no page and no stats to show.
    { slug: "unpublished", configPath: "y", modifiedAt: 0, config: {} },
  ] as unknown as DashboardSources["data"]["curatorConfigs"];

  const packages = [
    { packagePath: "p", fileName: "meridia-s-panties-event-horizon-1.0.22.zip", modifiedAt: 200, sizeBytes: 1_730_000_000 },
    { packagePath: "p", fileName: "meridia-s-panties-event-horizon-1.0.21.zip", modifiedAt: 100, sizeBytes: 1_665_000_000 },
    { packagePath: "p", fileName: "some-other-collection-9.9.9.zip", modifiedAt: 300, sizeBytes: 1_000_000 },
  ];

  it("shows only published collections, with their own builds oldest first", () => {
    const s = sources({ data: { ...sources().data, curatorConfigs: configs, builtPackages: packages } });
    const vm = toViewModel({ sources: s, ...base, mode: "curator" });
    expect(vm.curator).toHaveLength(1);
    expect(vm.curator[0].slug).toBe("ecb76c");
    expect(vm.curator[0].name).toBe("Meridia on Nexus");
    // Another collection's package must not appear in this one's trend.
    expect(vm.curator[0].builds.map((b) => b.label)).toEqual(["1.0.21", "1.0.22"]);
    expect(vm.curator[0].builds.map((b) => b.megabytes)).toEqual([1665, 1730]);
  });
});

/**
 * The health gather opens one plugin header per recorded plugin — 1,597 on
 * the reference collection, serially — and Home remounts on every
 * navigation. The answer is cached for a minute, keyed on the INSTALL, so a
 * reinstall is never answered from the previous install's measurement.
 */
describe("the health measurement is not repeated on every visit", () => {
  beforeEach(() => __clearHealthCache());

  /** Counts every read of Vortex state, which is what the gather costs. */
  const fakeApi = (count: { reads: number }) =>
    ({
      getState: () => {
        count.reads += 1;
        return { persistent: { profiles: {}, mods: {} }, settings: { profiles: {} }, session: {} };
      },
    }) as never;

  it("asks once for the same install, then serves the memo", async () => {
    const count = { reads: 0 };
    const r = receipt({ packageId: "p", installedAt: "2026-09-20T00:00:00Z" });
    await healthOf(fakeApi(count), r, [r]);
    const afterFirst = count.reads;
    expect(afterFirst).toBeGreaterThan(0);
    await healthOf(fakeApi(count), r, [r]);
    expect(count.reads).toBe(afterFirst);
  });

  it("measures again once the collection has been reinstalled", async () => {
    // Keyed on the install, not the package: answering a fresh install from
    // the previous one's measurement would be worse than no cache at all.
    const count = { reads: 0 };
    const first = receipt({ packageId: "p", installedAt: "2026-09-20T00:00:00Z" });
    await healthOf(fakeApi(count), first, [first]);
    const afterFirst = count.reads;
    const again = receipt({ packageId: "p", installedAt: "2026-09-22T00:00:00Z" });
    await healthOf(fakeApi(count), again, [again]);
    expect(count.reads).toBeGreaterThan(afterFirst);
  });
});
