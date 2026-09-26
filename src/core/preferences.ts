/**
 * Event Horizon's own user preferences: one small JSON file,
 *   <Vortex userData>/event-horizon/preferences.json
 *
 * A file rather than a persistent reducer, for the reason `draftStorage.ts`
 * gives: EH keeps its state out of Vortex's store. It is read synchronously
 * because it is tiny and read at startup, before anything else could race it.
 *
 * Every read tolerates a missing or broken file and returns the defaults: a
 * preference file must never be the reason Event Horizon fails to start.
 */

import * as fs from "fs";
import * as path from "path";

import { getEventHorizonRoot } from "./paths/appDataPaths";

export interface EhPreferences {
  /** The local control channel for agents (off unless the user turns it on). */
  controlChannel: { enabled: boolean };
  /** One-time notices already shown, by id. Shown once per user, ever. */
  shownOnce: Record<string, true>;
}

export const DEFAULT_PREFERENCES: EhPreferences = {
  controlChannel: { enabled: false },
  shownOnce: {},
};

export function preferencesPath(root: string = getEventHorizonRoot()): string {
  return path.join(root, "preferences.json");
}

/** Merges whatever the file holds over the defaults; anything malformed falls back per field. */
export function parsePreferences(raw: unknown): EhPreferences {
  const obj = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const cc = obj.controlChannel as { enabled?: unknown } | undefined;
  const shown = obj.shownOnce as Record<string, unknown> | undefined;
  const shownOnce: Record<string, true> = {};
  if (shown !== null && typeof shown === "object") {
    for (const [k, v] of Object.entries(shown)) if (v === true) shownOnce[k] = true;
  }
  return {
    controlChannel: { enabled: cc?.enabled === true },
    shownOnce,
  };
}

export function loadPreferences(file: string = preferencesPath()): EhPreferences {
  try {
    return parsePreferences(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return parsePreferences({});
  }
}

/** Read-modify-write, so two callers changing different fields do not undo each other. */
export function updatePreferences(
  change: (prefs: EhPreferences) => EhPreferences,
  file: string = preferencesPath(),
): EhPreferences {
  const next = change(loadPreferences(file));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return next;
}
