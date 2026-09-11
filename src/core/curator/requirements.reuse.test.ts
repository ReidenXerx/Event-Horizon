import { describe, expect, it } from "vitest";

import { reusableAnswers, type NexusModRequirements } from "./requirements";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const t0 = Date.UTC(2026, 8, 1);
const raw = (n: number): Partial<NexusModRequirements> => ({ nexusRequirements: { totalCount: n, nodes: [] } });

describe("reusableAnswers", () => {
  it("reuses an answer only within the window of ITS OWN fetch, and only for a mod still asked about", () => {
    const out = reusableAnswers({
      fetched: new Map([
        ["old", raw(1)],
        ["recent", raw(2)],
        ["removed", raw(3)],
      ]),
      fetchedAt: new Map([
        ["old", t0],
        ["recent", t0 + 23 * HOUR],
        ["removed", t0 + 23 * HOUR],
      ]),
      wanted: new Set(["old", "recent", "new"]),
      now: t0 + 25 * HOUR,
      maxAgeMs: DAY,
    });
    expect([...out.keys()]).toEqual(["recent"]);
    expect(out.get("recent")).toEqual({ raw: raw(2), fetchedAt: t0 + 23 * HOUR });
  });

  it("keeps a reused answer's age: reading again later does not make it fresh", () => {
    const first = reusableAnswers({
      fetched: new Map([["a", raw(1)]]),
      fetchedAt: new Map([["a", t0]]),
      wanted: new Set(["a"]),
      now: t0 + 20 * HOUR,
      maxAgeMs: DAY,
    });
    expect(first.get("a")?.fetchedAt).toBe(t0);
    // The next incremental read builds on what the last one kept.
    const second = reusableAnswers({
      fetched: new Map([...first].map(([uid, v]) => [uid, v.raw])),
      fetchedAt: new Map([...first].map(([uid, v]) => [uid, v.fetchedAt])),
      wanted: new Set(["a"]),
      now: t0 + 25 * HOUR,
      maxAgeMs: DAY,
    });
    expect(second.size).toBe(0);
  });

  it("never reuses an answer whose fetch time was not recorded", () => {
    const out = reusableAnswers({
      fetched: new Map([["a", raw(1)]]),
      fetchedAt: new Map(),
      wanted: new Set(["a"]),
      now: t0,
      maxAgeMs: DAY,
    });
    expect(out.size).toBe(0);
  });
});
