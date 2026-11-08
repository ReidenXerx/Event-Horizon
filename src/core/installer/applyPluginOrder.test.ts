/**
 * Pinning the curator's plugin order, and letting LOOT place everything else.
 *
 * The safety argument for doing this at all is the ORDER of three events: pin,
 * then sort, then write. Sorting is the step that can fail — LOOT refuses
 * outright when rules form a cycle — and pinning first means that failure
 * costs the interleaving of the user's own plugins, never the curator's order.
 * That is why the failure paths carry more tests here than the happy one.
 */
import { describe, expect, it } from "vitest";

import type { types } from "@nexusmods/vortex-api";

import {
  applyPluginOrder,
  curatorOffPluginsOn,
  pickedModPluginsOff,
  describePluginOrderApplication,
} from "./applyPluginOrder";
import type { EhcollPluginEntry } from "../../types/ehcoll";

type Emit = { event: string; args: unknown[] };

const ORDER: EhcollPluginEntry[] = [
  { name: "Unofficial Fallout 4 Patch.esp", enabled: true },
  { name: "BakaFramework.esm", enabled: true },
  { name: "LOD Fixes and Additons.esp", enabled: false },
];

/**
 * A Vortex whose event bus behaves like the real one.
 *
 * `sort` decides what the autosort handler does: call back cleanly, call back
 * with an error (LOOT's cycle case), or never call back at all.
 */
/**
 * What Vortex currently thinks, keyed by plugin id (lowercased).
 *
 * Default: every plugin in ORDER is deployed and ENABLED. That makes the one
 * plugin the curator disabled the single genuine correction, which is the real
 * shape of this collection — 816 of 817 already agree.
 */
const DEPLOYED_ALL_ENABLED: Record<string, { enabled: boolean }> = {
  "unofficial fallout 4 patch.esp": { enabled: true },
  "bakaframework.esm": { enabled: true },
  "lod fixes and additons.esp": { enabled: true },
};

const fakeApi = (
  sort: "ok" | { error: string } | "never",
  loadOrder: Record<string, { enabled: boolean }> = DEPLOYED_ALL_ENABLED,
): {
  api: types.IExtensionApi;
  emits: Emit[];
  dispatched: Array<{ type: string; payload?: unknown }>;
} => {
  const emits: Emit[] = [];
  const dispatched: Array<{ type: string; payload?: unknown }> = [];
  const api = {
    getState: () => ({ loadOrder }),
    events: {
      emit: (event: string, ...args: unknown[]): void => {
        emits.push({ event, args });
        if (event === "autosort-plugins") {
          const cb = args[1] as (e: Error | null) => void;
          if (sort === "ok") setTimeout(() => cb(null), 0);
          else if (sort !== "never") {
            setTimeout(() => cb(new Error(sort.error)), 0);
          }
          // "never": the handler exists and simply never answers.
        }
      },
    },
    store: {
      dispatch: (a: { type: string; payload?: unknown }): void => {
        dispatched.push(a);
      },
    },
  } as unknown as types.IExtensionApi;
  return { api, emits, dispatched };
};

const run = (
  api: types.IExtensionApi,
  over: Partial<Parameters<typeof applyPluginOrder>[0]> = {},
) =>
  applyPluginOrder({
    api,
    gameId: "fallout4",
    collectionId: "pkg-1",
    order: ORDER,
    sortTimeoutMs: 50,
    ...over,
  });

