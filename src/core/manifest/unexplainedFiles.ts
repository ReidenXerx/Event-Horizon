import { createHash } from "crypto";

import { pathKey } from "../paths";

/**
 * ──────────────────────────────────────────────────────────────────────
 * Two different things wear the same verdict, and the curator can't see which.
 *
 * `verifyStagingAgainstArchive` reports a staged file as `unexplained` when no
 * archive entry has its content. That one word covers two situations with
 * opposite consequences for the person installing the collection:
 *
 *   ADDED   — the archive has NO file at that path. xLODGen output, a DynDOLOD
 *             folder, a patch dropped in by hand. Declare it and the user
 *             simply never has the file.
 *
 *   CHANGED — the archive HAS a file at that path and the curator's copy
 *             differs. A cleaned plugin, a repacked BA2, an edited INI.
 *             Declare it and the user does NOT go without the file: they get
 *             the ARCHIVE's version of it.
 *
 * The build said "N files its archive cannot produce" for both, and the
 * decision copy said "users install this mod without your N files" for both —
 * true of the first, false of the second.
 *
 * ─── THIS REPORTS, IT DOES NOT ADVISE ──────────────────────────────────
 * An earlier draft recommended an answer: a file that GREW has records the
 * archive cannot supply, so bundle it. That advice is correct today and about
 * to be wrong — the settled design replaces bundling with a MIRRORING pipeline
 * that reproduces the curator's staging folder exactly, and `bundle` survives
 * only for mods with no usable archive at all. Teaching curators to bundle now
 * would train a habit we intend to reverse, and a bundled package is expensive
 * to undo.
 *
 * So the size delta is stated as a fact — "24.5 KB BIGGER than the archive's
 * copy" — and the curator draws the conclusion. That is the useful half of a
 * recommendation without the half that expires.
 *
 * ─── WHY DIRECTION IS WORTH STATING AT ALL ─────────────────────────────
 * Cleaning a plugin — removing ITM records, undeleting references — only ever
 * makes it SMALLER. A plugin that GREW has records the archive does not
 * contain, so declaring it ships a collection that silently omits the
 * curator's own work while installing cleanly for everyone. Same verdict on
 * screen, opposite outcome, and only the sign of one number separates them.
 *
 * Pure: no I/O, no Vortex. Both inputs are captured elsewhere.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { ArchiveListing } from "./archiveContents";
import type { StagedFileRef } from "./verifyAgainstArchive";

export type UnexplainedFile = {
  /** POSIX-style path relative to the mod's staging root. */
  path: string;
  /**
   * - `added`   — no archive entry at this path. The user gets nothing.
   * - `changed` — the archive has this path with different bytes. The user
   *               gets the archive's version.
   */
  kind: "added" | "changed";
  /**
   * Staged size minus archive size, for `changed` only.
   *
   * Positive means the curator's copy is LARGER — content was added and the
   * archive cannot supply it. Absent when the archive entry reported no size.
   */
  delta?: number;
};

/** Case-insensitive, separator-normalised, for matching a staged path. */
/**
 * A comparison key over staging paths.
 *
 * Fixed to the Windows reading rather than probed — but NOT for the reason
 * this comment used to give. It claimed the two sides "came from the same walk
 * of the same folder, so they cannot disagree about case". They did not: one
 * side is the ARCHIVE's internal namespace (`listing.entries`) and the other
 * is a staging walk, and an archive built on Linux can legitimately hold
 * `Textures/Foo.dds` and `textures/foo.dds` as two entries. Folding them makes
 * the first-entry-wins lookups below pick one size arbitrarily, so a reported
 * `delta` can be computed against the wrong entry.
 *
 * It stays folded anyway, deliberately: this is a build-time REPORT (the only
 * caller is `selfCheckMod`), the folded reading is the right one for the
 * Windows archives that make up essentially all of them, and being wrong costs
 * a slightly-off number in a diagnostic rather than a wrong file anywhere.
 * Written down so the next reader is deciding with the real reason rather than
 * trusting one that was not true.
 */
const norm = (p: string): string => pathKey(p, "insensitive");

/** Last path segment of an already-normalised path. */
function baseName(p: string): string {
  const at = norm(p).lastIndexOf("/");
  return at === -1 ? norm(p) : norm(p).slice(at + 1);
}

