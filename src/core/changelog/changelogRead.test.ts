import { describe, expect, it } from "vitest";

import {
  compareVersionStrings,
  entriesSince,
  readChangelogEntries,
  summarizeEntry,
  changeSections,
  type ChangelogEntry,
} from "./changelog";

describe("compareVersionStrings", () => {
  it("orders numerically, part by part", () => {
    expect(compareVersionStrings("1.0.10", "1.0.9")).toBe(1);
    expect(compareVersionStrings("1.0.9", "1.0.10")).toBe(-1);
    expect(compareVersionStrings("1.0", "1.0.0")).toBe(0);
  });

  it("puts a labelled pre-release before the release it labels", () => {
    expect(compareVersionStrings("1.0.0-beta", "1.0.0")).toBe(-1);
    expect(compareVersionStrings("1.0.0", "1.0.0-beta")).toBe(1);
  });
});

describe("entriesSince", () => {
  const entries: ChangelogEntry[] = ["1.0.27", "1.0.26", "1.0.25", "1.0.9"].map((version) => ({
    version,
    date: "2026-09-15",
  }));

  it("gives someone updating every version they skipped, and nothing they have", () => {
    expect(entriesSince(entries, "1.0.25").map((e) => e.version)).toEqual(["1.0.27", "1.0.26"]);
  });

  it("gives everything when nothing is installed", () => {
    expect(entriesSince(entries)).toHaveLength(4);
  });
});

describe("readChangelogEntries", () => {
  it("is undefined for a manifest with no changelog", () => {
    expect(readChangelogEntries(undefined)).toBeUndefined();
  });

  it("drops what cannot be an entry and counts it, instead of refusing the manifest", () => {
    const read = readChangelogEntries([
      { version: "1.0.1", date: "2026-09-15", notes: "Hi" },
      { version: "1.0.0" },
      "garbage",
      null,
    ]);
    expect(read?.entries.map((e) => e.version)).toEqual(["1.0.1"]);
    expect(read?.dropped).toBe(3);
    expect(readChangelogEntries({ not: "a list" })).toEqual({ entries: [], dropped: 1 });
  });

  it("fills in every list a partial entry leaves out, so it still renders", () => {
    const read = readChangelogEntries([
      { version: "1.0.1", date: "2026-09-15", changes: { mods: { added: [{ name: "Lux" }, 7] } } },
    ]);
    const entry = read!.entries[0]!;
    expect(entry.changes?.plugins.moved).toEqual([]);
    expect(entry.changes?.mods.added).toEqual([{ name: "Lux" }]);
    expect(summarizeEntry(entry)).toBe("1 mod added.");
    expect(changeSections(entry.changes!).map((s) => s.title)).toEqual(["Mods added"]);
  });

  it("keeps a first release's totals", () => {
    const read = readChangelogEntries([
      { version: "1.0.0", date: "2026-09-15", firstRelease: { mods: 978, plugins: 819 } },
    ]);
    expect(read!.entries[0]!.firstRelease).toEqual({ mods: 978, plugins: 819 });
  });
});
