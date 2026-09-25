/**
 * The uninstall does exactly what the plan listed, and reports what happened.
 * A mod that could not be removed keeps the receipt, because the receipt is
 * the only record that the mod is ours.
 */
import { describe, expect, it, vi } from "vitest";

import type { UninstallPlan } from "./collectionUninstall";
import { runCollectionUninstall, type UninstallDeps } from "./runCollectionUninstall";

const plan = (over: Partial<UninstallPlan> = {}): UninstallPlan => ({
  packageId: "pkg",
  packageName: "Ivy",
  gameId: "fallout4",
  remove: [
    { vortexModId: "a", name: "A", from: "current", displacedModId: "users-a" },
    { vortexModId: "b", name: "B", from: "retired" },
  ],
  keep: [],
  notOursCount: 0,
  alreadyGoneCount: 0,
  profiles: [
    { id: "p34", name: "Ivy (Event Horizon v1.0.34)", deletable: true },
    { id: "p33", name: "Ivy (Event Horizon v1.0.33)", deletable: true },
    { id: "active", name: "Ivy (Event Horizon v1.0.32)", deletable: false, reason: "active" },
  ],
  ...over,
});

const deps = (over: Partial<UninstallDeps> = {}) => {
  const calls: string[] = [];
  const d: UninstallDeps = {
    uninstallMod: vi.fn(async (id: string) => {
      calls.push(`remove:${id}`);
    }),
    enableModInProfile: vi.fn((profileId: string, id: string) => {
      calls.push(`enable:${profileId}:${id}`);
    }),
    removeProfiles: vi.fn(async (profiles) => {
      calls.push(`profiles:${profiles.map((p) => p.id).join(",")}`);
      return { removed: profiles.map((p) => ({ id: p.id })), failed: [] };
    }),
    deleteReceipt: vi.fn(async () => {
      calls.push("delete-receipt");
    }),
    clearStoredPackage: vi.fn(async () => {
      calls.push("clear-package");
    }),
    ...over,
  };
  return { d, calls };
};

describe("runCollectionUninstall", () => {
  it("removes every listed mod, deletes only ticked deletable profiles, then the receipt and package", async () => {
    const { d, calls } = deps();
    const out = await runCollectionUninstall({
      plan: plan(),
      collectionProfileId: "p34",
      deleteProfileIds: new Set(["p33", "active"]),
      deps: d,
    });
    expect(calls).toEqual(["remove:a", "enable:p34:users-a", "remove:b", "profiles:p33", "delete-receipt", "clear-package"]);
    expect(out).toMatchObject({ restored: 1, profilesRemoved: ["p33"], receiptDeleted: true });
    expect(out.removed.map((m) => m.vortexModId)).toEqual(["a", "b"]);
  });

  it("does not switch the player's copy back on in a profile that is being deleted", async () => {
    const { d, calls } = deps();
    const out = await runCollectionUninstall({ plan: plan(), collectionProfileId: "p34", deleteProfileIds: new Set(["p34"]), deps: d });
    expect(calls.some((c) => c.startsWith("enable:"))).toBe(false);
    expect(out.restored).toBe(0);
  });

  it("keeps the receipt when a mod could not be removed, and says which", async () => {
    const { d, calls } = deps({
      uninstallMod: vi.fn(async (id: string) => {
        if (id === "b") throw new Error("staging drive offline");
      }),
    });
    const out = await runCollectionUninstall({ plan: plan(), collectionProfileId: "p34", deleteProfileIds: new Set(), deps: d });
    expect(out.failed).toEqual([{ mod: { vortexModId: "b", name: "B", from: "retired" }, error: "staging drive offline" }]);
    expect(out.receiptDeleted).toBe(false);
    expect(calls).not.toContain("delete-receipt");
    // The kept package serves the receipt: it goes only with it.
    expect(calls).not.toContain("clear-package");
  });

  it("reports progress for every mod", async () => {
    const seen: string[] = [];
    const { d } = deps({ onProgress: (done, total) => seen.push(`${done}/${total}`) });
    await runCollectionUninstall({ plan: plan(), collectionProfileId: "p34", deleteProfileIds: new Set(), deps: d });
    expect(seen).toEqual(["1/2", "2/2"]);
  });
});
