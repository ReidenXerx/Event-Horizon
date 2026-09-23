/**
 * The Creation Club note counts FILES a user has to own. The game does not care
 * about letter case in a plugin name, so two plugins spelling one master two
 * ways need one file — and a real build listed "ccOTMFO4001-Remnants.esl" and
 * "ccotmfo4001-remnants.esl" as two.
 */
import { describe, expect, it } from "vitest";

import { describeUserOwnedMasters, userOwnedMasterFiles } from "./checkMasters";

describe("userOwnedMasterFiles", () => {
  // What the manifest records for the install's check: one entry per file, so the player is not told to find
  // "ccotmfo4001-remnants.esl" twice, and sorted, so the same collection always writes the same manifest.
  it("lists each file once, spelled as its first plugin spells it, in a stable order", () => {
    const files = userOwnedMasterFiles({
      missing: [],
      userOwned: [
        { plugin: "a.esp", master: "ccQDRSSE001-SurvivalMode.esl" },
        { plugin: "b.esp", master: "ccOTMFO4001-Remnants.esl" },
        { plugin: "c.esp", master: "ccotmfo4001-remnants.esl " },
        { plugin: "d.esp", master: "_ResourcePack.esl" },
      ],
      unreadable: [],
      checked: 4,
    });
    expect(files).toEqual(["_ResourcePack.esl", "ccOTMFO4001-Remnants.esl", "ccQDRSSE001-SurvivalMode.esl"]);
  });
});

describe("describeUserOwnedMasters", () => {
  it("names each Creation Club file once, whatever case its plugins spell it in", () => {
    const [line] = describeUserOwnedMasters({
      missing: [],
      userOwned: [
        { plugin: "a.esp", master: "ccOTMFO4001-Remnants.esl" },
        { plugin: "b.esp", master: "ccotmfo4001-remnants.esl" },
        { plugin: "c.esp", master: "ccqdrfo4001_powerarmorai.esl" },
      ],
      unreadable: [],
      checked: 3,
    } as never);

    expect(line).toContain("depends on 2 Creation Club file(s)");
    expect(line).toContain("ccOTMFO4001-Remnants.esl, ccqdrfo4001_powerarmorai.esl.");
    expect(line).not.toContain("ccotmfo4001-remnants.esl");
  });

  it("says nothing when no plugin needs one", () => {
    expect(describeUserOwnedMasters({ missing: [], userOwned: [], unreadable: [], checked: 0 } as never)).toEqual([]);
  });
});
