import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { assessWipe, loadSnapshot, snapshotPath, worthSaving, type PluginSnapshot } from "./pluginWipeGuard";

const snap = (active: number, entries: number): PluginSnapshot => ({
  profileId: "S1xCt4Cbj1x",
  gameId: "fallout4",
  savedAt: "2026-09-26T18:00:00.000Z",
  active,
  entries: Array.from({ length: entries }, (_, i) => ({ name: `p${i}.esp`, enabled: i < active, loadOrder: i })),
});

describe("assessWipe", () => {
  it("calls the owner's case a collapse: 807 entries kept, none active", () => {
    expect(assessWipe(snap(806, 807), 807, 0)).toEqual({ kind: "collapsed", before: 806, now: 0 });
  });

  it("calls the AE profile's 12 of ~800 a collapse too", () => {
    expect(assessWipe(snap(800, 810), 810, 12)).toMatchObject({ kind: "collapsed", now: 12 });
  });

  it("does not judge a list that lost most of its entries: that is a switch or reload in flight", () => {
    expect(assessWipe(snap(806, 807), 30, 0)).toEqual({ kind: "unsettled" });
  });

  it("leaves ordinary changes alone, and tiny profiles out of it", () => {
    expect(assessWipe(snap(806, 807), 807, 700)).toEqual({ kind: "ok" });
    expect(assessWipe(snap(10, 12), 12, 0)).toEqual({ kind: "ok" });
    expect(assessWipe(undefined, 807, 0)).toEqual({ kind: "ok" });
  });
});

describe("worthSaving", () => {
  it("never makes a wiped list the baseline, so Restore cannot restore the wipe", () => {
    expect(worthSaving(807, 0)).toBe(false);
    expect(worthSaving(807, 12)).toBe(false);
  });

  it("saves an ordinary list", () => {
    expect(worthSaving(807, 806)).toBe(true);
    expect(worthSaving(5, 2)).toBe(true);
  });
});

describe("snapshots on disk", () => {
  it("names the file after the profile, safely, and reads it back", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eh-snap-"));
    const file = snapshotPath("a/b:c", root);
    expect(path.basename(file)).toBe("a_b_c.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(snap(3, 4)));
    expect(loadSnapshot("a/b:c", root)?.active).toBe(3);
    expect(loadSnapshot("missing", root)).toBeUndefined();
  });
});
