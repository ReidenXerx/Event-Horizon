/**
 * ──────────────────────────────────────────────────────────────────────
 * A full diagnostic snapshot of one game setup, for someone who cannot see it.
 *
 * Testers are remote, and "it doesn't work" cannot be diagnosed from a receipt.
 * This writes everything that decides whether a collection works, so the answer
 * comes from reading the file rather than from a round of questions:
 *
 *   summary    the preflight verdicts and the folder findings, first, so a
 *              truncated file still carries the conclusions
 *   vortex     discovery record, store, executable, deployment method,
 *              staging root, automation settings, profile
 *   preflight  every check with its evidence (preflight.ts)
 *   texts      plugins.txt, loadorder.txt, ContentCatalog.txt, the game's INIs,
 *              Vortex's deployment manifests, today's Event Horizon log
 *   receipts   every install receipt for the game, and quarantine records
 *   files      EVERY file in the game folder and in Vortex's staging folder:
 *              path, size, mtime — plus SHA-256 for the files whose exact
 *              bytes decide behaviour (exe, dll, asi, plugins, ini, archives)
 *
 * Size is not a constraint (NS-1); the file is streamed so memory is. A file
 * reached twice through hard links — Vortex's usual deployment — is hashed once.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";

import { selectors } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";

import { hashFileSha256 } from "../archiveHashing";
import { listReceipts } from "../installLedger";
import { ehLog, getLogFilePath } from "../logging/ehLog";
import { getEventHorizonDir, getVortexUserDataPath } from "../paths";
import { resolveDeploymentMethod, resolveVortexVersion } from "../resolver/userState";
import { installRootFor } from "../stagingPath";
import { groupEntries, walkFolder, type FolderEntry } from "./gameFolderScan";
import { runEnvironmentPreflight } from "./preflight";
import { listQuarantines } from "./quarantine";
import { gatherPreflightFacts, readDiscovery } from "./vortexEnvironment";

const SCHEMA = "event-horizon.snapshot/1";

/** Extensions whose exact bytes decide behaviour. */
export const HASHED_EXTENSIONS: ReadonlySet<string> = new Set([
  ".exe",
  ".dll",
  ".asi",
  ".esp",
  ".esm",
  ".esl",
  ".ini",
  ".ba2",
  ".bsa",
]);

export function shouldHash(relPath: string): boolean {
  return HASHED_EXTENSIONS.has(path.extname(relPath).toLowerCase());
}

export type SnapshotProgress = {
  phase: "preflight" | "texts" | "game-files" | "staging-files" | "done";
  done: number;
  total?: number;
  current?: string;
};

export type SnapshotResult = {
  filePath: string;
  gameFiles: number;
  stagingFiles: number;
  hashed: number;
  bytes: number;
  elapsedMs: number;
};

async function readText(p: string, encoding: BufferEncoding = "utf8"): Promise<string | null> {
  try {
    return await fsp.readFile(p, encoding);
  } catch {
    return null;
  }
}

