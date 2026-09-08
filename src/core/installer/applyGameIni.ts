/**
 * ──────────────────────────────────────────────────────────────────────
 * Writing the collection's game settings into the user's INI files.
 *
 * Three rules, and they come from what a user actually wants:
 *
 *  1. **Say what was changed.** Editing someone's game configuration silently
 *     is not acceptable even when it is correct. Every applied key is reported
 *     with its old and new value.
 *
 *  2. **Once, on install or update.** Not on every launch, not on a re-check.
 *     The collection states a starting configuration; it does not own the file
 *     forever.
 *
 *  3. **The user wins afterwards.** If they change a setting later, that is
 *     the end of it — nothing here re-asserts the curator's value, and that is
 *     why (2) matters: a re-apply would silently undo their edit.
 *
 * ## Surgical, not a rewrite
 *
 * The merge edits the lines it is changing and leaves the rest of the file
 * byte-for-byte alone. Comments survive, unknown keys survive, ordering
 * survives, and the user's own settings that the collection says nothing about
 * survive. Rewriting the file from a parsed model would be far simpler and
 * would quietly discard every comment and hand-tuned key the user has.
 *
 * A key that does not exist yet is appended to its section — creating the
 * section at the end of the file if it is absent.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fsp from "fs/promises";
import * as path from "path";

import { ehLog, beginOp } from "../logging/ehLog";
import { iniLocationFor, isMachineOwned } from "../manifest/gameIni";
import type { EhcollGameIni } from "../../types/ehcoll";
import type { GameIniApplicationReceipt } from "../../types/installLedger";

/** A setting to write. Matches the manifest's shape. */
export type IniAssignment = {
  section: string;
  key: string;
  value: string;
};

/** What one key did. `before === undefined` means it was not there. */
export type IniChange = {
  section: string;
  key: string;
  before?: string;
  after: string;
};

export type MergeResult = {
  text: string;
  /** Keys whose value the merge altered or added. */
  changed: IniChange[];
  /** Keys already at the wanted value — reported so counts are honest. */
  unchanged: number;
};

const isSectionHeader = (line: string): string | undefined => {
  const t = line.trim();
  if (!t.startsWith("[")) return undefined;
  const close = t.indexOf("]");
  return close > 0 ? t.slice(1, close).trim() : t.slice(1).trim();
};

const keyOf = (line: string): string | undefined => {
  const t = line.trim();
  if (t.length === 0 || t.startsWith(";") || t.startsWith("#") || t.startsWith("[")) {
    return undefined;
  }
  const eq = t.indexOf("=");
  return eq > 0 ? t.slice(0, eq).trim() : undefined;
};

/**
 * Apply assignments to INI text, touching only the lines that change.
 *
 * Pure: no I/O, so the interesting cases (a duplicate key, a missing section,
 * a file that ends without a newline) are testable without a game installed.
 *
 * Where a key appears more than once in a section, the LAST occurrence is
 * rewritten — that is the one the game reads, and rewriting an earlier one
 * would change nothing while reporting that it had.
 */
