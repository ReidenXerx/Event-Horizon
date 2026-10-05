/**
 * Optional mods (owner, 2026-10-05; first use Ivy's Creation Club patches):
 * a player may untick one, a failed download skips one, and neither is ever
 * reported as a problem — not by the plan, the plugin order or the rules.
 */
import { describe, expect, it } from "vitest";

import { computeVerdict } from "../../ui/pages/install/steps";
import { wizardReducer, type PreviewBundle, type WizardState } from "../../ui/pages/install/state";
import { pluginsGatedOff } from "../manifest/conditionalFiles";
import { parseManifest } from "../manifest/parseManifest";
import type { RulesApplicationReceipt } from "../../types/installLedger";
import type { InstallPlan } from "../../types/installPlan";
import { describeOptionalNotInstalled, namesAbsentMod, optionalKeys, withoutOptionalSkips } from "./optionalMods";
import { collectRemovalPlan, preflight } from "./runInstall";

const CC = "nexus:900:1";
const absent = new Set([CC]);

describe("rules and load order of an optional mod that is not here", () => {
  it("names the mod by its key, and by its Nexus page", () => {
    expect(namesAbsentMod(CC, absent)).toBe(true);
    expect(namesAbsentMod("nexus:900", absent)).toBe(true);
    expect(namesAbsentMod("nexus:901", absent)).toBe(false);
    expect(namesAbsentMod("nexus:9000:1", absent)).toBe(false);
  });

  it("drops only the skips the absent optional mod caused", () => {
    const rules = {
      appliedRuleCount: 3,
      overwrittenUserRuleCount: 0,
      skippedRules: [
        { ruleType: "after", source: CC, reference: "nexus:1:1", reason: "Source mod is not present" },
        { ruleType: "after", source: "nexus:2:2", reference: "nexus:900", reason: "did not match" },
        { ruleType: "after", source: "nexus:3:3", reference: "nexus:4:4", reason: "a real failure" },
      ],
      appliedLoadOrderCount: 0,
      skippedLoadOrderEntries: [
        { compareKey: CC, pos: 1, reason: "not present" },
        { compareKey: "nexus:5:5", pos: 2, reason: "not present" },
      ],
      baselinePluginOrder: [],
    } as unknown as RulesApplicationReceipt;
    const out = withoutOptionalSkips(rules, absent);
    expect(out.skippedRules.map((s) => s.reason)).toEqual(["a real failure"]);
    expect(out.skippedLoadOrderEntries.map((s) => s.compareKey)).toEqual(["nexus:5:5"]);
    expect(withoutOptionalSkips(rules, new Set())).toBe(rules);
  });

  it("says why each one was left out, in plain words", () => {
    expect(describeOptionalNotInstalled([{ compareKey: CC, name: "CC Patches", reason: "not installed, you unticked it" }])).toEqual([
      "CC Patches: not installed, you unticked it.",
    ]);
  });
});

describe("the compared plugin order", () => {
  const mods = [
    { state: { optional: true as const, stagingFiles: [{ path: "Ivy - Ghoul Patch.esp" }, { path: "Ivy - Hunter Patch.esp" }] } },
    { state: { stagingFiles: [{ path: "Required.esp" }] } },
  ];
  it("switches off an optional mod's plugin that is not here, never a required mod's", () => {
    const known = (p: string): boolean => p === "ivy - ghoul patch.esp";
    const gated = pluginsGatedOff(mods, () => true, known);
    expect([...gated]).toEqual(["ivy - hunter patch.esp"]);
  });
  it("is unchanged without the known-plugins answer", () => {
    expect([...pluginsGatedOff(mods, () => true)]).toEqual([]);
  });
});

