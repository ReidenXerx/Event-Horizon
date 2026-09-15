/**
 * Where a collection's changelog history lives between builds.
 *
 * `<configDir>/.changelog/<slug>.json`, and deliberately NOT beside the config
 * as `<slug>.changelog.json`: every `*.json` directly in the config folder is
 * read as a collection config, so a history file there would show up on the
 * dashboard as a broken collection.
 *
 * Losing this file costs little. The next build falls back to the newest
 * package on disk, whose manifest carries the whole history, so reading is
 * forgiving: a missing or damaged file is logged and treated as absent, never
 * allowed to fail a build.
 */

import * as fsp from "fs/promises";
import * as path from "path";

import { ehLog } from "../logging/ehLog";
import {
  readChangelogEntries,
  type ChangelogHistory,
  type ChangelogSnapshot,
} from "./changelog";

export function changelogHistoryPath(configDir: string, slug: string): string {
  return path.join(configDir, ".changelog", `${slug}.json`);
}

/** A snapshot only when it has every list the diff walks. */
function snapshotOrUndefined(raw: unknown): ChangelogSnapshot | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const s = raw as Record<string, unknown>;
  const lists = [
    "requiredExtensions",
    "mods",
    "plugins",
    "loadOrder",
    "rules",
    "iniTweaks",
    "gameIni",
    "externalDependencies",
  ];
  if (s.schema !== 1 || typeof s.version !== "string") return undefined;
  if (s.game === null || typeof s.game !== "object") return undefined;
  if (!lists.every((k) => Array.isArray(s[k]))) return undefined;
  return raw as ChangelogSnapshot;
}

export async function loadChangelogHistory(
  configDir: string,
  slug: string,
): Promise<ChangelogHistory | undefined> {
  const file = changelogHistoryPath(configDir, slug);
  let raw: string;
  try {
    raw = await fsp.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      ehLog("warn", "changelog.history.read-failed", { file: path.basename(file), err });
    }
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    ehLog("warn", "changelog.history.invalid-json", { file: path.basename(file), err });
    return undefined;
  }
  const obj = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  if (obj === undefined || obj.schema !== 1 || !Array.isArray(obj.entries)) {
    ehLog("warn", "changelog.history.unrecognised", { file: path.basename(file) });
    return undefined;
  }
  const entries = readChangelogEntries(obj.entries)?.entries ?? [];
  const last = snapshotOrUndefined(obj.last);
  const beforeLast = snapshotOrUndefined(obj.beforeLast);
  return {
    schema: 1,
    entries,
    ...(last !== undefined ? { last } : {}),
    ...(beforeLast !== undefined ? { beforeLast } : {}),
  };
}

/** Written beside itself first and then moved over, so a crash never leaves half a file. */
export async function saveChangelogHistory(
  configDir: string,
  slug: string,
  history: ChangelogHistory,
): Promise<void> {
  const file = changelogHistoryPath(configDir, slug);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const partial = `${file}.partial`;
  await fsp.writeFile(partial, JSON.stringify(history), "utf8");
  await fsp.rename(partial, file);
}
