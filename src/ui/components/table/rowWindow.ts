/**
 * ──────────────────────────────────────────────────────────────────────
 * Which rows of a long table exist in the DOM — decided without a DOM.
 *
 * ─── ONE HEIGHT FOR EVERY ROW NEVER SETTLED ────────────────────────────
 * The table used to measure the FIRST rendered row and use that one height
 * for all of them. The first rendered row depends on the scroll position
 * divided by that height, so the height chose the row that chose the
 * height. On the curator's Plugins view a native plugin row (no action
 * buttons, 38.8px) and an ordinary one (50px) took turns being first at
 * scrollTop 700, 760, 800 and 3800: every render measured the other one,
 * React gave up with "Maximum update depth exceeded", and the view was
 * replaced by the error boundary with zero rows.
 *
 * ─── A HEIGHT BELONGS TO A ROW, NOT TO A POSITION ─────────────────────
 * Each rendered row's height is recorded against its id. A row's height is
 * a property of its content, so re-rendering the same row at a different
 * scroll position measures the same number, and the record only ever gains
 * rows it did not have. That is what makes the loop FINITE: each pass
 * either learns a row it had never seen or changes nothing, and a pass that
 * changes nothing is the last one.
 *
 * Every rendered row is placed at the sum of the recorded heights above it,
 * so the row the arithmetic says is under the pointer is the row the
 * browser drew there, and a click selects what it landed on.
 *
 * ─── FINITE IS NOT ENOUGH: REACT STOPS AT 50 ───────────────────────────
 * Recording alone still took 19 passes to settle a thumb-drag into a list
 * of 38.8px and 50px runs, and 24 on wilder heights: every pass moved the
 * mean that unseen rows are counted at, which moved the window hundreds of
 * rows below, which measured new rows, which moved the mean. React throws
 * past 50 nested layout-effect updates. So while one scroll position
 * settles (same rows, same scroll position, same viewport):
 *   - the estimate for unseen rows is FIXED at what it was when the
 *     position was first placed, and
 *   - the window already rendered is KEPT for as long as it still covers
 *     the viewport under the new heights.
 * With both, every sequence tested settles in at most three passes (see
 * rowWindow.test.ts). The estimate moves on the next scroll or list change.
 * ──────────────────────────────────────────────────────────────────────
 */

/** Rows rendered beyond the visible band, so a scroll never shows a gap. */
export const OVERSCAN = 12;

/** A difference smaller than this is sub-pixel rounding, not a new height. */
const HEIGHT_EPSILON = 0.5;

export type RowWindow = {
  /** First rendered index, inclusive. */
  start: number;
  /** Last rendered index, exclusive. */
  end: number;
  /** Height of the spacer standing in for rows [0, start). */
  topSpace: number;
  /** Height of the spacer standing in for rows [end, total). */
  bottomSpace: number;
  /** The whole list's height, as far as it is known. */
  totalHeight: number;
};

/**
 * What one render placed, handed back to the next so a scroll position that
 * is still settling keeps its estimate and, while it covers, its rows.
 */
export type RowPlacement = {
  ids: readonly string[];
  scrollTop: number;
  viewport: number;
  estimate: number;
  start: number;
  end: number;
};

/**
 * The height an unseen row is assumed to have: the mean of the rows that
 * have been measured, or `fallback` before any has been.
 */
export function estimateRowHeight(
  heights: ReadonlyMap<string, number>,
  fallback: number,
): number {
  if (heights.size === 0) return fallback;
  let sum = 0;
  for (const h of heights.values()) sum += h;
  return sum / heights.size;
}

function offsetsOf(
  ids: readonly string[],
  heights: ReadonlyMap<string, number>,
  estimate: number,
): number[] {
  const offsets = new Array<number>(ids.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < ids.length; i += 1) {
    offsets[i + 1] = offsets[i]! + (heights.get(ids[i]!) ?? estimate);
  }
  return offsets;
}

/**
 * The scroll position, clamped to the CURRENT list: a filter typed while
 * scrolled to the bottom of 1,900 rows would otherwise ask for rows past the
 * end and render a blank table under a spacer the browser unwinds in ~85
 * scroll events.
 */
