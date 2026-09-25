/**
 * The uninstall does exactly what the plan listed, and reports what happened.
 * A mod that could not be removed keeps the receipt, because the receipt is
 * the only record that the mod is ours.
 */
import { describe, expect, it, vi } from "vitest";

import type { UninstallPlan } from "./collectionUninstall";
import { runCollectionUninstall, UNINSTALL_CHUNK, type UninstallDeps } from "./runCollectionUninstall";

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

describe("runCollectionUninstall, removing in chunks", () => {
  // A Nexus report on 0.2.13: uninstalling a whole collection was "slow and one at a time". Vortex's removeMods
  // undeploys its whole list in one pass, so one call per mod paid that undeploy once per mod.
  const many = (n: number): UninstallPlan =>
    plan({ remove: Array.from({ length: n }, (_, i) => ({ vortexModId: `m${i}`, name: `M${i}`, from: "current" as const })) });

  it("removes in chunks of UNINSTALL_CHUNK when the host can take a list", async () => {
    const lists: string[][] = [];
    const { d } = deps({ uninstallMods: vi.fn(async (ids: readonly string[]) => void lists.push([...ids])) });
    const progress: number[] = [];
    const out = await runCollectionUninstall({
      plan: many(UNINSTALL_CHUNK * 2 + 3),
      collectionProfileId: "p34",
      deleteProfileIds: new Set(),
      deps: { ...d, onProgress: (done) => progress.push(done) },
    });
    expect(lists.map((l) => l.length)).toEqual([UNINSTALL_CHUNK, UNINSTALL_CHUNK, 3]);
    expect(d.uninstallMod).not.toHaveBeenCalled();
    expect(out.removed).toHaveLength(UNINSTALL_CHUNK * 2 + 3);
    expect(out.failed).toEqual([]);
    expect(out.receiptDeleted).toBe(true);
    expect(progress).toEqual([UNINSTALL_CHUNK, UNINSTALL_CHUNK * 2, UNINSTALL_CHUNK * 2 + 3]);
  });

  it("replays a failed chunk one mod at a time, so the failure is named and the rest still go", async () => {
    const { d } = deps({
      uninstallMods: vi.fn(async () => {
        throw new Error("EBUSY somewhere in the chunk");
      }),
      uninstallMod: vi.fn(async (id: string) => {
        if (id === "m2") throw new Error("EBUSY: m2 is open");
      }),
    });
    const out = await runCollectionUninstall({ plan: many(4), collectionProfileId: "p34", deleteProfileIds: new Set(), deps: d });
    expect(out.removed.map((m) => m.vortexModId)).toEqual(["m0", "m1", "m3"]);
    expect(out.failed).toEqual([{ mod: expect.objectContaining({ vortexModId: "m2" }), error: "EBUSY: m2 is open" }]);
    // A mod still on disk keeps the receipt: it is the only record that the mod is ours.
    expect(out.receiptDeleted).toBe(false);
  });

  it("still switches the player's displaced copy back on after a chunk removes ours", async () => {
    const { d, calls } = deps({ uninstallMods: vi.fn(async () => undefined) });
    const out = await runCollectionUninstall({ plan: plan(), collectionProfileId: "p34", deleteProfileIds: new Set(), deps: d });
    expect(out.restored).toBe(1);
    expect(calls).toContain("enable:p34:users-a");
  });
});
