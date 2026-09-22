/**
 * ──────────────────────────────────────────────────────────────────────
 * THE CURE THAT WRITES BYTES HAD NO IDEA WHERE IT WAS POINTING.
 *
 * `restore-light-flags` opens `<game>/Data/*.esp` and rewrites a header bit.
 * It takes no game and no profile: `getGameDirectory(state, gameId)` resolves
 * against whatever Vortex is managing, and the plugin names come from the
 * receipt on screen. `pickDoctorReceipt` deliberately falls back to the newest
 * install when no receipt claims the active profile, so the Doctor can be open
 * on a Skyrim receipt while Vortex manages Fallout 4, or on the "Ivy 2"
 * receipt while the player is on "Default".
 *
 * Under EH's required hardlink deployment those Data files ARE the owning
 * mods' staging files, so the write lands inside a third-party mod's folder
 * and is inherited by every profile on the machine — NS-2's class of harm,
 * permanent, and with no inverse cure in `HealAction`. Plugin-name overlap
 * between two profiles of one game (USSEP, the unofficial patches) makes it
 * ordinary rather than exotic.
 *
 * `repin-plugin-order` carried exactly this guard and this one did not, which
 * is the weaker half of the pair guarding the stronger act.
 *
 * The second half of this file is the over-limit sentence: the one line that
 * answers "will my game start" was computed and then dropped on the SUCCESS
 * path, which is the only path where it can fire.
 * ──────────────────────────────────────────────────────────────────────
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  applyPluginLightFlags: vi.fn(),
}));

vi.mock("../installer/applyPluginLightFlags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../installer/applyPluginLightFlags")>()),
  applyPluginLightFlags: h.applyPluginLightFlags,
}));
vi.mock("../manifest/externalDependencies", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../manifest/externalDependencies")>()),
  getGameDirectory: () => "C:\\Games\\Skyrim",
}));
vi.mock("../comparePlugins", () => ({ discoveredStore: () => undefined }));

import { runHeal } from "./runHeal";

const baseline = [
  { name: "A.esp", enabled: true, light: true },
  { name: "B.esp", enabled: true, light: false },
];

const receipt = {
  packageId: "pkg-ivy",
  packageName: "Ivy 2",
  packageVersion: "1.0.11",
  gameId: "skyrimse",
  vortexProfileId: "prof-ivy",
  vortexProfileName: "Ivy 2",
  installedAt: "2026-09-01T10:00:00.000Z",
  mods: [],
  rulesApplication: { baselinePluginOrder: baseline },
} as never;

const profiles = {
  "prof-ivy": { gameId: "skyrimse", name: "Ivy 2" },
  default: { gameId: "skyrimse", name: "Default" },
  "prof-fo4": { gameId: "fallout4", name: "Fallout 4" },
};

const stateOn = (activeProfileId: string): unknown => ({
  settings: { profiles: { activeProfileId } },
  persistent: { profiles },
});

const apiOver = (state: unknown): never =>
  ({
    getState: () => state,
    events: { emit: () => undefined },
    store: { dispatch: () => undefined },
  }) as never;

/** A repair that succeeded in part, which is the shape that carries the line. */
const partialRepair = {
  corrected: 900,
  alreadyCorrect: 0,
  unknown: 0,
  missing: 0,
  failures: new Array(300).fill({ name: "x.esp", error: "locked" }),
  unreadable: [],
  regularAfter: 340,
  regularLimit: 254,
};

beforeEach(() => {
  h.applyPluginLightFlags.mockReset();
  h.applyPluginLightFlags.mockResolvedValue(partialRepair);
});

describe("restore-light-flags refuses a game folder it was not installed into", () => {
  it("refuses — and writes nothing — when Vortex is managing another game", async () => {
    const outcome = await runHeal("restore-light-flags", {
      api: apiOver(stateOn("prof-fo4")),
      gameId: "skyrimse",
      receipt,
    });
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind === "blocked") {
      expect(outcome.reason).toMatch(/Vortex is managing fallout4/);
    }
    // The whole point: not one plugin file was opened.
    expect(h.applyPluginLightFlags).not.toHaveBeenCalled();
  });

  it("refuses — and writes nothing — from a profile the collection was not installed into", async () => {
    const outcome = await runHeal("restore-light-flags", {
      api: apiOver(stateOn("default")),
      gameId: "skyrimse",
      receipt,
    });
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind === "blocked") expect(outcome.reason).toMatch(/"Ivy 2".*"Default"/);
    expect(h.applyPluginLightFlags).not.toHaveBeenCalled();
  });

  it("runs when the receipt IS the active game and profile", async () => {
    const outcome = await runHeal("restore-light-flags", {
      api: apiOver(stateOn("prof-ivy")),
      gameId: "skyrimse",
      receipt,
    });
    expect(outcome.kind).toBe("done");
    expect(h.applyPluginLightFlags).toHaveBeenCalledTimes(1);
  });
});

describe("restore-light-flags reports whether the game can start", () => {
  it("carries the over-limit sentence into the SUCCESS summary", async () => {
    /**
     * 900 restored, 300 locked, 340 regular plugins against a limit of 254.
     * The old summary read "Restored 900 ESL flag(s), and 300 could not be
     * changed. 300 plugin(s) were locked…" and stopped there — a success toast
     * for a setup that still will not launch. `describePluginFlagRepair`
     * produced the missing sentence and it was read only in the
     * `corrected === 0` branch, which this case is not.
     */
    const outcome = await runHeal("restore-light-flags", {
      api: apiOver(stateOn("prof-ivy")),
      gameId: "skyrimse",
      receipt,
    });
    expect(outcome.kind).toBe("done");
    if (outcome.kind !== "done") return;
    expect(outcome.summary).toContain("Restored 900 ESL flag(s)");
    expect(outcome.summary).toContain("340 regular plugins");
    expect(outcome.summary).toContain("will not start");
  });

  it("says nothing extra when the repair leaves the profile under the limit", async () => {
    // The line is a warning, not a fixture: a clean repair must not grow one.
    h.applyPluginLightFlags.mockResolvedValue({
      ...partialRepair,
      failures: [],
      regularAfter: 200,
    });
    const outcome = await runHeal("restore-light-flags", {
      api: apiOver(stateOn("prof-ivy")),
      gameId: "skyrimse",
      receipt,
    });
    expect(outcome.kind).toBe("done");
    if (outcome.kind !== "done") return;
    expect(outcome.summary).not.toContain("will not start");
    expect(outcome.summary.trim()).toBe("Restored 900 ESL flag(s).");
  });
});
