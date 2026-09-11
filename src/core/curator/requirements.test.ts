import { describe, expect, it } from "vitest";

import type { CuratorMod } from "./profileActions";
import {
  addMasterRequirements,
  countDistinct,
  dependantsOf,
  describeRequirementCell,
  disabledProvidersFor,
  domainForNumber,
  fetchRequirements,
  makeModUid,
  nexusDomainOf,
  parseGameList,
  pickInstallFile,
  resolveNexusRequirements,
  requirementCellCategory,
  splitModUid,
  summarizeRequirements,
  uidsFor,
  type NexusModRequirements,
} from "./requirements";

const GAMES = parseGameList(
  JSON.stringify([
    { id: 1704, domain_name: "skyrimspecialedition", name: "Skyrim Special Edition" },
    { id: 1151, domain_name: "fallout4", name: "Fallout 4" },
    { id: 110, domain_name: "skyrim", name: "Skyrim" },
  ]),
);

const mod = (over: Partial<CuratorMod> & { id: string; name: string }): CuratorMod => ({
  enabled: true,
  modType: "",
  source: "nexus",
  ...over,
});

describe("UID", () => {
  it("matches Vortex's makeModUID: game in the high 32 bits, mod in the low", () => {
    // 1704 << 32 | 32444 — the real Address Library page under SSE.
    expect(makeModUid(1704, 32444)).toBe(String((1704n << 32n) | 32444n));
    expect(splitModUid(makeModUid(1704, 32444))).toEqual({ numericGameId: 1704, nexusModId: 32444 });
  });

  it("reads Vortex's games cache and survives garbage", () => {
    expect(GAMES.get("skyrimspecialedition")).toBe(1704);
    expect(domainForNumber(GAMES, 1151)).toBe("fallout4");
    expect(parseGameList("not json").size).toBe(0);
    expect(parseGameList('{"a":1}').size).toBe(0);
    expect(parseGameList('[{"domain_name":"x"}]').size).toBe(0);
  });

  it("only asks about Nexus mods, and names the ones it cannot key", () => {
    const mods = [
      mod({ id: "a", name: "A", nexusModId: 1 }),
      mod({ id: "b", name: "B", nexusModId: 2, source: "user-generated" }),
      mod({ id: "c", name: "C" }),
      mod({ id: "d", name: "D", nexusModId: 4, downloadGame: "no-such-game" }),
      // A compatible download: the file lives under another game's id.
      mod({ id: "e", name: "E", nexusModId: 5, downloadGame: "skyrim" }),
    ];
    const { uidByMod, noUid } = uidsFor(mods, GAMES, "skyrimspecialedition");
    expect([...uidByMod.keys()]).toEqual(["a", "e"]);
    expect(uidByMod.get("e")).toBe(makeModUid(110, 5));
    expect(noUid).toEqual(["d"]);
  });
});

describe("fetchRequirements", () => {
  it("chunks, dedupes, and reports what it could not fetch instead of pretending", async () => {
    const calls: string[][] = [];
    const { byUid, failedUids } = await fetchRequirements({
      uids: ["1", "2", "2", "3", "4", "5"],
      chunkSize: 2,
      fetch: async (uids) => {
        calls.push(uids);
        if (uids.includes("3")) throw new Error("rate limited");
        const out: Record<string, NexusModRequirements> = {};
        for (const u of uids) if (u !== "5") out[u] = { nexusRequirements: { nodes: [], totalCount: 0 } };
        return out;
      },
    });
    expect(calls).toEqual([["1", "2"], ["3", "4"], ["5"]]);
    expect([...byUid.keys()]).toEqual(["1", "2"]);
    // A failed chunk and a uid the server left out are both "not fetched".
    expect(failedUids).toEqual(["3", "4", "5"]);
  });

  it("stops at an abort and counts the rest as unfetched", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const { byUid, failedUids } = await fetchRequirements({
      uids: ["1", "2"],
      fetch: async () => ({}),
      signal: ctl.signal,
    });
    expect(byUid.size).toBe(0);
    expect(failedUids).toEqual(["1", "2"]);
  });
});

