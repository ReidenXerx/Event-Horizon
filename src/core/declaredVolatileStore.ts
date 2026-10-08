/**
 * Where curator-declared volatile files are remembered between sessions.
 *
 * A package declares them (`state.volatileFiles`) and reading it declares them
 * for this session; this keeps them for the next one, so the Doctor or an
 * update check that runs before any package is read still skips them. The
 * list only grows: a path a curator once said is generated for each machine
 * stays generated (see `volatileFiles.ts`).
 */

import * as fs from "fs";
import * as path from "path";

import type { EhcollManifest } from "../types/ehcoll";
import { ehLog } from "./logging/ehLog";
import { getEventHorizonDir } from "./paths/appDataPaths";
import { declareVolatileFiles, declaredVolatileFiles } from "./volatileFiles";

function storeFile(): string {
  return getEventHorizonDir("volatile-files.json");
}

/** Read the remembered list into this session. Never throws. */
export function loadDeclaredVolatileFiles(file: string = storeFile()): number {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { files?: unknown };
    const files = Array.isArray(raw.files) ? raw.files.filter((f): f is string => typeof f === "string") : [];
    const added = declareVolatileFiles(files);
    ehLog("info", "volatile.declared.loaded", { files: files.length, added });
    return added;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      ehLog("warn", "volatile.declared.load-failed", { err: String(err) });
    }
    return 0;
  }
}

/** Declare paths for this session and remember them. Never throws. */
export function rememberDeclaredVolatileFiles(paths: readonly string[], file: string = storeFile()): number {
  const added = declareVolatileFiles(paths);
  if (added === 0) return 0;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ files: declaredVolatileFiles() }, null, 2), "utf8");
    ehLog("info", "volatile.declared.saved", { added, files: declaredVolatileFiles().length });
  } catch (err) {
    ehLog("warn", "volatile.declared.save-failed", { err: String(err) });
  }
  return added;
}

/** Every path a package's mods declare. */
export function volatileFilesOf(manifest: Pick<EhcollManifest, "mods">): string[] {
  return manifest.mods.flatMap((m) => m.state?.volatileFiles ?? []);
}
