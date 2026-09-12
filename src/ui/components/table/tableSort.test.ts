import { describe, expect, it } from "vitest";

import { initialSort, parseStoredSort, readStoredSort, sortStorageKeyFor, writeStoredSort } from "./tableSort";

function memoryStore(): { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void; data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

const keys = ["name", "enabledTime", "state"];

describe("table sort memory", () => {
  it("opens with the default the first time", () => {
    expect(initialSort(undefined, { key: "enabledTime", direction: "desc" })).toEqual({ key: "enabledTime", direction: "desc" });
  });

  it("opens with the last sort chosen, including no sort at all", () => {
    const store = memoryStore();
    writeStoredSort("curator.mods", { key: "name", direction: "asc" }, store);
    expect(initialSort(readStoredSort("curator.mods", keys, store), { key: "enabledTime", direction: "desc" })).toEqual({
      key: "name",
      direction: "asc",
    });
    writeStoredSort("curator.mods", undefined, store);
    expect(store.data.get(sortStorageKeyFor("curator.mods"))).toBe('"none"');
    expect(initialSort(readStoredSort("curator.mods", keys, store), { key: "enabledTime", direction: "desc" })).toBeUndefined();
  });

  it("ignores a stored sort on a column the table no longer has, or a broken entry", () => {
    expect(parseStoredSort('{"key":"gone","direction":"asc"}', keys)).toBeUndefined();
    expect(parseStoredSort('{"key":"name","direction":"sideways"}', keys)).toBeUndefined();
    expect(parseStoredSort("{nope", keys)).toBeUndefined();
    expect(parseStoredSort("[1]", keys)).toBeUndefined();
    expect(parseStoredSort(null, keys)).toBeUndefined();
  });

  it("keeps each table's sort apart", () => {
    const store = memoryStore();
    writeStoredSort("curator.mods", { key: "name", direction: "desc" }, store);
    expect(readStoredSort("curator.plugins", keys, store)).toBeUndefined();
  });

  it("never throws when storage refuses", () => {
    const refusing = { getItem: (): string | null => { throw new Error("denied"); }, setItem: (): void => { throw new Error("full"); } };
    expect(readStoredSort("t", keys, refusing)).toBeUndefined();
    expect(writeStoredSort("t", { key: "name", direction: "asc" }, refusing)).toBe(false);
    expect(writeStoredSort("t", undefined, undefined)).toBe(false);
  });
});
