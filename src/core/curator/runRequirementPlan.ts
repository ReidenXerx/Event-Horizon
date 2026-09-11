/**
 * ──────────────────────────────────────────────────────────────────────
 * Run a previewed "Make it work" plan, one install at a time, and decide
 * whether the mod it was for may be switched on.
 *
 * ─── THE ROOT COMES ON ONLY WHEN NOTHING WAS LEFT OUT ──────────────────
 * The curator declined "Enable anyway" when they took this path, so the mod
 * they wanted made to work is enabled only when the plan actually covered
 * its chain (settled: a failed plan must not turn into exactly that).
 * "Failed" used to mean only a step that was attempted and did not install.
 * A step with no file to install — which is also what a file lookup that
 * failed produces — a page for a game this Vortex does not manage, a page
 * whose own requirements were never read, and a chain cut at its depth cap
 * were all skipped without a word, and the root was enabled over the gap.
 * Every one of those is a blocker now, and the report names it.
 *
 * The providers already in the pool (the plan's `toEnable`) still come on
 * unless the run was stopped: enabling one of those is its whole fix.
 * ──────────────────────────────────────────────────────────────────────
 */

import { ehLog } from "../logging/ehLog";
import { fileForStep, type InstallPlan, type PlannedFile, type PlannedInstall } from "./installPlan";
import type { CuratorMod } from "./profileActions";
import type { NexusFileInfo } from "./requirements";

type Picked = Readonly<Record<string, number | undefined>>;

const namesOf = (files: readonly PlannedFile[]): string => files.map((pf) => pf.step.name).join(", ");

/**
 * What keeps this plan from making the mod work, known before anything runs.
 *
 * Empty when every page in the chain was read, is for a managed game, and has
 * a file to install. Shown in the preview and repeated in the report.
 */
export function planBlockers(plan: InstallPlan, files: readonly PlannedFile[], picked: Picked): string[] {
  const otherGame = files.filter((pf) => pf.step.vortexGameId === undefined);
  const here = files.filter((pf) => pf.step.vortexGameId !== undefined);
  const noFile = here.filter((pf) => pf.choice.kind === "none");
  const unchosen = here.filter((pf) => pf.choice.kind === "choose" && fileForStep(pf, picked) === undefined);
  const out: string[] = [];
  if (noFile.length > 0) {
    out.push(`no file to install for ${namesOf(noFile)} (no current file on the page, or Nexus did not answer)`);
  }
  if (unchosen.length > 0) out.push(`no file chosen for ${namesOf(unchosen)}`);
  if (otherGame.length > 0) {
    out.push(`${namesOf(otherGame)} ${otherGame.length === 1 ? "is a page" : "are pages"} for a game this Vortex is not managing`);
  }
  if (plan.unfetched.length > 0) {
    out.push(`Nexus did not answer for ${plan.unfetched.join(", ")}, so whatever those need is not in the plan`);
  }
  if (plan.truncated) out.push("the chain was cut at its depth cap, so the plan may be short");
  return out;
}

export type PlanStepOutcome = { ok: true; newModId: string } | { ok: false; why: string; refused: boolean };

export type PlanRunReport = {
  lines: string[];
  /** Every needed step installed and nothing was left out: the root was enabled. */
  worked: boolean;
  /** Why it did not work, in the report's words. Empty when it did. */
  blockers: string[];
};

export async function runRequirementPlan(input: {
  rootName: string;
  plan: InstallPlan;
  files: readonly PlannedFile[];
  picked: Picked;
  /** The mods this plan was opened to switch on; empty for a plain "install this requirement". */
  thenEnable: readonly CuratorMod[];
  signal: AbortSignal;
  /** Install one step and wait for it to land. Sequential: awaited before the next. */
  installStep: (step: PlannedInstall, file: NexusFileInfo) => Promise<PlanStepOutcome>;
  enableMods: (mods: readonly CuratorMod[]) => void;
  onProgress: (message: string) => void;
}): Promise<PlanRunReport> {
  const { rootName, plan, files, picked, thenEnable, signal, installStep, enableMods, onProgress } = input;
  const todo = files.filter((pf) => pf.step.vortexGameId !== undefined && fileForStep(pf, picked) !== undefined);
  const skipped = files.filter((pf) => !todo.includes(pf));
  const known = planBlockers(plan, files, picked);
  ehLog("info", "curator.requirement.plan.start", {
    root: rootName,
    installs: todo.length,
    skipped: skipped.map((pf) => pf.step.key),
    enables: plan.toEnable.map((m) => m.id),
    thenEnable: thenEnable.map((m) => m.id),
    blockers: known,
  });

  const lines: string[] = [];
  const installed: string[] = [];
  const failed: string[] = [];
  let stoppedBefore: string | undefined;
  let n = 0;
  for (const pf of todo) {
    if (signal.aborted) {
      stoppedBefore = pf.step.name;
      lines.push(`Stopped before ${pf.step.name}.`);
      break;
    }
    n += 1;
    onProgress(`Installing ${n} of ${todo.length} — ${pf.step.name}`);
    const file = fileForStep(pf, picked)!;
    const result = await installStep(pf.step, file);
    if (result.ok) {
      installed.push(pf.step.name);
      lines.push(`Installed ${pf.step.name} (${file.name ?? file.file_name ?? `file ${file.file_id}`}).`);
    } else if (result.refused) {
      failed.push(pf.step.name);
      lines.push(
        `${pf.step.name}: Vortex did not download it — its own notification says why. Nexus only lets Vortex fetch files ` +
          `directly for Premium members; otherwise open the page and use "Mod manager download", which lands in Vortex.`,
      );
    } else {
      failed.push(pf.step.name);
      lines.push(`${pf.step.name}: did not finish installing — ${result.why}.`);
    }
  }

  const blockers = [
    ...(signal.aborted ? [stoppedBefore === undefined ? "the run was stopped" : `the run was stopped before ${stoppedBefore}`] : []),
    ...(failed.length > 0 ? [`${failed.length} requirement(s) did not install (${failed.join(", ")})`] : []),
    ...known,
  ];
  const worked = blockers.length === 0;
  const roots = worked ? thenEnable.filter((m) => !plan.toEnable.some((p) => p.id === m.id)) : [];
  const toEnable = signal.aborted ? [] : [...plan.toEnable, ...roots];
  if (toEnable.length > 0) {
    enableMods(toEnable);
    lines.push(`Enabled ${toEnable.map((m) => m.name).join(", ")}.`);
  }
  if (!worked && thenEnable.length > 0) {
    lines.push(
      `${thenEnable.map((m) => m.name).join(", ")} left disabled: ${blockers.join("; ")}. ` +
        `Enable anyway from the table if that is what you want.`,
    );
  }
  if (skipped.length > 0) {
    lines.push(`Not installed (no file chosen, no current file, or another game): ${namesOf(skipped)}.`);
  }
  ehLog("info", "curator.requirement.plan.done", {
    root: rootName,
    installed: installed.length,
    failed,
    skipped: skipped.map((pf) => pf.step.key),
    stopped: signal.aborted,
    worked,
    blockers,
    enabled: toEnable.map((m) => m.id),
  });
  return { lines, worked, blockers };
}
