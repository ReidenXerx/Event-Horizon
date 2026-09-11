/**
 * The watcher compares the active order against the receipt that OWNS it —
 * the newest install into the active game and profile — and nothing else.
 * When there is no such receipt its notification goes away: left up, the
 * Re-apply on it is bound to a receipt whose order is not the one on screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  receipts: [] as unknown[],
  runHeal: vi.fn(async () => ({ kind: "done", summary: "ok" })),
}));

vi.mock("../installLedger", () => ({ listReceipts: async () => h.receipts }));
vi.mock("../paths", () => ({ getVortexUserDataPath: () => "C:/vortex" }));
vi.mock("./runHeal", () => ({ runHeal: h.runHeal }));

import { assessActiveOrder, LOAD_ORDER_NOTIFICATION_ID, reapplyCuratorOrder, startLoadOrderWatcher } from "./loadOrderWatcher";

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

function vortex(initialProfile: string, order: string[]) {
  let activeProfileId = initialProfile;
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
  return {
    api: api as never,
    sent,
    dismissed,
    switchTo(pid: string): void {
      activeProfileId = pid;
      for (const c of callbacks) if (c.path === "settings.profiles.activeProfileId") c.cb();
    },
  };
}

describe("assessActiveOrder", () => {
  it("compares nothing when the collection lives in another profile", async () => {
    h.receipts = [receipt()];
    const look = await assessActiveOrder(vortex("default", ["B.esp", "A.esp"]).api);
    expect(look.kind).toBe("nothing");
    if (look.kind !== "nothing") return;
    expect(look.reason).toBe("other-profile");
    expect(look.elsewhere[0]).toMatch(/Ivy 2.*"Ivy 2"/);
  });

  it("compares the newest install into the active profile, and names what it supersedes", async () => {
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
  beforeEach(() => h.runHeal.mockClear());

  it("refuses a superseded receipt without running the heal", async () => {
    const older = receipt();
    const newer = receipt({ packageId: "pkg-new", packageName: "Other", installedAt: "2026-09-05T10:00:00.000Z" });
    h.receipts = [older, newer];
    const outcome = await reapplyCuratorOrder(vortex("prof-ivy", ["B.esp", "A.esp"]).api, older);
    expect(outcome.kind).toBe("blocked");
    expect(h.runHeal).not.toHaveBeenCalled();
  });

  it("runs the heal for the owner", async () => {
    const only = receipt();
    h.receipts = [only];
    await reapplyCuratorOrder(vortex("prof-ivy", ["B.esp", "A.esp"]).api, only);
    expect(h.runHeal).toHaveBeenCalledTimes(1);
  });
});

describe("startLoadOrderWatcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("dismisses its drift notification when the active profile has nothing to assess", async () => {
    h.receipts = [receipt()];
    const v = vortex("prof-ivy", ["B.esp", "A.esp"]);
    startLoadOrderWatcher(v.api);
    await vi.advanceTimersByTimeAsync(8000);
    await vi.waitFor(() => expect(v.sent.some((n) => n.id === LOAD_ORDER_NOTIFICATION_ID)).toBe(true));

    // Same game, the Default profile: the collection was never installed here.
    v.switchTo("default");
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(v.dismissed).toContain(LOAD_ORDER_NOTIFICATION_ID));
  });
});
