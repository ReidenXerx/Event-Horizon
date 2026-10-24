/**
 * Which mod the game gets each collection file from — recorded from the
 * curator's deployment, judged on the player's. Built after an Ivy updated
 * through several revisions gave every new character "nailed" breasts that a
 * fresh install did not (alasdairn, 2026-10-04), with every mod's files intact.
 */
import { describe, expect, it } from "vitest";

import { describeDeployFindings, judgeDeployment, planWinnerPins, recordDeploymentWinners, type DeployFinding } from "./deploymentWinners";
import { deployWinnersCheck } from "../doctor/health";
import { parseManifest } from "./parseManifest";

const BODY = "Meshes/Actors/Character/CharacterAssets/FemaleBody.nif";
const SKEL = "Meshes/Actors/Character/CharacterAssets/skeleton.nif";
const body = BODY.toLowerCase();
const skel = SKEL.toLowerCase();

const mods = [
  { compareKey: "k:body", files: [{ path: BODY, sha256: "b1" }, { path: "Body.esp", sha256: "e1" }] },
  { compareKey: "k:outfit", files: [{ path: BODY, sha256: "b2" }, { path: "Outfit.esp", sha256: "e2" }] },
  { compareKey: "k:zex", files: [{ path: SKEL, sha256: "s1" }] },
  { compareKey: "k:off", enabled: false, files: [{ path: "Solo.esp", sha256: "x" }, { path: SKEL, sha256: "s9" }] },
];
const manifest = (entries: Array<[string, string]>) => [
  { modType: "", entryCount: entries.length, files: entries.map(([relPath, source]) => ({ relPath: relPath.split("/").join("\\"), source })) },
];
const folders = new Map([
  ["k:body", "Body (EH)"],
  ["k:outfit", "Outfit (EH)"],
  ["k:zex", "ZeX"],
]);

describe("recording the curator's winners", () => {
  const folderToKey = new Map([
    ["body (eh)", "k:body"],
    ["outfit (eh)", "k:outfit"],
    ["zex", "k:zex"],
  ]);

  it("records only paths several ENABLED collection mods ship, under the one that won", () => {
    const winners = recordDeploymentWinners({
      mods,
      manifests: manifest([[BODY, "Body (EH)"], [SKEL, "ZeX"], ["Body.esp", "Body (EH)"]]),
      folderToKey,
    });
    // skeleton.nif: ZeX plus a DISABLED mod — not contested at deployment.
    expect(winners).toEqual([{ modType: "", mod: "k:body", paths: [body] }]);
  });

  it("does not record a winner that does not ship the path (a deployment older than the staging)", () => {
    const winners = recordDeploymentWinners({ mods, manifests: manifest([[BODY, "ZeX"]]), folderToKey });
    expect(winners).toEqual([]);
  });
});