/**
 * Say, for each unexplained file, whether the archive has it at all.
 *
 * Matched on full path first and on FILE NAME second. The second is not
 * sloppiness: a FOMOD installs `<file source="a/x.esp" destination="x.esp">`,
 * so a staged path routinely has no counterpart in the archive even though the
 * same file is plainly there. Matching only on full path would call almost
 * every FOMOD-installed file "added" — the wrong answer in the direction that
 * loses the curator's work.
 */
export function classifyUnexplained(
  unexplained: readonly StagedFileRef[],
  listing: ArchiveListing,
): UnexplainedFile[] {
  const byPath = new Map<string, number | undefined>();
  const byName = new Map<string, number | undefined>();
  for (const entry of listing.entries) {
    if (!byPath.has(norm(entry.path))) byPath.set(norm(entry.path), entry.size);
    // First entry wins: with two same-named files the archive is ambiguous,
    // and choosing between them would invent a delta.
    if (!byName.has(baseName(entry.path))) {
      byName.set(baseName(entry.path), entry.size);
    }
  }

  return unexplained.map((file) => {
    const path = norm(file.path);
    const name = baseName(file.path);
    if (!byPath.has(path) && !byName.has(name)) {
      return { path: file.path, kind: "added" as const };
    }
    const archiveSize = byPath.has(path) ? byPath.get(path) : byName.get(name);
    return {
      path: file.path,
      kind: "changed" as const,
      ...(archiveSize !== undefined ? { delta: file.size - archiveSize } : {}),
    };
  });
}

/** Bytes as something a person reads, for one number inside a sentence. */
export function formatBytes(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1024 * 1024) return `${(abs / (1024 * 1024)).toFixed(1)} MB`;
  if (abs >= 1024) return `${(abs / 1024).toFixed(1)} KB`;
  return `${abs} bytes`;
}

/**
 * What this file means for the person installing, in one clause.
 *
 * Kept beside the classifier so the words and the rule cannot drift apart —
 * this repo has now shipped two warnings whose prose outlived the code they
 * described.
 */
export function describeUnexplainedFile(file: UnexplainedFile): string {
  if (file.kind === "added") return "not in the archive — users won't have it";
  if (file.delta === undefined) return "differs from the archive's copy";
  if (file.delta > 0) {
    return `${formatBytes(file.delta)} BIGGER than the archive's copy`;
  }
  if (file.delta < 0) {
    return `${formatBytes(file.delta)} smaller than the archive's copy`;
  }
  return "same size as the archive's copy, different content";
}

/** How many of these a card shows. Evidence for a human, not a manifest. */
export const UNEXPLAINED_EXAMPLES = 6;

/**
 * Do any of these files exist in the archive?
 *
 * Drives the wording of the "declare" consequence: users go WITHOUT an added
 * file, but they receive the archive's version of a changed one, and one
 * sentence cannot honestly cover both.
 */
export function countKinds(files: readonly UnexplainedFile[]): {
  added: number;
  changed: number;
} {
  let added = 0;
  for (const f of files) if (f.kind === "added") added += 1;
  return { added, changed: files.length - added };
}


/**
 * ──────────────────────────────────────────────────────────────────────
 * A stable name for "the diverged files, as they were when you answered".
 *
 * A decision about a mod's unreproducible files is a decision about THOSE
 * files. Storing only the answer means a curator who later drops another
 * patch into the same folder keeps the old verdict, and for "these files are
 * mine — users don't need them" that is the dangerous direction: the new file
 * is withheld silently, with no warning and nothing in a diff.
 *
 * So the answer is stored against this, and the question reopens when it
 * moves. Content, not just paths: editing a file in place is exactly the case
 * a path list cannot see.
 * ──────────────────────────────────────────────────────────────────────
 */
export function fingerprintUnexplained(
  files: readonly { path: string; size?: number; sha256?: string }[],
): string {
  const lines = files
    .map((f) => `${f.path}\u0000${f.sha256 ?? `size:${f.size ?? -1}`}`)
    // Sorted, because the order files come back in is an implementation
    // detail of the walk and must not read as a change.
    .sort();
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}