describe("the preview", () => {
  const plan = (optional: boolean) =>
    ({
      manifest: { mods: [] },
      modResolutions: [
        { compareKey: CC, name: "CC Patches", sourceKind: "nexus", decision: { kind: "nexus-unreachable" }, ...(optional ? { optional: true } : {}) },
      ],
      compatibility: { errors: [], warnings: [] },
      summary: { canProceed: true, needsUserConfirmation: 0, orphans: 0 },
    }) as unknown as InstallPlan;

  it("never blocks on an optional mod nobody can download", () => {
    expect(computeVerdict(plan(true)).canProceed).toBe(true);
    expect(computeVerdict(plan(false)).canProceed).toBe(false);
  });

  it("keeps the player's untick across decisions and confirm, and starts fresh with a new preview", () => {
    const bundle = { plan: plan(true) } as unknown as PreviewBundle;
    let s: WizardState = { kind: "preview", bundle };
    s = wizardReducer(s, { type: "set-optional-skipped", compareKey: CC, skipped: true });
    expect((s as { bundle: PreviewBundle }).bundle.optionalSkipped).toEqual([CC]);
    s = wizardReducer(s, { type: "set-optional-skipped", compareKey: CC, skipped: false });
    expect((s as { bundle: PreviewBundle }).bundle.optionalSkipped).toEqual([]);
    s = wizardReducer(s, { type: "set-optional-skipped", compareKey: CC, skipped: true });
    s = wizardReducer(s, {
      type: "open-decisions",
      bundle: (s as { bundle: PreviewBundle }).bundle,
      conflictChoices: {},
      orphanChoices: {},
    } as never);
    expect((s as { bundle: PreviewBundle }).bundle.optionalSkipped).toEqual([CC]);
    const fresh = wizardReducer(s, { type: "plan-ready", bundle } as never);
    expect((fresh as { bundle: PreviewBundle }).bundle.optionalSkipped).toBeUndefined();
  });
});

describe("the manifest", () => {
  const manifest = (state: Record<string, unknown>) =>
    JSON.stringify({
      schemaVersion: 2,
      package: { id: "00000000-0000-4000-8000-000000000000", name: "t", version: "1.0.0", author: "a", createdAt: "2026-01-01T00:00:00.000Z", strictMissingMods: false },
      game: { id: "fallout4", version: "1.11.240", versionPolicy: "exact" },
      vortex: { version: "2.6.3", deploymentMethod: "hardlink", requiredExtensions: [] },
      mods: [
        {
          name: "t",
          compareKey: CC,
          source: { kind: "nexus", gameDomain: "fallout4", modId: 900, fileId: 1, archiveName: "t.zip", sha256: "a".repeat(64) },
          install: { fomodSelections: [] },
          state: { enabled: true, installOrder: 0, deploymentPriority: 0, ...state },
        },
      ],
      rules: [],
      plugins: { order: [] },
      loadOrder: [],
      userlist: { plugins: [], groups: [] },
      iniTweaks: [],
      gameIni: { files: [] },
      externalDependencies: [],
    });

  it("carries optional and its note, and reads anything but true as required", () => {
    const yes = parseManifest(manifest({ optional: true, optionalNote: " Patches for Creations you own " })).manifest;
    expect(yes.mods[0]!.state.optional).toBe(true);
    expect(yes.mods[0]!.state.optionalNote).toBe("Patches for Creations you own");
    expect(optionalKeys(yes.mods)).toEqual(new Set([CC]));
    const odd = parseManifest(manifest({ optional: "yes", optionalNote: "x" })).manifest;
    expect(odd.mods[0]!.state.optional).toBeUndefined();
    expect(odd.mods[0]!.state.optionalNote).toBeUndefined();
  });
});

describe("the install driver's own gates", () => {
  const plan = (decision: Record<string, unknown>) =>
    ({
      manifest: { mods: [] },
      modResolutions: [{ compareKey: CC, name: "CC Patches", sourceKind: "nexus", decision, optional: true }],
      orphanedMods: [],
      compatibility: { errors: [], warnings: [], gameMatches: true },
      summary: { canProceed: true, needsUserConfirmation: 0, orphans: 0 },
      installTarget: { kind: "fresh-profile" },
    }) as never;

  it("does not refuse to start over an optional mod nobody can download", () => {
    expect(preflight(plan({ kind: "nexus-unreachable" }), {})).toBeUndefined();
  });

  it("never removes the player's copy for an optional mod they unticked (NS-2)", () => {
    const diverged = plan({ kind: "nexus-bytes-diverged", existingModId: "players-own" });
    const choice = { conflictChoices: { [CC]: { kind: "replace-existing" as const } } };
    expect(collectRemovalPlan(diverged, choice).map((i) => i.modId)).toEqual(["players-own"]);
    expect(collectRemovalPlan(diverged, { ...choice, optionalSkipped: [CC] })).toEqual([]);
  });

  it("asks no conflict question about an optional mod the player unticked", () => {
    const diverged = plan({ kind: "nexus-bytes-diverged", existingModId: "players-own" });
    expect(preflight(diverged, {})).toMatch(/choice/i);
    expect(preflight(diverged, { optionalSkipped: [CC] })).toBeUndefined();
  });
});
