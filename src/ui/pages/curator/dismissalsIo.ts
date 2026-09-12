/**
 * Where dismissed requirements live on disk: Event Horizon's own folder, one
 * file for every game (each entry is keyed by a Nexus domain and mod id, so
 * games cannot collide).
 *
 * Not a mod attribute in Vortex: an update installs the mod anew, and a
 * dismissal kept on the old install would vanish with it — the curator chose
 * that a dismissal survives updates and returns only when Nexus changes the
 * requirement. Written to a partial file and renamed, so a crash mid-write
 * leaves the previous dismissals rather than half a file.
 */

import * as fsp from "fs/promises";
import * as path from "path";

import { getEventHorizonDir } from "../../../core/paths";
import { ehLog } from "../../../core/logging/ehLog";
import {
  EMPTY_DISMISSALS,
  parseDismissals,
  serializeDismissals,
  type DismissalStore,
} from "../../../core/curator/requirementDismissals";

export function dismissalsFilePath(): string {
  return getEventHorizonDir("curator", "dismissed-requirements.json");
}

function entryCount(store: DismissalStore): number {
  return Object.values(store.pages).reduce((n, page) => n + Object.keys(page).length, 0);
}

export async function readDismissals(file: string = dismissalsFilePath()): Promise<DismissalStore> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      ehLog("warn", "curator.dismissals.read-fail", { file, err });
    }
    return EMPTY_DISMISSALS;
  }
  const store = parseDismissals(raw);
  ehLog("info", "curator.dismissals.read", { file, pages: Object.keys(store.pages).length, entries: entryCount(store) });
  return store;
}

export async function writeDismissals(store: DismissalStore, file: string = dismissalsFilePath()): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const partial = `${file}.partial`;
  await fsp.writeFile(partial, serializeDismissals(store), "utf8");
  await fsp.rename(partial, file);
  ehLog("info", "curator.dismissals.write", { file, pages: Object.keys(store.pages).length, entries: entryCount(store) });
}
