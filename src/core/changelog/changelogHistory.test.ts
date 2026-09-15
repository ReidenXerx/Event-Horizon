import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  changelogHistoryPath,
  loadChangelogHistory,
  saveChangelogHistory,
} from "./changelogHistory";
import type { ChangelogHistory, ChangelogSnapshot } from "./changelog";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-changelog-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const snapshot: ChangelogSnapshot = {
  schema: 1,
  version: "1.0.26",
  game: { version: "1.10.163.0", versionPolicy: "exact" },
  requiredExtensions: [],
  mods: [{ compareKey: "nexus:1:1", name: "A", enabled: true, delivery: "download", fomodSelections: [] }],
  plugins: [],
  loadOrder: [],
  rules: [],
  iniTweaks: [],
  gameIni: [],
  externalDependencies: [],
};

describe("changelog history on disk", () => {
  it("comes back as it was saved", async () => {
    const history: ChangelogHistory = {
      schema: 1,
      entries: [{ version: "1.0.26", date: "2026-09-15T10:00:00Z", firstRelease: { mods: 1, plugins: 0 } }],
      last: snapshot,
    };
    await saveChangelogHistory(dir, "ivy", history);
    expect(await loadChangelogHistory(dir, "ivy")).toEqual(history);
  });

  it("lives in a dot folder, never as a *.json the config listing would read as a collection", () => {
    const file = changelogHistoryPath(dir, "ivy");
    expect(path.dirname(file)).toBe(path.join(dir, ".changelog"));
    expect(fs.existsSync(path.join(dir, "ivy.changelog.json"))).toBe(false);
  });

  it("is absent, not an error, when there is no file", async () => {
    expect(await loadChangelogHistory(dir, "ivy")).toBeUndefined();
  });

  it("treats a damaged or foreign file as absent", async () => {
    const file = changelogHistoryPath(dir, "ivy");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    expect(await loadChangelogHistory(dir, "ivy")).toBeUndefined();
    fs.writeFileSync(file, JSON.stringify({ schema: 2, entries: [] }));
    expect(await loadChangelogHistory(dir, "ivy")).toBeUndefined();
  });

  it("drops a snapshot missing a list the diff walks, keeping the entries", async () => {
    const file = changelogHistoryPath(dir, "ivy");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const broken = { ...snapshot, plugins: undefined };
    fs.writeFileSync(
      file,
      JSON.stringify({ schema: 1, entries: [{ version: "1.0.0", date: "2026-01-01" }], last: broken }),
    );
    const loaded = await loadChangelogHistory(dir, "ivy");
    expect(loaded?.entries.map((e) => e.version)).toEqual(["1.0.0"]);
    expect(loaded?.last).toBeUndefined();
  });
});
