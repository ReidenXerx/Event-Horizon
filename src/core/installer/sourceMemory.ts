/**
 * ──────────────────────────────────────────────────────────────────────
 * Remember where the user found a mod we could not fetch for them.
 *
 * A collection carries mods Vortex cannot download — hand-installed things,
 * mods pulled from Nexus, files from elsewhere. For each one the install asks
 * the user to point at the archive, and that answer used to live only in the
 * wizard's state. Press "check and continue" a day later and it asks for every
 * one of them again, having learned nothing from the first time.
 *
 * A tester with two dozen external mods had to re-supply all of them to resume
 * an install he had already answered.
 *
 * ─── WRITTEN WHEN THE USER ANSWERS, NOT WHEN THE INSTALL SUCCEEDS ──────
 * The run that most needs this is the one that did NOT finish. Recording at
 * the end would remember only the answers that were already paid off by a
 * completed install, and forget precisely the ones the user would have to give
 * again. So the answer is kept the moment it is given.
 *
 * ─── AND IT IS A HINT, NEVER A SOURCE OF TRUTH ─────────────────────────
 * Nothing installs from this file on its own. A remembered path is offered
 * back as the pre-filled answer to the same question, and only after checking
 * the file is still there — drives get unplugged, folders get tidied, and a
 * silently-wrong path would install the wrong bytes under a compareKey that
 * claims otherwise. If the file is gone, the question is asked again, which is
 * exactly what should happen.
 *
 * The archive is still hashed and verified by the normal path afterwards. This
 * saves the user a file dialog; it does not lower the bar for what gets
 * installed.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fsp from "fs/promises";
import * as path from "path";

export interface RememberedSource {
  /** Absolute path the user chose. */
  path: string;
  /** ISO-8601 UTC, so a stale entry can be reasoned about later. */
  rememberedAt: string;
  /**
   * Size and mtime of the file when the user chose it.
   *
   * The path alone is not enough. A path that still EXISTS is not necessarily
   * the same file — folders get reorganised and names get reused, and a
   * pre-filled answer is the one field nobody re-reads. Offering back a
   * different archive under a compareKey that names a specific sha256 is
   * caught eventually (by archive identity, or by verifying the staged files)
   * but only AFTER installing the wrong mod, and it surfaces as a puzzling
   * verification failure rather than "the file you picked has changed".
   *
   * Same fingerprint the archive hash cache uses — `path|size|mtime` — and
   * cheap for the same reason: one stat, no reading.
   *
   * Optional because entries written before this existed have no fingerprint,
   * and those still work: absent means "cannot compare", which is treated as
   * usable rather than discarded. Forgetting a good answer has a cost too.
   */
  size?: number;
  mtimeMs?: number;
}

/** compareKey → where the user said that mod lives. */
export type SourceMemory = Record<string, RememberedSource>;

export function getSourceMemoryDir(appDataPath: string): string {
  return path.join(appDataPath, "event-horizon", "install-ledger", "sources");
}

function memoryPath(appDataPath: string, packageId: string): string {
  // Per collection, keyed the same way the receipt is: two collections may
  // legitimately reference the same mod from different places.
  return path.join(getSourceMemoryDir(appDataPath), `${packageId}.json`);
}

