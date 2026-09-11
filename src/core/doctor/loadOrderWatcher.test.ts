/**
 * The watcher compares the active order against the receipt that OWNS it —
 * the newest install into the active game and profile — and nothing else.
 * When there is no such receipt its notification goes away: left up, the
 * Re-apply on it is bound to a receipt whose order is not the one on screen.
 *
 * It stays out of an install's way, never drops a change that lands while it
 * is looking, and every Re-apply it offers refuses on the Doctor's grounds
 * and runs one at a time. Every one of those decisions is in the log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type HealResult = { kind: "done"; summary: string } | { kind: "blocked"; reason: string };

const h = vi.hoisted(() => ({
  receipts: [] as unknown[],
  /** listReceipts waits on this; a test holds it to keep a look running. */
  gate: Promise.resolve() as Promise<void>,
  runHeal: vi.fn(async (): Promise<HealResult> => ({ kind: "done", summary: "ok" })),
  logs: [] as Array<{ event: string; data: Record<string, unknown> }>,
}));

vi.mock("../installLedger", () => ({
  listReceipts: async () => {
    await h.gate;
    return h.receipts;
  },
}));
vi.mock("../paths", () => ({ getVortexUserDataPath: () => "C:/vortex" }));
vi.mock("./runHeal", () => ({ runHeal: h.runHeal }));
vi.mock("../logging/ehLog", () => ({
  ehLog: (_level: string, event: string, data: Record<string, unknown> = {}): void => {
    h.logs.push({ event, data });
  },
  beginOp: () => ({ ok: (): undefined => undefined, fail: (): undefined => undefined }),
}));

/** A fresh module graph: the watcher's `started` latch and the runtime singleton are per process. */
async function fresh() {
  vi.resetModules();
  const watcher = await import("./loadOrderWatcher");
  const { getEHRuntime } = await import("../../ui/runtime/ehRuntime");
  return { ...watcher, runtime: getEHRuntime() };
}

const on = (...names: string[]): { name: string; enabled: boolean }[] => names.map((name) => ({ name, enabled: true }));

const receipt = (over: Record<string, unknown> = {}): never =>
  ({
    packageId: "pkg-ivy",
    packageName: "Ivy 2",
    packageVersion: "1.0.11",
    gameId: "skyrimse",
    vortexProfileId: "prof-ivy",
    vortexProfileName: "Ivy 2",
    installedAt: "2026-09-01T10:00:00.000Z",
    mods: [],
    rulesApplication: { baselinePluginOrder: on("A.esp", "B.esp") },
    ...over,
  }) as never;

function vortex(initialProfile: string, initialOrder: string[]) {
  let activeProfileId = initialProfile;
  let order = initialOrder;
  const callbacks: Array<{ path: string; cb: () => void }> = [];
  const sent: Array<{ id?: string }> = [];
  const dismissed: string[] = [];
  const api = {
    getState: () => ({
      settings: { profiles: { activeProfileId } },
      persistent: {
        profiles: {
          "prof-ivy": { gameId: "skyrimse", name: "Ivy 2" },
          default: { gameId: "skyrimse", name: "Default" },
        },
      },
      session: { plugins: { pluginList: Object.fromEntries(order.map((n) => [n.toLowerCase(), {}])) } },
      loadOrder: Object.fromEntries(order.map((n, i) => [n.toLowerCase(), { name: n, enabled: true, loadOrder: i }])),
    }),
    onStateChange: (path: string[], cb: () => void): void => {
      callbacks.push({ path: path.join("."), cb });
    },
    sendNotification: (n: { id?: string }): void => {
      sent.push(n);
    },
    dismissNotification: (id: string): void => {
      dismissed.push(id);
    },
    events: { on: (): undefined => undefined, emit: (): undefined => undefined },
  };
  const fire = (path: string): void => {
    for (const c of callbacks) if (c.path === path) c.cb();
  };
  return {
    api: api as never,
    sent,
    dismissed,
    switchTo(pid: string): void {
      activeProfileId = pid;
      fire("settings.profiles.activeProfileId");
    },
    reorder(next: string[]): void {
      order = next;
      fire("loadOrder");
    },
  };
}