describe("pinning the curator's order", () => {
  it("sets the plugin list with setEnabled FALSE", async () => {
    // The flag is coupled: `true` force-enables ours AND DISABLES every plugin
    // the user added themselves. Silently switching off mods somebody chose to
    // install is not ours to do, and it is one boolean away.
    const { api, emits } = fakeApi("ok");
    await run(api);

    const pin = emits.find((e) => e.event === "set-plugin-list");
    expect(pin).toBeDefined();
    expect(pin!.args[0]).toEqual([
      "Unofficial Fallout 4 Patch.esp",
      "BakaFramework.esm",
      "LOD Fixes and Additons.esp",
    ]);
    expect(pin!.args[1]).toBe(false);
  });

  it("pins, THEN sorts, THEN writes", async () => {
    // The whole safety argument. Sorting before pinning would sort the user's
    // order rather than the curator's, and writing before sorting would save
    // the un-integrated list.
    const { api, emits } = fakeApi("ok");
    await run(api);

    const seq = emits.map((e) => e.event);
    expect(seq.indexOf("set-plugin-list")).toBeGreaterThan(-1);
    expect(seq.indexOf("set-plugin-list")).toBeLessThan(
      seq.indexOf("autosort-plugins"),
    );
    expect(seq.indexOf("autosort-plugins")).toBeLessThan(
      seq.indexOf("collection-postprocess-complete"),
    );
  });

  it("corrects ONLY the plugin whose enabled state actually differs", async () => {
    // `setEnabled: false` above means our plugins keep whatever state they had
    // — so a plugin the curator deliberately turned OFF would still load. One
    // is enough to change what the game does; this collection ships exactly
    // one.
    //
    // And only that one gets a dispatch. Firing all 817 unconditionally was
    // 817 synchronous Redux actions, each waking the plugin list's React tree,
    // to change about one — and it made the reported count a loop bound
    // dressed up as a finding.
    const { api, dispatched } = fakeApi("ok");
    const result = await run(api);

    const sets = dispatched.filter((d) => d.type === "SET_PLUGIN_ENABLED");
    expect(sets).toHaveLength(1);
    expect(result.enabledCorrections).toBe(1);
    expect(sets[0].payload).toMatchObject({
      pluginName: "LOD Fixes and Additons.esp",
      enabled: false,
    });
  });

  it("says nothing about plugins Vortex has never heard of", async () => {
    // A plugin in the manifest with no entry here did not deploy — most often
    // its mod failed to install. Setting a state for it would invent an entry
    // for a file that is not on disk, and the persistor writes only deployed
    // plugins regardless.
    const { api, dispatched } = fakeApi("ok", {});
    const result = await run(api);

    expect(dispatched.filter((d) => d.type === "SET_PLUGIN_ENABLED")).toEqual([]);
    expect(result.enabledCorrections).toBe(0);
    expect(result.pinned).toBe(true); // the ORDER is still pinned
  });

  it("matches Vortex's plugin ids, not raw filenames", async () => {
    // The extension keys everything on toPluginId — lowercased, .ghost
    // stripped. Comparing raw names would match nothing, silently restoring
    // the dispatch-everything behaviour this replaced.
    const { api, dispatched } = fakeApi("ok", {
      "unofficial fallout 4 patch.esp": { enabled: false }, // differs
      "bakaframework.esm": { enabled: true },
      "lod fixes and additons.esp": { enabled: false }, // already correct
    });
    await run(api);

    const sets = dispatched.filter((d) => d.type === "SET_PLUGIN_ENABLED");
    expect(sets).toHaveLength(1);
    expect((sets[0].payload as { pluginName: string }).pluginName).toBe(
      "Unofficial Fallout 4 Patch.esp",
    );
  });

  it("reports success by saying nothing at all", async () => {
    const { api } = fakeApi("ok");
    const result = await run(api);
    expect(result).toMatchObject({ pinned: true, sorted: true, writeRequested: true });
    expect(describePluginOrderApplication(result)).toBeUndefined();
  });
});

describe("when LOOT will not sort", () => {
  it("keeps the pinned order AND still writes it — a cycle costs the interleaving only", async () => {
    // This is the case that killed the previous design. The "~399 LOOT rules"
    // approach was rejected because a cycle meant no sort at all, which is
    // worse than drift. Pinning first is what makes the attempt safe: the
    // curator's order is already in the hive and still reaches disk.
    const { api, emits } = fakeApi({
      error: "Cyclic interaction detected between plugins",
    });
    const result = await run(api);

    expect(result.pinned).toBe(true);
    expect(result.sorted).toBe(false);
    expect(result.writeRequested).toBe(true); // <- the load-bearing assertion
    expect(emits.some((e) => e.event === "collection-postprocess-complete")).toBe(
      true,
    );
    expect(result.notes.join(" ")).toMatch(/cyclic/i);
  });

  it("does not hang the install when the sort never answers", async () => {
    // An event with a callback that never fires would stall the driver at the
    // very last step, after everything else had succeeded.
    const { api } = fakeApi("never");
    const result = await run(api, { sortTimeoutMs: 30 });

    expect(result.sorted).toBe(false);
    expect(result.writeRequested).toBe(true);
    expect(result.notes.join(" ")).toMatch(/did not finish sorting/i);
  });

  it("tells the user their own plugins were not woven in", async () => {
    const { api } = fakeApi({ error: "Cyclic interaction" });
    const lines = describePluginOrderApplication(await run(api));
    expect(lines!.join(" ")).toMatch(/order was applied/i);
    expect(lines!.join(" ")).toMatch(/load after the collection/i);
  });
});

