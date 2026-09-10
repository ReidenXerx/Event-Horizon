/**
 * The environment gate at the Install click — the only gate that changes the
 * game folder, so its wiring is pinned: a blocked check refuses with its steps
 * and touches nothing; the clean-folder flow's answer decides whether the
 * install starts; a crashed check never becomes a wall, but never proceeds
 * without the user saying so either.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  report: { checks: [] as Array<{ id: string; status: string; title: string; lines: string[]; steps: string[] }>, gameDir: "E:/Games/Fallout 4" } as {
    checks: Array<{ id: string; status: string; title: string; lines: string[]; steps: string[] }>;
    gameDir?: string;
  },
  preflightThrows: false,
  activeGameId: "fallout4",
  switchBeforePurge: false,
  cleanOutcome: { kind: "cleaned", purged: true, moved: 3 } as Record<string, unknown>,
  cleanCalls: 0,
  purgeCalls: 0,
}));

vi.mock("../../../core/installer/probeDeployment", () => ({
  probeDeploymentMethod: () => ({ kind: "ok", methodId: "hardlink" }),
  describeDeploymentBlock: () => ({ title: "", body: "" }),
}));

vi.mock("../../../core/installer/runInstall", () => ({
  runInstall: () => new Promise(() => undefined),
  buildAbortedResult: () => ({ kind: "aborted" }),
}));

vi.mock("../../../core/environment/vortexEnvironment", () => ({
  gatherPreflightFacts: () => ({ gameId: "fallout4", gameName: "Fallout 4", declared: new Set(), protectedRoots: [], wine: false }),
  purgeGameDeployment: async () => {
    env.purgeCalls += 1;
  },
}));

vi.mock("../../../core/environment/preflight", () => ({
  runEnvironmentPreflight: async () => {
    if (env.preflightThrows) throw new Error("EACCES reading the game folder");
    return { gameId: "fallout4", gameName: "Fallout 4", ...env.report };
  },
}));

vi.mock("../../../core/environment/cleanGameFolder", () => ({
  cleanGameFolder: async (deps: { purge: () => Promise<void> }) => {
    env.cleanCalls += 1;
    if (env.switchBeforePurge) env.activeGameId = "skyrimse";
    if (env.cleanOutcome["kind"] === "cleaned") await deps.purge();
    return env.cleanOutcome;
  },
  describeCleanPlan: () => ({ title: "t", text: "t", message: "m", confirm: "Clean and install", decline: "Cancel" }),
}));

import { getInstallSession } from "./installSession";
import type { PreviewBundle } from "./state";

const plan = { modResolutions: [], manifest: { game: { id: "fallout4" }, package: { name: "Ivy", version: "1.0.0" }, externalDependencies: [] } };

function confirmSession(): ReturnType<typeof getInstallSession> {
  const s = getInstallSession();
  (s as unknown as { installInFlight: boolean }).installInFlight = false;
  (s as unknown as { installController?: unknown }).installController = undefined;
  (s as unknown as { environmentClearedFor: unknown }).environmentClearedFor = undefined;
  (s as unknown as { environmentGateRunning: boolean }).environmentGateRunning = false;
  (s as unknown as { state: unknown }).state = {
    kind: "confirm",
    bundle: { zipPath: "C:/x.ehcoll", ehcoll: {}, receipt: undefined, plan, appDataPath: "C:/a" } as unknown as PreviewBundle,
    decisions: { conflictChoices: {}, orphanChoices: {} },
  };
  return s;
}

const fakeApi = (answer: string | undefined = undefined) => {
  const dialogs: unknown[][] = [];
  return {
    dialogs,
    api: {
      getState: () => ({ settings: { profiles: { activeGameId: env.activeGameId } } }),
      showDialog: (...args: unknown[]) => {
        dialogs.push(args);
        return Promise.resolve(answer === undefined ? {} : { action: answer });
      },
    } as never,
  };
};

const kindOf = (s: unknown): string => (s as { state: { kind: string } }).state.kind;
/**
 * Wait for the gate to FINISH, not for a fixed time. A 20 ms sleep passed alone
 * and failed under the full suite, where the gate's dynamic imports take longer.
 */
const settle = (s: unknown): Promise<void> =>
  vi.waitFor(
    () => {
      if ((s as { environmentGateRunning: boolean }).environmentGateRunning) throw new Error("gate still running");
    },
    { timeout: 10_000, interval: 5 },
  );

