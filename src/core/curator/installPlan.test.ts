import { describe, expect, it } from "vitest";

import { describePlan, fileForStep, planRequirementClosure, resolveInstallFiles } from "./installPlan";
import type { CuratorMod } from "./profileActions";
import { makeModUid, nexusDomainOf, parseGameList, type ModRequirement, type NexusModRequirements } from "./requirements";

const GAMES = parseGameList(JSON.stringify([{ id: 1704, domain_name: "skyrimspecialedition" }, { id: 1151, domain_name: "fallout4" }]));

const mod = (over: Partial<CuratorMod> & { id: string; name: string }): CuratorMod => ({
  enabled: true,
  modType: "",
  source: "nexus",
  ...over,
});

// The pool: SKSE present and enabled, Address Library present but OFF.
const mods = [
  mod({ id: "skse", name: "SKSE64", nexusModId: 30379 }),
  mod({ id: "addr", name: "Address Library", nexusModId: 32444, enabled: false }),
];

const node = (modId: number, modName: string, gameId = 1704): { gameId: number; modId: number; modName: string } => ({ gameId, modId, modName });

// What Nexus says about each page the walk will ask about.
const pages = new Map<string, Partial<NexusModRequirements>>([
  // SkyUI needs SKSE (present) and "MCM Helper" (missing).
  [makeModUid(1704, 12604), { nexusRequirements: { totalCount: 2, nodes: [node(30379, "SKSE64"), node(53000, "MCM Helper")] } }],
  // MCM Helper needs SKSE and Address Library (present, disabled).
  [makeModUid(1704, 53000), { nexusRequirements: { totalCount: 2, nodes: [node(30379, "SKSE64"), node(32444, "Address Library")] } }],
  // Papyrus Extender needs MCM Helper too: a cross edge to a page already found.
  [makeModUid(1704, 22854), { nexusRequirements: { totalCount: 1, nodes: [node(53000, "MCM Helper")] } }],
  // A page that needs an FO4 mod (a game this Vortex knows nothing about here).
  [makeModUid(1704, 777), { nexusRequirements: { totalCount: 1, nodes: [node(999, "FO4 thing", 1151)] } }],
  // Two pages that list each other.
  [makeModUid(1704, 6001), { nexusRequirements: { totalCount: 1, nodes: [node(6002, "Loop B")] } }],
  [makeModUid(1704, 6002), { nexusRequirements: { totalCount: 1, nodes: [node(6001, "Loop A")] } }],
]);
const fetch = async (uids: string[]): Promise<Record<string, Partial<NexusModRequirements> | undefined>> =>
  Object.fromEntries(uids.map((u) => [u, pages.get(u)]));

const missing = (name: string, nexusModId: number): ModRequirement => ({
  source: "nexus",
  status: "missing",
  name,
  nexusModId,
  gameDomain: "skyrimspecialedition",
  vortexGameId: "skyrimse",
  satisfiedBy: [],
});

