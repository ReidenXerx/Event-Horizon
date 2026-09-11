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
   * are broken at the deepest member; no order is right for those.
   */
  steps: PlannedInstall[];
  /** In the pool but disabled: enabling is the whole fix (settled: enable, report). */
  toEnable: CuratorMod[];
  /** Off-Nexus links and DLC found along the way; nothing to download. */
  external: ModRequirement[];
  /** Nexus pages whose own requirements could not be read. The plan may be short. */
  unfetched: string[];
  /** The depth cap stopped the walk. */
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
  maxDepth?: number;
  signal?: AbortSignal;
}): Promise<InstallPlan> {
  const maxDepth = args.maxDepth ?? MAX_DEPTH;
  const plan: InstallPlan = { steps: [], toEnable: [], external: [], unfetched: [], truncated: false };
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
          const own = args.report?.byMod.get(m.id)?.requirements ?? [];
          if (depth < maxDepth) absorb(own, m.name, undefined, depth + 1);
          else if (own.length > 0) plan.truncated = true;
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
      plan.truncated = true;
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
    const lines = report.byMod.get(synthetic.id)?.requirements ?? [];
    absorb(lines, step.name, step.key, step.depth + 1);
  }

  plan.steps = topologicalOrder([...stepByKey.values()], requires);
  return plan;
}

/**
 * Dependencies before dependants; ties and cycles in discovery order.
 *
 * Kahn's algorithm over "this page requires that page", restricted to pages
 * in the plan. Whatever is left when nothing has zero unmet dependencies is
 * a cycle: appended as discovered, and the preview says nothing about it
 * because there is no right order to say.
 */
function topologicalOrder(steps: readonly PlannedInstall[], requires: ReadonlyMap<string, ReadonlySet<string>>): PlannedInstall[] {
  const inPlan = new Set(steps.map((s) => s.key));
  const unmet = new Map<string, number>();
  const dependants = new Map<string, string[]>();
  for (const s of steps) {
    const deps = [...(requires.get(s.key) ?? [])].filter((k) => inPlan.has(k) && k !== s.key);
    unmet.set(s.key, deps.length);
    for (const d of deps) dependants.set(d, [...(dependants.get(d) ?? []), s.key]);
  }
  const out: PlannedInstall[] = [];
  const done = new Set<string>();
  const release = (s: PlannedInstall): void => {
    done.add(s.key);
    out.push(s);
    for (const d of dependants.get(s.key) ?? []) unmet.set(d, (unmet.get(d) ?? 1) - 1);
  };
  while (done.size < steps.length) {
    let progressed = false;
    for (const s of steps) {
      if (done.has(s.key) || (unmet.get(s.key) ?? 0) > 0) continue;
      release(s);
      progressed = true;
    }
    if (progressed) continue;
    // A stall means a cycle. Everything left is either in it or above it,
    // so releasing the DEEPEST leftover (the member furthest from the root)
    // lets the rest resolve in order; only the cycle itself loses its.
    const stuck = steps.filter((s) => !done.has(s.key));
    const deepest = stuck.reduce((a, b) => (b.depth > a.depth ? b : a));
    release(deepest);
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