describe("judging the player's deployment", () => {
  const winners = [{ modType: "", mod: "k:body", paths: [body] }];
  const judge = (entries: Array<[string, string]>, keyToFolder = folders, w = winners) =>
    judgeDeployment({ winners: w, mods, rules: [], manifests: manifest(entries), keyToFolder });

  it("is silent on a game that matches the creator's", () => {
    const r = judge([[BODY, "Body (EH)"], [SKEL, "ZeX"], ["Body.esp", "Body (EH)"], ["Outfit.esp", "Outfit (EH)"]]);
    expect(r.findings).toEqual([]);
    expect(r.judgedWinners).toBe(1);
  });

  it("catches THE incident: a mod outside the collection replacing a file only one collection mod ships", () => {
    // Ivy 1.0.38's skeleton.nif comes from ZeX alone, so no recorded winner
    // covers it; a leftover or a player's own mod is the only way to replace it.
    const r = judge([[BODY, "Body (EH)"], [SKEL, "Old XPMSE Rev6"]], folders, []);
    expect(r.findings).toEqual([
      { kind: "foreign", modType: "", path: skel, expected: "k:zex", actualFolder: "Old XPMSE Rev6" },
    ]);
  });

  it("names the other collection mod that won, and says whether the collection's rules decide it", () => {
    const r = judge([[BODY, "Outfit (EH)"]]);
    expect(r.findings).toEqual([
      { kind: "wrong-winner", modType: "", path: body, expected: "k:body", actualFolder: "Outfit (EH)", actualKey: "k:outfit", ruled: false },
    ]);
    const ruled = judgeDeployment({
      winners,
      mods,
      rules: [{ source: "k:body", type: "after", reference: "k:outfit" }] as never,
      manifests: manifest([[BODY, "Outfit (EH)"]]),
      keyToFolder: folders,
    });
    expect(ruled.findings[0]?.ruled).toBe(true);
  });

  it("drops a difference the game cannot see: both copies byte-identical", () => {
    const same = mods.map((m) => (m.compareKey === "k:outfit" ? { ...m, files: [{ path: BODY, sha256: "b1" }] } : m));
    const r = judgeDeployment({ winners, mods: same, rules: [], manifests: manifest([[BODY, "Outfit (EH)"]]), keyToFolder: folders });
    expect(r.findings).toEqual([]);
  });

  it("says when nothing is deployed there", () => {
    expect(judge([[SKEL, "ZeX"]]).findings.map((f) => f.kind)).toEqual(["not-deployed"]);
  });

  it("does not judge mods the player does not have, and reports a game Vortex never deployed", () => {
    expect(judge([[BODY, "Whatever"]], new Map()).findings).toEqual([]);
    const none = judgeDeployment({ winners, mods, rules: [], manifests: [], keyToFolder: folders });
    expect(none.undeployedTypes).toEqual([""]);
    expect(none.judgedPaths + none.judgedWinners).toBe(0);
  });

  it("groups one cause into one line", () => {
    const lines = describeDeployFindings(
      [
        { kind: "foreign", modType: "", path: "a.nif", expected: "k:zex", actualFolder: "Old" },
        { kind: "foreign", modType: "", path: "b.nif", expected: "k:zex", actualFolder: "Old" },
      ],
      (k) => (k === "k:zex" ? "ZeX" : k),
    );
    expect(lines).toEqual(['"Old" (not part of the collection) replaces 2 file(s) of "ZeX", e.g. a.nif, b.nif']);
  });
});

describe("the Doctor card", () => {
  it("is unknown when not checked, healthy when clean, drifted — with a fix only when rules decide", () => {
    expect(deployWinnersCheck(undefined).status).toBe("unknown");
    expect(deployWinnersCheck({ kind: "not-checked", why: "x" }).status).toBe("unknown");
    expect(
      deployWinnersCheck({ kind: "checked", judgedPaths: 10, judgedWinners: 2, findings: [], lines: [], fixable: false }).status,
    ).toBe("healthy");
    const finding = { kind: "foreign" as const, modType: "", path: "x", expected: "k" };
    const foreign = deployWinnersCheck({ kind: "checked", judgedPaths: 10, judgedWinners: 0, findings: [finding], lines: ["l"], fixable: false });
    expect(foreign.status).toBe("drifted");
    expect(foreign.heal).toBeUndefined();
    const fixable = deployWinnersCheck({ kind: "checked", judgedPaths: 10, judgedWinners: 2, findings: [finding], lines: ["l"], fixable: true });
    expect(fixable.heal?.action).toBe("redeploy-winners");
  });
});

