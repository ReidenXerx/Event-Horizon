/**
 * The schedule the owner chose (poll, 2026-09-30): after Play launches only,
 * "Not now" backs off 3 / 7 / 14 / 30 days, a new revision brings it back
 * after 3, "Don't ask again" holds until the next revision, and endorsed
 * means never again.
 */
import { describe, expect, it } from "vitest";

import { DAY_MS, endorseDue, modsDue, nextEndorsePrompt, noteAsk, noteLaunch, type CollectionPlay } from "./endorsePrompts";

const T0 = Date.parse("2026-10-01T12:00:00.000Z");
const at = (days: number): string => new Date(T0 + days * DAY_MS).toISOString();
const facts = (revisionNumber = 5) => ({
  packageId: "pkg",
  packageName: "Meridia",
  slug: "abc123",
  gameDomain: "skyrimspecialedition",
  gameId: "skyrimse",
  collectionId: 1234,
  revisionNumber,
});
const launched = (times: number, rev = 5, startDay = 0): CollectionPlay => {
  let p: CollectionPlay | undefined;
  for (let i = 0; i < times; i++) p = noteLaunch(p, facts(rev), at(startDay + i * 0.01));
  return p!;
};

describe("when to ask about endorsing the collection", () => {
  it("not after one launch, yes after the second", () => {
    expect(endorseDue(launched(1), T0)).toBe(false);
    expect(endorseDue(launched(2), T0)).toBe(true);
  });

  it("'Not now' backs off 3, 7, 14, 30 days, then every 30", () => {
    let p = launched(2);
    const waits: number[] = [];
    let day = 0;
    for (let i = 0; i < 6; i++) {
      p = noteAsk(p, "endorse", "not-now", at(day));
      let wait = 1;
      while (!endorseDue(p, T0 + (day + wait) * DAY_MS)) wait++;
      waits.push(wait);
      day += wait;
    }
    expect(waits).toEqual([3, 7, 14, 30, 30, 30]);
  });

  it("a new revision brings it back after 3 days, however far the back-off had got", () => {
    let p = launched(2);
    for (let d = 0; d < 4; d++) p = noteAsk(p, "endorse", "not-now", at(d * 40));
    // Declined four times; the next wait would be 30 days.
    p = noteLaunch(p, facts(6), at(121));
    expect(endorseDue(p, T0 + 122 * DAY_MS)).toBe(false);
    expect(endorseDue(p, T0 + 124 * DAY_MS)).toBe(true);
  });

  it("'Don't ask again' holds until the curator publishes a new revision", () => {
    let p = noteAsk(launched(2), "endorse", "never", at(0));
    expect(endorseDue(p, T0 + 400 * DAY_MS)).toBe(false);
    p = noteLaunch(p, facts(5), at(10)); // same revision again
    expect(endorseDue(p, T0 + 400 * DAY_MS)).toBe(false);
    p = noteLaunch(p, facts(6), at(20)); // a new one
    expect(endorseDue(p, T0 + 24 * DAY_MS)).toBe(true);
  });

  it("never again once endorsed, new revisions included", () => {
    let p = noteAsk(launched(2), "endorse", "done", at(0));
    p = noteLaunch(p, facts(9), at(50));
    expect(endorseDue(p, T0 + 400 * DAY_MS)).toBe(false);
  });
});

describe("when to offer endorsing the collection's mods", () => {
  it("from the third launch, only while some are left, on a slower clock", () => {
    expect(modsDue(launched(2), 10, T0)).toBe(false);
    expect(modsDue(launched(3), 0, T0)).toBe(false);
    const p = noteAsk(launched(3), "mods", "not-now", at(0));
    expect(modsDue(p, 10, T0 + 6 * DAY_MS)).toBe(false);
    expect(modsDue(p, 10, T0 + 7 * DAY_MS)).toBe(true);
  });
});

describe("one question per visit", () => {
  it("the collection before its mods, the most recently played first", () => {
    const a = launched(3, 5, 0);
    const b = { ...launched(3, 5, 1), packageId: "other" };
    const next = nextEndorsePrompt([a, b], () => 4, T0 + 2 * DAY_MS);
    expect(next).toMatchObject({ kind: "endorse", play: { packageId: "other" } });
    const bothEndorsed = [noteAsk(a, "endorse", "done", at(0)), noteAsk(b, "endorse", "done", at(0))];
    expect(nextEndorsePrompt(bothEndorsed, (id) => (id === "pkg" ? 4 : 0), T0 + 30 * DAY_MS)).toMatchObject({
      kind: "mods",
      play: { packageId: "pkg" },
      count: 4,
    });
  });
});

describe("recording a launch", () => {
  it("counts every launch and keeps the newest revision", () => {
    let p = noteLaunch(undefined, facts(5), at(0));
    p = noteLaunch(p, facts(6), at(1));
    p = noteLaunch(p, facts(5), at(2)); // an older profile launched later
    expect(p).toMatchObject({ launches: 3, revisionNumber: 6, revisionSeenAt: at(1), lastPlayedAt: at(2) });
  });
});
