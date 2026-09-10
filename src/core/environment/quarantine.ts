/**
 * ──────────────────────────────────────────────────────────────────────
 * Move files out of the game's way — and back again.
 *
 * The files a clean-folder check finds are not ours (NS-2): a tester's hand-
 * installed mod, a previous collection's MCM settings, a shader cache. So this
 * never deletes. It MOVES, into a folder beside the game folder on the same
 * drive — outside what the store owns, so uninstalling, reinstalling or moving
 * the game (exactly what a tester with a dirty folder tends to do) does not
 * take the files with it — and the restore puts every file back where it was.
 *
 * ─── THE ORDER IS THE SAFETY ───────────────────────────────────────────
 *  1. The record is written BEFORE the first file moves — twice, once in Event
 *     Horizon's own folder and once beside the files — and rewritten every few
 *     files, so a crash, a power cut or a killed Vortex mid-move still leaves a
 *     list of where everything went. If the record cannot be rewritten, moving
 *     stops: a move nobody recorded is the one thing this must never do.
 *  2. Same volume as the game. A regular file is hard-linked into place and
 *     then unlinked from the game folder: creating a link FAILS when the
 *     destination exists, which makes "never overwrite" atomic in a way a
 *     check-then-rename is not (rename silently replaces on Windows). Links and
 *     filesystems without hard links fall back to check-then-rename, and a
 *     cross-volume junction to copy, size check, then unlink.
 *  3. What is held is read from the DISK, not from recorded states: a crash can
 *     leave "pending" on a file that did move, and the Doctor must still offer
 *     it back. Restore puts a file back only if its original place is free.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";

import { ehLog } from "../logging/ehLog";
import type { FolderEntry } from "./gameFolderScan";
import { logPaths } from "./logPaths";

export const QUARANTINE_FOLDER_NAME = "Event Horizon quarantine";

/**
 * `<parent of game folder>\Event Horizon quarantine\<game folder name>` — the
 * curator's choice: same drive (a move stays instant), outside the folder the
 * store owns. A game installed at a drive root has no parent, so its quarantine
 * is a root sub-folder of the game, which the scan never walks.
 */
export function quarantineRootFor(gameDir: string): string {
  const resolved = path.resolve(gameDir);
  const parent = path.dirname(resolved);
  return parent === resolved
    ? path.join(resolved, QUARANTINE_FOLDER_NAME)
    : path.join(parent, QUARANTINE_FOLDER_NAME, path.basename(resolved));
}
const SCHEMA = "event-horizon.quarantine/1";
const RECORD_IN_FOLDER = "restore.json";
/** Small on purpose: a crash can lose at most this many state updates. */
const FLUSH_EVERY = 25;

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
  /** The user acknowledged files that went missing from quarantine. */
  dismissedAt?: string;
  entries: QuarantineEntry[];
};