describe("resolveNexusRequirements", () => {
  const skse = mod({ id: "skse", name: "SKSE64", nexusModId: 30379 });
  const addr = mod({ id: "addr", name: "Address Library", nexusModId: 32444, enabled: false });
  const ordinator = mod({ id: "ord", name: "Ordinator", nexusModId: 1137 });
  const mods = [skse, addr, ordinator];
  const uidByMod = uidsFor(mods, GAMES, "skyrimspecialedition").uidByMod;
  const ordUid = uidByMod.get("ord")!;

  const fetched = new Map<string, Partial<NexusModRequirements>>([
    [
      ordUid,
      {
        nexusRequirements: {
          totalCount: 5,
          nodes: [
            { modId: "30379", gameId: "1704", modName: "SKSE64", notes: "" },
            { modId: 32444, gameId: 1704, modName: "Address Library", notes: "AE build" },
            { modId: "99999", gameId: "1704", modName: "Some Patch" },
            { modName: "ENB", url: "https://enbdev.com", externalRequirement: true },
          ],
        },
        dlcRequirements: [{ gameExpansion: { id: 1, name: "Dawnguard" }, notes: null }],
      },
    ],
  ]);

  it("resolves against the pool, not the profile (NS-3): disabled is not missing", () => {
    const report = resolveNexusRequirements({
      mods,
      activeGame: "skyrimspecialedition",
      games: GAMES,
      uidByMod,
      fetched,
    });
    const r = report.byMod.get("ord")!;
    const by = (name: string) => r.requirements.find((q) => q.name === name)!;
    expect(by("SKSE64").status).toBe("satisfied");
    expect(by("SKSE64").satisfiedBy).toEqual(["skse"]);
    expect(by("Address Library").status).toBe("installed-disabled");
    expect(by("Address Library").notes).toBe("AE build");
    expect(by("Some Patch").status).toBe("missing");
    expect(by("Some Patch").url).toBe("https://www.nexusmods.com/skyrimspecialedition/mods/99999");
    expect(by("ENB").status).toBe("external");
    expect(by("Dawnguard").status).toBe("dlc");
    // Nexus said five, sent four: the page must say "and 1 more".
    expect(r.truncatedBy).toBe(1);
    expect(r.unfetched).toBe(false);
    // Reverse index only over what the pool provides.
    expect(report.requiredBy.get("skse")).toEqual(["ord"]);
    expect(report.requiredBy.get("addr")).toEqual(["ord"]);
    expect(report.requiredBy.get("ord")).toBeUndefined();
  });

  it("marks a mod Nexus was not asked about as unfetched, never as requirement-free", () => {
    const report = resolveNexusRequirements({
      mods,
      activeGame: "skyrimspecialedition",
      games: GAMES,
      uidByMod,
      fetched: new Map(),
    });
    expect(report.byMod.get("ord")!.unfetched).toBe(true);
    expect(report.byMod.get("ord")!.requirements).toEqual([]);
    expect(describeRequirementCell(report.byMod.get("ord"))).toBe("not checked");
  });

  it("names a requirement whose game is not in the cache instead of building a wrong key", () => {
    const report = resolveNexusRequirements({
      mods,
      activeGame: "skyrimspecialedition",
      games: GAMES,
      uidByMod,
      fetched: new Map([
        [ordUid, { nexusRequirements: { nodes: [{ modId: "7", gameId: "424242", modName: "Elsewhere" }], totalCount: 1 } }],
      ]),
    });
    expect(report.byMod.get("ord")!.requirements[0]!.status).toBe("unknown-game");
  });

  it("summarises for the tiles and the cell", () => {
    const report = resolveNexusRequirements({
      mods,
      activeGame: "skyrimspecialedition",
      games: GAMES,
      uidByMod,
      fetched,
    });
    expect(summarizeRequirements(report)).toEqual({
      modsWithMissing: 1,
      missing: 1,
      installedDisabled: 1,
      external: 1,
      dlc: 1,
      unfetched: 2, // skse and addr were never fetched in this fixture
      truncated: 1,
    });
    // Nexus listed five and returned four: what is known leads, and the cell says the list is cut.
    expect(describeRequirementCell(report.byMod.get("ord"))).toBe("1 missing · 1 disabled · incomplete");
  });

  it("finds dependants of a mod about to be disabled, and disabled providers of one about to be enabled", () => {
    const report = resolveNexusRequirements({
      mods,
      activeGame: "skyrimspecialedition",
      games: GAMES,
      uidByMod,
      fetched,
    });
    const dep = dependantsOf(report, mods, new Set(["skse"]));
    expect(dep.map((d) => [d.provider.id, d.dependants.map((m) => m.id)])).toEqual([["skse", ["ord"]]]);
    // Disabling both at once is not a warning: the dependant goes too.
    expect(dependantsOf(report, mods, new Set(["skse", "ord"]))).toEqual([]);
    expect(disabledProvidersFor(report, mods, new Set(["ord"])).map((m) => m.id)).toEqual(["addr"]);
  });
});

