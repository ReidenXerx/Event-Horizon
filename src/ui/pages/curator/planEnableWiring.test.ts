/**
 * ──────────────────────────────────────────────────────────────────────
 * "Make it work" switches on what it installs itself.
 *
 * It used to rely on Vortex's `settings.automation.enable` without saying so.
 * The rule — enable each right after it lands, keep the root off when one
 * cannot be — is tested in runRequirementPlan.test.ts. What only the hook can
 * show is that `enableInstalled` really dispatches Vortex's enable action
 * into the active profile rather than reporting success. Same approach as
 * modUpdateWiring.test.ts.
 * ──────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = readFileSync(join(__dirname, "useCuratorActions.ts"), "utf8");

describe("enabling the requirements a plan installed", () => {
  it("dispatches setModEnabled for the new mod, after checking it is not already on", () => {
    const at = SRC.indexOf("enableInstalled: (vortexModId) =>");
    expect(at, "runPlan no longer wires enableInstalled").toBeGreaterThan(-1);
    const body = SRC.slice(at, SRC.indexOf("enableMods:", at));
    expect(body).toContain("readEnabledModIds(");
    expect(body).toMatch(/setModEnabled\(profileId, vortexModId, true\)/);
    expect(body.indexOf("setModEnabled(")).toBeGreaterThan(body.indexOf('return "already-enabled"'));
  });
});
