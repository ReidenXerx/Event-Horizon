/**
 * Ivy Rev 26 (sudo_bluuuk, 2026-10-25): four mods' staging folders had lost
 * PersistantSubgraphInfoAndOffsetData.txt, so the curator's game had no conflict
 * and JNFA's merged copy won alone. A player's install puts the file back from
 * each archive, nothing orders them, and a 368-line copy won.
 */
import { describe, expect, it } from "vitest";

import { describeArchiveRestoreConflicts, findArchiveRestoreConflicts, type RestoreConflictMod } from "./archiveRestoreConflicts";

const PSG = "Meshes/AnimTextData/AnimationOffsets/PersistantSubgraphInfoAndOffsetData.txt";

const jnfa: RestoreConflictMod = {
  compareKey: "k:jnfa",
  name: "Ivy - JNFA2026 Women Only",
  installsFromArchive: false,
  files: [{ path: PSG, size: 3804 * 40 }],
};
const fpa: RestoreConflictMod = {
  compareKey: "k:fpa",
  name: "MTs-255 FPA Replacer",
  installsFromArchive: true,
  files: [{ path: "Meshes/Actors/Character/x.hkx", size: 10 }],
};

describe("findArchiveRestoreConflicts", () => {
  it("names an archive that puts back a file the keeper's copy should win", () => {
    const conflicts = findArchiveRestoreConflicts({
      mods: [jnfa, fpa],
      // A plain archive, so the path carries its wrapper folder.
      restoresByKey: new Map([["k:fpa", [{ path: `00 Main/${PSG}`, size: 368 * 40, exact: false }]]]),
      rules: [],
    });
    expect(conflicts).toEqual([{ restorer: "k:fpa", keeper: "k:jnfa", paths: [PSG], restorerWins: false }]);
    const [line] = describeArchiveRestoreConflicts(conflicts, (k) => (k === "k:fpa" ? fpa.name : jnfa.name));
    expect(line).toMatch(/"MTs-255 FPA Replacer" puts back 1 file/);
    expect(line).toMatch(/Add a rule: "Ivy - JNFA2026 Women Only" loads after "MTs-255 FPA Replacer"/);
  });

  it("is quiet when a rule already keeps the curator's copy on top, or the bytes are the same size", () => {
    const restoresByKey = new Map([["k:fpa", [{ path: PSG, size: 368 * 40, exact: true }]]]);
    expect(
      findArchiveRestoreConflicts({ mods: [jnfa, fpa], restoresByKey, rules: [{ type: "after", source: "k:jnfa", reference: "k:fpa" }] }),
    ).toEqual([]);
    const same = new Map([["k:fpa", [{ path: PSG, size: 3804 * 40, exact: true }]]]);
    expect(findArchiveRestoreConflicts({ mods: [jnfa, fpa], restoresByKey: same, rules: [] })).toEqual([]);
  });

  it("says when the collection's own rule puts the restored copy on top", () => {
    const conflicts = findArchiveRestoreConflicts({
      mods: [jnfa, fpa],
      restoresByKey: new Map([["k:fpa", [{ path: PSG, size: 1, exact: true }]]]),
      rules: [{ type: "after", source: "k:fpa", reference: "k:jnfa" }],
    });
    expect(conflicts[0]?.restorerWins).toBe(true);
  });

  it("ignores mirrored or bundled mods, other mod types, and an exact path that only shares a tail", () => {
    const base = { mods: [jnfa, { ...fpa, installsFromArchive: false }], rules: [] };
    expect(findArchiveRestoreConflicts({ ...base, restoresByKey: new Map([["k:fpa", [{ path: PSG, size: 1, exact: true }]]]) })).toEqual([]);
    expect(
      findArchiveRestoreConflicts({
        mods: [jnfa, { ...fpa, modType: "dinput" }],
        restoresByKey: new Map([["k:fpa", [{ path: PSG, size: 1, exact: true }]]]),
        rules: [],
      }),
    ).toEqual([]);
    expect(
      findArchiveRestoreConflicts({
        mods: [jnfa, fpa],
        restoresByKey: new Map([["k:fpa", [{ path: `Optional/${PSG}`, size: 1, exact: true }]]]),
        rules: [],
      }),
    ).toEqual([]);
  });
});