describe("degrading instead of failing", () => {
  it("does nothing, loudly, on a Vortex with no event bus", async () => {
    // An older Vortex, or one where these events were renamed. The mods are
    // already installed and correct by this point: a load order we cannot set
    // is a worse install, not a failed one.
    const api = { store: { dispatch: () => undefined } } as unknown as types.IExtensionApi;
    const result = await run(api);

    expect(result.pinned).toBe(false);
    expect(result.notes.join(" ")).toMatch(/no event bus/i);
    expect(describePluginOrderApplication(result)!.join(" ")).toMatch(
      /could not be applied/i,
    );
  });

  it("says so when the collection recorded no order", async () => {
    const { api, emits } = fakeApi("ok");
    const result = await run(api, { order: [] });
    expect(result.pinned).toBe(false);
    expect(emits).toEqual([]);
    expect(result.notes.join(" ")).toMatch(/no plugin order/i);
  });

  it("never throws when the store rejects an enable dispatch", async () => {
    const api = {
      events: {
        emit: (event: string, ...args: unknown[]): void => {
          if (event === "autosort-plugins") {
            (args[1] as (e: Error | null) => void)(null);
          }
        },
      },
      store: {
        dispatch: (): void => {
          throw new Error("store is locked");
        },
      },
    } as unknown as types.IExtensionApi;

    const result = await run(api);
    expect(result.pinned).toBe(true);
    expect(result.enabledCorrections).toBe(0);
  });
});

describe("the driver applies it after deploying", () => {
  const read = async (rel: string): Promise<string> => {
    const fs = await import("fs");
    const path = await import("path");
    return fs.readFileSync(path.join(__dirname, rel), "utf8");
  };

  it("pins the order only after the mods are on disk", async () => {
    // Vortex only knows a plugin exists once its mod has been deployed, so
    // setting the order before that would name plugins it has never heard of.
    const src = await read("runInstall.ts");
    expect(src.indexOf("await deployAndWait(api)")).toBeLessThan(
      src.indexOf("await applyPluginOrder({"),
    );
  });

  it("measures drift AFTER writing, so it reports what the game will load", async () => {
    const src = await read("runInstall.ts");
    expect(src.indexOf("await applyPluginOrder({")).toBeLessThan(
      src.indexOf("await readUserPluginsTxt("),
    );
  });

  it("surfaces a failure rather than logging it into the void", async () => {
    const src = await read("runInstall.ts");
    expect(src).toMatch(/pluginOrderNotApplied/);
    const fs = await import("fs");
    const path = await import("path");
    const steps = fs.readFileSync(
      path.join(__dirname, "..", "..", "ui", "pages", "install", "steps.tsx"),
      "utf8",
    );
    expect(steps).toMatch(
      /<PluginOrderNotAppliedNotice[\s\S]{0,120}result\.pluginOrderNotApplied/,
    );
  });
});

// Ivy Rev 28 (stormy0286, 11-07): ETJ10mmPistol.esp shipped off, ticked by
// Vortex when its single-plugin mod was switched on after the enabled pass.
describe("curatorOffPluginsOn", () => {
  const order = [
    { name: "Ivy.esm", enabled: true },
    { name: "ETJ10mmPistol.esp", enabled: false },
    { name: "VehicleOverhaulContinued_Previs.esp", enabled: false },
  ];
  it("names a collection mod's plugin the curator shipped off that is on now", () => {
    const plugins = [
      { name: "Ivy.esm", enabled: true, modId: "ivy" },
      { name: "etj10mmpistol.esp", enabled: true, modId: "etj" },
      { name: "VehicleOverhaulContinued_Previs.esp", enabled: false, modId: "voc" },
    ];
    expect(curatorOffPluginsOn(order, plugins, new Set(["ivy", "etj", "voc"]))).toEqual(["etj10mmpistol.esp"]);
  });
  it("leaves the player's own mod and loose plugins alone", () => {
    const plugins = [
      { name: "ETJ10mmPistol.esp", enabled: true, modId: "players-own" },
      { name: "VehicleOverhaulContinued_Previs.esp", enabled: true },
    ];
    expect(curatorOffPluginsOn(order, plugins, new Set(["ivy", "etj", "voc"]))).toEqual([]);
  });
});

describe("pickedModPluginsOff", () => {
  const plugins = [
    { name: "AceMaleRace.esp", enabled: false, modId: "amr" },
    { name: "AMR KSHairdos.esp", enabled: false, modId: "amr-patch" },
    { name: "AceMaleRace - Base.esp", enabled: true, modId: "amr" },
    { name: "etj10mmpistol.esp", enabled: false, modId: "etj" },
    { name: "Loose.esp", enabled: false },
  ];
  it("names the off plugins of a picked mod the curator shipped off", () => {
    expect(pickedModPluginsOff(plugins, new Set(["amr", "amr-patch"]))).toEqual(["AceMaleRace.esp", "AMR KSHairdos.esp"]);
  });
  it("leaves every other mod's and loose plugins alone", () => {
    expect(pickedModPluginsOff(plugins, new Set())).toEqual([]);
    expect(pickedModPluginsOff(plugins, new Set(["players-own"]))).toEqual([]);
  });
});