const logged = (event: string): Array<Record<string, unknown>> => h.logs.filter((l) => l.event === event).map((l) => l.data);
const drift = (sent: Array<{ id?: string }>): boolean => sent.some((n) => n.id === "event-horizon-load-order-drift");

beforeEach(() => {
  h.gate = Promise.resolve();
  h.logs.length = 0;
  h.runHeal.mockReset();
  h.runHeal.mockImplementation(async () => ({ kind: "done", summary: "ok" }));
});

describe("assessActiveOrder", () => {
  it("compares nothing when the collection lives in another profile", async () => {
    const { assessActiveOrder } = await fresh();
    h.receipts = [receipt()];
    const look = await assessActiveOrder(vortex("default", ["B.esp", "A.esp"]).api);
    expect(look.kind).toBe("nothing");
    if (look.kind !== "nothing") return;
    expect(look.reason).toBe("other-profile");
    expect(look.elsewhere[0]).toMatch(/Ivy 2.*"Ivy 2"/);
  });

  it("compares the newest install into the active profile, and names what it supersedes", async () => {
    const { assessActiveOrder } = await fresh();
    const older = receipt();
    const newer = receipt({ packageId: "pkg-new", packageName: "Other", packageVersion: "2.0.0", installedAt: "2026-09-05T10:00:00.000Z" });
    h.receipts = [newer, older];
    const look = await assessActiveOrder(vortex("prof-ivy", ["B.esp", "A.esp"]).api);
    expect(look.kind).toBe("assessed");
    if (look.kind !== "assessed") return;
    expect(look.receipt).toBe(newer);
    expect(look.superseded).toEqual(["Ivy 2 v1.0.11"]);
  });
});

describe("reapplyCuratorOrder", () => {
  it("refuses a superseded receipt without running the heal", async () => {
    const { reapplyCuratorOrder } = await fresh();
    const older = receipt();
    const newer = receipt({ packageId: "pkg-new", packageName: "Other", installedAt: "2026-09-05T10:00:00.000Z" });
    h.receipts = [older, newer];
    const outcome = await reapplyCuratorOrder(vortex("prof-ivy", ["B.esp", "A.esp"]).api, older);
    expect(outcome.kind).toBe("blocked");
    expect(h.runHeal).not.toHaveBeenCalled();
  });

  it("runs the heal for the owner, and logs which receipt and profile it re-applied", async () => {
    const { reapplyCuratorOrder } = await fresh();
    const only = receipt();
    h.receipts = [only];
    await reapplyCuratorOrder(vortex("prof-ivy", ["B.esp", "A.esp"]).api, only);
    expect(h.runHeal).toHaveBeenCalledTimes(1);
    expect(logged("loadorder.reapply.done")).toEqual([
      expect.objectContaining({ package: "Ivy 2 v1.0.11", activeProfile: "Ivy 2", before: "drifted", moved: 1, outcome: "done" }),
    ]);
  });

  it("refuses while an install is running — two writers corrupt a collection", async () => {
    const { reapplyCuratorOrder, runtime } = await fresh();
    const only = receipt();
    h.receipts = [only];
    runtime.setInstallBusy(true);
    const outcome = await reapplyCuratorOrder(vortex("prof-ivy", ["B.esp", "A.esp"]).api, only);
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind === "blocked") expect(outcome.reason).toMatch(/install is running/i);
    expect(h.runHeal).not.toHaveBeenCalled();
    expect(logged("loadorder.reapply.refused")).toEqual([expect.objectContaining({ why: "install-running" })]);
  });

  it("runs one at a time: a second click while the first runs is refused", async () => {
    const { reapplyCuratorOrder } = await fresh();
    const only = receipt();
    h.receipts = [only];
    let finish: (r: HealResult) => void = () => undefined;
    h.runHeal.mockImplementationOnce(() => new Promise<HealResult>((resolve) => (finish = resolve)));
    const api = vortex("prof-ivy", ["B.esp", "A.esp"]).api;

    const first = reapplyCuratorOrder(api, only);
    const second = await reapplyCuratorOrder(api, only);
    expect(second.kind).toBe("blocked");
    if (second.kind === "blocked") expect(second.reason).toMatch(/already being re-applied/);

    await vi.waitFor(() => expect(h.runHeal).toHaveBeenCalledTimes(1));
    finish({ kind: "done", summary: "ok" });
    expect((await first).kind).toBe("done");
    // And the latch lets go.
    expect((await reapplyCuratorOrder(api, only)).kind).toBe("done");
    expect(h.runHeal).toHaveBeenCalledTimes(2);
  });
});

