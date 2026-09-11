/**
 * The re-apply heal writes through Vortex's `set-plugin-list`, whose handler
 * takes names and nothing else: it lands in whatever game and profile are
 * active. So the heal must refuse unless the receipt's game and profile ARE
 * the active ones — and must not write when it refuses.
 *
 * And it must write the order the Load order card previewed: built by the
 * same function, from Vortex's state — not from a plugins.txt that can lag
 * or differ.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  applyPluginOrder: vi.fn(async (_input: { order: readonly { name: string; enabled: boolean }[] }) => ({
    pinned: true,
    sorted: false,
    writeRequested: true,
    enabledCorrections: 0,
    notes: [] as string[],
  })),
}));

vi.mock("../installer/applyPluginOrder", () => ({ applyPluginOrder: h.applyPluginOrder }));
/**
 * plugins.txt deliberately DISAGREES with Vortex's state — a lagging or
 * hand-edited file. Merged from this, the heal would put Mine.esp first and
 * write a different order than the card previewed.
 */
vi.mock("../installer/checkPluginOrder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../installer/checkPluginOrder")>()),
  readUserPluginsTxt: async () => [
    { name: "Mine.esp", enabled: true },
    { name: "A.esp", enabled: true },
    { name: "B.esp", enabled: true },
    { name: "D.esp", enabled: true },
  ],
}));
vi.mock("../comparePlugins", () => ({ discoveredStore: () => undefined }));

import { buildRepinOrder, currentOrderFromState, previewRepin } from "./loadOrderStatus";
import { runHeal } from "./runHeal";

const baseline = [
  { name: "A.esp", enabled: true },
  { name: "D.esp", enabled: false },
  { name: "B.esp", enabled: true },
];

const receipt = {
  packageId: "pkg-ivy",
  packageName: "Ivy 2",
  packageVersion: "1.0.11",
  gameId: "skyrimse",
  vortexProfileId: "prof-ivy",
  vortexProfileName: "Ivy 2",
  installedAt: "2026-09-01T10:00:00.000Z",
  mods: [],
  rulesApplication: { baselinePluginOrder: baseline },
} as never;

const profiles = {
  "prof-ivy": { gameId: "skyrimse", name: "Ivy 2" },
  default: { gameId: "skyrimse", name: "Default" },
  "prof-fo4": { gameId: "fallout4", name: "Fallout 4" },
};

/** Vortex's state: D (off), B, A, then the user's own Mine. */
const stateOn = (activeProfileId: string, withPlugins = true): unknown => ({
  settings: { profiles: { activeProfileId } },
  persistent: { profiles },
  ...(withPlugins
    ? {
        session: { plugins: { pluginList: { "d.esp": {}, "b.esp": {}, "a.esp": {}, "mine.esp": {} } } },
        loadOrder: {
          "d.esp": { name: "D.esp", enabled: false, loadOrder: 0 },
          "b.esp": { name: "B.esp", enabled: true, loadOrder: 1 },
          "a.esp": { name: "A.esp", enabled: true, loadOrder: 2 },
          "mine.esp": { name: "Mine.esp", enabled: true, loadOrder: 3 },
        },
      }
    : {}),
});

const apiOver = (state: unknown): never =>
  ({
    getState: () => state,
    events: { emit: () => undefined },
    store: { dispatch: () => undefined },
  }) as never;

beforeEach(() => h.applyPluginOrder.mockClear());

describe("repin-plugin-order refuses an order it was not pinned into", () => {
  it("refuses — and writes nothing — when Vortex is managing another game", async () => {
    const outcome = await runHeal("repin-plugin-order", { api: apiOver(stateOn("prof-fo4")), gameId: "skyrimse", receipt });
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind === "blocked") expect(outcome.reason).toMatch(/Vortex is managing fallout4/);
    expect(h.applyPluginOrder).not.toHaveBeenCalled();
  });

  it("refuses — and writes nothing — from a profile the collection was not installed into", async () => {
    const outcome = await runHeal("repin-plugin-order", { api: apiOver(stateOn("default")), gameId: "skyrimse", receipt });
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind === "blocked") expect(outcome.reason).toMatch(/"Ivy 2".*"Default"/);
    expect(h.applyPluginOrder).not.toHaveBeenCalled();
  });

  it("refuses — and writes nothing — when Vortex lists no plugins for the game", async () => {
    const outcome = await runHeal("repin-plugin-order", { api: apiOver(stateOn("prof-ivy", false)), gameId: "skyrimse", receipt });
    expect(outcome.kind).toBe("blocked");
    expect(h.applyPluginOrder).not.toHaveBeenCalled();
  });
});

describe("repin-plugin-order writes the order the card previewed", () => {
  it("builds from Vortex's state with the preview's function, not from plugins.txt", async () => {
    const state = stateOn("prof-ivy");
    const outcome = await runHeal("repin-plugin-order", { api: apiOver(state), gameId: "skyrimse", receipt });
    expect(outcome.kind).toBe("done");
    expect(h.applyPluginOrder).toHaveBeenCalledTimes(1);
    const written = h.applyPluginOrder.mock.calls[0]![0].order;

    // Every recorded plugin keeps its curator slot (D included), Mine keeps
    // its own, and D stays switched off.
    expect(written).toEqual([
      { name: "A.esp", enabled: true },
      { name: "D.esp", enabled: false },
      { name: "B.esp", enabled: true },
      { name: "Mine.esp", enabled: true },
    ]);

    // …and it is the order the card's preview describes.
    const current = currentOrderFromState(state)!;
    expect(written).toEqual(buildRepinOrder(baseline, current));
    const replayed = current.map((p) => p.name);
    for (const m of previewRepin(baseline, current).moves) replayed[m.to] = m.name;
    expect(written.map((p) => p.name)).toEqual(replayed);
  });
});
