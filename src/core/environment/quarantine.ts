/**
 * ──────────────────────────────────────────────────────────────────────
 * Move files out of the game's way — and back again.
 *
 * The files a clean-folder check finds are not ours (NS-2): a tester's hand-
 * installed mod, a previous collection's MCM settings, a shader cache. So this
 * never deletes. It MOVES, into a folder inside the game root that the game
 * does not load, and the restore puts every file back where it was.
 *
 * ─── THE ORDER IS THE SAFETY ───────────────────────────────────────────
 *  1. The record is written BEFORE the first file moves — twice, once in Event
 *     Horizon's own folder and once beside the files — so a crash, a power cut
 *     or a killed Vortex mid-move still leaves a list of where everything went.
 *  2. Same volume as the game, so a move is a rename: nothing is copied, and a
 *     half-finished move cannot exist. A cross-volume junction falls back to
 *     copy, size check, then unlink of the original.
 *  3. Restore reads the DISK, not the record's states: a file in quarantine
 *     goes back if its original place is free, and stays put if something now
 *     occupies it. It never overwrites.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fsp from "fs/promises";
import * as path from "path";

import { ehLog } from "../logging/ehLog";
import type { FolderEntry } from "./gameFolderScan";

/** A root sub-folder: off the load surface, so the scan never sees its own quarantine. */
export const QUARANTINE_FOLDER_NAME = "Event Horizon quarantine";
const SCHEMA = "event-horizon.quarantine/1";
const RECORD_IN_FOLDER = "restore.json";
const FLUSH_EVERY = 250;

export type QuarantineEntryState =
  | "pending"
  | "moved"
  | "failed"
  | "restored"
  | "conflict"
  | "absent";

export type QuarantineEntry = {
  path: string;
  size: number;
  mtimeMs: number;
  state: QuarantineEntryState;
  error?: string;
};

export type QuarantineRecord = {
  schema: typeof SCHEMA;
  id: string;
  gameId: string;
  gameDir: string;
  /** Absolute folder holding the moved files. */
  folder: string;
  reason: string;
  createdAt: string;
  completedAt?: string;
  restoredAt?: string;
  entries: QuarantineEntry[];
};

export type QuarantineSummary = {
  recordPath: string;
  record: QuarantineRecord;
  /** Files still sitting in quarantine. */
  held: number;
};

function isSafeRelative(rel: string): boolean {
  if (rel.length === 0 || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return false;
  return rel.split(/[\\/]+/).every((s) => s !== ".." && s !== "");
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function moveFile(from: string, to: string): Promise<void> {
  if (await exists(to)) throw new Error(`destination already exists: ${to}`);
  await fsp.mkdir(path.dirname(to), { recursive: true });
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EXDEV") throw err;
    await fsp.copyFile(from, to, (await import("fs")).constants.COPYFILE_EXCL);
    const [a, b] = await Promise.all([fsp.stat(from), fsp.stat(to)]);
    if (a.size !== b.size) {
      await fsp.unlink(to).catch(() => undefined);
      throw new Error(`copy size mismatch (${a.size} vs ${b.size})`);
    }
    await fsp.unlink(from);
  }
}

async function writeRecord(record: QuarantineRecord, recordPath: string): Promise<void> {
  const text = JSON.stringify(record, null, 2);
  await fsp.mkdir(path.dirname(recordPath), { recursive: true });
  await fsp.writeFile(recordPath, text, "utf8");
  if (await exists(record.folder)) {
    await fsp.writeFile(path.join(record.folder, RECORD_IN_FOLDER), text, "utf8");
  }
}

export async function quarantineFiles(args: {
  gameId: string;
  gameDir: string;
  entries: readonly FolderEntry[];
  reason: string;
  /** Where the canonical records live (Event Horizon's app-data folder). */
  recordDir: string;
  now?: Date;
}): Promise<{ recordPath: string; record: QuarantineRecord; moved: number; failed: QuarantineEntry[] }> {
  const now = args.now ?? new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  let id = `${args.gameId}-${stamp}`;
  let folder = path.join(args.gameDir, QUARANTINE_FOLDER_NAME, id);
  for (let n = 2; await exists(folder); n += 1) {
    id = `${args.gameId}-${stamp}-${n}`;
    folder = path.join(args.gameDir, QUARANTINE_FOLDER_NAME, id);
  }

  const record: QuarantineRecord = {
    schema: SCHEMA,
    id,
    gameId: args.gameId,
    gameDir: args.gameDir,
    folder,
    reason: args.reason,
    createdAt: now.toISOString(),
    entries: args.entries.map((e) => ({ path: e.path, size: e.size, mtimeMs: e.mtimeMs, state: "pending" })),
  };
  const recordPath = path.join(args.recordDir, `${id}.json`);

  // Step 1: the record exists before anything moves. If this throws, nothing did.
  await fsp.mkdir(folder, { recursive: true });
  await writeRecord(record, recordPath);
  ehLog("info", "quarantine.start", { id, gameDir: args.gameDir, folder, files: record.entries.length, recordPath });

  let moved = 0;
  const failed: QuarantineEntry[] = [];
  for (let i = 0; i < record.entries.length; i += 1) {
    const entry = record.entries[i]!;
    try {
      if (!isSafeRelative(entry.path)) throw new Error("unsafe relative path");
      await moveFile(path.join(args.gameDir, entry.path), path.join(folder, entry.path));
      entry.state = "moved";
      moved += 1;
    } catch (err) {
      entry.state = "failed";
      entry.error = err instanceof Error ? err.message : String(err);
      failed.push(entry);
      ehLog("warn", "quarantine.move-failed", { id, file: entry.path, error: entry.error });
    }
    if ((i + 1) % FLUSH_EVERY === 0) await writeRecord(record, recordPath);
  }
  record.completedAt = new Date().toISOString();
  await writeRecord(record, recordPath);
  ehLog(failed.length === 0 ? "info" : "warn", "quarantine.done", {
    id,
    moved,
    failed: failed.length,
    failedSample: failed.slice(0, 50).map((f) => `${f.path}: ${f.error}`),
  });
  return { recordPath, record, moved, failed };
}

export async function readQuarantineRecord(recordPath: string): Promise<QuarantineRecord | undefined> {
  try {
    const parsed = JSON.parse(await fsp.readFile(recordPath, "utf8")) as QuarantineRecord;
    return parsed?.schema === SCHEMA && Array.isArray(parsed.entries) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function listQuarantines(recordDir: string): Promise<QuarantineSummary[]> {
  let names: string[];
  try {
    names = await fsp.readdir(recordDir);
  } catch {
    return [];
  }
  const out: QuarantineSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const recordPath = path.join(recordDir, name);
    const record = await readQuarantineRecord(recordPath);
    if (record === undefined) continue;
    out.push({
      recordPath,
      record,
      held: record.entries.filter((e) => e.state === "moved" || e.state === "conflict").length,
    });
  }
  return out.sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt));
}

