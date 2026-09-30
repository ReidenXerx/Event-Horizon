/**
 * A definite free or signed-out Nexus account stops the install before it
 * starts (owner poll, 2026-09-30). A player on a free account started Ivy,
 * got eight failed downloads under "Only available to premium users", and a
 * message blaming their extractor and disk.
 *
 * What only the preview can show is the wiring: the account lines reach the
 * verdict as BLOCKERS for a definite reading, and stay a warning otherwise.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { describeNexusAccount } from "../../../core/installer/checkNexusAccount";
import type { InstallPlan } from "../../../types/installPlan";
import { computeVerdict } from "./steps";

const SRC = readFileSync(join(__dirname, "steps.tsx"), "utf8");

const plan = {
  manifest: { package: { id: "pkg", name: "Ivy", version: "1.0.35" }, mods: [] },
  modResolutions: [],
  orphanedMods: [],
  compatibility: { errors: [], warnings: [] },
  summary: { canProceed: true, needsUserConfirmation: 0, orphans: 0 },
} as unknown as InstallPlan;

describe("the Nexus account gate on the install preview", () => {
  it("a free account's lines as blockers make it 'Cannot install'", () => {
    const lines = describeNexusAccount({ kind: "free" }, 965);
    const v = computeVerdict(plan, [], lines);
    expect(v.canProceed).toBe(false);
    expect(v.headline).toBe("Cannot install");
    expect(v.lines.join(" ")).toMatch(/Premium/);
  });

  it("the same lines as a warning still let it proceed (the unknown-account case)", () => {
    const lines = describeNexusAccount({ kind: "free" }, 965);
    expect(computeVerdict(plan, lines, []).canProceed).toBe(true);
  });

  it("only a definite free or signed-out reading becomes a blocker, and it is passed as one", () => {
    expect(SRC).toMatch(/\(account\.kind === "free" \|\| account\.kind === "logged-out"\) && accountLines\.length > 0/);
    expect(SRC).toMatch(/\[\.\.\.environment\.blockers, \.\.\.accountBlocks\]/);
    // Not shown twice: a blocking account is not also listed as a warning.
    expect(SRC).toMatch(/\.\.\.\(accountBlocks\.length > 0 \? \[\] : accountLines\)/);
  });

  it("nothing to download means nothing to block, whatever the account", () => {
    expect(describeNexusAccount({ kind: "free" }, 0)).toEqual([]);
  });
});
