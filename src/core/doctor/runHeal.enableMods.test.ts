/**
 * The Doctor's "Enable N mods" fix, against Vortex's real state shape: profiles
 * live in persistent.profiles, while settings.profiles holds activeProfileId.
 * Reading the wrong one refused the fix for every real profile, saying it had
 * been deleted (Rubens, Ivy 1.0.37, 2026-09-28).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ enabled: [] as Array<[string, string]> }));
vi.mock("../installer/profile", () => ({
  enableModInProfile: (_api: unknown, profileId: string, modId: string) => h.enabled.push([profileId, modId]),
}));

import { runHeal } from "./runHeal";

const receipt = {
  packageId: "pkg-ivy",
  packageName: "Ivy's Panties - Event Horizon",
  packageVersion: "1.0.37",
  gameId: "fallout4",
  vortexProfileId: "prof-ivy",
  vortexProfileName: "Ivy's Panties - Event Horizon (Event Horizon v1.0.37)",
  installedAt: "2026-09-28T10:00:00.000Z",
  mods: [{ vortexModId: "anatomy-body" }, { vortexModId: "gone" }],
} as never;

const api = (profiles: Record<string, unknown>): never =>
  ({
    getState: () => ({
      settings: { profiles: { activeProfileId: "prof-ivy", nextProfileId: "prof-ivy" } },
      persistent: { profiles, mods: { fallout4: { "anatomy-body": {} } } },
    }),
    events: { emit: () => undefined },
    store: { dispatch: () => undefined },
  }) as never;

beforeAll(async () => {
  await Promise.all([import("./health"), import("../../ui/runtime/ehRuntime"), import("../../ui/pages/install/installSession")]);
}, 60_000);

describe("enable-mods", () => {
  it("enables the installed mods in a profile that exists in persistent.profiles", async () => {
    h.enabled.length = 0;
    const out = await runHeal("enable-mods", { api: api({ "prof-ivy": { gameId: "fallout4", name: "Ivy" } }), gameId: "fallout4", receipt });
    expect(out.kind).toBe("done");
    expect(h.enabled).toEqual([["prof-ivy", "anatomy-body"]]);
  });

  it("refuses, writing nothing, only when the profile really is gone", async () => {
    h.enabled.length = 0;
    const out = await runHeal("enable-mods", { api: api({ other: { gameId: "fallout4" } }), gameId: "fallout4", receipt });
    expect(out.kind).toBe("blocked");
    expect(h.enabled).toEqual([]);
  });
});
