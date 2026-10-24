/**
 * Ivy Rev 26 (sudo_bluuuk, 2026-10-25): four mods' staging folders had lost
 * PersistantSubgraphInfoAndOffsetData.txt, so the curator's game had no conflict
 * and JNFA's merged copy won alone. A player's install puts the file back from
 * each archive, nothing orders them, and a 368-line copy won.
 */
import { describe, expect, it } from "vitest";

import {
  describeArchiveRestoreConflicts,
  findArchiveRestoreConflicts,
  tailMatches,
  type RestoreConflictMod,
} from "./archiveRestoreConflicts";

const PSG = "Meshes/AnimTextData/AnimationOffsets/PersistantSubgraphInfoAndOffsetData.txt";
const psg = PSG.toLowerCase();

const mod = (compareKey: string, name: string, files: Array<{ path: string; size?: number }>, installsFromArchive = false): RestoreConflictMod => ({
  compareKey,
  name,
  installsFromArchive,
  files,
});
const jnfa = mod("k:jnfa", "Ivy - JNFA2026 Women Only", [{ path: PSG, size: 3804 * 40 }]);
const fpa = mod("k:fpa", "MTs-255 FPA Replacer", [{ path: "Meshes/Actors/Character/x.hkx", size: 10 }], true);
const names: Record<string, string> = { "k:jnfa": jnfa.name, "k:fpa": fpa.name };

describe("findArchiveRestoreConflicts", () => {
  it("names an archive that puts back a file the curator's copy should win (Rev 26)", () => {
    const conflicts = findArchiveRestoreConflicts({
      mods: [jnfa, fpa],
      restoresByKey: new Map([["k:fpa", [{ path: `00 Main/${PSG}`, size: 368 * 40, exact: false }]]]),
      rules: [],
    });
    expect(conflicts).toEqual([{ restorer: "k:fpa", keeper: "k:jnfa", paths: [PSG], restorerWins: false, maybe: false }]);
    const [line] = describeArchiveRestoreConflicts(conflicts, (k) => names[k] ?? k);
    expect(line).toMatch(/"MTs-255 FPA Replacer" puts back 1 file/);
    expect(line).toMatch(/Add a rule: "Ivy - JNFA2026 Women Only" loads after "MTs-255 FPA Replacer"/);
  });

  it("judges only the copy the curator's game uses, beaten through a chain (Ivy 1.0.57: 12 false warnings)", () => {
    // Knife Anims also stages the path and loses it; JNFA wins it and the
    // rules put JNFA after both. What FPA replaces among the losers never
    // reaches the game.
    const knife = mod("k:knife", "Knife Anims", [{ path: PSG, size: 500 }]);
    const conflicts = findArchiveRestoreConflicts({
      mods: [jnfa, knife, fpa],
      restoresByKey: new Map([["k:fpa", [{ path: PSG, size: 368 * 40, exact: true }]]]),
      rules: [
        { type: "after", source: "k:jnfa", reference: "k:knife" },
        { type: "after", source: "k:knife", reference: "k:fpa" },
      ],
      winners: [{ modType: "", mod: "k:jnfa", paths: [psg] }],
    });
    expect(conflicts).toEqual([]);
  });

  it("still warns when the live winner does not beat the restorer, even if a loser does", () => {
    const knife = mod("k:knife", "Knife Anims", [{ path: PSG, size: 500 }]);
    const conflicts = findArchiveRestoreConflicts({
      mods: [jnfa, knife, fpa],
      restoresByKey: new Map([["k:fpa", [{ path: PSG, size: 368 * 40, exact: true }]]]),
      rules: [{ type: "after", source: "k:knife", reference: "k:fpa" }],
      winners: [{ modType: "", mod: "k:jnfa", paths: [psg] }],
    });
    expect(conflicts.map((c) => c.keeper)).toEqual(["k:jnfa"]);
  });

  it("never drops a Data folder to make a tail match (Knife Anims staged at Data\\AnimTextData)", () => {
    expect(tailMatches(`00 main/${psg}`, psg)).toBe(true);
    expect(tailMatches(`00 main/${psg}`, "animtextdata/animationoffsets/persistantsubgraphinfoandoffsetdata.txt")).toBe(false);
    const knifeRoot = mod("k:knife", "Knife Anims", [{ path: "AnimTextData/AnimationOffsets/PersistantSubgraphInfoAndOffsetData.txt", size: 500 }]);
    expect(
      findArchiveRestoreConflicts({
        mods: [knifeRoot, fpa],
        restoresByKey: new Map([["k:fpa", [{ path: `00 Main/${PSG}`, size: 368 * 40, exact: false }]]]),
        rules: [],
      }),
    ).toEqual([]);
  });

  it("is quiet when a rule keeps the curator's copy on top, or the bytes are the same size", () => {
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

  it("words a restore from an unreplayable installer as a possibility (ZaZOut4)", () => {
    const zaz = mod("k:zaz", "ZaZOut4", [{ path: "Meshes/z.nif", size: 1 }], true);
    const conflicts = findArchiveRestoreConflicts({
      mods: [jnfa, zaz],
      restoresByKey: new Map([["k:zaz", [{ path: `00 Base/${PSG}`, size: 368 * 40, exact: false, maybe: true }]]]),
      rules: [],
    });
    expect(conflicts[0]?.maybe).toBe(true);
    const [line] = describeArchiveRestoreConflicts(conflicts, (k) => (k === "k:zaz" ? "ZaZOut4" : jnfa.name));
    expect(line).toMatch(/"ZaZOut4" may put back 1 file/);
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