describe("startLoadOrderWatcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("dismisses its drift notification when the active profile has nothing to assess, and logs why", async () => {
    const { startLoadOrderWatcher } = await fresh();
    h.receipts = [receipt()];
    const v = vortex("prof-ivy", ["B.esp", "A.esp"]);
    startLoadOrderWatcher(v.api);
    await vi.advanceTimersByTimeAsync(8000);
    await vi.waitFor(() => expect(drift(v.sent)).toBe(true));
    expect(logged("loadorder.watch.assessed")).toEqual([
      expect.objectContaining({ package: "Ivy 2 v1.0.11", profile: "Ivy 2", status: "drifted", moved: 1 }),
    ]);

    // Same game, the Default profile: the collection was never installed here.
    v.switchTo("default");
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(v.dismissed).toContain("event-horizon-load-order-drift"));
    expect(logged("loadorder.watch.skip")).toEqual([
      expect.objectContaining({ reason: "other-profile", activeProfile: "Default", installedIn: ['Ivy 2 v1.0.11 in "Ivy 2"'] }),
    ]);
  });

  it("takes its notification down the moment an install starts", async () => {
    const { startLoadOrderWatcher, runtime } = await fresh();
    h.receipts = [receipt()];
    const v = vortex("prof-ivy", ["B.esp", "A.esp"]);
    startLoadOrderWatcher(v.api);
    await vi.advanceTimersByTimeAsync(8000);
    await vi.waitFor(() => expect(drift(v.sent)).toBe(true));

    runtime.setInstallBusy(true);
    expect(v.dismissed).toContain("event-horizon-load-order-drift");
    runtime.setInstallBusy(false);
  });

  it("judges the order when the install finishes, not at the next order change", async () => {
    const { startLoadOrderWatcher, runtime } = await fresh();
    h.receipts = [receipt()];
    const v = vortex("prof-ivy", ["B.esp", "A.esp"]);
    runtime.setInstallBusy(true);
    startLoadOrderWatcher(v.api);
    await vi.advanceTimersByTimeAsync(8000);
    expect(drift(v.sent)).toBe(false);
    expect(logged("loadorder.watch.skip")).toEqual([expect.objectContaining({ reason: "install-running" })]);

    runtime.setInstallBusy(false);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(drift(v.sent)).toBe(true));
  });

  it("looks again when the order changed while a look was still running", async () => {
    const { startLoadOrderWatcher } = await fresh();
    h.receipts = [receipt()];
    let open: () => void = () => undefined;
    h.gate = new Promise<void>((resolve) => (open = resolve));
    const v = vortex("prof-ivy", ["B.esp", "A.esp"]);
    startLoadOrderWatcher(v.api);

    // Look #1 reads the drifted order, then waits on the receipts.
    await vi.advanceTimersByTimeAsync(8000);
    // The user's re-apply lands meanwhile; its look finds #1 still running.
    v.reorder(["A.esp", "B.esp"]);
    await vi.advanceTimersByTimeAsync(2000);

    open();
    await vi.waitFor(() => expect(drift(v.sent)).toBe(true));
    // The dropped look is run after all: it sees the restored order.
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(v.dismissed).toContain("event-horizon-load-order-drift"));
  });
});