function clampTop(scrollTop: number, totalHeight: number, viewport: number): number {
  return Math.max(0, Math.min(scrollTop, Math.max(0, totalHeight - viewport)));
}

function spanOf(offsets: readonly number[], start: number, end: number): RowWindow {
  const totalHeight = offsets[offsets.length - 1]!;
  return {
    start,
    end,
    topSpace: offsets[start]!,
    bottomSpace: Math.max(0, totalHeight - offsets[end]!),
    totalHeight,
  };
}

function windowFromOffsets(
  offsets: readonly number[],
  scrollTop: number,
  viewport: number,
  overscan: number,
): RowWindow {
  const total = offsets.length - 1;
  const top = clampTop(scrollTop, offsets[total]!, viewport);
  const bottom = top + viewport;
  // The row containing `top`: the first whose bottom edge is below it.
  let first = 0;
  while (first < total && offsets[first + 1]! <= top) first += 1;
  // One past the last row that starts above the viewport's bottom edge.
  let last = first;
  while (last < total && offsets[last]! < bottom) last += 1;
  return spanOf(offsets, Math.max(0, first - overscan), Math.min(total, last + overscan));
}

/** The window of rows to render for a scroll position, from scratch. */
export function computeRowWindow(input: {
  ids: readonly string[];
  heights: ReadonlyMap<string, number>;
  estimate: number;
  scrollTop: number;
  viewport: number;
  overscan?: number;
}): RowWindow {
  return windowFromOffsets(
    offsetsOf(input.ids, input.heights, input.estimate),
    input.scrollTop,
    input.viewport,
    input.overscan ?? OVERSCAN,
  );
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The window to render, given what the previous render placed.
 *
 * A new scroll position, viewport or list is placed from scratch with a
 * fresh estimate. The SAME one — a re-render because the last one measured
 * rows it had not seen — keeps the estimate, and keeps the rendered rows if
 * they still cover the viewport; see the header for why both are needed.
 */
export function placeRowWindow(input: {
  ids: readonly string[];
  heights: ReadonlyMap<string, number>;
  scrollTop: number;
  viewport: number;
  /** The estimate before any row has been measured. */
  fallback: number;
  prior?: RowPlacement;
  overscan?: number;
}): { span: RowWindow; placement: RowPlacement } {
  const { ids, heights, scrollTop, viewport, prior } = input;
  const settling =
    prior !== undefined &&
    prior.scrollTop === scrollTop &&
    prior.viewport === viewport &&
    sameIds(prior.ids, ids);
  const estimate = settling ? prior.estimate : estimateRowHeight(heights, input.fallback);
  const offsets = offsetsOf(ids, heights, estimate);

  let span: RowWindow | undefined;
  if (settling && prior.end <= ids.length && prior.start < prior.end) {
    const totalHeight = offsets[ids.length]!;
    const top = clampTop(scrollTop, totalHeight, viewport);
    const covers =
      offsets[prior.start]! <= top && offsets[prior.end]! >= Math.min(top + viewport, totalHeight);
    if (covers) span = spanOf(offsets, prior.start, prior.end);
  }
  span ??= windowFromOffsets(offsets, scrollTop, viewport, input.overscan ?? OVERSCAN);

  return {
    span,
    placement: { ids, scrollTop, viewport, estimate, start: span.start, end: span.end },
  };
}

/**
 * Fold measured row heights into the record.
 *
 * Returns the new record, or `undefined` when nothing moved — the caller
 * sets state only on a new record, which is the loop's stopping condition.
 * A height of zero is a row that was not laid out (a hidden page), not a
 * row of height zero, and is ignored.
 */
export function recordRowHeights(
  heights: ReadonlyMap<string, number>,
  measured: Iterable<readonly [string, number]>,
): ReadonlyMap<string, number> | undefined {
  let next: Map<string, number> | undefined;
  for (const [id, h] of measured) {
    if (!(h > 0)) continue;
    const known = (next ?? heights).get(id);
    if (known !== undefined && Math.abs(known - h) <= HEIGHT_EPSILON) continue;
    next ??= new Map(heights);
    next.set(id, h);
  }
  return next;
}
