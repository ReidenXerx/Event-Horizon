/**
 * ──────────────────────────────────────────────────────────────────────
 * Make this machine's staging folder match the curator's, exactly.
 *
 * A curator who cleans a plugin, repacks a BA2 or drops in a patch has a
 * staging folder their archive cannot reproduce. Until now the collection
 * offered two answers and both lost something: DECLARE it, and the user
 * silently goes without the curator's work; BUNDLE it, and the whole staging
 * folder ships — 333 MB of BSA to carry a 167 KB plugin.
 *
 * Mirroring is the third answer. The mod still installs from its own Nexus
 * archive; afterwards the differences are reconciled against the curator's
 * recorded folder state. The author keeps the download, the package carries
 * only what the archive cannot produce, and the result is byte-identical.
 *
 * ─── WHY THERE IS NO added/changed/deleted TAXONOMY HERE ───────────────
 * An earlier design classified every divergence and asked the curator to
 * answer per kind. That is the tool making its own implementation the user's
 * problem: a curator thinks "should they end up with what I have?", not
 * "is this file added or mutated?". Adding, overwriting and deleting are
 * simply what a diff DOES. One question per mod, three operations underneath.
 *
 * ─── THE TARGET ALREADY SHIPS ──────────────────────────────────────────
 * `EhcollStagingFile[]` — path, size, sha256 — is captured for every mod
 * today. `stagingFileWalker` computes the same shape on this machine, and its
 * own contract requires both sides to agree byte-for-byte on which files count
 * and how they are hashed. So the target and the current state are already
 * directly comparable; this module is the comparison, kept pure.
 *
 * ─── DELETION IS THE HALF THAT CAN DESTROY SOMETHING ───────────────────
 * Restoring a file is recoverable — worst case it is rewritten. Deleting one
 * the curator actually had, because our record of their folder was incomplete,
 * is not. So deletion is withheld unless the target is provably whole, and
 * "provably" means every entry carries a hash: a build at `fast` verification
 * records sizes only, and a file the curator's machine could not read is
 * recorded without one. Either way the folder listing has holes, and a hole is
 * indistinguishable from "the user has something extra".
 * ──────────────────────────────────────────────────────────────────────
 */

import type { EhcollStagingFile } from "../../types/ehcoll";

import { type CaseMode, pathKey } from "../paths";

export type MirrorRestore = {
  /** POSIX-style path relative to the staging root, in the curator's casing. */
  path: string;
  /** What the file must hash to once written. */
  sha256: string;
  size: number;
  /** Why it is being written, for the receipt and the report. */
  reason: "missing" | "different";
};

export type MirrorPlan = {
  /** Files to write from the package. */
  restore: MirrorRestore[];
  /** Files to delete. Always empty when `removalWithheld` is set. */
  remove: string[];
  /** Already identical. Counted rather than listed — it is the boring case. */
  matched: number;
  /**
   * Target files carrying no hash, left exactly as they are.
   *
   * Without a hash there is no way to tell a correct copy from a wrong one,
   * and overwriting on a guess is how a mirror becomes a corruption.
   */
  unverifiable: string[];
  /** Set when extra files exist but removing them is not provably safe. */
  removalWithheld?: { count: number; why: string };
};

/**
 * Staging paths differ in separator everywhere and in CASE only on some
 * filesystems, so the mode is an argument rather than a constant.
 *
 * This module had the rule right from the start and kept it to itself, while
 * verification compared paths verbatim and reported four healthy mods as
 * broken. Shared now — and no longer hard-coded to lowercase, because this is
 * the function that decides which of the user's files get DELETED, and on a
 * case-sensitive filesystem merging two real files here is data loss.
 */
const key = (p: string, mode: CaseMode): string => pathKey(p, mode);

/**
 * Plan the reconciliation. Pure: no filesystem, no Vortex, no package.
 *
 * `target` is the curator's recorded folder. `current` is this machine's, from
 * the same walker. Both must be hashed at `thorough`, which is what makes the
 * comparison meaningful rather than a size guess.
 */