export type QuarantineSummary = {
  recordPath: string;
  record: QuarantineRecord;
  /** Files sitting in the quarantine folder right now. */
  held: number;
  /** Files recorded as moved that are no longer in the quarantine folder. */
  absent: number;
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
  await fsp.mkdir(path.dirname(to), { recursive: true });
  const st = await fsp.lstat(from);
  if (st.isFile()) {
    let linked = false;
    try {
      await fsp.link(from, to);
      linked = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
        throw new Error(`destination already exists: ${to}`);
      }
      // No hard links here (FAT, some shares, a locked file): fall through.
    }
    if (linked) {
      try {
        await fsp.unlink(from);
        return;
      } catch (err) {
        // The original could not be removed (a running game holds it). Undo
        // the link so the file exists in exactly one place, and report it.
        await fsp.unlink(to).catch(() => undefined);
        throw err;
      }
    }
  }
  if (await exists(to)) throw new Error(`destination already exists: ${to}`);
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EXDEV") throw err;
    await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
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
  const root = quarantineRootFor(args.gameDir);
  let folder = path.join(root, id);
  for (let n = 2; await exists(folder); n += 1) {
    id = `${args.gameId}-${stamp}-${n}`;
    folder = path.join(root, id);
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
  const movedPaths: string[] = [];
  let recordError: string | undefined;
  for (let i = 0; i < record.entries.length; i += 1) {
    const entry = record.entries[i]!;
    try {
      if (!isSafeRelative(entry.path)) throw new Error("unsafe relative path");
      await moveFile(path.join(args.gameDir, entry.path), path.join(folder, entry.path));
      entry.state = "moved";
      moved += 1;
      movedPaths.push(entry.path);
    } catch (err) {
      entry.state = "failed";
      entry.error = err instanceof Error ? err.message : String(err);
      failed.push(entry);
      ehLog("warn", "quarantine.move-failed", { id, file: entry.path, error: entry.error });
    }
    if ((i + 1) % FLUSH_EVERY === 0) {
      try {
        await writeRecord(record, recordPath);
      } catch (err) {
        recordError = err instanceof Error ? err.message : String(err);
        ehLog("error", "quarantine.record-write-failed", { id, afterEntries: i + 1, error: recordError });
        break;
      }
    }
  }
  record.completedAt = new Date().toISOString();
  try {
    await writeRecord(record, recordPath);
  } catch (err) {
    recordError ??= err instanceof Error ? err.message : String(err);
    ehLog("error", "quarantine.record-write-failed", { id, final: true, error: recordError });
  }
  if (recordError !== undefined) {
    failed.unshift({
      path: "(quarantine record)",
      size: 0,
      mtimeMs: 0,
      state: "failed",
      error: `the quarantine record could not be written, so moving stopped: ${recordError}`,
    });
  }

  logPaths("info", "quarantine.moved", { id, folder, recordPath }, movedPaths);
  ehLog(failed.length === 0 ? "info" : "warn", "quarantine.done", {
    id,
    moved,
    failed: failed.length,
    failedDetail: failed.map((f) => `${f.path}: ${f.error}`),
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

/** What a record holds on disk right now — never what its states claim. */
async function countOnDisk(record: QuarantineRecord): Promise<{ held: number; absent: number }> {
  let held = 0;
  let absent = 0;
  for (const e of record.entries) {
    if (e.state === "restored" || e.state === "failed" || !isSafeRelative(e.path)) continue;
    if (await exists(path.join(record.folder, e.path))) held += 1;
    // "pending" and not in the folder: it never left the game folder.
    else if (e.state !== "pending") absent += 1;
  }
  return { held, absent };
}

export async function listQuarantines(recordDir: string, gameId?: string): Promise<QuarantineSummary[]> {
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
    if (record === undefined || (gameId !== undefined && record.gameId !== gameId)) continue;
    out.push({ recordPath, record, ...(await countOnDisk(record)) });
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
  const restoredPaths: string[] = [];
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
      if (entry.state !== "pending") {
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
      restoredPaths.push(entry.path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      entry.error = message;
      result.failed.push({ path: entry.path, error: message });
    }
  }

  const { held } = await countOnDisk(record);
  if (held === 0 && result.failed.length === 0 && result.absent.length === 0) {
    record.restoredAt = new Date().toISOString();
  }
  await fsp.writeFile(recordPath, JSON.stringify(record, null, 2), "utf8");

  if (held === 0 && result.failed.length === 0) {
    // Only our own folder is tidied, and only once it holds nothing of anyone's.
    await fsp.unlink(path.join(record.folder, RECORD_IN_FOLDER)).catch(() => undefined);
    await pruneEmptyDirs(record.folder);
    // `<game folder name>`, then `Event Horizon quarantine` — each only if empty.
    await fsp.rmdir(path.dirname(record.folder)).catch(() => undefined);
    if (path.basename(path.dirname(path.dirname(record.folder))) === QUARANTINE_FOLDER_NAME) {
      await fsp.rmdir(path.dirname(path.dirname(record.folder))).catch(() => undefined);
    }
  } else if (await exists(record.folder)) {
    await fsp.writeFile(path.join(record.folder, RECORD_IN_FOLDER), JSON.stringify(record, null, 2), "utf8");
  }

  logPaths("info", "quarantine.restored", { id: record.id, recordPath }, restoredPaths);
  ehLog(result.conflicts.length + result.failed.length + result.absent.length === 0 ? "info" : "warn", "quarantine.restore.done", {
    id: record.id,
    restored: result.restored,
    conflicts: result.conflicts,
    absent: result.absent,
    failed: result.failed,
    stillHeld: held,
  });
  return result;
}

/**
 * Acknowledge files that went missing from quarantine, so the Doctor stops
 * listing a record it can do nothing more with. Refuses while anything is held.
 */
export async function dismissQuarantine(recordPath: string): Promise<void> {
  const record = await readQuarantineRecord(recordPath);
  if (record === undefined) throw new Error(`Not a readable quarantine record: ${recordPath}`);
  const { held, absent } = await countOnDisk(record);
  if (held > 0) throw new Error(`This quarantine still holds ${held} file(s); restore them first.`);
  record.dismissedAt = new Date().toISOString();
  await fsp.writeFile(recordPath, JSON.stringify(record, null, 2), "utf8");
  ehLog("info", "quarantine.dismissed", { id: record.id, recordPath, absent });
}

/** Remove empty directories bottom-up, `dir` included. Never touches a file. */
async function pruneEmptyDirs(dir: string): Promise<void> {
  let dirents: fs.Dirent[];
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
