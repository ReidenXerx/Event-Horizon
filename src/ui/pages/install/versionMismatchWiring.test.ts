/**
 * The game-version soft block through the wizard (owner poll, 2026-09-22).
 *
 * The tick has to hold Continue shut, survive Back and Next, and reach the
 * driver as the exact (required, installed) pair the player saw. A tick that
 * renders and then gets lost on the way is refused by the driver — which is
 * safe, and from the player's side indistinguishable from a broken button.
 */
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { computeVerdict } from "./steps";
import { getInstallSession } from "./installSession";
import { wizardReducer as reduce } from "./state";
import type { WizardState } from "./state";
import type { InstallPlan } from "../../../types/installPlan";

const versionMismatch = {
  required: "1.6.1179.0",
  installed: "1.6.1170.0",
  policy: "exact",
  direction: -1,
  changeGame: ["Downgrade with the patcher."],
};

const plan = (withMismatch: boolean): InstallPlan =>
  ({
    manifest: { package: { id: "pkg-version-mismatch", name: "Meridia", version: "1.0.23" }, mods: [] },
    modResolutions: [],
    orphanedMods: [],
    compatibility: { errors: [], warnings: [], ...(withMismatch ? { versionMismatch } : {}) },
    summary: { canProceed: true, needsUserConfirmation: 0, orphans: 0 },
  }) as unknown as InstallPlan;

// The session pre-fills remembered local files in the background when decisions open, and
// reads the package id and app-data folder to do it. A folder with no memory in it answers "none".
const bundle = (withMismatch = true): never =>
  ({ plan: plan(withMismatch), appDataPath: path.join(os.tmpdir(), "eh-no-such-appdata") }) as never;

describe("the preview verdict on another game version", () => {
  it("holds Continue shut until the box is ticked", () => {
    const v = computeVerdict(plan(true), [], [], false);
    expect(v.canProceed).toBe(false);
    expect(v.tone).toBe("warning");
    expect(v.headline).toMatch(/Different game version/);
  });

  it("lets the player through once ticked, and never calls it clean", () => {
    const v = computeVerdict(plan(true), [], [], true);
    expect(v.canProceed).toBe(true);
    expect(v.tone).toBe("warning");
    expect(v.lines.join(" ")).toMatch(/1\.6\.1179\.0.*1\.6\.1170\.0/);
  });

  it("changes nothing when the versions match", () => {
    expect(computeVerdict(plan(false)).headline).toBe("Plan resolves cleanly");
  });
});

describe("the tick through the wizard", () => {
  it("survives decisions → back to preview", () => {
    let s: WizardState = { kind: "preview", bundle: bundle() } as WizardState;
    s = reduce(s, { type: "acknowledge-version", acknowledged: true });
    s = reduce(s, {
      type: "open-decisions",
      bundle: bundle(),
      conflictChoices: {},
      orphanChoices: {},
      versionAcknowledged: true,
    });
    s = reduce(s, { type: "back-to-preview" });
    expect(s).toMatchObject({ kind: "preview", versionAcknowledged: true });
  });

  it("can be unticked", () => {
    let s: WizardState = { kind: "preview", bundle: bundle() } as WizardState;
    s = reduce(s, { type: "acknowledge-version", acknowledged: true });
    s = reduce(s, { type: "acknowledge-version", acknowledged: false });
    expect((s as { versionAcknowledged?: true }).versionAcknowledged).toBeUndefined();
  });

  it("reaches the driver's decisions as the exact pair, through the real session", () => {
    const session = getInstallSession();
    (session as unknown as { state: WizardState }).state = { kind: "preview", bundle: bundle() } as WizardState;

    // Not ticked: Continue is refused even if something calls it directly.
    session.openDecisionsFromPreview();
    expect(session.getSnapshot().state.kind).toBe("preview");

    session.acknowledgeVersion(true);
    session.openDecisionsFromPreview();
    expect(session.getSnapshot().state.kind).toBe("decisions");
    session.openConfirm();
    const s = session.getSnapshot().state;
    expect(s.kind).toBe("confirm");
    expect((s as { decisions: { versionMismatchAcknowledged?: unknown } }).decisions.versionMismatchAcknowledged).toEqual({
      required: "1.6.1179.0",
      installed: "1.6.1170.0",
    });
    session.reset();
  });
});