export function planMirror(args: {
  target: readonly EhcollStagingFile[];
  current: readonly EhcollStagingFile[];
  /**
   * How the filesystem holding this mod treats case.
   *
   * An argument rather than a constant because this function decides which of
   * the user's files get DELETED. On NTFS `Scripts/a.pex` and `scripts/a.pex`
   * are one file and folding them is required; on the ext4 under a Proton
   * install they are two, and folding them would delete one of them on the
   * strength of the other's presence.
   *
   * Defaults to `insensitive` so existing callers keep the behaviour they
   * were written against — the Windows answer, and the one every shipped
   * package was built on.
   */
  caseMode?: CaseMode;
}): MirrorPlan {
  const { target, current } = args;
  const mode: CaseMode = args.caseMode ?? "insensitive";

  const currentByPath = new Map<string, EhcollStagingFile>();
  for (const file of current) currentByPath.set(key(file.path, mode), file);

  const restore: MirrorRestore[] = [];
  const unverifiable: string[] = [];
  const wanted = new Set<string>();
  /**
   * The same target paths, folded case-INSENSITIVELY, whatever `mode` says.
   *
   * This exists to make the DELETE decision independent of the case mode, and
   * that is not belt-and-braces — it closes a way to destroy a mod's content
   * and then certify it as perfect.
   *
   * `wanted` is keyed with `mode`. Under `"sensitive"`, a curator's
   * `scripts/foo.pex` and this machine's `Scripts/foo.pex` are two different
   * keys, so the file is BOTH a missing restore and an unwanted extra. On a
   * filesystem that is really case-insensitive they are one physical file, and
   * `applyMirrorPlan` deletes last: it writes the curator's bytes and then
   * removes them. Zero failures, so `mirrorProvesTarget` returns true and the
   * receipt records a drift reference for a folder we just emptied.
   *
   * The mode can be wrong in that direction — the probe falls back to
   * `"sensitive"` whenever it cannot answer, deliberately, because that is the
   * safe guess for a COMPARISON. It is the unsafe guess for a DELETION, and
   * the fix is not a better probe but a rule that does not depend on one: a
   * file whose name matches a target under case folding is never provably
   * extra, on any filesystem. Under `"insensitive"` this set is identical to
   * `wanted` and the filter is a no-op.
   */
  const wantedInsensitive = new Set<string>();
  let matched = 0;

  for (const want of target) {
    wanted.add(key(want.path, mode));
    wantedInsensitive.add(key(want.path, "insensitive"));

    if (want.sha256 === undefined) {
      // No recorded hash: we cannot say whether this machine's copy is right,
      // and we may not carry the bytes to replace it. Leave it alone and say
      // so, rather than pretending the mirror was complete.
      unverifiable.push(want.path);
      continue;
    }

    const have = currentByPath.get(key(want.path, mode));
    if (have === undefined) {
      restore.push({
        path: want.path,
        sha256: want.sha256,
        size: want.size,
        reason: "missing",
      });
      continue;
    }
    if (have.sha256 === want.sha256) {
      matched += 1;
      continue;
    }
    // A present file whose hash we could not compute is not "the same". It is
    // unknown, and the known-good bytes are the ones the curator recorded.
    restore.push({
      path: want.path,
      sha256: want.sha256,
      size: want.size,
      reason: "different",
    });
  }

  const extra = current
    .filter((file) => !wanted.has(key(file.path, mode)))
    // Never delete a file that only looks extra because of letter case.
    .filter((file) => !wantedInsensitive.has(key(file.path, "insensitive")))
    .map((file) => file.path);

  if (extra.length === 0) {
    return { restore, remove: [], matched, unverifiable };
  }

  // The guard. An incomplete target cannot distinguish "the user has something
  // extra" from "we failed to record what the curator had", and only one of
  // those is safe to act on.
  if (unverifiable.length > 0) {
    return {
      restore,
      remove: [],
      matched,
      unverifiable,
      removalWithheld: {
        count: extra.length,
        why:
          `${unverifiable.length} of the curator's files were recorded ` +
          `without a checksum, so their folder listing is not known to be ` +
          `complete. Files here that it does not mention are left alone: an ` +
          `unrecorded file and a genuinely extra one look identical.`,
      },
    };
  }
  if (target.length === 0) {
    return {
      restore,
      remove: [],
      matched,
      unverifiable,
      removalWithheld: {
        count: extra.length,
        why:
          `The curator recorded no files for this mod, which means the ` +
          `capture did not run rather than that the folder was empty. ` +
          `Deleting everything on the strength of that is not a mirror.`,
      },
    };
  }

  return { restore, remove: extra, matched, unverifiable };
}

