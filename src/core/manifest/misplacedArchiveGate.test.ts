/**
 * The case that made this a refusal: Meridia's grass cache, installed one
 * folder deep for every player from 1.0.17 to 1.0.23.
 */
import { describe, expect, it } from "vitest";

import { misplacedArchiveRefusal, type MisplacedArchiveMod } from "./misplacedArchiveGate";

const grass = (over: Partial<MisplacedArchiveMod> = {}): MisplacedArchiveMod => ({
  id: "Grass_Cache_Default_LOD",
  name: "Grass_Cache_Default_LOD",
  misplaced: {
    count: 9087,
    under: "Grass_Cache_Default/Data/",
    example: {
      staged: "Grass/AlftandWorldx-001y-001.cgid",
      installed: "Grass_Cache_Default/Data/Grass/AlftandWorldx-001y-001.cgid",
    },
  },
  bundled: false,
  mirrored: false,
  ...over,
});

describe("misplacedArchiveRefusal", () => {
  it("refuses a mod that would land where the game never reads, and says where and how to fix it", () => {
    const refusal = misplacedArchiveRefusal([grass()])!;
    expect(refusal.code).toBe("external-misplaced");
    expect(refusal.mods).toEqual([{ id: "Grass_Cache_Default_LOD", name: "Grass_Cache_Default_LOD" }]);
    expect(refusal.message).toMatch(/1 external mod would install into a folder the game never reads/);
    expect(refusal.message).toMatch(/9087 files inside "Grass_Cache_Default\/Data\/"/);
    expect(refusal.message).toMatch(
      /players get Grass_Cache_Default\/Data\/Grass\/AlftandWorldx-001y-001\.cgid where you have Grass\/AlftandWorldx-001y-001\.cgid/,
    );
    // All three ways out, the preferred one first.
    expect(refusal.message).toMatch(/re-pack the archive with your staging folder's layout at its root/);
    expect(refusal.message).toMatch(/"mirror"/);
    expect(refusal.message).toMatch(/"Bundle"/);
  });

  it("is one paragraph — the span above the Build button has no pre-line", () => {
    expect(misplacedArchiveRefusal([grass(), grass({ id: "b", name: "B" })])!.message).not.toMatch(/\n/);
  });

  it("lets a bundled or mirrored mod through: both ship the curator's own layout", () => {
    expect(misplacedArchiveRefusal([grass({ bundled: true })])).toBeUndefined();
    expect(misplacedArchiveRefusal([grass({ mirrored: true })])).toBeUndefined();
    expect(misplacedArchiveRefusal([])).toBeUndefined();
  });

  it("names five and counts the rest", () => {
    const many = Array.from({ length: 7 }, (_v, i) => grass({ id: `m${i}`, name: `Mod ${i}` }));
    const refusal = misplacedArchiveRefusal(many)!;
    expect(refusal.mods).toHaveLength(7);
    expect(refusal.message).toMatch(/^7 external mods would install/);
    expect(refusal.message).toMatch(/"Mod 4"/);
    expect(refusal.message).not.toMatch(/"Mod 5"/);
    expect(refusal.message).toMatch(/; and 2 more\./);
  });
});