export function mergeIniText(
  original: string,
  assignments: readonly IniAssignment[],
): MergeResult {
  const usesCrlf = original.includes("\r\n");
  const newline = usesCrlf ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);

  const changed: IniChange[] = [];
  let unchanged = 0;

  // Where each (section, key) last occurs, and where each section ends.
  const lastIndexOf = new Map<string, number>();
  const sectionEnd = new Map<string, number>();
  let current = "";
  lines.forEach((line, i) => {
    const header = isSectionHeader(line);
    if (header !== undefined) {
      current = header;
      sectionEnd.set(current.toLowerCase(), i);
      return;
    }
    const key = keyOf(line);
    if (key === undefined) return;
    lastIndexOf.set(`${current.toLowerCase()}\u0000${key.toLowerCase()}`, i);
    sectionEnd.set(current.toLowerCase(), i);
  });

  // Appends are collected and inserted afterwards, so indexes stay valid
  // while we edit in place.
  const appends = new Map<string, IniAssignment[]>();

  for (const assignment of assignments) {
    const at = lastIndexOf.get(
      `${assignment.section.toLowerCase()}\u0000${assignment.key.toLowerCase()}`,
    );
    if (at !== undefined) {
      const line = lines[at]!;
      const eq = line.indexOf("=");
      const before = line.slice(eq + 1).trim();
      if (before === assignment.value) {
        unchanged += 1;
        continue;
      }
      // Keep the key AND the spacing exactly as the user wrote it. `iSize W
      // = 1920` must not come back as `iSize W =2560`: it is their file, and
      // a reformatted line is a change they did not ask for.
      const spacingAfterEquals = /^[ \t]*/.exec(line.slice(eq + 1))?.[0] ?? "";
      lines[at] = `${line.slice(0, eq)}=${spacingAfterEquals}${assignment.value}`;
      changed.push({
        section: assignment.section,
        key: assignment.key,
        before,
        after: assignment.value,
      });
      continue;
    }
    const bucket = appends.get(assignment.section) ?? [];
    bucket.push(assignment);
    appends.set(assignment.section, bucket);
  }

  // Insert missing keys from the bottom up so earlier indexes stay correct.
  const insertions = [...appends.entries()]
    .map(([section, items]) => ({
      section,
      items,
      at: sectionEnd.get(section.toLowerCase()),
    }))
    .sort((a, b) => (b.at ?? -1) - (a.at ?? -1));

  for (const insertion of insertions) {
    const rendered = insertion.items.map((a) => `${a.key}=${a.value}`);
    for (const item of insertion.items) {
      changed.push({ section: insertion.section, key: item.key, after: item.value });
    }
    if (insertion.at === undefined) {
      // Section absent entirely: add it at the end.
      if (lines.length > 0 && lines[lines.length - 1]!.trim() !== "") lines.push("");
      lines.push(`[${insertion.section}]`, ...rendered);
    } else {
      lines.splice(insertion.at + 1, 0, ...rendered);
    }
  }

  return { text: lines.join(newline), changed, unchanged };
}

/** One line per changed setting, for showing the user what was done. */
export function describeIniChanges(
  fileName: string,
  changes: readonly IniChange[],
): string[] {
  return changes.map((c) =>
    c.before === undefined
      ? `${fileName} [${c.section}] ${c.key} = ${c.after} (added)`
      : `${fileName} [${c.section}] ${c.key}: ${c.before} → ${c.after}`,
  );
}

/**
 * Write a collection's game settings into the user's INI files.
 *
 * Called once per install or update — see {@link shouldApplyGameIni}. Never
 * throws: a settings file that cannot be written is reported and the install
 * continues, because a collection whose mods all installed is not a failure
 * just because one INI was read-only.
 */