/**
 * Did this mirror leave the folder EXACTLY equal to the curator's?
 *
 * The receipt records a drift reference only for mods whose state we proved,
 * and mirroring is the one path that can prove one after verification already
 * failed — verification runs before the mirror and compares the archive's
 * output against the curator's files, which is the very difference mirroring
 * removes. Without this the mods most likely to be disturbed later would be
 * the only ones with no oracle, and a wiped mirror would go unnoticed.
 *
 * All three conditions, because each covers a way the folder can be closer
 * without being identical:
 *
 *   - nothing unverifiable — every target file had a hash to check against;
 *   - nothing failed       — every write landed and was verified on arrival;
 *   - no removal withheld  — no extra files were left in place;
 *   - not aborted          — the plan ran to the end.
 *
 * The last one is not redundant. `applyMirrorPlan` returns early on a stop
 * with whatever it had done so far and an EMPTY failure list, because nothing
 * failed — it simply never happened. Without this condition a user pressing
 * Stop twelve files into a four-hundred-file mirror certifies the other three
 * hundred and eighty-eight as byte-perfect.
 *
 * Any one of them and the disk is merely nearer the target, and a drift
 * reference for a disk nobody proved is the fiction the receipt rules refuse
 * everywhere else.
 */
export function mirrorProvesTarget(
  plan: MirrorPlan,
  outcome: { failures: readonly unknown[]; aborted?: boolean },
): boolean {
  return (
    plan.unverifiable.length === 0 &&
    plan.removalWithheld === undefined &&
    outcome.failures.length === 0 &&
    outcome.aborted !== true
  );
}

/**
 * What the plan will do, for the install report and the receipt.
 *
 * Returns `undefined` when the folder already matches — the common case once a
 * mirror has been applied, and not worth a line.
 */
export function describeMirrorPlan(
  modName: string,
  plan: MirrorPlan,
): string | undefined {
  const parts: string[] = [];
  const missing = plan.restore.filter((r) => r.reason === "missing").length;
  const different = plan.restore.length - missing;
  if (missing > 0) parts.push(`${missing} file(s) restored`);
  if (different > 0) parts.push(`${different} file(s) replaced with yours`);
  if (plan.remove.length > 0) parts.push(`${plan.remove.length} removed`);
  if (parts.length === 0 && plan.removalWithheld === undefined) return undefined;

  const head =
    parts.length > 0
      ? `"${modName}": ${parts.join(", ")} to match the curator's folder.`
      : `"${modName}": already matches the curator's folder.`;
  return plan.removalWithheld === undefined
    ? head
    : `${head} ${plan.removalWithheld.count} extra file(s) left in place — ` +
        plan.removalWithheld.why;
}

/**
 * Which files the package has to carry for this mod.
 *
 * The curator's side of the same question: a file the archive can produce
 * needs no payload, so this is the target minus what the archive already
 * explains. Kept here beside the plan it feeds so the two cannot drift.
 */
export function filesNeedingPayload(
  target: readonly EhcollStagingFile[],
  explainedByArchive: ReadonlySet<string>,
  /** Must match the mode the `explainedByArchive` keys were built with. */
  caseMode: CaseMode = "insensitive",
): EhcollStagingFile[] {
  return target.filter(
    (file) =>
      file.sha256 !== undefined &&
      !explainedByArchive.has(key(file.path, caseMode)),
  );
}
