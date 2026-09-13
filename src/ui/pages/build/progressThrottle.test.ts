/**
 * Build progress arrives once per file in the long phases, and each report was
 * its own screen update. These pin what reaches the screen instead: the first
 * report at once, then at most one per interval, always the newest, and a new
 * phase never held back — and that the build session actually routes its
 * progress through it.
 */
import * as fs from "fs";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PROGRESS_INTERVAL_MS, throttleProgress } from "./progressThrottle";

type Progress = { phase: string; done?: number };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const collect = (): { seen: Progress[]; emit: (p: Progress) => void } => {
  const seen: Progress[] = [];
  return { seen, emit: (p) => seen.push(p) };
};

describe("throttleProgress", () => {
  it("sends the first report at once", () => {
    const { seen, emit } = collect();
    throttleProgress(emit).push({ phase: "packaging", done: 1 });
    expect(seen).toEqual([{ phase: "packaging", done: 1 }]);
  });

  it("sends one report per interval, and the newest one when the interval ends", () => {
    const { seen, emit } = collect();
    const throttle = throttleProgress(emit);
    for (let done = 1; done <= 1000; done += 1) throttle.push({ phase: "packaging", done });
    expect(seen.map((p) => p.done)).toEqual([1]);

    vi.advanceTimersByTime(PROGRESS_INTERVAL_MS);
    expect(seen.map((p) => p.done)).toEqual([1, 1000]);
  });

  it("lets a report straight through once the interval has passed", () => {
    const { seen, emit } = collect();
    const throttle = throttleProgress(emit);
    throttle.push({ phase: "packaging", done: 1 });
    vi.advanceTimersByTime(PROGRESS_INTERVAL_MS + 1);
    throttle.push({ phase: "packaging", done: 2 });
    expect(seen.map((p) => p.done)).toEqual([1, 2]);
  });

  it("never holds back a report that starts a new phase, and drops the stale one it replaces", () => {
    const { seen, emit } = collect();
    const throttle = throttleProgress(emit);
    throttle.push({ phase: "hashing", done: 1 });
    throttle.push({ phase: "hashing", done: 2 });
    throttle.push({ phase: "packaging", done: 0 });
    expect(seen).toEqual([
      { phase: "hashing", done: 1 },
      { phase: "packaging", done: 0 },
    ]);

    vi.advanceTimersByTime(PROGRESS_INTERVAL_MS);
    expect(seen).toHaveLength(2);
  });

  it("sends nothing after cancel, not even the report it was holding", () => {
    const { seen, emit } = collect();
    const throttle = throttleProgress(emit);
    throttle.push({ phase: "packaging", done: 1 });
    throttle.push({ phase: "packaging", done: 2 });
    throttle.cancel();
    vi.advanceTimersByTime(PROGRESS_INTERVAL_MS);
    throttle.push({ phase: "packaging", done: 3 });
    expect(seen.map((p) => p.done)).toEqual([1]);
  });
});

describe("the build session", () => {
  it("routes both loading and building progress through a throttle, and stops it when the run ends", () => {
    // Read from source: the session drives Vortex state and a real build, and a
    // throttle it forgot to use would pass every test above.
    const source = fs.readFileSync(path.join(__dirname, "buildSession.ts"), "utf8");
    expect(source).toContain("onProgress: loadingProgress.push");
    expect(source).toContain(".finally(loadingProgress.cancel)");
    expect(source).toContain("onProgress: buildProgress.push");
    expect(source).toContain(".finally(buildProgress.cancel)");
  });
});
