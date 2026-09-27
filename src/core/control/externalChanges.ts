/**
 * Vortex's "External Changes" dialog, for the control channel.
 *
 * Before a deploy or purge, Vortex compares the game folder with what it last
 * deployed. Files changed outside Vortex (a mod's settings file the game wrote,
 * a file deleted by hand) are put to the user in this dialog, and the deploy
 * WAITS on it. It is not a notification dialog: its state is
 * `session.mods.changes` (IFileEntry[]), shown while non-empty, so the
 * control channel's `openDialogs` never saw it, and a deploy behind it hung
 * until the socket gave up (skyrim-collection, 2026-09-27).
 *
 * Read out of app.asar (mod_management/views/ExternalChangeDialog):
 *   - per-file answers: action SET_EXTERNAL_CHANGE_ACTION {filePaths, action}
 *   - Confirm / Cancel: the buttons #btn-confirm-activation /
 *     #btn-cancel-activation. The thunk behind them (confirmExternalChanges)
 *     resolves a promise private to Vortex, and Vortex does not export it to
 *     extensions, so the button is the only door.
 *   - Confirm with more than one "delete" opens a notification dialog
 *     "Confirm deletion" [Back, Continue].
 */

import * as fs from "fs";
import * as path from "path";

/** Vortex's four kinds of change, and the answers its dialog offers for each. */
const CHOICES: Record<string, Partial<Record<Choice, string>>> = {
  // The deployed file's content changed (e.g. the game wrote it).
  refchange: { revert: "drop", save: "import", newer: "newest" },
  // Only the recorded value changed; Vortex offers "Save" alone.
  valchange: { save: "nop" },
  // The deployed file (link) was deleted.
  deleted: { revert: "restore", save: "delete" },
  // The staging (source) file was deleted.
  srcdeleted: { revert: "import", save: "drop" },
};

const PLAIN: Record<string, string> = {
  refchange: "modified in the game folder",
  valchange: "recorded value changed",
  deleted: "deleted from the game folder",
  srcdeleted: "deleted from the mod's staging folder",
};

export type Choice = "revert" | "save" | "newer";
export const CHOICE_WORDS: readonly Choice[] = ["revert", "save", "newer"];

type Entry = {
  modTypeId?: string;
  filePath: string;
  source: string;
  type: string;
  action: string;
  sourceModified?: unknown;
  destModified?: unknown;
};

export function readChanges(state: unknown): Entry[] {
  const list = (state as { session?: { mods?: { changes?: unknown } } })?.session?.mods?.changes;
  return Array.isArray(list) ? (list as Entry[]).filter((e) => typeof e?.filePath === "string") : [];
}

const choiceOf = (type: string, action: string): Choice | undefined =>
  (Object.entries(CHOICES[type] ?? {}) as Array<[Choice, string]>).find(([, a]) => a === action)?.[0];

/** Where a mod's files are deployed and staged, so the report can say whether the two are the same file. */
export type Locate = (entry: Entry) => { staged?: string; deployed?: string } | undefined;

function sameFile(a: string | undefined, b: string | undefined): boolean | undefined {
  if (a === undefined || b === undefined) return undefined;
  try {
    const x = fs.statSync(a, { bigint: true });
    const y = fs.statSync(b, { bigint: true });
    return x.ino !== BigInt(0) && x.ino === y.ino && x.dev === y.dev;
  } catch {
    return undefined;
  }
}

/**
 * The dialog as an agent reads it, or undefined when it is not open.
 * `sameFile: true` means the deployed file and the staged file are one file
 * (a hardlink): whatever changed it, changed both, and "newer" loses nothing.
 */
export function describeExternalChanges(
  state: unknown,
  modIdBySource: (source: string) => string | undefined,
  locate?: Locate,
): Record<string, unknown> | undefined {
  const changes = readChanges(state);
  if (changes.length === 0) return undefined;
  const bySource = new Map<string, Entry[]>();
  for (const c of changes) bySource.set(c.source, [...(bySource.get(c.source) ?? []), c]);
  return {
    type: "external-changes",
    title: "External Changes",
    note:
      "Vortex found mod files changed outside it and is WAITING for an answer before it deploys. " +
      "Answer with externalChanges.answer; nothing deploys until then.",
    files: changes.length,
    mods: [...bySource.entries()].map(([source, files]) => ({
      mod: source,
      ...(modIdBySource(source) !== undefined ? { modId: modIdBySource(source) } : {}),
      files: files.map((f) => {
        const where = locate?.(f);
        const same = sameFile(where?.staged, where?.deployed);
        return {
          path: f.filePath,
          change: PLAIN[f.type] ?? f.type,
          kind: f.type,
          choices: Object.keys(CHOICES[f.type] ?? {}),
          current: choiceOf(f.type, f.action) ?? f.action,
          ...(same !== undefined ? { sameFile: same } : {}),
        };
      }),
    })),
  };
}

export type AnswerPlan = { actions: Array<{ filePaths: string[]; action: string }>; problems: string[] };

/**
 * Pure: the Vortex actions that carry out an answer. `all` applies to every
 * file; `mods` (by staging folder name or mod id) and `files` (by path)
 * override it. A file left with no answer keeps Vortex's default.
 */
export function planAnswer(
  changes: readonly Entry[],
  answer: { all?: string; mods?: Record<string, string>; files?: Record<string, string> },
  modIdBySource: (source: string) => string | undefined,
): AnswerPlan {
  const problems: string[] = [];
  const grouped = new Map<string, string[]>();
  const words = [answer.all, ...Object.values(answer.mods ?? {}), ...Object.values(answer.files ?? {})];
  for (const w of words) {
    if (w !== undefined && !CHOICE_WORDS.includes(w as Choice)) problems.push(`"${w}" is not an answer; use revert, save or newer.`);
  }
  if (problems.length > 0) return { actions: [], problems };
  for (const c of changes) {
    const modId = modIdBySource(c.source);
    const word =
      answer.files?.[c.filePath] ??
      answer.mods?.[c.source] ??
      (modId !== undefined ? answer.mods?.[modId] : undefined) ??
      answer.all;
    if (word === undefined) continue;
    const action = CHOICES[c.type]?.[word as Choice];
    if (action === undefined) {
      problems.push(
        `${c.filePath} (${c.source}) was ${PLAIN[c.type] ?? c.type}; "${word}" is not offered for that. ` +
          `Offered: ${Object.keys(CHOICES[c.type] ?? {}).join(", ")}.`,
      );
      continue;
    }
    if (c.action === action) continue;
    grouped.set(action, [...(grouped.get(action) ?? []), c.filePath]);
  }
  return { actions: [...grouped.entries()].map(([action, filePaths]) => ({ action, filePaths })), problems };
}

/** Clicks one of the dialog's footer buttons. False when the dialog is not on screen. */
export function clickDialogButton(which: "confirm" | "cancel"): boolean {
  const doc = (globalThis as { document?: { getElementById?: (id: string) => { click?: () => void } | null } }).document;
  const button = doc?.getElementById?.(which === "confirm" ? "btn-confirm-activation" : "btn-cancel-activation");
  if (button?.click === undefined) return false;
  button.click();
  return true;
}

/** Where a change's files live, for the default mod type (the game's Data folder). */
export function locateDefault(stagingRoot: string | undefined, deployRoot: string | undefined): Locate {
  return (e) =>
    stagingRoot === undefined || deployRoot === undefined || (e.modTypeId ?? "") !== ""
      ? undefined
      : { staged: path.join(stagingRoot, e.source, e.filePath), deployed: path.join(deployRoot, e.filePath) };
}
