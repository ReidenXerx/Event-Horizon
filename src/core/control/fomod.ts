/**
 * Vortex's FOMOD installer wizard, read and driven from the control channel.
 *
 * Live, 2026-09-27: an install with no recorded choices opened the wizard and
 * waited for the owner's clicks. The agent could not see it (it is not a
 * Vortex dialog, so openDialogs stayed empty) and could not answer it.
 *
 * Read out of Vortex's bundle (app.asar, installer_fomod_native
 * DialogManager + the shared InstallerDialog view):
 *   state   session.fomod.installer.dialog = { activeInstanceId,
 *             instances: { [id]: { info: { moduleName }, state: {
 *               installSteps: [{ id, name, visible, optionalFileGroups:
 *                 { group: [{ id, name, type, options: [{ id, name,
 *                   selected, type, description }] }] } }],
 *               currentStep /* an INDEX into installSteps *\/ } } } }
 *   select  events.emit(`fomod-installer-select-${id}`, step.id, groupId, optionIds)
 *           (the group's whole selected set, as the view sends it)
 *   next    events.emit(`fomod-installer-continue-${id}`, "forward"|"finish"|"back", currentStep)
 *           ("finish" when no later step is visible, exactly like the view's next())
 *   cancel  events.emit(`fomod-installer-cancel-${id}`)
 */

export type FomodOption = { id: number; name: string; selected: boolean; type?: string; description?: string };
export type FomodGroup = { id: number; name: string; type: string; options: FomodOption[] };
export type FomodStep = { index: number; id: number; name: string; visible: boolean; groups: FomodGroup[] };
export type FomodView = { instanceId: string; moduleName?: string; currentStep: number; steps: FomodStep[] };

type RawOption = { id?: unknown; name?: unknown; selected?: unknown; type?: unknown; description?: unknown };
type RawGroup = { id?: unknown; name?: unknown; type?: unknown; options?: RawOption[] };
type RawStep = { id?: unknown; name?: unknown; visible?: unknown; optionalFileGroups?: { group?: RawGroup[] } };

/** The open wizard, or undefined when none is. Never throws: a changed shape reads as "none". */
export function readFomod(state: unknown): FomodView | undefined {
  try {
    const dialog = (state as { session?: { fomod?: { installer?: { dialog?: Record<string, unknown> } } } }).session?.fomod
      ?.installer?.dialog;
    const id = dialog?.["activeInstanceId"];
    if (typeof id !== "string" || id === "") return undefined;
    const inst = (dialog?.["instances"] as Record<string, { info?: { moduleName?: unknown }; state?: Record<string, unknown> }>)?.[id];
    const steps = (inst?.state?.["installSteps"] as RawStep[] | undefined) ?? [];
    return {
      instanceId: id,
      ...(typeof inst?.info?.moduleName === "string" ? { moduleName: inst.info.moduleName } : {}),
      currentStep: typeof inst?.state?.["currentStep"] === "number" ? (inst.state["currentStep"] as number) : 0,
      steps: steps.map((s, index) => ({
        index,
        id: Number(s.id),
        name: String(s.name ?? ""),
        visible: s.visible !== false,
        groups: (s.optionalFileGroups?.group ?? []).map((g) => ({
          id: Number(g.id),
          name: String(g.name ?? ""),
          type: String(g.type ?? ""),
          options: (g.options ?? []).map((o) => ({
            id: Number(o.id),
            name: String(o.name ?? ""),
            selected: o.selected === true,
            ...(typeof o.type === "string" ? { type: o.type } : {}),
            ...(typeof o.description === "string" && o.description !== "" ? { description: o.description.slice(0, 300) } : {}),
          })),
        })),
      })),
    };
  } catch {
    return undefined;
  }
}

export type FomodPick = { group: string | number; options: Array<string | number>; step?: string | number };

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Which step a pick belongs to (by name or index), or undefined when it names none. */
export function pickAppliesTo(pick: FomodPick, step: FomodStep): boolean {
  if (pick.step === undefined) return step.groups.some((g) => matchesGroup(g, pick.group));
  return typeof pick.step === "number" ? pick.step === step.index : same(pick.step, step.name);
}

function matchesGroup(g: FomodGroup, key: string | number): boolean {
  return typeof key === "number" ? g.id === key : same(g.name, key);
}

/**
 * Resolves a pick against the step on screen: the group and the option ids,
 * or a reason naming what exists. Exact names only (case-insensitive): a
 * near-miss is an error that lists the choices, never a guess (NS-8's rule,
 * that FOMOD answers are never guessed, applies to live answers too).
 */
export function resolvePick(
  step: FomodStep,
  pick: FomodPick,
): { ok: true; groupId: number; optionIds: number[] } | { ok: false; reason: string } {
  const group = step.groups.find((g) => matchesGroup(g, pick.group));
  if (group === undefined) {
    return { ok: false, reason: `Step "${step.name}" has no group ${JSON.stringify(pick.group)}. Groups: ${step.groups.map((g) => `"${g.name}"`).join(", ")}.` };
  }
  const optionIds: number[] = [];
  for (const want of pick.options) {
    const o = group.options.find((x) => (typeof want === "number" ? x.id === want : same(x.name, want)));
    if (o === undefined) {
      return {
        ok: false,
        reason: `Group "${group.name}" has no option ${JSON.stringify(want)}. Options: ${group.options.map((x) => `"${x.name}"`).join(", ")}.`,
      };
    }
    optionIds.push(o.id);
  }
  if (/ExactlyOne/i.test(group.type) && optionIds.length !== 1) {
    return { ok: false, reason: `Group "${group.name}" takes exactly one option (${group.type}); got ${optionIds.length}.` };
  }
  if (/AtMostOne/i.test(group.type) && optionIds.length > 1) {
    return { ok: false, reason: `Group "${group.name}" takes at most one option (${group.type}); got ${optionIds.length}.` };
  }
  return { ok: true, groupId: group.id, optionIds };
}

/** "finish" when no later step is visible: the wizard view's own next(). */
export function continueDirection(view: FomodView): "forward" | "finish" {
  return view.steps.some((s) => s.index > view.currentStep && s.visible) ? "forward" : "finish";
}

/** A compact line per open wizard, for replies that are not about FOMOD. */
export function fomodSummary(view: FomodView | undefined): Record<string, unknown> | undefined {
  if (view === undefined) return undefined;
  const step = view.steps[view.currentStep];
  return { moduleName: view.moduleName, step: step?.name, stepIndex: view.currentStep, steps: view.steps.length };
}