export async function applyGameIni(args: {
  gameIni: EhcollGameIni;
  gameId: string;
  documentsPath: string;
  /**
   * Vortex's discovered store. My Games is store-specific, and writing INIs
   * into the Steam folder of a GOG install edits a directory the game never
   * reads — a "success" that changes nothing.
   */
  store?: string;
}): Promise<GameIniApplicationReceipt> {
  const receipt: GameIniApplicationReceipt = {
    appliedCount: 0,
    alreadyMatchedCount: 0,
    changes: [],
    failed: [],
  };

  const op = beginOp("game-ini", {
    gameId: args.gameId,
    files: args.gameIni.files.length,
  });

  const location = iniLocationFor(
    args.gameId,
    args.documentsPath,
    args.store,
  );
  if (location === undefined) {
    receipt.failed.push({
      fileName: "(all)",
      reason: `No INI layout known for game "${args.gameId}".`,
    });
    op.ok({ reason: "no-ini-layout", failed: receipt.failed.length });
    return receipt;
  }

  for (const file of args.gameIni.files) {
    // Second guard. Machine-owned keys are already dropped at capture, so
    // nothing should be here — but this is the last point before someone
    // else's screen resolution gets written, and the cost of checking twice
    // is nothing next to the cost of being wrong once.
    const assignments = file.settings.filter((s) => !isMachineOwned(s.key));
    if (assignments.length === 0) continue;

    const full = path.join(location.dir, file.fileName);
    let original: string;
    try {
      original = await fsp.readFile(full, "utf8");
    } catch {
      // Absent is normal for *Custom.ini — create it rather than skip, since
      // that is exactly where hand-authored settings belong.
      original = "";
      ehLog("debug", "game-ini.file-absent", { file: file.fileName });
    }

    const merged = mergeIniText(original, assignments);
    receipt.alreadyMatchedCount += merged.unchanged;
    ehLog("debug", "game-ini.merge", {
      file: file.fileName,
      changed: merged.changed.length,
      unchanged: merged.unchanged,
    });
    if (merged.changed.length === 0) continue;

    try {
      await fsp.mkdir(location.dir, { recursive: true });
      await fsp.writeFile(full, merged.text, "utf8");
    } catch (err) {
      receipt.failed.push({
        fileName: file.fileName,
        reason: err instanceof Error ? err.message : String(err),
      });
      ehLog("error", "game-ini.write.fail", {
        file: file.fileName,
        err: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    // Every key this touched — the exact record that answers "what did this
    // change in my game's settings" when a user reports something behaving
    // differently after an install.
    for (const change of merged.changed) {
      ehLog("debug", "game-ini.key-changed", {
        file: file.fileName,
        section: change.section,
        key: change.key,
        before: change.before,
        after: change.after,
      });
    }

    receipt.appliedCount += merged.changed.length;
    receipt.changes.push(...describeIniChanges(file.fileName, merged.changed));
    ehLog("info", "game-ini.write.ok", {
      file: file.fileName,
      keys: merged.changed.length,
    });
  }

  op.ok({
    applied: receipt.appliedCount,
    alreadyMatched: receipt.alreadyMatchedCount,
    failed: receipt.failed.length,
  });
  return receipt;
}

/**
 * Should this install write the collection's settings?
 *
 * Only when this exact release has not already written them. The collection
 * states a starting configuration; after that the file is the user's, and
 * re-applying on a re-run would silently revert whatever they changed.
 *
 * A NEW version is a fresh statement and applies again — that is what "on
 * install or update" means.
 */
export function shouldApplyGameIni(args: {
  gameIni: EhcollGameIni | undefined;
  /** Version being installed now. */
  packageVersion: string;
  /** The previous receipt for this collection, if any. */
  previous?: {
    packageVersion: string;
    /**
     * Typed, not `unknown`. As `unknown` this compiled happily against a
     * `PreviousCollectionInstall` that had no such field at all, so the guard
     * below was structurally inert for as long as it existed.
     */
    gameIniApplication?: GameIniApplicationReceipt;
  };
}): boolean {
  if (args.gameIni === undefined || args.gameIni.files.length === 0) return false;
  const previous = args.previous;
  if (previous === undefined) return true;
  const appliedForThisVersion =
    previous.packageVersion === args.packageVersion &&
    previous.gameIniApplication !== undefined;
  return !appliedForThisVersion;
}

/** What to tell the user after their settings were changed. */
export function describeGameIniApplication(
  receipt: GameIniApplicationReceipt,
): string[] {
  const out: string[] = [];
  if (receipt.appliedCount > 0) {
    out.push(
      `This collection set ${receipt.appliedCount} game setting(s) in your INI ` +
        `files — things like uGridsToLoad, archive invalidation and LOD ` +
        `distances that its mods expect. Your screen resolution, CPU threads, ` +
        `audio device and field of view were left alone. Change any of it back ` +
        `whenever you like: this is done once per version and never re-applied.`,
    );
    out.push(...receipt.changes.slice(0, 20));
    if (receipt.changes.length > 20) {
      out.push(`  ...and ${receipt.changes.length - 20} more; see the event-horizon log.`);
    }
  }
  for (const failure of receipt.failed) {
    out.push(
      `Could not write ${failure.fileName}: ${failure.reason}. The collection ` +
        `is installed; these settings were not applied.`,
    );
  }
  return out;
}
