import { describe, expect, it } from "vitest";

import {
  OVERSCAN,
  computeRowWindow,
  placeRowWindow,
  recordRowHeights,
  type RowPlacement,
  type RowWindow,
} from "./rowWindow";

/** DataTable's guess before any row has been measured. */
const GUESS = 42;
/**
 * React throws "Maximum update depth exceeded" past 50 nested updates from
 * a layout effect. One pass renders, one learns the rows it drew, one
 * confirms; the fourth is room for one re-placement when the kept window
 * stopped covering. Recording heights without holding the estimate took
 * up to 24 on these sequences — measured — which is one slow list away
 * from the error boundary.
 */
const PASS_BUDGET = 4;

type Settled = {
  span: RowWindow;
  passes: number;
  heights: ReadonlyMap<string, number>;
  placement: RowPlacement;
};

/**
 * DataTable's render → layout effect → setState cycle, against a browser
 * that lays every row out at its true height. `prior` is the component's
 * placement ref, carried across passes and across scroll positions exactly
 * as the component carries it. Undefined when the cycle never settles,
 * which in React is the error boundary.
 */
function settle(input: {
  ids: readonly string[];
  trueHeight: (id: string) => number;
  scrollTop: number;
  viewport: number;
  heights?: ReadonlyMap<string, number>;
  prior?: RowPlacement;
}): Settled | undefined {
  let heights = input.heights ?? new Map<string, number>();
  let prior = input.prior;
  for (let pass = 1; pass <= 60; pass += 1) {
    const { span, placement } = placeRowWindow({
      ids: input.ids,
      heights,
      scrollTop: input.scrollTop,
      viewport: input.viewport,
      fallback: GUESS,
      prior,
    });
    prior = placement;
    const measured = input.ids
      .slice(span.start, span.end)
      .map((id) => [id, input.trueHeight(id)] as const);
    const next = recordRowHeights(heights, measured);
    if (next === undefined) return { span, passes: pass, heights, placement };
    heights = next;
  }
  return undefined;
}

/**
 * Where the browser actually puts each rendered row: under the top spacer,
 * stacked at their real heights. Not where the arithmetic hopes they are.
 */
function laidOut(
  ids: readonly string[],
  span: RowWindow,
  trueHeight: (id: string) => number,
): { id: string; top: number; bottom: number }[] {
  const out: { id: string; top: number; bottom: number }[] = [];
  let y = span.topSpace;
  for (let i = span.start; i < span.end; i += 1) {
    const h = trueHeight(ids[i]!);
    out.push({ id: ids[i]!, top: y, bottom: y + h });
    y += h;
  }
  return out;
}

/** The row the arithmetic says is at content offset `y`. */
function rowAt(
  ids: readonly string[],
  heights: ReadonlyMap<string, number>,
  estimate: number,
  y: number,
): string | undefined {
  let top = 0;
  for (const id of ids) {
    const h = heights.get(id) ?? estimate;
    if (y >= top && y < top + h) return id;
    top += h;
  }
  return undefined;
}

