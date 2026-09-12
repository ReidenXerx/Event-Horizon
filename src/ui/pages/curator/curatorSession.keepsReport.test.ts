/**
 * The curator session keeps the requirements report through every run.
 *
 * `begin` and `finish` rebuilt the snapshot from an object literal, and the
 * requirements report was not in it. "Read requirements" stored its result
 * with `setRequirements` and then called `finish`, which threw it away: the
 * count reached the note ("411 mod(s) are missing something") while the
 * table, the chips, the Requires column and the Plugins view's headers never
 * saw a report at all. The render harness sets the snapshot directly, so it
 * could not show this.
 */
import { describe, expect, it } from "vitest";

import { getCuratorSession, type RequirementsCache } from "./curatorSession";

const cache = { gameId: "skyrimse", fetchedAt: 1, load: { report: { byMod: new Map() } } } as unknown as RequirementsCache;

describe("curator session keeps the requirements report", () => {
  it("through the run that read it", () => {
    const session = getCuratorSession();
    expect(session.begin("requirements", { keepReport: true })).toBeDefined();
    session.setRequirements(cache);
    session.finish(undefined, "Read requirements: 411 mod(s) are missing something");
    const snap = session.getSnapshot();
    expect(snap.requirements).toBe(cache);
    expect(snap.busy).toBeUndefined();
    expect(snap.note).toMatch(/411/);
  });

  it("through every later run, resetting only the run's own fields", () => {
    const session = getCuratorSession();
    session.setRequirements(cache);
    expect(session.begin("update")).toBeDefined();
    session.progress("Updating 1 of 3");
    expect(session.getSnapshot().requirements).toBe(cache);
    session.finish(["a line"]);
    const snap = session.getSnapshot();
    expect(snap.requirements).toBe(cache);
    expect(snap.progress).toBeUndefined();
    expect(snap.lines).toEqual(["a line"]);
    expect(session.begin("refresh")).toBeDefined();
    expect(session.getSnapshot().note).toBeUndefined();
    expect(session.getSnapshot().requirements).toBe(cache);
    session.finish(undefined);
  });
});