describe("plugin masters", () => {
  it("adds hard requirements from headers, resolved through who ships the master", () => {
    const usleep = mod({ id: "usleep", name: "USSEP", nexusModId: 266 });
    const patch = mod({ id: "patch", name: "Some Patch", nexusModId: 300 });
    const racecomp = mod({ id: "rc", name: "RaceCompatibility", nexusModId: 2853, enabled: false });
    const mods = [usleep, patch, racecomp];
    const base = resolveNexusRequirements({
      mods,
      activeGame: "skyrimspecialedition",
      games: GAMES,
      uidByMod: new Map(),
      fetched: new Map(),
    });
    const report = addMasterRequirements(base, {
      mods,
      owners: [
        { plugin: "Unofficial Skyrim Special Edition Patch.esp", modId: "usleep" },
        { plugin: "SomePatch.esp", modId: "patch" },
        { plugin: "RaceCompatibility.esm", modId: "rc" },
      ],
      masters: new Map([
        [
          "SomePatch.esp",
          ["Skyrim.esm", "Unofficial Skyrim Special Edition Patch.esp", "RaceCompatibility.esm", "Gone.esm"],
        ],
        ["Unofficial Skyrim Special Edition Patch.esp", ["Skyrim.esm", "Update.esm"]],
      ]),
      isBaseGame: (m) => /^(skyrim|update|dawnguard|hearthfires|dragonborn)\.esm$/i.test(m),
    });
    const r = report.byMod.get("patch")!;
    expect(r.requirements.map((q) => [q.master, q.status])).toEqual([
      ["Unofficial Skyrim Special Edition Patch.esp", "satisfied"],
      ["RaceCompatibility.esm", "installed-disabled"],
      ["Gone.esm", "missing"],
    ]);
    expect(report.requiredBy.get("usleep")).toEqual(["patch"]);
    // Base-game masters are never a requirement to install.
    expect(report.byMod.get("usleep")!.requirements).toEqual([]);
  });
});

describe("game namespaces", () => {
  it("maps Vortex ids to Nexus domains the way Vortex does", () => {
    expect(nexusDomainOf("skyrimse")).toBe("skyrimspecialedition");
    expect(nexusDomainOf("SkyrimVR")).toBe("skyrimspecialedition");
    expect(nexusDomainOf("falloutnv")).toBe("newvegas");
    expect(nexusDomainOf("fallout4")).toBe("fallout4");
    // A game extension's own page id wins over the table.
    expect(nexusDomainOf("enderalspecialedition", "enderalspecialedition")).toBe("enderalspecialedition");
    expect(nexusDomainOf("skyrimse", "")).toBe("skyrimspecialedition");
  });

  it("keys UIDs and the pool by the Nexus domain when Vortex's id differs (the SSE case)", () => {
    // Vortex says "skyrimse"; the games cache only knows "skyrimspecialedition".
    const mods = [
      mod({ id: "ord", name: "Ordinator", nexusModId: 1137 }),
      mod({ id: "skse", name: "SKSE64", nexusModId: 30379 }),
      // Downloaded under Skyrim VR's id: same Nexus domain, same pool.
      mod({ id: "vr", name: "VR thing", nexusModId: 555, downloadGame: "skyrimvr" }),
    ];
    const { uidByMod, noUid } = uidsFor(mods, GAMES, "skyrimse", nexusDomainOf);
    expect(noUid).toEqual([]);
    expect(uidByMod.get("ord")).toBe(makeModUid(1704, 1137));
    expect(uidByMod.get("vr")).toBe(makeModUid(1704, 555));

    const fetched = new Map<string, Partial<NexusModRequirements>>([
      [
        makeModUid(1704, 1137),
        {
          nexusRequirements: {
            totalCount: 3,
            nodes: [
              { gameId: 1704, modId: 30379, modName: "SKSE64" },
              { gameId: "1704", modId: 555, modName: "VR thing" },
              // Nexus lists the page itself: not a requirement.
              { gameId: 1704, modId: 1137, modName: "Ordinator" },
            ],
          },
        },
      ],
    ]);
    const report = resolveNexusRequirements({
      mods,
      activeGame: "skyrimse",
      games: GAMES,
      uidByMod,
      fetched,
      toDomain: nexusDomainOf,
      knownGameIds: ["skyrimse", "skyrimvr", "fallout4"],
    });
    const r = report.byMod.get("ord")!;
    expect(r.requirements.map((q) => [q.name, q.status])).toEqual([
      ["SKSE64", "satisfied"],
      ["VR thing", "satisfied"],
    ]);
    // The page keeps the Nexus domain; the download surface gets Vortex's id.
    expect(r.requirements[0]).toMatchObject({ gameDomain: "skyrimspecialedition", vortexGameId: "skyrimse" });
    expect(report.requiredBy.get("ord")).toBeUndefined();
  });

  it("leaves vortexGameId off a requirement for a game this Vortex does not know", () => {
    const mods = [mod({ id: "a", name: "A", nexusModId: 1 })];
    const { uidByMod } = uidsFor(mods, GAMES, "skyrimse", nexusDomainOf);
    const fetched = new Map<string, Partial<NexusModRequirements>>([
      [makeModUid(1704, 1), { nexusRequirements: { totalCount: 1, nodes: [{ gameId: 1151, modId: 7, modName: "FO4 thing" }] } }],
    ]);
    const report = resolveNexusRequirements({
      mods,
      activeGame: "skyrimse",
      games: GAMES,
      uidByMod,
      fetched,
      toDomain: nexusDomainOf,
      knownGameIds: ["skyrimse"],
    });
    const q = report.byMod.get("a")!.requirements[0]!;
    expect(q.status).toBe("missing");
    expect(q.gameDomain).toBe("fallout4");
    expect(q.vortexGameId).toBeUndefined();
  });
});