beforeEach(() => {
  env.report = { checks: [], gameDir: "E:/Games/Fallout 4" };
  env.preflightThrows = false;
  env.activeGameId = "fallout4";
  env.switchBeforePurge = false;
  env.cleanOutcome = { kind: "cleaned", purged: true, moved: 3 };
  env.cleanCalls = 0;
  env.purgeCalls = 0;
});

describe("startInstall — environment gate", () => {
  it("does not start synchronously: the gate runs first", () => {
    const s = confirmSession();
    s.startInstall(fakeApi().api);
    expect(kindOf(s)).toBe("confirm");
  });

  it("refuses a blocked check with its steps, and never reaches the folder", async () => {
    env.report.checks = [
      { id: "launcher-ran", status: "blocked", title: "Fallout 4 has never been started on this PC.", lines: ["missing"], steps: ["Start it once"] },
    ];
    const s = confirmSession();
    const { api, dialogs } = fakeApi();
    s.startInstall(api);
    await settle(s);
    expect(kindOf(s)).toBe("confirm");
    expect(dialogs).toHaveLength(1);
    expect(String(dialogs[0]?.[1])).toMatch(/never been started/);
    expect(JSON.stringify(dialogs[0]?.[2])).toMatch(/Start it once/);
    expect(env.cleanCalls).toBe(0);
  });

  it("starts the install once the folder is cleaned", async () => {
    const s = confirmSession();
    s.startInstall(fakeApi().api);
    await settle(s);
    expect(env.cleanCalls).toBe(1);
    expect(env.purgeCalls).toBe(1);
    expect(kindOf(s)).toBe("installing");
  });

  it("refuses — and purges nothing — when Vortex switched to another game before the click", async () => {
    env.activeGameId = "skyrimse";
    const s = confirmSession();
    const { api, dialogs } = fakeApi();
    s.startInstall(api);
    await settle(s);
    expect(kindOf(s)).toBe("confirm");
    expect(env.cleanCalls).toBe(0);
    expect(env.purgeCalls).toBe(0);
    expect(String(dialogs[0]?.[1])).toMatch(/managing skyrimse now/);
  });

  it("purges nothing when Vortex switches game while the folder is being scanned", async () => {
    env.switchBeforePurge = true;
    const s = confirmSession();
    const { api, dialogs } = fakeApi("Cancel");
    s.startInstall(api);
    await settle(s);
    expect(env.purgeCalls).toBe(0);
    expect(kindOf(s)).toBe("confirm");
    expect(JSON.stringify(dialogs[0])).toMatch(/switched to skyrimse before the purge/);
  });

  it("starts when the folder cannot be verified (warned, not blocked)", async () => {
    env.cleanOutcome = { kind: "unverifiable", reason: "no store record" };
    const s = confirmSession();
    s.startInstall(fakeApi().api);
    await settle(s);
    expect(kindOf(s)).toBe("installing");
  });

  it("stays put when the user declines the clean-up", async () => {
    env.cleanOutcome = { kind: "declined" };
    const s = confirmSession();
    const { api, dialogs } = fakeApi();
    s.startInstall(api);
    await settle(s);
    expect(kindOf(s)).toBe("confirm");
    expect(dialogs).toHaveLength(0);
  });

  it("says why and stays put when cleaning fails", async () => {
    env.cleanOutcome = { kind: "failed", message: "2 file(s) could not be moved", remaining: [{ path: "dxgi.dll", size: 1, mtimeMs: 0 }] };
    const s = confirmSession();
    const { api, dialogs } = fakeApi();
    s.startInstall(api);
    await settle(s);
    expect(kindOf(s)).toBe("confirm");
    expect(JSON.stringify(dialogs[0])).toMatch(/could not be moved/);
    expect(JSON.stringify(dialogs[0])).toMatch(/dxgi\.dll/);
  });

  it("a crashed check asks — and proceeds only on 'Install anyway'", async () => {
    env.preflightThrows = true;
    const declined = confirmSession();
    declined.startInstall(fakeApi("Cancel").api);
    await settle(declined);
    expect(kindOf(declined)).toBe("confirm");

    const accepted = confirmSession();
    accepted.startInstall(fakeApi("Install anyway").api);
    await settle(accepted);
    expect(kindOf(accepted)).toBe("installing");
  });
});
