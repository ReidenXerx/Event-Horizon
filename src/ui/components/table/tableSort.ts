/**
 * The sort a table opens with, remembered per table.
 *
 * Settled with the curator (2026-09-12): a table starts with its default sort
 * the first time (the mods table: enabled time, freshest first), and after
 * that opens with whatever sort they last chose — including no sort at all,
 * which is remembered as its own answer rather than falling back to the
 * default they had turned off.
 *
 * Pure except for the storage calls at the bottom, which never throw.
 */

import type { SortState } from "./tableView";

/** What was stored: a sort, or the curator's explicit "no sort". */
export type StoredSort = SortState | "none";

export function sortStorageKeyFor(tableId: string): string {
  return `event-horizon.table-sort.${tableId}`;
}

/**
 * A stored sort, when it still makes sense: a column this table still has
 * and a real direction. Anything else is `undefined` — nothing usable was
 * stored — so the table falls back to its default instead of breaking.
 */
export function parseStoredSort(raw: string | null | undefined, knownKeys: readonly string[]): StoredSort | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === "none") return "none";
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const { key, direction } = parsed as { key?: unknown; direction?: unknown };
  if (typeof key !== "string" || !knownKeys.includes(key)) return undefined;
  if (direction !== "asc" && direction !== "desc") return undefined;
  return { key, direction };
}

/** The sort a table opens with: what was stored, else its default. */
export function initialSort(stored: StoredSort | undefined, fallback: SortState | undefined): SortState | undefined {
  if (stored === "none") return undefined;
  return stored ?? fallback;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function storage(): StorageLike | undefined {
  try {
    return typeof window !== "undefined" && window.localStorage !== undefined ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

export function readStoredSort(tableId: string, knownKeys: readonly string[], store: StorageLike | undefined = storage()): StoredSort | undefined {
  try {
    return parseStoredSort(store?.getItem(sortStorageKeyFor(tableId)), knownKeys);
  } catch {
    return undefined;
  }
}

/** Remember the sort; `undefined` is stored as the explicit "no sort". Returns false when storage refused. */
export function writeStoredSort(tableId: string, sort: SortState | undefined, store: StorageLike | undefined = storage()): boolean {
  if (store === undefined) return false;
  try {
    store.setItem(sortStorageKeyFor(tableId), JSON.stringify(sort ?? "none"));
    return true;
  } catch {
    return false;
  }
}
