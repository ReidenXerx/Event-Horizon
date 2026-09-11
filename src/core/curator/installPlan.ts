/**
 * "Make this mod work": the closure of what a mod is missing.
 *
 * A requirement has requirements of its own. Installing one level and
 * telling the curator to re-read and come back is the loop the user asked
 * to be rid of, so the plan walks the chain — each missing page is asked
 * for ITS requirements, resolved against the same pool, and anything still
 * missing joins the plan — until nothing new appears or the depth cap is
 * hit. The curator sees the whole plan before the first download (settled
 * with the user, 2026-09-11: full closure, with a preview).
 *
 * Pure apart from the two fetchers it is handed, so the walk is tested with
 * a fake Nexus.
 */

import type { CuratorMod } from "./profileActions";
import {
  makeModUid,
  pickInstallFile,
  pickProvider,
  resolveNexusRequirements,
  type GameNumbers,
  type InstallFileChoice,
  type ModRequirement,
  type NexusFileInfo,
  type RequirementsFetcher,
  type RequirementsReport,
  type ToDomain,
} from "./requirements";

export type PlannedInstall = {
  /** "domain:modId" — the plan's identity for the page. */
  key: string;
  name: string;
  nexusModId: number;
  gameDomain: string;
  /** Vortex's id for the game; absent when this Vortex cannot download for it. */
  vortexGameId?: string;
  url?: string;
  notes?: string;
  /** Names of the mods (root or planned) that list it. */
  neededBy: string[];
  /** 1 = listed by the root mod; 2 = listed by one of those; … */
  depth: number;
};

export type InstallPlan = {
  /**
   * Install order: a dependency before everything that lists it (a
   * topological order over the chain). Pages in a cycle — Nexus has them —
   * install together, in the order they were found: no order inside a cycle
   * is right, but everything outside it still is.
   */
  steps: PlannedInstall[];
  /** In the pool but disabled: enabling is the whole fix (settled: enable, report). */
  toEnable: CuratorMod[];
  /** Off-Nexus links and DLC found along the way; nothing to download. */
  external: ModRequirement[];
  /** Nexus pages whose own requirements could not be read. The plan may be short. */
  unfetched: string[];
  /**
   * Mods and pages whose Requirements list Nexus cut short: it said how many
   * there are (`totalCount`) and returned fewer (Vortex asks for ten). What
   * was not returned was not planned.
   */
  truncatedLists: Array<{ name: string; notReturned: number }>;
  /** The depth cap stopped the walk. */
  depthCapped: boolean;
  /**
   * The plan is KNOWN to be short: the depth cap stopped the walk, or a list
   * above was cut. Installing it does not mean the mod works; a caller that
   * enables the root only when the plan worked must treat this as not worked.
   */
  truncated: boolean;
};

const MAX_DEPTH = 6;

/**
 * Walk the chain from the mod's missing lines.
 *
 * `roots` are the lines already resolved for the focused mod (its report
 * entry), so the first level costs no fetch.
 */