describe("planRequirementClosure", () => {
  it("walks the chain, orders dependencies first, and turns a disabled provider into an enable", async () => {
    const plan = await planRequirementClosure({
      rootName: "Apocalypse",
      roots: [
        missing("SkyUI", 12604),
        missing("Papyrus Extender", 22854),
        { source: "nexus", status: "external", name: "ENB", url: "http://enb", satisfiedBy: [] },
      ],
      mods,
      activeGame: "skyrimse",
      games: GAMES,
      toDomain: nexusDomainOf,
      knownGameIds: ["skyrimse"],
      fetch,
    });
    // MCM Helper is listed by both root requirements, so it installs first
    // even though it was discovered one level down.
    expect(plan.steps.map((s) => [s.name, s.depth])).toEqual([
      ["MCM Helper", 2],
      ["SkyUI", 1],
      ["Papyrus Extender", 1],
    ]);
    expect(plan.steps[0]!.neededBy).toEqual(["SkyUI", "Papyrus Extender"]);
    expect(plan.steps[1]!.neededBy).toEqual(["Apocalypse"]);
    expect(plan.steps.every((s) => s.vortexGameId === "skyrimse")).toBe(true);
    // Address Library is in the pool: enable it, do not download it.
    expect(plan.toEnable.map((m) => m.id)).toEqual(["addr"]);
    expect(plan.external.map((q) => q.name)).toEqual(["ENB"]);
    expect(plan.unfetched).toEqual([]);
    expect(plan.truncated).toBe(false);
  });

  it("survives a cycle and an unanswered page, and stops at the depth cap", async () => {
    const plan = await planRequirementClosure({
      rootName: "Root",
      roots: [missing("SkyUI", 12604), missing("Unknown page", 4242)],
      mods,
      activeGame: "skyrimse",
      games: GAMES,
      toDomain: nexusDomainOf,
      knownGameIds: ["skyrimse"],
      fetch,
      maxDepth: 1,
    });
    // Depth cap 1: SkyUI's own requirements are never asked for.
    expect(plan.steps.map((s) => s.name)).toEqual(["SkyUI", "Unknown page"]);
    expect(plan.truncated).toBe(true);
    expect(plan.unfetched).toEqual([]);

    const deeper = await planRequirementClosure({
      rootName: "Root",
      roots: [missing("Unknown page", 4242)],
      mods,
      activeGame: "skyrimse",
      games: GAMES,
      toDomain: nexusDomainOf,
      knownGameIds: ["skyrimse"],
      fetch,
    });
    expect(deeper.unfetched).toEqual(["Unknown page"]);
    expect(deeper.steps.map((s) => s.name)).toEqual(["Unknown page"]);

    // Two pages listing each other: both planned, discovery order, no hang.
    const loop = await planRequirementClosure({
      rootName: "Root",
      roots: [missing("Loop A", 6001)],
      mods,
      activeGame: "skyrimse",
      games: GAMES,
      toDomain: nexusDomainOf,
      knownGameIds: ["skyrimse"],
      fetch,
    });
    expect(loop.steps.map((s) => s.name)).toEqual(["Loop A", "Loop B"]);
    expect(loop.truncated).toBe(false);
  });

  it("keeps a requirement for a game this Vortex cannot download for, without a Vortex id", async () => {
    const plan = await planRequirementClosure({
      rootName: "Root",
      roots: [missing("Cross-game page", 777)],
      mods,
      activeGame: "skyrimse",
      games: GAMES,
      toDomain: nexusDomainOf,
      knownGameIds: ["skyrimse"],
      fetch,
    });
    const fo4 = plan.steps.find((s) => s.name === "FO4 thing")!;
    expect(fo4.gameDomain).toBe("fallout4");
    expect(fo4.vortexGameId).toBeUndefined();
  });
});

describe("resolveInstallFiles / describePlan", () => {
  it("settles one-file pages, leaves choices to the curator, and counts what will happen", async () => {
    const steps = [
      { key: "skyrimspecialedition:1", name: "One", nexusModId: 1, gameDomain: "skyrimspecialedition", vortexGameId: "skyrimse", neededBy: ["R"], depth: 1 },
      { key: "skyrimspecialedition:2", name: "Two", nexusModId: 2, gameDomain: "skyrimspecialedition", vortexGameId: "skyrimse", neededBy: ["R"], depth: 1 },
      { key: "skyrimspecialedition:3", name: "Three", nexusModId: 3, gameDomain: "skyrimspecialedition", vortexGameId: "skyrimse", neededBy: ["R"], depth: 1 },
      { key: "fallout4:9", name: "Elsewhere", nexusModId: 9, gameDomain: "fallout4", neededBy: ["R"], depth: 1 },
    ];
    const files = await resolveInstallFiles(steps, async (_g, modId) =>
      modId === 1
        ? [{ file_id: 10, category_id: 1, name: "Main" }]
        : modId === 2
          ? [
              { file_id: 20, category_id: 1, name: "LE" },
              { file_id: 21, category_id: 1, name: "AE" },
            ]
          : modId === 3
            ? []
            : [{ file_id: 90, category_id: 1, name: "x" }],
    );
    expect(files.map((f) => f.choice.kind)).toEqual(["one", "choose", "none", "one"]);
    const plan = { steps, toEnable: [], external: [], unfetched: [], truncated: false };
    expect(describePlan(plan, files, {})).toEqual({ installable: 1, undecided: 1, noFile: 1, notHere: 1 });
    expect(fileForStep(files[1]!, { "skyrimspecialedition:2": 21 })?.name).toBe("AE");
    expect(describePlan(plan, files, { "skyrimspecialedition:2": 21 }).installable).toBe(2);
  });
});