export async function writeEnvironmentSnapshot(args: {
  api: types.IExtensionApi;
  gameId: string;
  filePath: string;
  extensionVersion: string;
  signal?: AbortSignal;
  onProgress?: (p: SnapshotProgress) => void;
}): Promise<SnapshotResult> {
  const startedAt = Date.now();
  const { api, gameId, signal } = args;
  const progress = args.onProgress ?? ((): void => undefined);
  const checkAbort = (): void => {
    if (signal?.aborted) throw new Error("Snapshot cancelled");
  };
  const state = api.getState();
  ehLog("info", "snapshot.start", { gameId, filePath: args.filePath });

  // ── preflight (with the full folder scan) ──────────────────────────────
  progress({ phase: "preflight", done: 0 });
  const facts = gatherPreflightFacts({ state, gameId });
  const report = await runEnvironmentPreflight(facts, {
    scanFolder: true,
    context: "snapshot",
    ...(signal !== undefined ? { signal } : {}),
  });
  checkAbort();

  const out = fs.createWriteStream(args.filePath, { encoding: "utf8" });
  let streamError: Error | undefined;
  out.on("error", (err) => {
    streamError = err;
  });
  const write = (s: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (streamError !== undefined) {
        reject(streamError);
        return;
      }
      if (out.write(s)) resolve();
      else out.once("drain", () => resolve());
    });
  const field = async (name: string, value: unknown, last = false): Promise<void> => {
    await write(`${JSON.stringify(name)}:${JSON.stringify(value ?? null)}${last ? "" : ","}\n`);
  };

  let gameFiles = 0;
  let stagingFiles = 0;
  let hashed = 0;
  try {
    await write("{\n");
    await field("schema", SCHEMA);
    await field("generatedAt", new Date().toISOString());
    await field("extension", { name: "vortex-event-horizon", version: args.extensionVersion });

    const folder = report.folder?.report;
    await field("summary", {
      gameId,
      gameName: report.gameName,
      gameDir: report.gameDir,
      store: report.store,
      verdicts: report.checks.map((c) => ({ id: c.id, status: c.status, title: c.title })),
      unmanagedFiles: folder?.unmanaged.length,
      unmanagedGroups: folder !== undefined ? groupEntries(folder.unmanaged).slice(0, 100) : undefined,
      vanilla: folder?.vanilla,
      vanillaMissing: folder?.vanillaMissing.length,
      vanillaSizeMismatch: folder?.vanillaSizeMismatch.length,
      deployedFiles: report.folder?.deployedCount,
    });

    await field("host", {
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      cpus: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      node: process.version,
      electron: process.versions["electron"],
      wine: facts.wine,
      env: {
        ProgramFiles: process.env["ProgramFiles"],
        "ProgramFiles(x86)": process.env["ProgramFiles(x86)"],
        LOCALAPPDATA: process.env["LOCALAPPDATA"],
      },
    });

    const typedState = state as types.IState;
    const profileId = selectors.activeProfileId(typedState);
    const known = (state as { session?: { gameMode?: { known?: unknown[] } } })?.session?.gameMode?.known;
    const knownGame = Array.isArray(known)
      ? (known as Array<Record<string, unknown>>).find((g) => g?.["id"] === gameId)
      : undefined;
    await field("vortex", {
      version: safe(() => resolveVortexVersion(typedState)),
      activeGameId: safe(() => selectors.activeGameId(typedState)),
      activeProfileId: profileId,
      activeProfile: safe(() => {
        const p = (state as { persistent?: { profiles?: Record<string, { name?: unknown; gameId?: unknown }> } })
          ?.persistent?.profiles?.[profileId ?? ""];
        return p === undefined ? undefined : { name: p.name, gameId: p.gameId };
      }),
      discovery: (state as { settings?: { gameMode?: { discovered?: Record<string, unknown> } } })?.settings?.gameMode
        ?.discovered?.[gameId],
      discoveryView: readDiscovery(state, gameId),
      knownGame:
        knownGame === undefined
          ? undefined
          : {
              id: knownGame["id"],
              name: knownGame["name"],
              executable: knownGame["executable"],
              requiredFiles: knownGame["requiredFiles"],
              details: knownGame["details"],
            },
      executableResolved: facts.executable,
      deploymentMethod: safe(() => resolveDeploymentMethod(typedState, gameId)),
      stagingRoot: safe(() => installRootFor(typedState, gameId)),
      automation: (state as { settings?: { automation?: unknown } })?.settings?.automation,
      modsInPool: Object.keys(
        ((state as { persistent?: { mods?: Record<string, Record<string, unknown>> } })?.persistent?.mods?.[gameId] ??
          {}) as Record<string, unknown>,
      ).length,
    });

    await field("preflight", report);

    // ── texts ────────────────────────────────────────────────────────────
    progress({ phase: "texts", done: 0 });
    const texts: Record<string, string | null> = {};
    if (facts.localGameDir !== undefined) {
      for (const name of ["plugins.txt", "loadorder.txt", "ContentCatalog.txt", "DLCList.txt"]) {
        // plugins.txt is latin1 (see comparePlugins.ts); the rest are ASCII or JSON.
        texts[path.join(facts.localGameDir, name)] = await readText(
          path.join(facts.localGameDir, name),
          name === "plugins.txt" ? "latin1" : "utf8",
        );
      }
    }
    // The INI folder the launcher check used — store-specific (gameIni.ts).
    const iniDir = facts.prefsPath !== undefined ? path.dirname(facts.prefsPath) : undefined;
    if (iniDir !== undefined) {
      try {
        for (const name of await fsp.readdir(iniDir)) {
          if (name.toLowerCase().endsWith(".ini")) texts[path.join(iniDir, name)] = await readText(path.join(iniDir, name));
        }
      } catch {
        texts[iniDir] = null;
      }
    }
    if (report.gameDir !== undefined) {
      for (const m of report.folder?.manifests ?? []) {
        texts[path.join(report.gameDir, m.file)] = await readText(path.join(report.gameDir, m.file));
      }
    }
    const logPath = getLogFilePath();
    if (logPath !== undefined) texts[logPath] = await readText(logPath);
    await field("prefsPath", facts.prefsPath);
    await field("texts", texts);
    checkAbort();

    const appDataPath = getVortexUserDataPath();
    const receipts = await listReceipts(appDataPath).catch(() => []);
    await field(
      "receipts",
      receipts.filter((r) => r.gameId === gameId),
    );
    await field(
      "quarantines",
      (await listQuarantines(getEventHorizonDir("quarantine"))).map((q) => ({ ...q.record, recordPath: q.recordPath })),
    );

    // ── files ────────────────────────────────────────────────────────────
    const hashCache = new Map<string, string>();
    const writeFiles = async (
      root: string | undefined,
      phase: "game-files" | "staging-files",
    ): Promise<number> => {
      await write("[\n");
      if (root === undefined) {
        await write("]");
        return 0;
      }
      const walk = await walkFolder(root, { loadSurfaceOnly: false, ...(signal !== undefined ? { signal } : {}) });
      const total = walk.entries.length;
      let first = true;
      let done = 0;
      for (const entry of walk.entries) {
        checkAbort();
        const sha = shouldHash(entry.path) ? await hashOnce(root, entry, hashCache, signal) : null;
        if (sha !== null) hashed += 1;
        await write(`${first ? "" : ",\n"}${JSON.stringify([entry.path, entry.size, entry.mtimeMs, sha])}`);
        first = false;
        done += 1;
        if (done % 500 === 0 || sha !== null) progress({ phase, done, total, current: entry.path });
      }
      if (walk.unreadable.length > 0) {
        await write(`${first ? "" : ",\n"}${JSON.stringify(["<unreadable>", walk.unreadable])}`);
      }
      await write("\n]");
      return total;
    };

    await write(`"fileColumns":["path","size","mtimeMs","sha256"],\n`);
    await write(`"gameRoot":${JSON.stringify(report.gameDir ?? null)},\n"gameFiles":`);
    gameFiles = await writeFiles(report.gameDir, "game-files");
    const stagingRoot = safe(() => installRootFor(typedState, gameId));
    await write(`,\n"stagingRoot":${JSON.stringify(stagingRoot ?? null)},\n"stagingFiles":`);
    stagingFiles = await writeFiles(stagingRoot, "staging-files");
    await write("\n}\n");
  } finally {
    await new Promise<void>((resolve) => out.end(() => resolve()));
  }
  if (streamError !== undefined) throw streamError;

  const bytes = (await fsp.stat(args.filePath)).size;
  const result: SnapshotResult = {
    filePath: args.filePath,
    gameFiles,
    stagingFiles,
    hashed,
    bytes,
    elapsedMs: Date.now() - startedAt,
  };
  progress({ phase: "done", done: gameFiles + stagingFiles });
  ehLog("info", "snapshot.done", result);
  return result;
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

async function hashOnce(
  root: string,
  entry: FolderEntry,
  cache: Map<string, string>,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  const full = path.join(root, entry.path);
  try {
    const st = await fsp.stat(full, { bigint: true });
    const key = st.ino !== BigInt(0) ? `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}` : undefined;
    if (key !== undefined) {
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
    }
    const sha = await hashFileSha256(full, signal);
    if (key !== undefined) cache.set(key, sha);
    return sha;
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
}