describe("rules for pairs the collection leaves open (Ivy Rev 26, sudo_bluuuk 2026-10-25)", () => {
  // MTs-255 FPA Replacer and "Ivy - JNFA2026 Women Only" both ship
  // PersistantSubgraphInfoAndOffsetData.txt and no collection rule orders
  // them: the creator's game got JNFA's merged copy, a player FPA's.
  const wrong = (expected: string, actualKey: string, path: string, ruled = false): DeployFinding => ({
    kind: "wrong-winner", modType: "", path, expected, actualKey, actualFolder: actualKey, ruled,
  });
  const fpa = wrong("k:jnfa", "k:fpa", "meshes/animtextdata/persistantsubgraphinfoandoffsetdata.txt");

  it("makes the creator's winner deploy after the other mod, once per pair", () => {
    const plan = planWinnerPins({ findings: [fpa, { ...fpa, path: "b.txt" }], rules: [] });
    expect(plan.pins).toEqual([{ winner: "k:jnfa", loser: "k:fpa", files: 2 }]);
    expect(plan.skipped).toEqual([]);
  });

  it("leaves pairs the collection's rules decide to the rule re-apply", () => {
    expect(planWinnerPins({ findings: [wrong("k:jnfa", "k:fpa", "a", true)], rules: [] }).pins).toEqual([]);
  });

  it("never overrules the collection's own rule, the player's own rule, or a split pair", () => {
    const collection = planWinnerPins({ findings: [fpa], rules: [{ type: "after", source: "k:fpa", reference: "k:jnfa" }] });
    expect(collection.pins).toEqual([]);
    expect(collection.skipped[0]?.why).toMatch(/collection's own rules/);
    const player = planWinnerPins({ findings: [fpa], rules: [], playerOrdersLoserLast: (w, l) => w === "k:jnfa" && l === "k:fpa" });
    expect(player.pins).toEqual([]);
    expect(player.skipped[0]?.why).toMatch(/of your own/);
    const split = planWinnerPins({ findings: [fpa, wrong("k:fpa", "k:jnfa", "c.txt")], rules: [] });
    expect(split.pins).toEqual([]);
    expect(split.skipped).toHaveLength(2);
  });

  it("does not chain new rules into a cycle", () => {
    // a over b, b over c, then c over a would close the loop through the first two.
    const plan = planWinnerPins({
      findings: [wrong("k:a", "k:b", "1"), wrong("k:a", "k:b", "1b"), wrong("k:b", "k:c", "2"), wrong("k:c", "k:a", "3")],
      rules: [],
    });
    expect(plan.pins.map((p) => `${p.winner}>${p.loser}`)).toEqual(["k:a>k:b", "k:b>k:c"]);
    expect(plan.skipped.map((s) => s.winner)).toEqual(["k:c"]);
  });

  it("offers the repair on the card when only such pairs are wrong", () => {
    const card = deployWinnersCheck({ kind: "checked", judgedPaths: 10, judgedWinners: 2, findings: [fpa], lines: ["l"], fixable: false, pinnable: true });
    expect(card.heal?.action).toBe("redeploy-winners");
    expect(card.summary).not.toMatch(/order it yourself/);
  });
});

describe("the package field", () => {
  const fixture: Record<string, unknown> = {
    schemaVersion: 2,
    package: {
      id: "00000000-0000-4000-8000-000000000000",
      name: "t",
      version: "1.0.0",
      author: "a",
      createdAt: "2026-01-01T00:00:00.000Z",
      strictMissingMods: false,
    },
    game: { id: "fallout4", version: "1.11.240.0", versionPolicy: "exact" },
    vortex: { version: "2.7.2", deploymentMethod: "hardlink", requiredExtensions: [] },
    mods: [],
    rules: [],
    plugins: { order: [] },
    loadOrder: [],
    userlist: { plugins: [], groups: [] },
    iniTweaks: [],
    externalDependencies: [],
  };

  it("survives the parser with its paths normalised", () => {
    expect(parseManifest(JSON.stringify(fixture)).manifest.deployment).toBeUndefined();
    const winners = [{ modType: "", mod: "k", paths: ["Meshes/Sub/X.nif"] }];
    const parsed = parseManifest(JSON.stringify({ ...fixture, deployment: { winners } }));
    expect(parsed.manifest.deployment).toEqual({ winners: [{ modType: "", mod: "k", paths: ["meshes/sub/x.nif"] }] });
  });

  it("never refuses a package over it: malformed entries are dropped with a warning", () => {
    const parsed = parseManifest(
      JSON.stringify({ ...fixture, deployment: { winners: [{ mod: 1 }, { modType: "", mod: "k", paths: ["a"] }] } }),
    );
    expect(parsed.manifest.deployment?.winners).toHaveLength(1);
    expect(parsed.warnings.join(" ")).toMatch(/malformed/);
    expect(parseManifest(JSON.stringify({ ...fixture, deployment: {} })).manifest.deployment).toBeUndefined();
  });
});
