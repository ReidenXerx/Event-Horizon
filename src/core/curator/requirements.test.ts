import { describe, expect, it } from "vitest";

import type { CuratorMod } from "./profileActions";
import {
  addMasterRequirements,
  dependantsOf,
  describeRequirementCell,
  disabledProvidersFor,
  domainForNumber,
  fetchRequirements,
  makeModUid,
  parseGameList,
  pickInstallFile,
  resolveNexusRequirements,
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
    expect(describeRequirementCell(report.byMod.get("ord"))).toBe("1 missing · 1 disabled");
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