/** Everything remembered for one collection. Never throws. */
export async function readSourceMemory(
  appDataPath: string,
  packageId: string,
): Promise<SourceMemory> {
  try {
    const raw = await fsp.readFile(memoryPath(appDataPath, packageId), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object") return {};
    const out: SourceMemory = {};
    for (const [key, value] of Object.entries(parsed as SourceMemory)) {
      const p = (value as { path?: unknown })?.path;
      if (typeof p !== "string" || p.length === 0) continue;
      const at = (value as { rememberedAt?: unknown })?.rememberedAt;
      const size = (value as { size?: unknown })?.size;
      const mtimeMs = (value as { mtimeMs?: unknown })?.mtimeMs;
      out[key] = {
        path: p,
        rememberedAt: typeof at === "string" ? at : "",
        ...(typeof size === "number" ? { size } : {}),
        ...(typeof mtimeMs === "number" ? { mtimeMs } : {}),
      };
    }
    return out;
  } catch {
    // No file is the normal case, and an unreadable one must not stop an
    // install — it only means nothing is remembered.
    return {};
  }
}

/**
 * Remember one answer. Never throws.
 *
 * Merges rather than replaces: answers arrive one at a time as the user works
 * through the list, and a write that dropped the others would lose everything
 * said before it.
 */
export async function rememberSource(
  appDataPath: string,
  packageId: string,
  compareKey: string,
  filePath: string,
): Promise<void> {
  try {
    const current = await readSourceMemory(appDataPath, packageId);
    // Best-effort: a file we cannot stat is still worth remembering by path.
    const stat = await fsp.stat(filePath).catch(() => undefined);
    current[compareKey] = {
      path: filePath,
      rememberedAt: new Date().toISOString(),
      ...(stat !== undefined
        ? { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) }
        : {}),
    };
    const dir = getSourceMemoryDir(appDataPath);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      memoryPath(appDataPath, packageId),
      JSON.stringify(current, null, 2),
      "utf8",
    );
  } catch {
    // Losing a convenience is not worth failing an install for.
  }
}

/**
 * The remembered answers whose files are STILL THERE.
 *
 * Existence is checked here rather than trusted, because the failure of a
 * stale path is silent: it would pre-fill an answer the user never re-confirms
 * and install from a file that has since changed or vanished.
 *
 * `exists` is injected so the filtering is testable without a filesystem.
 */
export async function usableSources(
  memory: SourceMemory,
  inspect: (p: string) => Promise<{ size: number; mtimeMs: number } | undefined> =
    async (p) =>
      fsp
        .stat(p)
        .then((st) => ({ size: st.size, mtimeMs: Math.floor(st.mtimeMs) }))
        .catch(() => undefined),
): Promise<SourceMemory> {
  const out: SourceMemory = {};
  for (const [key, value] of Object.entries(memory)) {
    const now = await inspect(value.path);
    if (now === undefined) continue; // gone: ask again
    // No fingerprint recorded (an older entry) means we cannot compare, which
    // is not the same as a mismatch. Keep it.
    const known = value.size !== undefined && value.mtimeMs !== undefined;
    if (known && (now.size !== value.size || now.mtimeMs !== value.mtimeMs)) {
      continue; // same name, different file: ask again
    }
    out[key] = value;
  }
  return out;
}

/**
 * Forget ONE mod's answer.
 *
 * The counterpart to `rememberSource`, and it was missing — which made the
 * memory write-only per mod. `setConflictChoice` records a `use-local-file`
 * pick and returns early for every other choice, so a player who picked a
 * file, was told by the pick-time check that it is NOT the one the collection
 * was built from, and switched that row to "Skip" left the rejected path
 * sitting in the store. The next revision pre-filled it, rendered it as an
 * answered row, and installed the archive they had explicitly refused.
 *
 * Never throws: losing a convenience is not worth failing an install for, and
 * neither is failing to lose one.
 */
export async function forgetOneSource(
  appDataPath: string,
  packageId: string,
  compareKey: string,
): Promise<void> {
  try {
    const current = await readSourceMemory(appDataPath, packageId);
    if (current[compareKey] === undefined) return;
    delete current[compareKey];
    await fsp.mkdir(getSourceMemoryDir(appDataPath), { recursive: true });
    await fsp.writeFile(
      memoryPath(appDataPath, packageId),
      JSON.stringify(current, null, 2),
      "utf8",
    );
  } catch {
    // As above.
  }
}

/** Forget one collection's answers entirely. Never throws. */
export async function forgetSources(
  appDataPath: string,
  packageId: string,
): Promise<void> {
  try {
    await fsp.unlink(memoryPath(appDataPath, packageId));
  } catch {
    // Absent is the normal case.
  }
}
