/**
 * The re-apply heal writes through Vortex's `set-plugin-list`, whose handler
 * takes names and nothing else: it lands in whatever game and profile are
 * active. So the heal must refuse unless the receipt's game and profile ARE
 * the active ones — and must not write when it refuses.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  applyPluginOrder: vi.fn(async () => ({ pinned: true, sorted: false, writeRequested: true, enabledCorrections: 0, notes: [] as string[] })),
}));

vi.mock("../installer/applyPluginOrder", () => ({ applyPluginOrder: h.applyPluginOrder }));
vi.mock("../installer/checkPluginOrder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../installer/checkPluginOrder")>()),
  readUserPluginsTxt: async () => [
    { name: "B.esp", enabled: true },
    { name: "A.esp", enabled: true },
  ],
}));
vi.mock("../comparePlugins", () => ({ discoveredStore: () => undefined }));

import { runHeal } from "./runHeal";

const receipt = {
  packageId: "pkg-ivy",
  packageName: "Ivy 2",
  packageVersion: "1.0.11",
  gameId: "skyrimse",
  vortexProfileId: "prof-ivy",
  vortexProfileName: "Ivy 2",
  installedAt: "2026-09-01T10:00:00.000Z",
  mods: [],
  rulesApplication: {
    baselinePluginOrder: [
      { name: "A.esp", enabled: true },
      { name: "B.esp", enabled: true },
    ],
  },
} as never;

const apiOn = (activeProfileId: string): never =>
  ({
    getState: () => ({
      settings: { profiles: { activeProfileId } },
      persistent: {
        profiles: {
          "prof-ivy": { gameId: "skyrimse", name: "Ivy 2" },
          default: { gameId: "skyrimse", name: "Default" },
          "prof-fo4": { gameId: "fallout4", name: "Fallout 4" },
        },
      },
      session: { plugins: { pluginList: { "a.esp": {}, "b.esp": {} } } },
      loadOrder: {
        "b.esp": { name: "B.esp", enabled: true, loadOrder: 0 },
        "a.esp": { name: "A.esp", enabled: true, loadOrder: 1 },
      },
    }),
    events: { emit: () => undefined },
    store: { dispatch: () => undefined },
  }) as never;

beforeEach(() => h.applyPluginOrder.mockClear());

describe("repin-plugin-order refuses an order it was not pinned into", () => {
  it("refuses — and writes nothing — when Vortex is managing another game", async () => {
    const outcome = await runHeal("repin-plugin-order", { api: apiOn("prof-fo4"), gameId: "skyrimse", receipt });
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind === "blocked") expect(outcome.reason).toMatch(/Vortex is managing fallout4/);
    expect(h.applyPluginOrder).not.toHaveBeenCalled();
  });

  it("refuses — and writes nothing — from a profile the collection was not installed into", async () => {
    const outcome = await runHeal("repin-plugin-order", { api: apiOn("default"), gameId: "skyrimse", receipt });
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind === "blocked") expect(outcome.reason).toMatch(/"Ivy 2".*"Default"/);
    expect(h.applyPluginOrder).not.toHaveBeenCalled();
  });

  it("writes when the receipt's game and profile are the active ones", async () => {
    const outcome = await runHeal("repin-plugin-order", { api: apiOn("prof-ivy"), gameId: "skyrimse", receipt });
    expect(outcome.kind).toBe("done");
    expect(h.applyPluginOrder).toHaveBeenCalledTimes(1);
  });
});