export async function planRequirementClosure(args: {
  rootName: string;
  roots: readonly ModRequirement[];
  mods: readonly CuratorMod[];
  activeGame: string;
  games: GameNumbers;
  toDomain?: ToDomain;
  knownGameIds?: readonly string[];
  fetch: RequirementsFetcher;
  /**
   * The page's own report: a provider that will be ENABLED has its
   * requirements here already (the pool was asked about every Nexus mod,
   * disabled ones included), so its chain is walked without a fetch.
   */
  report?: RequirementsReport;
  /**
   * The mods the plan is for, when `roots` came from their report entries:
   * a root whose own list Nexus cut short makes the plan short too.
   */
  rootModIds?: readonly string[];
  maxDepth?: number;
  signal?: AbortSignal;
}): Promise<InstallPlan> {
  const maxDepth = args.maxDepth ?? MAX_DEPTH;
  const plan: InstallPlan = {
    steps: [],
    toEnable: [],
    external: [],
    unfetched: [],
    truncatedLists: [],
    depthCapped: false,
    truncated: false,
  };
  const noteTruncated = (name: string, notReturned: number | undefined): void => {
    if (notReturned === undefined || notReturned <= 0) return;
    if (plan.truncatedLists.some((t) => t.name === name)) return;
    plan.truncatedLists.push({ name, notReturned });
  };
  for (const id of args.rootModIds ?? []) {
    const entry = args.report?.byMod.get(id);
    const name = args.mods.find((m) => m.id === id)?.name ?? args.rootName;
    noteTruncated(name, entry?.truncatedBy);
  }
  const stepByKey = new Map<string, PlannedInstall>();
  /** step key → keys of the planned pages it requires (edges for the order). */
  const requires = new Map<string, Set<string>>();
  const enableIds = new Set<string>();
  const externalKeys = new Set<string>();
  const queue: Array<{ step: PlannedInstall }> = [];

  const absorb = (lines: readonly ModRequirement[], from: string, fromKey: string | undefined, depth: number): void => {
    for (const q of lines) {
      if (q.source !== "nexus") continue;
      if (q.status === "installed-disabled") {
        // One provider per line (two disabled copies of one page would
        // otherwise both come on), and ITS chain is walked too: an enable
        // that leaves the enabled mod missing something is the one-level
        // loop this planner exists to end.
        const m = pickProvider(q.satisfiedBy.map((id) => args.mods.find((x) => x.id === id)).filter((x): x is CuratorMod => x !== undefined && !x.enabled));
        if (m !== undefined && !enableIds.has(m.id)) {
          enableIds.add(m.id);
          plan.toEnable.push(m);
          const entry = args.report?.byMod.get(m.id);
          const own = entry?.requirements ?? [];
          noteTruncated(m.name, entry?.truncatedBy);
          if (depth < maxDepth) absorb(own, m.name, undefined, depth + 1);
          else if (own.length > 0) plan.depthCapped = true;
        }
        continue;
      }
      if (q.status === "external" || q.status === "dlc" || q.status === "unknown-game") {
        const k = `${q.status}:${q.url ?? q.name}`;
        if (!externalKeys.has(k)) {
          externalKeys.add(k);
          plan.external.push(q);
        }
        continue;
      }
      if (q.status !== "missing" || q.nexusModId === undefined || q.gameDomain === undefined) continue;
      const key = `${q.gameDomain}:${q.nexusModId}`;
      if (fromKey !== undefined) {
        const deps = requires.get(fromKey) ?? new Set<string>();
        deps.add(key);
        requires.set(fromKey, deps);
      }
      const existing = stepByKey.get(key);
      if (existing !== undefined) {
        if (!existing.neededBy.includes(from)) existing.neededBy.push(from);
        continue;
      }
      const step: PlannedInstall = {
        key,
        name: q.name,
        nexusModId: q.nexusModId,
        gameDomain: q.gameDomain,
        neededBy: [from],
        depth,
        ...(q.vortexGameId === undefined ? {} : { vortexGameId: q.vortexGameId }),
        ...(q.url === undefined ? {} : { url: q.url }),
        ...(q.notes === undefined ? {} : { notes: q.notes }),
      };
      stepByKey.set(key, step);
      queue.push({ step });
    }
  };

  absorb(args.roots, args.rootName, undefined, 1);

  while (queue.length > 0) {
    if (args.signal?.aborted === true) break;
    const { step } = queue.shift()!;
    if (step.depth >= maxDepth) {
      plan.depthCapped = true;
      continue;
    }
    const num = args.games.get(step.gameDomain);
    if (num === undefined) {
      plan.unfetched.push(step.name);
      continue;
    }
    const uid = makeModUid(num, step.nexusModId);
    let answer: Awaited<ReturnType<RequirementsFetcher>>;
    try {
      answer = await args.fetch([uid]);
    } catch {
      plan.unfetched.push(step.name);
      continue;
    }
    const raw = answer[uid];
    if (raw === undefined) {
      plan.unfetched.push(step.name);
      continue;
    }
    // Resolve the page's requirements as if it were a mod in the pool: the
    // same resolver, the same pool, one synthetic entry for the page itself.
    const synthetic: CuratorMod = {
      id: `plan:${step.key}`,
      name: step.name,
      enabled: true,
      modType: "",
      nexusModId: step.nexusModId,
      ...(step.vortexGameId === undefined ? {} : { downloadGame: step.vortexGameId }),
    };
    const report = resolveNexusRequirements({
      mods: [...args.mods, synthetic],
      activeGame: args.activeGame,
      games: args.games,
      uidByMod: new Map([[synthetic.id, uid]]),
      fetched: new Map([[uid, raw]]),
      ...(args.toDomain === undefined ? {} : { toDomain: args.toDomain }),
      ...(args.knownGameIds === undefined ? {} : { knownGameIds: args.knownGameIds }),
    });
    const entry = report.byMod.get(synthetic.id);
    noteTruncated(step.name, entry?.truncatedBy);
    absorb(entry?.requirements ?? [], step.name, step.key, step.depth + 1);
  }

  plan.steps = topologicalOrder([...stepByKey.values()], requires);
  plan.truncated = plan.depthCapped || plan.truncatedLists.length > 0;
  return plan;
}

/**
 * Dependencies before dependants; ties in discovery order; a cycle as one
 * block, its members in discovery order.
 *
 * The order is taken over the graph's strongly connected components (Tarjan),
 * not its pages. A cycle is one component, so everything the cycle needs is
 * installed before any of it, and everything that needs any member of the
 * cycle after all of it. Breaking a stall at "the deepest leftover page"
 * instead released the wrong page whenever a chain into the cycle was deeper
 * than the cycle itself: root → A ⇄ B plus root → S → T → U → A installed U,
 * which needs A, before A.
 *
 * The components are then ordered with Kahn's algorithm, always releasing
 * the ready component discovered first, so the order is deterministic.
 */
