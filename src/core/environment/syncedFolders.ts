/**
 * Folders a cloud client uploads everything from, as this machine reports them.
 *
 * OneDrive sets one environment variable per kind of account signed in:
 * `OneDrive` for the default one, `OneDriveConsumer` for a personal account,
 * `OneDriveCommercial` for work or school. Dropbox sets none, and documents
 * `info.json` under %APPDATA% or %LOCALAPPDATA% as the way to find its folder.
 * Google Drive keeps its folder in a database, so it is not read here, which is
 * why the check names only the two clients it knows.
 */

import * as path from "path";

import type { SyncedRoot } from "./environmentChecks";

const ONEDRIVE_VARIABLES = ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"] as const;

/**
 * @param env the process environment (on Windows, `process.env` looks names up case-insensitively)
 * @param readText a file's text, or undefined when it cannot be read
 */
export function syncedFolderRoots(
  env: Readonly<Record<string, string | undefined>>,
  readText: (file: string) => string | undefined,
): SyncedRoot[] {
  const out: SyncedRoot[] = [];
  const seen = new Set<string>();
  const add = (service: SyncedRoot["service"], folder: unknown): void => {
    if (typeof folder !== "string" || folder.trim().length === 0) return;
    // OneDrive and OneDriveConsumer usually name the same folder.
    const key = folder.replace(/[\\/]+/g, "\\").replace(/\\$/, "").toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ service, path: folder });
  };
  for (const name of ONEDRIVE_VARIABLES) add("OneDrive", env[name]);
  for (const base of [env["APPDATA"], env["LOCALAPPDATA"]]) {
    if (base === undefined || base.trim().length === 0) continue;
    const text = readText(path.win32.join(base, "Dropbox", "info.json"));
    if (text === undefined) continue;
    let accounts: unknown;
    try {
      accounts = JSON.parse(text);
    } catch {
      continue;
    }
    if (accounts === null || typeof accounts !== "object") continue;
    // { "personal": { "path": "C:\\Users\\x\\Dropbox", ... }, "business": { "path": ... } }
    for (const account of Object.values(accounts as Record<string, unknown>)) {
      if (account !== null && typeof account === "object") add("Dropbox", (account as { path?: unknown }).path);
    }
  }
  return out;
}
