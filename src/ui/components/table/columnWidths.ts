/**
 * Column widths the curator sets by dragging a header's edge, kept per table.
 *
 * A 1,900-mod profile has names longer than any default: "Dynamic F…" in
 * every row of the Manual updates view is unreadable, and the right width is
 * the one the person reading chose. So a width is set by hand, remembered for
 * that table across restarts, and a double-click on the edge gives the
 * column back its default.
 *
 * Pure, so the rules are tested without a DOM; the one impure part — reading
 * and writing the browser's storage — is at the bottom and never throws.
 */

/** Narrower than this a header cannot show its own name or its filter box. */
export const MIN_COLUMN_WIDTH = 48;
/** Wider than this is a slip of the mouse, not a choice. */
export const MAX_COLUMN_WIDTH = 1600;
/** One arrow-key press on a focused column edge. */
export const KEYBOARD_STEP = 16;

/** A column key → width in px. Only columns the curator resized are in it. */
export type ColumnWidths = Readonly<Record<string, number>>;

/** The key the actions column is stored under; no data column can have it. */
export const ACTIONS_COLUMN_KEY = "__actions";

export function clampWidth(px: number): number {
  if (!Number.isFinite(px)) return MIN_COLUMN_WIDTH;
  return Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, px)));
}

/**
 * Widths read back from storage, keeping only what still makes sense: known
 * columns (a column removed in a later build must not linger) with a finite
 * number, clamped. Anything unreadable is an empty set, never an error — a
 * corrupt entry costs the curator their widths, not the table.
 */
export function parseStoredWidths(raw: string | null | undefined, knownKeys: readonly string[]): ColumnWidths {
  if (raw === null || raw === undefined || raw === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const known = new Set(knownKeys);
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!known.has(key) || typeof value !== "number" || !Number.isFinite(value)) continue;
    out[key] = clampWidth(value);
  }
  return out;
}

/** The widths after dragging one column's edge by `delta` px from where the drag started. */
export function resizeColumn(widths: ColumnWidths, key: string, startWidth: number, delta: number): ColumnWidths {
  return { ...widths, [key]: clampWidth(startWidth + delta) };
}

/** The widths with one column back on its default. */
export function resetColumn(widths: ColumnWidths, key: string): ColumnWidths {
  if (!(key in widths)) return widths;
  const { [key]: _gone, ...rest } = widths;
  return rest;
}

/**
 * The narrowest the table may get before it scrolls sideways.
 *
 * The table is fixed-layout: squeezed below the sum of its set widths, the
 * columns without one get nothing. Every column counts at its set width, or at
 * the minimum when it has none, plus the tick column; the caller's own minimum
 * still applies when it is larger.
 */
export function tableMinWidth(args: {
  columns: ReadonlyArray<{ key: string; width?: number }>;
  widths: ColumnWidths;
  actions?: { width?: number };
  tickColumn: boolean;
  callerMin?: number;
}): number {
  let sum = args.tickColumn ? 44 : 0;
  for (const col of args.columns) sum += args.widths[col.key] ?? col.width ?? MIN_COLUMN_WIDTH;
  if (args.actions !== undefined) sum += args.widths[ACTIONS_COLUMN_KEY] ?? args.actions.width ?? MIN_COLUMN_WIDTH;
  return Math.max(args.callerMin ?? 0, Math.round(sum));
}

/** Where a table's widths are stored. One entry per table, not per game. */
export function storageKeyFor(tableId: string): string {
  return `event-horizon.table-widths.${tableId}`;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storage(): StorageLike | undefined {
  try {
    return typeof window !== "undefined" && window.localStorage !== undefined ? window.localStorage : undefined;
  } catch {
    // A browser that refuses storage throws on the property itself.
    return undefined;
  }
}

export function readStoredWidths(tableId: string, knownKeys: readonly string[], store: StorageLike | undefined = storage()): ColumnWidths {
  try {
    return parseStoredWidths(store?.getItem(storageKeyFor(tableId)), knownKeys);
  } catch {
    return {};
  }
}

/** Save, or forget the entry when nothing is resized. Returns false when storage refused. */
export function writeStoredWidths(tableId: string, widths: ColumnWidths, store: StorageLike | undefined = storage()): boolean {
  if (store === undefined) return false;
  try {
    if (Object.keys(widths).length === 0) store.removeItem(storageKeyFor(tableId));
    else store.setItem(storageKeyFor(tableId), JSON.stringify(widths));
    return true;
  } catch {
    return false;
  }
}
