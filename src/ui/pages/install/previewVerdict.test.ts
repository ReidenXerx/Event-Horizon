/**
 * The preview's verdict must say "Cannot install" when the environment
 * preflight blocked — a green "Plan resolves cleanly" above a game that was
 * never started is the headline contradicting the check it summarises, and it
 * is what let a tester reach the install without Vortex managing the game.
 */
import { describe, expect, it } from "vitest";

import { summarizeEnvironment } from "./EnvironmentCard";
import { computeVerdict } from "./steps";
import type { EnvironmentReport } from "../../../core/environment/preflight";
import type { InstallPlan } from "../../../types/installPlan";

const plan = {
  modResolutions: [],
  compatibility: { errors: [], warnings: [] },
  summary: { canProceed: true, needsUserConfirmation: 0, orphans: 0 },
} as unknown as InstallPlan;

const report = (statuses: Array<["blocked" | "warning" | "ok", string]>): EnvironmentReport => ({
  gameId: "fallout4",
  gameName: "Fallout 4",
  checks: statuses.map(([status, title], i) => ({ id: "game-folder", status, title: `${title}${i}`, lines: [], steps: [] })),
});

describe("computeVerdict with the environment preflight", () => {
  it("cannot install when a check is blocked, and names it", () => {
    const env = summarizeEnvironment(report([["blocked", "Vortex is not managing Fallout 4."], ["ok", "fine"]]));
    const v = computeVerdict(plan, env.warnings, env.blockers);
    expect(v.canProceed).toBe(false);
    expect(v.headline).toBe("Cannot install");
    expect(v.lines).toContain("Vortex is not managing Fallout 4.0");
  });

  it("proceeds, flagged for attention, on warnings only", () => {
    const env = summarizeEnvironment(report([["warning", "The Fallout 4 folder is not a clean game."]]));
    const v = computeVerdict(plan, env.warnings, env.blockers);
    expect(v.canProceed).toBe(true);
    expect(v.headline).toBe("Plan resolves — needs your input");
  });

  it("is unchanged when there is no report", () => {
    const env = summarizeEnvironment(undefined);
    expect(computeVerdict(plan, env.warnings, env.blockers).headline).toBe("Plan resolves cleanly");
  });
});
