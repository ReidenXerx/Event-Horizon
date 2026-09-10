/**
 * The clean-folder flow's ORDER is its contract: ask, purge, look again, move,
 * and only call the folder clean when a final scan finds nothing. Each case
 * pins one step that, skipped, would either touch a machine without consent
 * or report "clean" about a folder that is not.
 */
import { describe, expect, it, vi } from "vitest";

import { cleanGameFolder, describeCleanPlan } from "./cleanGameFolder";
import type { FolderEntry, GameFolderScan } from "./gameFolderScan";

const entry = (p: string): FolderEntry => ({ path: p, size: 10, mtimeMs: 1 });

const scanResult = (unmanaged: FolderEntry[], deployedCount: number, known = true): GameFolderScan => ({
  report: {
    vanilla: known ? { kind: "known", source: "gog", detail: "list", files: 5 } : { kind: "unknown", reason: "no record" },
    counts: { deployed: deployedCount, vanilla: 5, vortex: 0, declared: 0, creation: 0, tool: 0, "not-loaded": 0, volatile: 0, unmanaged: unmanaged.length },
    unmanaged,
    vanillaMissing: [],
    vanillaSizeMismatch: [],
  },
  manifests: [],
  deployedCount,
  unreadable: [],
  linkedDirs: [],
  creationSources: [],
  toolDlls: [],
});

function harness(scans: GameFolderScan[], options: { agree?: boolean; purgeFails?: boolean; failMoves?: string[] } = {}) {
  const calls: string[] = [];
  const queue = [...scans];
  const deps = {
    gameId: "fallout4",
    gameName: "Fallout 4",
    quarantineFolder: "E:/Games/Fallout 4/Event Horizon quarantine",
    scan: vi.fn(async () => {
      calls.push("scan");
      const next = queue.shift();
      if (next === undefined) throw new Error("unexpected extra scan");
      return next;
    }),
    purge: vi.fn(async () => {
      calls.push("purge");
      if (options.purgeFails === true) throw new Error("files changed outside Vortex");
    }),
    confirm: vi.fn(async () => {
      calls.push("confirm");
      return options.agree ?? true;
    }),
    quarantine: vi.fn(async (entries: FolderEntry[]) => {
      calls.push(`quarantine:${entries.length}`);
      const failed = entries.filter((e) => options.failMoves?.includes(e.path)).map((e) => ({ path: e.path, error: "EBUSY" }));
      return { recordPath: "C:/eh/quarantine/r.json", moved: entries.length - failed.length, failed };
    }),
  };
  return { deps, calls };
}

describe("cleanGameFolder", () => {
  it("does nothing at all without a store record — no question, no purge, no move", async () => {
    const { deps, calls } = harness([scanResult([entry("Data/x.esp")], 100, false)]);
    expect(await cleanGameFolder(deps)).toEqual({ kind: "unverifiable", reason: "no record" });
    expect(calls).toEqual(["scan"]);
  });

  it("asks nothing when the folder is already clean and nothing is deployed", async () => {
    const { deps, calls } = harness([scanResult([], 0)]);
    expect((await cleanGameFolder(deps)).kind).toBe("already-clean");
    expect(calls).toEqual(["scan"]);
  });

  it("touches nothing when the user declines", async () => {
    const { deps, calls } = harness([scanResult([entry("Data/F4SE/Plugins/a.dll")], 50)], { agree: false });
    expect((await cleanGameFolder(deps)).kind).toBe("declined");
    expect(calls).toEqual(["scan", "confirm"]);
  });

  it("purges BEFORE looking for leftovers, and moves what the purge left behind", async () => {
    const leftover = entry("Data/MCM/Settings/old.ini");
    const { deps, calls } = harness([
      scanResult([entry("Data/F4SE/Plugins/a.dll")], 50),
      scanResult([entry("Data/F4SE/Plugins/a.dll"), leftover], 0),
      scanResult([], 0),
    ]);
    const outcome = await cleanGameFolder(deps);
    expect(outcome).toEqual({ kind: "cleaned", purged: true, moved: 2, recordPath: "C:/eh/quarantine/r.json" });
    expect(calls).toEqual(["scan", "confirm", "purge", "scan", "quarantine:2", "scan"]);
  });

  it("does not purge when nothing is deployed", async () => {
    const { deps, calls } = harness([scanResult([entry("a.dll")], 0), scanResult([entry("a.dll")], 0), scanResult([], 0)]);
    expect((await cleanGameFolder(deps)).kind).toBe("cleaned");
    expect(calls).not.toContain("purge");
  });

  it("stops when Vortex's purge fails, before moving anything", async () => {
    const { deps, calls } = harness([scanResult([entry("a.dll")], 5)], { purgeFails: true });
    const outcome = await cleanGameFolder(deps);
    expect(outcome.kind).toBe("failed");
    expect(calls).toEqual(["scan", "confirm", "purge"]);
  });

  it("stops when files are still deployed after a purge", async () => {
    const { deps } = harness([scanResult([], 5), scanResult([], 3)]);
    expect((await cleanGameFolder(deps)).kind).toBe("failed");
  });

  it("reports the files that could not be moved", async () => {
    const { deps } = harness([scanResult([entry("a.dll"), entry("b.dll")], 0), scanResult([entry("a.dll"), entry("b.dll")], 0)], {
      failMoves: ["b.dll"],
    });
    const outcome = await cleanGameFolder(deps);
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" ? outcome.remaining.map((e) => e.path) : []).toEqual(["b.dll"]);
  });

  it("never claims clean unless the final scan agrees", async () => {
    const { deps } = harness([scanResult([entry("a.dll")], 0), scanResult([entry("a.dll")], 0), scanResult([entry("a.dll")], 0)]);
    const outcome = await cleanGameFolder(deps);
    expect(outcome.kind).toBe("failed");
  });

  it("says the deployment was purged when moving fails afterwards — the game has no mods deployed", async () => {
    const { deps } = harness([scanResult([entry("a.dll")], 5), scanResult([entry("a.dll")], 0)], { failMoves: ["a.dll"] });
    const outcome = await cleanGameFolder(deps);
    expect(outcome).toMatchObject({ kind: "failed", purged: true });
  });

  it("stops, without moving, when the folder cannot be verified after the purge", async () => {
    const { deps, calls } = harness([scanResult([entry("a.dll")], 5), scanResult([], 0, false)]);
    const outcome = await cleanGameFolder(deps);
    expect(outcome).toMatchObject({ kind: "failed", purged: true });
    expect(calls).not.toContain("quarantine:1");
  });
});

describe("describeCleanPlan", () => {
  it("names the purge, the destination, that nothing is deleted, and the files", () => {
    const d = describeCleanPlan({
      gameName: "Fallout 4",
      deployedCount: 50_795,
      unmanaged: [entry("Data/F4SE/Plugins/a.dll"), entry("Data/F4SE/Plugins/b.dll"), entry("dxgi.dll")],
      quarantineFolder: "E:/Games/Fallout 4/Event Horizon quarantine",
    });
    expect(d.message).toMatch(/Purge Vortex's deployment for Fallout 4 \(50795 files\)/);
    expect(d.message).toMatch(/Event Horizon quarantine/);
    expect(d.message).toMatch(/Nothing is deleted/);
    expect(d.message).toMatch(/Data\/F4SE — 2 files/);
    expect(d.message).toMatch(/dxgi\.dll — 1 file/);
  });
});
