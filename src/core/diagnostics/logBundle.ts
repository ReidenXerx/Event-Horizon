/**
 * ──────────────────────────────────────────────────────────────────────
 * Every log, in one file someone can send.
 *
 * A tester's machine is only ever seen through what they send back, and
 * "which log? where is it?" is a round of questions nobody answers well. So
 * the Doctor saves one zip holding (the curator's choice):
 *   - every Event Horizon daily log
 *   - Vortex's own log and its rotations (vortex.log, vortex1.log, …) — the
 *     half of a failure that happens inside Vortex
 *   - Event Horizon's small JSON records: install receipts, attempt records,
 *     in-progress markers, journals, quarantine records
 *   - bundle.json: what was included, what could not be read, and the host
 *
 * Nothing is masked (the curator's choice: exact paths diagnose; the file goes
 * to one person). Written to `<name>.partial` and renamed when complete, so a
 * failed save never leaves a broken zip under the name someone will send.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";

import { getInstallLedgerDir } from "../installLedger";
import { getAttemptDir } from "../installer/attemptRecord";
import { getJournalDir } from "../installer/installJournal";
import { getMarkerDir } from "../installer/installMarker";
import { ehLog } from "../logging/ehLog";
import { getEventHorizonDir, getEventHorizonRoot, getVortexUserDataPath, toPosix } from "../paths";
import { writeZip, type ZipSource } from "./zipWriter";

export type LogBundleDirs = {
  /** Vortex's userData folder, where vortex.log and its rotations live. */
  vortexUserData: string;
  /** Event Horizon's own folder. */
  ehRoot: string;
  /** Folders of Event Horizon's JSON records. */
  recordDirs: string[];
};

export type LogBundleSource = { absPath: string; zipName: string; size: number; mtimeMs: number };

const VORTEX_LOG = /^vortex\d*\.log$/i;

export function logBundleDirs(): LogBundleDirs {
  const appData = getVortexUserDataPath();
  return {
    vortexUserData: appData,
    ehRoot: getEventHorizonRoot(),
    recordDirs: [
      getInstallLedgerDir(appData),
      getMarkerDir(appData),
      getAttemptDir(appData),
      getJournalDir(appData),
      getEventHorizonDir("quarantine"),
    ],
  };
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: import("fs").Dirent[];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) out.push(full);
    }
  }
  return out.sort();
}

export async function collectLogSources(dirs: LogBundleDirs): Promise<LogBundleSource[]> {
  const seen = new Set<string>();
  const out: LogBundleSource[] = [];
  const add = async (absPath: string, zipName: string): Promise<void> => {
    const key = path.resolve(absPath).toLowerCase();
    if (seen.has(key)) return;
    try {
      const st = await fsp.stat(absPath);
      seen.add(key);
      out.push({ absPath, zipName, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
    } catch {
      // Vanished between listing and stat: nothing to include.
    }
  };
  const inEh = (file: string, fallbackFolder: string): string => {
    const rel = path.relative(dirs.ehRoot, file);
    return rel.startsWith("..") || path.isAbsolute(rel)
      ? `records/${fallbackFolder}/${path.basename(file)}`
      : `event-horizon/${toPosix(rel)}`;
  };

  for (const file of await filesUnder(path.join(dirs.ehRoot, "logs"))) await add(file, inEh(file, "logs"));
  let names: string[] = [];
  try {
    names = await fsp.readdir(dirs.vortexUserData);
  } catch {
    names = [];
  }
  for (const name of names.filter((n) => VORTEX_LOG.test(n)).sort()) {
    await add(path.join(dirs.vortexUserData, name), `vortex/${name}`);
  }
  for (const dir of dirs.recordDirs) {
    for (const file of await filesUnder(dir)) await add(file, inEh(file, path.basename(dir)));
  }
  return out;
}

export async function writeLogBundle(args: {
  filePath: string;
  extensionVersion: string;
  sources: readonly LogBundleSource[];
  now?: Date;
}): Promise<{ filePath: string; files: number; bytes: number; skipped: Array<{ name: string; error: string }> }> {
  const partial = `${args.filePath}.partial`;
  const unreadable: Array<{ name: string; error: string }> = [];
  function* entries(): Generator<ZipSource> {
    for (const s of args.sources) {
      yield {
        name: s.zipName,
        mtime: new Date(s.mtimeMs),
        read: async () => {
          try {
            return await fsp.readFile(s.absPath);
          } catch (err) {
            unreadable.push({ name: s.zipName, error: err instanceof Error ? err.message : String(err) });
            throw err;
          }
        },
      };
    }
    // Last, so it can say what could not be read.
    yield {
      name: "bundle.json",
      read: async () =>
        Buffer.from(
          JSON.stringify(
            {
              schema: "event-horizon.log-bundle/1",
              generatedAt: (args.now ?? new Date()).toISOString(),
              extension: { name: "vortex-event-horizon", version: args.extensionVersion },
              host: {
                platform: process.platform,
                arch: process.arch,
                osRelease: os.release(),
                node: process.version,
                electron: process.versions["electron"],
              },
              files: args.sources.map((s) => ({ name: s.zipName, source: s.absPath, size: s.size, mtimeMs: s.mtimeMs })),
              unreadable,
            },
            null,
            2,
          ),
          "utf8",
        ),
    };
  }

  try {
    const result = await writeZip(partial, entries());
    await fsp.rename(partial, args.filePath);
    ehLog(result.skipped.length === 0 ? "info" : "warn", "log-bundle.saved", {
      filePath: args.filePath,
      files: result.entries,
      bytes: result.bytes,
      skipped: result.skipped,
    });
    return { filePath: args.filePath, files: result.entries, bytes: result.bytes, skipped: result.skipped };
  } catch (err) {
    await fsp.unlink(partial).catch(() => undefined);
    ehLog("error", "log-bundle.failed", { filePath: args.filePath, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
