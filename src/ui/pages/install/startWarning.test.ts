/**
 * The "Hands off" warning comes after the pre-install checks, and the install
 * starts only from its "Understood".
 *
 * Owner's decisions (2026-09-15): the warning shows before every install, and
 * it sits behind the checks because a warning followed by a refusal teaches
 * people to click through it. A run that ends with the game left undeployed
 * says so, because Event Horizon clears Vortex's own "Deployment necessary"
 * prompt while it installs and purges the deployment before mirroring.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const driver = vi.hoisted(() => ({
  calls: 0,
  outcome: undefined as
    | undefined
    | ((ctx: { onDeploymentPurged?: () => void }) => Promise<unknown>),
}));

vi.mock("../../../core/installer/probeDeployment", () => ({
  probeDeploymentMethod: () => ({ kind: "ok", methodId: "hardlink_activator" }),
  describeDeploymentBlock: () => ({ title: "", body: "" }),
}));

vi.mock("../../../core/installer/runInstall", () => ({
  runInstall: (ctx: { onDeploymentPurged?: () => void }) => {
    driver.calls += 1;
    return driver.outcome !== undefined ? driver.outcome(ctx) : new Promise(() => undefined);
  },
  buildAbortedResult: () => ({ kind: "aborted" }),
}));

import { getInstallSession } from "./installSession";
import { wizardReducer, type PreviewBundle, type WizardState } from "./state";

const bundle = (): PreviewBundle =>
  ({
    zipPath: "C:/x.ehcoll",
    ehcoll: { manifest: { package: { name: "Ivy 2" } } },
    receipt: undefined,
    plan: {
      modResolutions: [],
      manifest: { game: { id: "fallout4" }, package: { id: "ivy", name: "Ivy 2" } },
    },
    appDataPath: "C:/appdata",
  }) as unknown as PreviewBundle;

function confirmSession(): ReturnType<typeof getInstallSession> {
  // A module singleton: reset what earlier cases leave behind.
  const s = getInstallSession();
  const x = s as unknown as Record<string, unknown>;
  x.installInFlight = false;
  x.installController = undefined;
  x.purgedForPlan = undefined;
  x.autoSortAnsweredFor = undefined;
  const b = bundle();
  // The environment gate is async and has its own tests; passed for this plan.
  x.environmentClearedFor = b.plan;
  x.state = { kind: "confirm", bundle: b, decisions: { conflictChoices: {}, orphanChoices: {} } };
  return s;
}

const stateOf = (s: unknown): { kind: string; readyToStart?: boolean } =>
  (s as { state: { kind: string; readyToStart?: boolean } }).state;

function vortex(needToDeploy = false): {
  api: never;
  notifications: Array<{ id?: string; message?: string }>;
} {
  const notifications: Array<{ id?: string; message?: string }> = [];
  return {
    notifications,
    api: {
      getState: () => ({
        settings: { automation: { deploy: false }, plugins: { autoSort: false } },
        persistent: { deployment: { needToDeploy: { fallout4: needToDeploy } } },
      }),
      sendNotification: (n: { id?: string; message?: string }) => {
        notifications.push(n);
        return n.id;
      },
      showDialog: () => Promise.resolve({}),
    } as never,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  driver.calls = 0;
  driver.outcome = undefined;
});

describe("the warning after the pre-install checks", () => {
  it("passing every check raises the warning and starts nothing", () => {
    const s = confirmSession();
    s.startInstall(vortex().api);
    expect(stateOf(s)).toMatchObject({ kind: "confirm", readyToStart: true });
    expect(driver.calls).toBe(0);
  });

  it("starts the install only from the warning's Understood, and only once", () => {
    const s = confirmSession();
    const v = vortex();
    s.startInstall(v.api);
    s.beginInstall(v.api);
    s.beginInstall(v.api);
    expect(stateOf(s).kind).toBe("installing");
    expect(driver.calls).toBe(1);
  });

  it("does nothing on Understood when the checks have not passed", () => {
    const s = confirmSession();
    s.beginInstall(vortex().api);
    expect(stateOf(s).kind).toBe("confirm");
    expect(driver.calls).toBe(0);
  });

  it("Cancel on the warning goes back to the confirm screen with nothing started", () => {
    const s = confirmSession();
    const v = vortex();
    s.startInstall(v.api);
    s.cancelStart(v.api);
    expect(stateOf(s).kind).toBe("confirm");
    expect(stateOf(s).readyToStart).toBeUndefined();
    s.beginInstall(v.api);
    expect(driver.calls).toBe(0);
  });
});

describe("leaving the warning after the game folder was prepared", () => {
  it("Cancel says the deployment was purged when the check purged it", () => {
    const s = confirmSession();
    const v = vortex();
    s.startInstall(v.api);
    // What the game-folder check records when it purged for this plan.
    (s as unknown as { purgedForPlan: unknown }).purgedForPlan = (
      s as unknown as { state: { bundle: { plan: unknown } } }
    ).state.bundle.plan;
    s.cancelStart(v.api);
    const warning = v.notifications.find((n) => n.id === "event-horizon-undeployed");
    expect(warning?.message).toMatch(/did not start/);
    expect(warning?.message).toMatch(/Moved-aside files/);
  });

  it("Cancel stays quiet when nothing was purged", () => {
    const s = confirmSession();
    const v = vortex();
    s.startInstall(v.api);
    s.cancelStart(v.api);
    expect(v.notifications.find((n) => n.id === "event-horizon-undeployed")).toBeUndefined();
  });

  it("Understood goes back through the checks when Vortex switched game under the warning", () => {
    const s = confirmSession();
    const v = vortex();
    s.startInstall(v.api);
    const switched = {
      ...(v.api as unknown as Record<string, unknown>),
      // Vortex's shape: the active game is the active profile's game.
      getState: () => ({
        settings: {
          profiles: { activeProfileId: "skyrim-profile" },
          automation: { deploy: false },
          plugins: { autoSort: false },
        },
        persistent: { profiles: { "skyrim-profile": { gameId: "skyrimse" } } },
      }),
    } as never;
    s.beginInstall(switched);
    expect(driver.calls).toBe(0);
    expect(stateOf(s).readyToStart).toBeUndefined();
  });
});

describe("a run that deployed again before it ended", () => {
  it("does not say the game was left purged", async () => {
    driver.outcome = async (ctx) => {
      ctx.onDeploymentPurged?.();
      (ctx as { onDeploymentRestored?: () => void }).onDeploymentRestored?.();
      return { kind: "failed" };
    };
    const s = confirmSession();
    const v = vortex(false);
    s.startInstall(v.api);
    s.beginInstall(v.api);
    await settle();
    expect(v.notifications.find((n) => n.id === "event-horizon-undeployed")).toBeUndefined();
  });
});

describe("the reducer", () => {
  const confirm = (): WizardState =>
    ({
      kind: "confirm",
      bundle: bundle(),
      decisions: { conflictChoices: {}, orphanChoices: {} },
    }) as unknown as WizardState;

  it("raises the warning only on the confirm step", () => {
    const pick = { kind: "pick" } as WizardState;
    expect(wizardReducer(pick, { type: "ready-to-start" })).toBe(pick);
    expect(wizardReducer(confirm(), { type: "ready-to-start" })).toMatchObject({
      kind: "confirm",
      readyToStart: true,
    });
  });

  it("does not bring a raised warning back after going back and returning", () => {
    const ready = wizardReducer(confirm(), { type: "ready-to-start" });
    const back = wizardReducer(ready, { type: "back-from-confirm" });
    const again = wizardReducer(back, {
      type: "open-confirm",
      decisions: { conflictChoices: {}, orphanChoices: {} },
    } as never);
    expect(again.kind).toBe("confirm");
    expect((again as { readyToStart?: boolean }).readyToStart).toBeUndefined();
  });
});

describe("a run that ends with the game left undeployed", () => {
  const warningIn = (v: ReturnType<typeof vortex>): { message?: string } | undefined =>
    v.notifications.find((n) => n.id === "event-horizon-undeployed");

  it("says the deployment was purged when the run purged it", async () => {
    driver.outcome = async (ctx) => {
      ctx.onDeploymentPurged?.();
      return { kind: "aborted" };
    };
    const s = confirmSession();
    const v = vortex(false);
    s.startInstall(v.api);
    s.beginInstall(v.api);
    await settle();
    expect(warningIn(v)?.message).toMatch(/purged Vortex's deployment/);
  });

  it("says changes are not deployed when Vortex still needs a deploy", async () => {
    driver.outcome = async () => ({ kind: "failed" });
    const s = confirmSession();
    const v = vortex(true);
    s.startInstall(v.api);
    s.beginInstall(v.api);
    await settle();
    expect(warningIn(v)?.message).toMatch(/not deployed yet/);
  });

  it("stays quiet when the run purged nothing and nothing waits to be deployed", async () => {
    driver.outcome = async () => ({ kind: "aborted" });
    const s = confirmSession();
    const v = vortex(false);
    s.startInstall(v.api);
    s.beginInstall(v.api);
    await settle();
    expect(warningIn(v)).toBeUndefined();
  });
});
