/**
 * Ivy Rev 26 on Linux (sudo_bluuuk, 2026-10-25): Data held 9 folder pairs that
 * differ only in case (characterassets/CharacterAssets, gal/Gal, …). Under Wine
 * the game saw one of each and 163 deployed files were invisible to it.
 */
import { describe, expect, it } from "vitest";

import { decideFolderCase } from "./environmentChecks";
import { findCaseSplitFolders, type GameFolderScan } from "./gameFolderScan";

const files = (...paths: string[]) => paths.map((path) => ({ path }));

describe("findCaseSplitFolders", () => {
  it("finds sibling folders that differ only in case, with the files under each", () => {
    const splits = findCaseSplitFolders(
      files(
        "Data/Meshes/Actors/Character/CharacterAssets/FaceGenMorphs.tri",
        "Data/Meshes/Actors/Character/characterassets/eyelashes.tri",
        "Data/Meshes/Actors/Character/characterassets/x.nif",
        "Data/Meshes/gal/a.nif",
        "Data/Meshes/Gal/b.nif",
        "Data/Meshes/Gal/c.nif",
        "Data/Textures/one.dds",
      ),
    );
    expect(splits).toEqual([
      {
        parent: "Data/Meshes",
        spellings: [
          { name: "Gal", files: 2 },
          { name: "gal", files: 1 },
        ],
      },
      {
        parent: "Data/Meshes/Actors/Character",
        spellings: [
          { name: "characterassets", files: 2 },
          { name: "CharacterAssets", files: 1 },
        ],
      },
    ].sort((a, b) => (a.parent < b.parent ? -1 : 1)));
  });

  it("reports only the topmost split of a branch, and nothing for a file named like a folder", () => {
    const splits = findCaseSplitFolders(files("Data/Meshes/a/x.nif", "Data/meshes/a/y.nif", "Data/Meshes/A.nif"));
    expect(splits).toEqual([{ parent: "Data", spellings: [{ name: "Meshes", files: 2 }, { name: "meshes", files: 1 }] }]);
  });

  it("finds nothing in a folder with one spelling per name", () => {
    expect(findCaseSplitFolders(files("Data/Meshes/a.nif", "Data/Meshes/B/b.nif", "Fallout4.exe"))).toEqual([]);
  });
});

describe("decideFolderCase", () => {
  const scan = (caseSplits?: GameFolderScan["caseSplits"]) => ({ caseSplits }) as unknown as GameFolderScan;

  it("warns with each pair and how many files the game can miss", () => {
    const c = decideFolderCase({
      gameName: "Fallout 4",
      scan: scan([{ parent: "Data/Meshes", spellings: [{ name: "Gal", files: 115 }, { name: "gal", files: 48 }] }]),
    });
    expect(c.status).toBe("warning");
    expect(c.title).toMatch(/up to 48 files/);
    expect(c.lines[0]).toBe("Data/Meshes/Gal (115 files) and Data/Meshes/gal (48 files)");
    expect(c.steps.join(" ")).toMatch(/move the files of the smaller folder/);
  });

  it("is ok with no splits and unknown for an old scan", () => {
    expect(decideFolderCase({ gameName: "Fallout 4", scan: scan([]) }).status).toBe("ok");
    expect(decideFolderCase({ gameName: "Fallout 4", scan: scan(undefined) }).status).toBe("unknown");
  });
});