export type RestoreResult = {
  restored: number;
  /** Left in quarantine because something now occupies the original place. */
  conflicts: string[];
  /** Recorded as moved, but gone from quarantine. */
  absent: string[];
  failed: Array<{ path: string; error: string }>;
};

export async function restoreQuarantine(recordPath: string): Promise<RestoreResult> {
  const record = await readQuarantineRecord(recordPath);
  if (record === undefined) throw new Error(`Not a readable quarantine record: ${recordPath}`);
  const result: RestoreResult = { restored: 0, conflicts: [], absent: [], failed: [] };
  ehLog("info", "quarantine.restore.start", { id: record.id, recordPath, files: record.entries.length });

  for (const entry of record.entries) {
    if (entry.state === "restored" || entry.state === "failed") continue;
    if (!isSafeRelative(entry.path)) {
      result.failed.push({ path: entry.path, error: "unsafe relative path" });
      continue;
    }
    const held = path.join(record.folder, entry.path);
    const original = path.join(record.gameDir, entry.path);
    // The disk decides, not the recorded state: a crash can leave "pending"
    // on a file that did move.
    if (!(await exists(held))) {
      if (entry.state === "moved" || entry.state === "conflict") {
        entry.state = "absent";
        result.absent.push(entry.path);
      }
      continue;
    }
    if (await exists(original)) {
      entry.state = "conflict";
      result.conflicts.push(entry.path);
      continue;
    }
    try {
      await moveFile(held, original);
      entry.state = "restored";
      delete entry.error;
      result.restored += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      entry.error = message;
      result.failed.push({ path: entry.path, error: message });
    }
  }

  const stillHeld = record.entries.some((e) => e.state === "conflict" || e.state === "moved");
  if (!stillHeld && result.failed.length === 0) record.restoredAt = new Date().toISOString();
  await fsp.writeFile(recordPath, JSON.stringify(record, null, 2), "utf8");

  if (record.restoredAt !== undefined) {
    // Only our own folder is tidied, and only once it holds nothing of anyone's.
    await fsp.unlink(path.join(record.folder, RECORD_IN_FOLDER)).catch(() => undefined);
    await pruneEmptyDirs(record.folder);
    await fsp.rmdir(path.dirname(record.folder)).catch(() => undefined);
  } else if (await exists(record.folder)) {
    await fsp.writeFile(path.join(record.folder, RECORD_IN_FOLDER), JSON.stringify(record, null, 2), "utf8");
  }

  ehLog(result.conflicts.length + result.failed.length === 0 ? "info" : "warn", "quarantine.restore.done", {
    id: record.id,
    restored: result.restored,
    conflicts: result.conflicts.length,
    conflictSample: result.conflicts.slice(0, 50),
    absent: result.absent.length,
    failed: result.failed.slice(0, 50),
  });
  return result;
}

/** Remove empty directories bottom-up, `dir` included. Never touches a file. */
async function pruneEmptyDirs(dir: string): Promise<void> {
  let dirents: import("fs").Dirent[];
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of dirents) {
    if (d.isDirectory()) await pruneEmptyDirs(path.join(dir, d.name));
  }
  await fsp.rmdir(dir).catch(() => undefined);
}
