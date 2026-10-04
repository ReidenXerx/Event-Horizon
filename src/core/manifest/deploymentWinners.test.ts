/**
 * Which mod's copy of each contested file the game gets — recorded from the
 * curator's deployment, judged on the player's. Built after an Ivy updated
 * through several revisions gave every new character "nailed" breasts that a
 * fresh install did not (alasdairn, 2026-10-04), with every mod's files intact.
 */
import { describe, expect, it } from "vitest";

import { judgeDeploymentWinners, recordDeploymentWinners } from "./deploymentWinners";
import { deployWinnersCheck } from "../doctor/health";
import { parseManifest } from "./parseManifest";

const body = "Meshes\\Actors\\Character\\CharacterAssets\\FemaleBody.nif";
const mods = [
  { compareKey: "k:body", stagingPaths: [body, "Body.esp"] },
  { compareKey: "k:outfit", stagingPaths: [body, "Outfit.esp"] },
  { compareKey: "k:solo", stagingPaths: ["Solo.esp"] },
];
const deployed = (winner: string) => [
  {
    modType: "",
    entryCount: 3,
    files: [
      { relPath: body, source: winner },
      { relPath: "Body.esp", source: "Body Folder" },
      { relPath: "Solo.esp", source: "Solo Folder" },
    ],
  },
];

describe("recording the curator's winners", () => {
  it("records only contested paths, under the collection mod that won them", () => {
    const winners = recordDeploymentWinners({
      mods,
      manifests: deployed("Body Folder"),
      folderToKey: new Map([
        ["body folder", "k:body"],
        ["outfit folder", "k:outfit"],
        ["solo folder", "k:solo"],
      ]),
    });
    expect(winners).toEqual([
      { modType: "", mod: "k:body", paths: ["meshes/actors/character/characterassets/femalebody.nif"] },
    ]);
  });

  it("skips a path whose curator winner is not a collection mod", () => {
    const winners = recordDeploymentWinners({
      mods,
      manifests: deployed("Curator Private Mod"),
      folderToKey: new Map([["body folder", "k:body"]]),
    });
    expect(winners).toEqual([]);
  });
});

describe("judging the player's deployment", () => {
  const winners = [{ modType: "", mod: "k:body", paths: ["meshes/actors/character/characterassets/femalebody.nif"] }];
  const keyToFolder = new Map([["k:body", "Body (EH)"]]);

  it("is silent when the same mod won", () => {
    expect(judgeDeploymentWinners({ winners, manifests: deployed("body (eh)"), keyToFolder })).toEqual([]);
  });

  it("names the mod that won instead", () => {
    expect(judgeDeploymentWinners({ winners, manifests: deployed("Old Outfit Rev7"), keyToFolder })).toEqual([
      { modType: "", path: "meshes/actors/character/characterassets/femalebody.nif", expected: "k:body", actual: "Old Outfit Rev7" },
    ]);
  });

  it("says when nothing was deployed there", () => {
    const empty = [{ modType: "", entryCount: 0, files: [] }];
    expect(judgeDeploymentWinners({ winners, manifests: empty, keyToFolder })[0]?.actual).toBeUndefined();
  });

  it("does not judge a winner the player does not have (the install reports the missing mod)", () => {
    expect(judgeDeploymentWinners({ winners, manifests: deployed("x"), keyToFolder: new Map() })).toEqual([]);
  });
});

describe("the Doctor card", () => {
  it("is unknown without a record, healthy when all match, drifted with a fix otherwise", () => {
    expect(deployWinnersCheck(undefined).status).toBe("not-applicable");
    expect(deployWinnersCheck({ recorded: 5178, findings: [] }).status).toBe("healthy");
    const drifted = deployWinnersCheck({
      recorded: 5178,
      findings: [{ path: "meshes/x.nif", expected: "Anatomy Body", actual: "Old Outfit" }],
    });
    expect(drifted.status).toBe("drifted");
    expect(drifted.detail[0]).toBe("meshes/x.nif — from Old Outfit, should come from Anatomy Body");
    expect(drifted.heal?.action).toBe("redeploy-winners");
  });
});

describe("the package field", () => {
  it("survives the parser, and a malformed entry is refused rather than guessed", () => {
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
    expect(parseManifest(JSON.stringify(fixture)).manifest.deployment).toBeUndefined();
    const winners = [{ modType: "", mod: "k:body", paths: ["meshes/x.nif"] }];
    const ok = parseManifest(JSON.stringify({ ...fixture, deployment: { winners } }));
    expect(ok.manifest.deployment).toEqual({ winners });
    expect(() => parseManifest(JSON.stringify({ ...fixture, deployment: { winners: [{ mod: 1 }] } }))).toThrow();
  });
});
