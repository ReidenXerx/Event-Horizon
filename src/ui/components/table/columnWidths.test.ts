import { describe, expect, it } from "vitest";

import {
  ACTIONS_COLUMN_KEY,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  clampWidth,
  parseStoredWidths,
  readStoredWidths,
  resetColumn,
  resizeColumn,
  storageKeyFor,
  tableMinWidth,
  writeStoredWidths,
} from "./columnWidths";

function memoryStore(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe("column widths", () => {
  it("keeps a width inside what a header can show and what a hand means", () => {
    expect(clampWidth(10)).toBe(MIN_COLUMN_WIDTH);
    expect(clampWidth(99999)).toBe(MAX_COLUMN_WIDTH);
    expect(clampWidth(240.6)).toBe(241);
    expect(clampWidth(Number.NaN)).toBe(MIN_COLUMN_WIDTH);
  });

  it("drags from where the drag started, and a double-click gives the default back", () => {
    const after = resizeColumn({}, "name", 180, 95);
    expect(after).toEqual({ name: 275 });
    expect(resizeColumn(after, "name", 275, -400)).toEqual({ name: MIN_COLUMN_WIDTH });
    expect(resetColumn({ name: 275, version: 90 }, "name")).toEqual({ version: 90 });
    const untouched = { version: 90 };
    expect(resetColumn(untouched, "name")).toBe(untouched);
  });

  it("reads back only known columns with real numbers, and survives a corrupt entry", () => {
    expect(parseStoredWidths('{"name":300,"gone":120,"version":"wide","state":-5}', ["name", "version", "state"])).toEqual({
      name: 300,
      state: MIN_COLUMN_WIDTH,
    });
    expect(parseStoredWidths("{not json", ["name"])).toEqual({});
    expect(parseStoredWidths("[300]", ["name"])).toEqual({});
    expect(parseStoredWidths(null, ["name"])).toEqual({});
  });

  it("remembers a table's widths across a restart, per table, and forgets them on reset", () => {
    const store = memoryStore();
    expect(writeStoredWidths("curator.mods", { name: 320, [ACTIONS_COLUMN_KEY]: 300 }, store)).toBe(true);
    expect(readStoredWidths("curator.mods", ["name", ACTIONS_COLUMN_KEY], store)).toEqual({ name: 320, [ACTIONS_COLUMN_KEY]: 300 });
    expect(readStoredWidths("curator.plugins", ["name"], store)).toEqual({});
    writeStoredWidths("curator.mods", {}, store);
    expect(store.data.has(storageKeyFor("curator.mods"))).toBe(false);
  });

  it("never throws when storage refuses", () => {
    const refusing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); }, removeItem: () => undefined };
    expect(readStoredWidths("t", ["a"], refusing)).toEqual({});
    expect(writeStoredWidths("t", { a: 100 }, refusing)).toBe(false);
    expect(writeStoredWidths("t", { a: 100 }, undefined)).toBe(false);
  });

  it("scrolls sideways before a widened column squeezes the others to nothing", () => {
    const columns = [{ key: "name" }, { key: "version", width: 120 }, { key: "state" }];
    expect(tableMinWidth({ columns, widths: {}, tickColumn: true })).toBe(44 + MIN_COLUMN_WIDTH + 120 + MIN_COLUMN_WIDTH);
    expect(tableMinWidth({ columns, widths: { name: 600 }, actions: { width: 290 }, tickColumn: false, callerMin: 900 })).toBe(
      600 + 120 + MIN_COLUMN_WIDTH + 290,
    );
    expect(tableMinWidth({ columns, widths: {}, tickColumn: false, callerMin: 1180 })).toBe(1180);
  });
});
