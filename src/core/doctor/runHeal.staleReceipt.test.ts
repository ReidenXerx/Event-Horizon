/**
 * A repair works from the receipt the Doctor read when it looked. When an
 * install wrote a newer one since, the repair is refused instead of acting on
 * the previous revision: "Keep your versions" wrote the old receipt back over
 * the new one, "Enable" switched on mods the update had dropped (alasdairn,
 * Ivy Rev 13, 2026-10-08).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  onDisk: undefined as unknown,
  enabled: [] as Array<[string, string]>,
}));
vi.mock("../installLedger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../installLedger")>()),
  readReceipt: async () => h.onDisk,
}));
vi.mock("../installer/profile", () => ({
  enableModInProfile: (_api: unknown, profileId: string, modId: string) => h.enabled.push([profileId, modId]),
}));

import { runHeal } from "./runHeal";

const looked = {
  packageId: "pkg-ivy",
  packageName: "Ivy's Panties - Event Horizon",
  packageVersion: "1.0.42",
  gameId: "fallout4",
  vortexProfileId: "prof-ivy",
  vortexProfileName: "Ivy",
  installedAt: "2026-10-07T10:00:00.000Z",
  mods: [{ vortexModId: "dropped-in-rev-13", compareKey: "nexus:1:1", name: "Dropped" }],
};

const api = {
  getState: () => ({
    settings: { profiles: { activeProfileId: "prof-ivy", nextProfileId: "prof-ivy" } },
    persistent: {
      profiles: { "prof-ivy": { gameId: "fallout4", name: "Ivy", modState: {} } },
      mods: { fallout4: { "dropped-in-rev-13": { attributes: {} } } },
    },
  }),
  events: { emit: () => undefined },
  store: { dispatch: () => undefined },
} as never;

beforeAll(async () => {
  await Promise.all([import("./health"), import("../../ui/runtime/ehRuntime"), import("../../ui/pages/install/installSession")]);
}, 60_000);

describe("a repair after the collection was installed again", () => {
  it("is refused, and changes nothing", async () => {
    h.enabled.length = 0;
    h.onDisk = { ...looked, packageVersion: "1.0.43", installedAt: "2026-10-08T22:30:00.000Z", mods: [] };
    const out = await runHeal("enable-mods", { api, gameId: "fallout4", receipt: looked as never });
    expect(out).toMatchObject({ kind: "blocked" });
    expect((out as { reason: string }).reason).toMatch(/installed again \(1\.0\.43\)/);
    expect(h.enabled).toEqual([]);
  });

  it("goes ahead when the receipt on disk is the one the Doctor read", async () => {
    h.enabled.length = 0;
    h.onDisk = looked;
    const out = await runHeal("enable-mods", { api, gameId: "fallout4", receipt: looked as never });
    expect(out.kind).toBe("done");
    expect(h.enabled).toEqual([["prof-ivy", "dropped-in-rev-13"]]);
  });
});