/** Deterministic, so a failure names a sequence that can be replayed. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const NATIVE = 38.8;
const ORDINARY = 50;

function sequence(name: string, count: number, heightOf: (i: number) => number) {
  const ids = Array.from({ length: count }, (_, i) => `${name}-${i}`);
  const table = new Map(ids.map((id, i) => [id, heightOf(i)]));
  const trueHeight = (id: string): number => table.get(id)!;
  const end = ids.reduce((sum, id) => sum + trueHeight(id), 0);
  return { name, ids, trueHeight, end };
}

const rand = seeded(20260911);
const randomHeights = Array.from({ length: 600 }, () => (rand() < 0.3 ? NATIVE : ORDINARY));
const rand2 = seeded(7);
const wildHeights = Array.from({ length: 600 }, () => 20 + Math.floor(rand2() * 180));

const SEQUENCES = [
  // The curator's Plugins view: natives without buttons, the rest with.
  sequence("alternating", 400, (i) => (i % 2 === 0 ? NATIVE : ORDINARY)),
  sequence("natives-first", 400, (i) => (i < 6 ? NATIVE : ORDINARY)),
  sequence("random-mix", 600, (i) => randomHeights[i]!),
  // Runs long enough that a whole window is one height and the next is the other.
  sequence("blocks", 600, (i) => (Math.floor(i / 30) % 2 === 0 ? NATIVE : ORDINARY)),
  // Far outside anything a nowrap table produces, so the bound is not luck.
  sequence("bimodal-blocks", 600, (i) => (Math.floor(i / 30) % 2 === 0 ? 20 : 200)),
  sequence("wild", 600, (i) => wildHeights[i]!),
];

const VIEWPORT = 420;

describe("computeRowWindow", () => {
  it("renders nothing for an empty list", () => {
    const w = computeRowWindow({ ids: [], heights: new Map(), estimate: GUESS, scrollTop: 500, viewport: 420 });
    expect(w).toEqual({ start: 0, end: 0, topSpace: 0, bottomSpace: 0, totalHeight: 0 });
  });

  it("clamps a scroll position past the end of a list a filter just shortened", () => {
    const ids = Array.from({ length: 30 }, (_, i) => `r${i}`);
    const w = computeRowWindow({ ids, heights: new Map(), estimate: 40, scrollTop: 76_000, viewport: 400 });
    // The last rows are rendered, not an empty band past the end.
    expect(w.end).toBe(30);
    expect(w.start).toBeLessThan(20);
    expect(w.topSpace + (w.end - w.start) * 40 + w.bottomSpace).toBe(1200);
  });

  it("places rows at the sum of the recorded heights above them", () => {
    const ids = ["a", "b", "c", "d"];
    const heights = new Map([["a", 10], ["b", 30], ["c", 20]]);
    const all = computeRowWindow({ ids, heights, estimate: 25, scrollTop: 0, viewport: 1000, overscan: 0 });
    expect(all).toEqual({ start: 0, end: 4, topSpace: 0, bottomSpace: 0, totalHeight: 85 });
    // 45 is inside c (40..60), and so is the viewport's bottom edge at 55.
    const c = computeRowWindow({ ids, heights, estimate: 25, scrollTop: 45, viewport: 10, overscan: 0 });
    expect(c).toMatchObject({ start: 2, end: 3, topSpace: 40, bottomSpace: 25 });
  });
});

describe("recordRowHeights", () => {
  it("returns undefined when nothing moved, so the caller does not set state", () => {
    const heights = new Map([["a", 50]]);
    expect(recordRowHeights(heights, [["a", 50.3]])).toBeUndefined();
    expect(recordRowHeights(heights, [["b", 0]])).toBeUndefined();
  });

  it("learns new rows and real changes without mutating the old record", () => {
    const heights = new Map([["a", 50]]);
    const next = recordRowHeights(heights, [["a", 38.8], ["b", 50]]);
    expect(next).toEqual(new Map([["a", 38.8], ["b", 50]]));
    expect(heights).toEqual(new Map([["a", 50]]));
  });
});

describe("placeRowWindow", () => {
  it("re-estimates for a new scroll position, and holds the estimate while one settles", () => {
    const ids = ["a", "b", "c"];
    const first = placeRowWindow({ ids, heights: new Map(), scrollTop: 0, viewport: 100, fallback: GUESS });
    expect(first.placement.estimate).toBe(GUESS);
    const learned = new Map([["a", 50]]);
    const same = placeRowWindow({ ids, heights: learned, scrollTop: 0, viewport: 100, fallback: GUESS, prior: first.placement });
    expect(same.placement.estimate).toBe(GUESS);
    const moved = placeRowWindow({ ids, heights: learned, scrollTop: 5, viewport: 100, fallback: GUESS, prior: same.placement });
    expect(moved.placement.estimate).toBe(50);
    // A list with the same ids in a new array is the same list.
    const copy = placeRowWindow({ ids: [...ids], heights: learned, scrollTop: 5, viewport: 100, fallback: GUESS, prior: moved.placement });
    expect(copy.placement.estimate).toBe(50);
  });
});

describe("the rendered window converges for any sequence of row heights", () => {
  // The positions the review reproduced the loop at, plus a sweep.
  const REPORTED = [700, 760, 800, 3800];

  for (const seq of SEQUENCES) {
    it(`${seq.name}: every scroll position settles, from a fresh mount and after a thumb-drag jump`, () => {
      const positions = [...REPORTED];
      for (let y = 0; y <= seq.end; y += 20) positions.push(y);
      // A thumb drag lands deep in the list knowing only the rows at the top.
      const top = settle({ ids: seq.ids, trueHeight: seq.trueHeight, scrollTop: 0, viewport: VIEWPORT })!;

      const over: string[] = [];
      for (const scrollTop of positions) {
        const fresh = settle({ ids: seq.ids, trueHeight: seq.trueHeight, scrollTop, viewport: VIEWPORT });
        const jump = settle({
          ids: seq.ids,
          trueHeight: seq.trueHeight,
          scrollTop,
          viewport: VIEWPORT,
          heights: top.heights,
          prior: top.placement,
        });
        if (fresh === undefined || fresh.passes > PASS_BUDGET) {
          over.push(`fresh@${scrollTop}: ${fresh?.passes ?? "never"}`);
        }
        if (jump === undefined || jump.passes > PASS_BUDGET) {
          over.push(`jump@${scrollTop}: ${jump?.passes ?? "never"}`);
        }
      }
      expect(over).toEqual([]);
    });

    it(`${seq.name}: scrolling down and back keeps settling, and the pointer lands on the row drawn there`, () => {
      const positions: number[] = [];
      for (let y = 0; y <= seq.end; y += 37) positions.push(y);
      for (let y = seq.end; y >= 0; y -= 53) positions.push(y);

      let heights: ReadonlyMap<string, number> = new Map();
      let prior: RowPlacement | undefined;
      for (const scrollTop of positions) {
        const s = settle({ ids: seq.ids, trueHeight: seq.trueHeight, scrollTop, viewport: VIEWPORT, heights, prior });
        expect(s, `unsettled at scrollTop ${scrollTop}`).toBeDefined();
        expect(s!.passes, `passes at scrollTop ${scrollTop}`).toBeLessThanOrEqual(PASS_BUDGET);
        ({ heights, placement: prior } = s!);

        const rows = laidOut(seq.ids, s!.span, seq.trueHeight);
        const top = Math.min(scrollTop, Math.max(0, s!.span.totalHeight - VIEWPORT));
        // The rendered rows cover the whole viewport: no blank band.
        expect(rows[0]!.top, `gap above at ${scrollTop}`).toBeLessThanOrEqual(top);
        expect(rows[rows.length - 1]!.bottom, `gap below at ${scrollTop}`).toBeGreaterThanOrEqual(
          Math.min(top + VIEWPORT, s!.span.totalHeight),
        );
        // Where the browser drew each row is where the arithmetic says it is,
        // so the row under the pointer is the row a click selects.
        for (const probe of [0.05, 0.5, 0.95]) {
          const y = top + VIEWPORT * probe;
          const drawn = rows.find((r) => y >= r.top && y < r.bottom)?.id;
          expect(drawn, `pointer at ${y} (scrollTop ${scrollTop})`).toBe(
            rowAt(seq.ids, heights, s!.placement.estimate, y),
          );
        }
      }
    });
  }

  it("still renders overscan either side on the Plugins view shape", () => {
    const seq = SEQUENCES[0]!;
    for (const scrollTop of REPORTED) {
      const s = settle({ ids: seq.ids, trueHeight: seq.trueHeight, scrollTop, viewport: VIEWPORT })!;
      const rows = laidOut(seq.ids, s.span, seq.trueHeight);
      expect(rows.filter((r) => r.bottom <= scrollTop).length).toBeGreaterThanOrEqual(OVERSCAN / 2);
      expect(rows.filter((r) => r.top >= scrollTop + VIEWPORT).length).toBeGreaterThanOrEqual(OVERSCAN / 2);
    }
  });
});
