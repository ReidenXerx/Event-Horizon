/**
 * Quarantine holds files that are not ours (NS-2), so the tests are about the
 * promises that make moving them acceptable at all: the record exists before
 * anything moves; what is held is read from the disk (a crash mid-move must not
 * hide files from the Doctor); restore puts everything back without ever
 * overwriting what now occupies a file's place; and the files live beside the
 * game folder, where uninstalling the game does not take them along.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  dismissQuarantine,
  listQuarantines,
  QUARANTINE_FOLDER_NAME,
  quarantineFiles,
  quarantineRootFor,
  readQuarantineRecord,
  restoreQuarantine,
} from "./quarantine";

let tmp: string;
let gameDir: string;
let recordDir: string;

const put = (rel: string, content = rel): void => {
  const full = path.join(gameDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
};
const entry = (rel: string) => ({ path: rel, size: fs.statSync(path.join(gameDir, rel)).size, mtimeMs: 1 });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eh-quarantine-"));
  gameDir = path.join(tmp, "Fallout 4");
  recordDir = path.join(tmp, "eh", "quarantine");
  fs.mkdirSync(gameDir, { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("quarantineRootFor", () => {
  it("is beside the game folder, named after it — outside what the store owns", () => {
    expect(quarantineRootFor(gameDir)).toBe(path.join(tmp, QUARANTINE_FOLDER_NAME, "Fallout 4"));
    expect(quarantineRootFor(`${gameDir}${path.sep}`)).toBe(path.join(tmp, QUARANTINE_FOLDER_NAME, "Fallout 4"));
  });
});

describe("quarantineFiles", () => {
  it("moves files beside the game folder, keeping their relative paths", async () => {
    put("Data/F4SE/Plugins/old.dll", "OLD");
    put("dxgi.dll", "DXGI");
    const result = await quarantineFiles({
      gameId: "fallout4",
      gameDir,
      entries: [entry("Data/F4SE/Plugins/old.dll"), entry("dxgi.dll")],
      reason: "test",
      recordDir,
      now: new Date("2026-09-11T10:00:00Z"),
    });
    expect(result.moved).toBe(2);
    expect(result.failed).toEqual([]);
    expect(fs.existsSync(path.join(gameDir, "dxgi.dll"))).toBe(false);
    expect(path.dirname(result.record.folder)).toBe(quarantineRootFor(gameDir));
    expect(fs.readFileSync(path.join(result.record.folder, "Data/F4SE/Plugins/old.dll"), "utf8")).toBe("OLD");
    expect((await readQuarantineRecord(result.recordPath))?.entries.map((e) => e.state)).toEqual(["moved", "moved"]);
    expect(fs.existsSync(path.join(result.record.folder, "restore.json"))).toBe(true);
  });

  it("writes the record before moving anything: no record, no move", async () => {
    put("dxgi.dll");
    // A FILE where the record directory should be: the record cannot be written.
    fs.mkdirSync(path.dirname(recordDir), { recursive: true });
    fs.writeFileSync(recordDir, "in the way");
    await expect(
      quarantineFiles({ gameId: "fallout4", gameDir, entries: [entry("dxgi.dll")], reason: "t", recordDir: path.join(recordDir, "sub") }),
    ).rejects.toThrow();
    expect(fs.existsSync(path.join(gameDir, "dxgi.dll"))).toBe(true);
  });

  it("records a file it could not move, and refuses paths outside the game folder", async () => {
    put("a.dll");
    const result = await quarantineFiles({
      gameId: "fallout4",
      gameDir,
      entries: [entry("a.dll"), { path: "../outside.dll", size: 1, mtimeMs: 1 }, { path: "gone.dll", size: 1, mtimeMs: 1 }],
      reason: "t",
      recordDir,
    });
    expect(result.moved).toBe(1);
    expect(result.failed.map((f) => f.path)).toEqual(["../outside.dll", "gone.dll"]);
  });
});

describe("listQuarantines — the disk, not the recorded states", () => {
  it("still shows files moved by a run that crashed before recording them", async () => {
    put("a.dll");
    put("Data/b.esp");
    const q = await quarantineFiles({ gameId: "fallout4", gameDir, entries: [entry("a.dll"), entry("Data/b.esp")], reason: "t", recordDir });
    // What a killed Vortex leaves: files moved, record still saying "pending".
    const record = JSON.parse(fs.readFileSync(q.recordPath, "utf8"));
    for (const e of record.entries) e.state = "pending";
    fs.writeFileSync(q.recordPath, JSON.stringify(record));
    const [summary] = await listQuarantines(recordDir);
    expect(summary?.held).toBe(2);
    expect((await restoreQuarantine(q.recordPath)).restored).toBe(2);
    expect(fs.existsSync(path.join(gameDir, "Data/b.esp"))).toBe(true);
  });

  it("filters by game", async () => {
    put("a.dll");
    await quarantineFiles({ gameId: "fallout4", gameDir, entries: [entry("a.dll")], reason: "t", recordDir });
    expect(await listQuarantines(recordDir, "skyrimse")).toEqual([]);
    expect((await listQuarantines(recordDir, "fallout4")).length).toBe(1);
  });
});

describe("restoreQuarantine", () => {
  it("puts every file back and removes its own empty folders", async () => {
    put("Data/MCM/Settings/x.ini", "INI");
    put("d3d11.dll", "ENB");
    const q = await quarantineFiles({
      gameId: "fallout4",
      gameDir,
      entries: [entry("Data/MCM/Settings/x.ini"), entry("d3d11.dll")],
      reason: "t",
      recordDir,
    });
    const r = await restoreQuarantine(q.recordPath);
    expect(r).toEqual({ restored: 2, conflicts: [], absent: [], failed: [] });
    expect(fs.readFileSync(path.join(gameDir, "Data/MCM/Settings/x.ini"), "utf8")).toBe("INI");
    expect(fs.existsSync(path.join(tmp, QUARANTINE_FOLDER_NAME))).toBe(false);
    expect((await readQuarantineRecord(q.recordPath))?.restoredAt).toBeDefined();
    expect((await listQuarantines(recordDir))[0]?.held).toBe(0);
  });

  it("never overwrites: a file whose place is taken stays in quarantine", async () => {
    put("d3d11.dll", "MINE");
    const q = await quarantineFiles({ gameId: "fallout4", gameDir, entries: [entry("d3d11.dll")], reason: "t", recordDir });
    put("d3d11.dll", "NEW ONE"); // the collection installed its own since
    const r = await restoreQuarantine(q.recordPath);
    expect(r.conflicts).toEqual(["d3d11.dll"]);
    expect(fs.readFileSync(path.join(gameDir, "d3d11.dll"), "utf8")).toBe("NEW ONE");
    expect(fs.readFileSync(path.join(q.record.folder, "d3d11.dll"), "utf8")).toBe("MINE");
    expect((await listQuarantines(recordDir))[0]?.held).toBe(1);

    fs.unlinkSync(path.join(gameDir, "d3d11.dll"));
    expect((await restoreQuarantine(q.recordPath)).restored).toBe(1);
    expect(fs.readFileSync(path.join(gameDir, "d3d11.dll"), "utf8")).toBe("MINE");
  });

  it("does not call a restore complete when files went missing from quarantine — until dismissed", async () => {
    put("a.dll");
    put("b.dll");
    const q = await quarantineFiles({ gameId: "fallout4", gameDir, entries: [entry("a.dll"), entry("b.dll")], reason: "t", recordDir });
    fs.unlinkSync(path.join(q.record.folder, "a.dll"));
    const r = await restoreQuarantine(q.recordPath);
    expect(r.absent).toEqual(["a.dll"]);
    expect(r.restored).toBe(1);
    const record = await readQuarantineRecord(q.recordPath);
    expect(record?.restoredAt).toBeUndefined();
    expect((await listQuarantines(recordDir))[0]).toMatchObject({ held: 0, absent: 1 });
    await dismissQuarantine(q.recordPath);
    expect((await readQuarantineRecord(q.recordPath))?.dismissedAt).toBeDefined();
  });

  it("refuses to dismiss a record that still holds files", async () => {
    put("a.dll");
    const q = await quarantineFiles({ gameId: "fallout4", gameDir, entries: [entry("a.dll")], reason: "t", recordDir });
    await expect(dismissQuarantine(q.recordPath)).rejects.toThrow(/still holds 1/);
  });
});