function topologicalOrder(steps: readonly PlannedInstall[], requires: ReadonlyMap<string, ReadonlySet<string>>): PlannedInstall[] {
  const indexOf = new Map(steps.map((s, i) => [s.key, i]));
  const depsOf = (key: string): string[] =>
    [...(requires.get(key) ?? [])].filter((k) => indexOf.has(k) && k !== key).sort((a, b) => indexOf.get(a)! - indexOf.get(b)!);

  // ── Tarjan: component id per page. ──
  const componentOf = new Map<string, number>();
  const components: string[][] = [];
  const low = new Map<string, number>();
  const order = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  let counter = 0;
  const visit = (key: string): void => {
    order.set(key, counter);
    low.set(key, counter);
    counter += 1;
    stack.push(key);
    onStack.add(key);
    for (const d of depsOf(key)) {
      if (!order.has(d)) {
        visit(d);
        low.set(key, Math.min(low.get(key)!, low.get(d)!));
      } else if (onStack.has(d)) {
        low.set(key, Math.min(low.get(key)!, order.get(d)!));
      }
    }
    if (low.get(key) === order.get(key)) {
      const members: string[] = [];
      for (;;) {
        const top = stack.pop()!;
        onStack.delete(top);
        componentOf.set(top, components.length);
        members.push(top);
        if (top === key) break;
      }
      components.push(members.sort((a, b) => indexOf.get(a)! - indexOf.get(b)!));
    }
  };
  for (const s of steps) if (!order.has(s.key)) visit(s.key);

  // ── Kahn over the components, earliest-discovered ready component first. ──
  const first = components.map((members) => indexOf.get(members[0]!)!);
  const unmet = components.map(() => new Set<number>());
  const dependants = components.map(() => new Set<number>());
  components.forEach((members, c) => {
    for (const m of members) {
      for (const d of depsOf(m)) {
        const dc = componentOf.get(d)!;
        if (dc === c) continue;
        unmet[c]!.add(dc);
        dependants[dc]!.add(c);
      }
    }
  });
  const stepByKey = new Map(steps.map((s) => [s.key, s]));
  const out: PlannedInstall[] = [];
  const released = new Set<number>();
  while (released.size < components.length) {
    let next: number | undefined;
    components.forEach((_, c) => {
      if (released.has(c) || unmet[c]!.size > 0) return;
      if (next === undefined || first[c]! < first[next]!) next = c;
    });
    // The condensation of any graph is acyclic, so something is always ready.
    const c = next!;
    released.add(c);
    for (const key of components[c]!) out.push(stepByKey.get(key)!);
    for (const d of dependants[c]!) unmet[d]!.delete(c);
  }
  return out;
}

export type PlannedFile = {
  step: PlannedInstall;
  choice: InstallFileChoice;
};

/** Which file each step would install; the curator settles every "choose". */
export async function resolveInstallFiles(
  steps: readonly PlannedInstall[],
  getModFiles: (gameDomain: string, modId: number) => Promise<NexusFileInfo[]>,
  signal?: AbortSignal,
): Promise<PlannedFile[]> {
  const out: PlannedFile[] = [];
  for (const step of steps) {
    if (signal?.aborted === true) break;
    let files: NexusFileInfo[] = [];
    try {
      files = await getModFiles(step.gameDomain, step.nexusModId);
    } catch {
      files = [];
    }
    out.push({ step, choice: pickInstallFile(files) });
  }
  return out;
}

/** The file a step will install, given the curator's picks; undefined = skipped. */
export function fileForStep(pf: PlannedFile, picked: Readonly<Record<string, number | undefined>>): NexusFileInfo | undefined {
  if (pf.choice.kind === "one") return pf.choice.file;
  if (pf.choice.kind === "choose") {
    const id = picked[pf.step.key];
    return id === undefined ? undefined : pf.choice.candidates.find((f) => f.file_id === id);
  }
  return undefined;
}

/** One line per thing the plan will do, for the confirm and the report. */
export function describePlan(plan: InstallPlan, files: readonly PlannedFile[], picked: Readonly<Record<string, number | undefined>>): {
  installable: number;
  undecided: number;
  noFile: number;
  notHere: number;
} {
  let installable = 0;
  let undecided = 0;
  let noFile = 0;
  let notHere = 0;
  for (const pf of files) {
    if (pf.step.vortexGameId === undefined) {
      notHere += 1;
      continue;
    }
    if (pf.choice.kind === "none") noFile += 1;
    else if (fileForStep(pf, picked) !== undefined) installable += 1;
    else undecided += 1;
  }
  void plan;
  return { installable, undecided, noFile, notHere };
}