describe("masters that no mod ships", () => {
  const mods = [mod({ id: "patch", name: "Patch" }), mod({ id: "cc", name: "CC Owner" })];
  const base = resolveNexusRequirements({ mods, activeGame: "skyrimse", games: GAMES, uidByMod: new Map(), fetched: new Map() });

  it("treats a present native or loose master as satisfied, not missing", () => {
    const report = addMasterRequirements(base, {
      mods,
      owners: [
        { plugin: "Patch.esp", modId: "patch" },
        // The game's own file on a game with no base-masters table, and a
        // Creation Club master the user bought: listed by Vortex, no mod.
        { plugin: "Starfield.esm", native: true },
        { plugin: "ccBGSSSE016-Umbra.esm" },
      ],
      masters: new Map([["Patch.esp", ["Starfield.esm", "ccBGSSSE016-Umbra.esm", "Gone.esm"]]]),
      isBaseGame: () => false,
    });
    expect(report.byMod.get("patch")!.requirements.map((q) => [q.master, q.status])).toEqual([["Gone.esm", "missing"]]);
  });

  it("never pushes into the input report's arrays", () => {
    const seeded: typeof base = { ...base, requiredBy: new Map([["cc", ["someone"]]]) };
    const before = seeded.requiredBy.get("cc")!;
    addMasterRequirements(seeded, {
      mods,
      owners: [
        { plugin: "Patch.esp", modId: "patch" },
        { plugin: "Umbra.esm", modId: "cc" },
      ],
      masters: new Map([["Patch.esp", ["Umbra.esm"]]]),
      isBaseGame: () => false,
    });
    expect(before).toEqual(["someone"]);
  });
});

describe("counting", () => {
  it("counts a requirement once when the page and a plugin header both name it", () => {
    const r = {
      modId: "ord",
      truncatedBy: 0,
      unfetched: false,
      requirements: [
        { source: "nexus" as const, status: "installed-disabled" as const, name: "USSEP", nexusModId: 266, satisfiedBy: ["ussep"] },
        { source: "master" as const, status: "installed-disabled" as const, name: "USSEP", plugin: "Ord.esp", master: "USSEP.esp", satisfiedBy: ["ussep"] },
        { source: "nexus" as const, status: "missing" as const, name: "Gone", nexusModId: 1, gameDomain: "skyrimspecialedition", satisfiedBy: [] },
        { source: "master" as const, status: "missing" as const, name: "Gone.esm", plugin: "Ord.esp", master: "Gone.esm", satisfiedBy: [] },
      ],
    };
    expect(countDistinct(r, "installed-disabled")).toBe(1);
    expect(describeRequirementCell(r)).toBe("2 missing · 1 disabled");
    expect(requirementCellCategory(r)).toBe("missing");
    const s = summarizeRequirements({ byMod: new Map([["ord", r]]), requiredBy: new Map(), noUid: [] });
    expect(s.installedDisabled).toBe(1);
    expect(s.missing).toBe(2);
  });
});

describe("pickInstallFile", () => {
  it("installs only when the answer is not a judgement", () => {
    const main = { file_id: 1, category_id: 1, name: "Main" };
    const old = { file_id: 2, category_id: 4, name: "Old main" };
    const optional = { file_id: 3, category_id: 3, name: "Optional" };
    expect(pickInstallFile([main, old, optional])).toEqual({ kind: "one", file: main });
    const main2 = { file_id: 4, category_id: 1, name: "Main (AE)" };
    expect(pickInstallFile([main, main2, old])).toEqual({ kind: "choose", candidates: [main, main2] });
    expect(pickInstallFile([optional])).toEqual({ kind: "choose", candidates: [optional] });
    expect(pickInstallFile([old])).toEqual({ kind: "none" });
    expect(pickInstallFile([])).toEqual({ kind: "none" });
  });
});
