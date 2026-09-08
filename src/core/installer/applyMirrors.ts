/**
 * ──────────────────────────────────────────────────────────────────────
 * Run the mirror plan against a real staging folder.
 *
 * `planMirror` decides; this does. Kept apart because the deciding is where
 * the rules live and the doing is where the filesystem is, and only one of
 * those can be tested without a disk.
 *
 * ─── WHERE IT RUNS ─────────────────────────────────────────────────────
 * Between the mods being installed and the single deploy — the same slot
 * `applyModTypes` uses, and for the same reason. Automatic deployment is off
 * (the install gate enforces it), so nothing is linked anywhere yet: the mirror
 * corrects staging while staging is still the only copy, and the deploy that
 * follows carries the corrected bytes out. Doing it after the deploy would
 * leave the game folder holding the version we just decided was wrong.
 *
 * ─── EVERY WRITE IS VERIFIED ON ARRIVAL ────────────────────────────────
 * The package is content-addressed: a mirrored file lives at `mirror/<sha256>`
 * and the name IS the expectation. So after extracting one, its hash is
 * checked before it is moved into place. A blob that does not match is not
 * written at all — a mirror that installs the wrong bytes is worse than one
 * that reports it could not finish, because the first looks like success.
 *
 * ─── AND FAILURE IS PER FILE, NOT PER INSTALL ──────────────────────────
 * One missing blob does not abandon the other corrections, which are unrelated
 * files in unrelated mods. Everything that could not be done is returned and
 * reported; nothing is swallowed.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fsp from "fs/promises";

import { segmentsOf } from "../paths";
import { ehLog } from "../logging/ehLog";

import {
  isSafeRelativePath,
  unsafePathReason,
} from "../safeRelativePath";
import * as os from "os";
import * as path from "path";

import { hashFileSha256 } from "../archiveHashing";
import { extractZipEntryToFile } from "../manifest/readZip";
import type { MirrorPlan } from "./mirrorStaging";

export type MirrorOutcome = {
  restored: number;
  removed: number;
  /** What could not be done, and why. Never thrown away. */
  failures: { path: string; why: string }[];
  /**
   * The run stopped early instead of finishing the plan.
   *
   * Distinct from a failure, and the distinction is the point: an aborted run
   * has an empty `failures` list because nothing went wrong — it just did not
   * happen. `mirrorProvesTarget` reads this so a stopped mirror cannot be
   * certified as an exact reproduction.
   */
  aborted?: boolean;
  /**
   * Deletions the plan called for and this run deliberately did not perform.
   *
   * Set when a restore failed: see the delete loop for why proceeding would
   * be worse than stopping.
   */
  removalsSkipped?: number;
};

/** Where a mirrored file lives inside the package. The name is its hash. */
export const mirrorEntryFor = (sha256: string): string => `mirror/${sha256}`;

/**
 * Apply one mod's plan.
 *
 * `stagingRoot` is this machine's folder for the mod; `ehcollPath` is the
 * package the bytes came in. Never throws for a per-file problem.
 */
export async function applyMirrorPlan(args: {
  stagingRoot: string;
  ehcollPath: string;
  plan: MirrorPlan;
  signal?: AbortSignal;
}): Promise<MirrorOutcome> {
  const { stagingRoot, ehcollPath, plan, signal } = args;
  const out: MirrorOutcome = { restored: 0, removed: 0, failures: [] };

  for (const file of plan.restore) {
    if (signal?.aborted === true) {
      out.aborted = true;
      return out;
    }
    try {
      await restoreOne(stagingRoot, ehcollPath, file.path, file.sha256);
      out.restored += 1;
    } catch (err) {
      out.failures.push({
        path: file.path,
        why: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Deletions last. `planMirror` has already withheld them entirely unless the
  // curator's listing is provably complete, so reaching here means the extra
  // files are known to be extra rather than merely unmentioned.
  //
  // ─── BUT NOT AFTER A FAILED RESTORE ──────────────────────────────────────
  // The two loops are not independent. A restore that failed means the bytes
  // meant to replace something are NOT on disk, and deleting on top of that
  // turns "this mod does not match the curator's copy" into "this mod is
  // missing files it had before Event Horizon ran" — a file the user owned,
  // gone, with nothing put in its place.
  //
  // It is not a hypothetical pairing either: a rename or a case change makes
  // one file both a restore and a delete, so the failed write and the delete
  // are frequently the SAME file. Being closer to the target is always better
  // than being short of where we started, so the whole pass stands down and
  // says so; `mirrorProvesTarget` already refuses to certify this mod because
  // `failures` is non-empty.
  if (out.failures.length > 0) {
    out.removalsSkipped = plan.remove.length;
    return out;
  }

  for (const rel of plan.remove) {
    if (signal?.aborted === true) {
      out.aborted = true;
      return out;
    }
    try {
      await fsp.rm(path.join(stagingRoot, ...rel.split("/")), { force: true });
      out.removed += 1;
    } catch (err) {
      out.failures.push({
        path: rel,
        why: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return out;
}

/**
 * Extract one blob, check it, then put it where it belongs.
 *
 * The temp directory is per file rather than per mod so a failure cleans up
 * after itself without tracking what else is in flight.
 */
async function restoreOne(
  stagingRoot: string,
  ehcollPath: string,
  relativePath: string,
  sha256: string,
): Promise<void> {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "eh-mirror-"));
  try {
    const staged = path.join(tempDir, sha256);
    await extractZipEntryToFile(ehcollPath, mirrorEntryFor(sha256), staged);

    const actual = await hashFileSha256(staged);
    if (actual !== sha256) {
      throw new Error(
        `the package's copy hashes ${actual}, not ${sha256} — it is not the ` +
          `file the manifest describes, so it was not written`,
      );
    }

    /**
     * Re-checked here even though the parser rejects it.
     *
     * This is the line that turns a string from someone else's file into a
     * write on this machine, and a single check at the far end of the chain
     * is one refactor away from being bypassed by a new call site. The cost
     * is a string scan per file; the thing it prevents is arbitrary write.
     */
    if (!isSafeRelativePath(relativePath)) {
      throw new Error(
        `the manifest asked to write "${relativePath}", which is not a path ` +
          `inside the mod's folder (${unsafePathReason(relativePath)}) — ` +
          `refused`,
      );
    }
    // `segmentsOf` rather than a private split: one module decides what a
    // path separator is, and this is the line that turns a string from
    // someone else's package into a write on this machine.
    const dest = path.join(stagingRoot, ...segmentsOf(relativePath));
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    /**
     * Land it atomically: copy BESIDE the destination, then rename over it.
     *
     * The previous form was `rm(dest)` then `copyFile(staged, dest)`, under a
     * comment claiming it avoided "a partial write over a good file". It did
     * not — it guaranteed the good file was gone first, so an ENOSPC or a
     * kill part-way through `copyFile` left a TRUNCATED file where a correct
     * one had been, and a truncated file passes a size check no more than a
     * missing one but looks present to anything that only lists names.
     *
     * The temp lives in the destination's own directory so the rename is a
     * same-filesystem metadata operation rather than a second copy, and it
     * carries the target's name so a leaked one is obvious in a support log.
     * On any failure the original is still there, untouched.
     */
    const tmp = `${dest}.ehcoll-restore-tmp`;
    try {
      await fsp.copyFile(staged, tmp);
      await replaceFile(tmp, dest);
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Move a fully-written temp file onto its destination.
 *
 * ─── RENAME-OVER-EXISTING IS NOT UNIVERSAL ──────────────────────────────────
 * POSIX rename replaces the destination, and Windows mostly does too — a
 * Proton/Wine staging folder does not. A tester's mirror failed with:
 *
 *   EPERM: operation not permitted, rename
 *   '...\Rebecca_Rose_TWB_Nude.xml.ehcoll-restore-tmp'
 *   -> '...\Rebecca_Rose_TWB_Nude.xml'
 *
 * So the atomic path is tried first and taken wherever the filesystem supports
 * it; on refusal the destination is removed and the rename retried. That
 * window — between the unlink and the rename — is a metadata operation on a
 * file that is ALREADY fully written, and still strictly safer than the form
 * this replaced (`rm(dest)` then `copyFile`), where the gap spanned the whole
 * copy and a failure part-way left a TRUNCATED file behind.
 *
 * `ops` exists so a test can supply a rename that refuses the way that
 * tester's filesystem does. Production never passes it.
 */
export async function replaceFile(
  tmp: string,
  dest: string,
  ops: {
    rename: (from: string, to: string) => Promise<void>;
    rm: (target: string) => Promise<void>;
  } = {
    rename: async (from, to) => {
      await fsp.rename(from, to);
    },
    rm: async (target) => {
      await fsp.rm(target, { force: true });
    },
  },
): Promise<void> {
  try {
    await ops.rename(tmp, dest);
  } catch (renameErr) {
    await ops.rm(dest);
    await ops.rename(tmp, dest);
    ehLog("debug", "mirror.restore.rename-fallback", {
      dest,
      why: (renameErr as NodeJS.ErrnoException)?.code ?? "unknown",
      note:
        "rename could not replace an existing file on this filesystem; " +
        "removed it first and renamed the completed temp into place",
    });
  }
}

/**
 * One line per mod for the install report.
 *
 * Failures are named rather than counted: "3 files could not be mirrored" tells
 * a user nothing they can act on, and this is the moment where their game
 * quietly stops matching the curator's.
 */
export function describeMirrorOutcome(
  modName: string,
  outcome: MirrorOutcome,
): string | undefined {
  if (
    outcome.restored === 0 &&
    outcome.removed === 0 &&
    outcome.failures.length === 0 &&
    outcome.aborted !== true &&
    outcome.removalsSkipped === undefined
  ) {
    return undefined;
  }
  const parts: string[] = [];
  if (outcome.restored > 0) parts.push(`${outcome.restored} file(s) written`);
  if (outcome.removed > 0) parts.push(`${outcome.removed} removed`);
  if (parts.length === 0) parts.push("nothing applied");
  let line = `"${modName}": ${parts.join(", ")}.`;
  if (outcome.aborted === true) {
    line += ` STOPPED before the plan finished, so this mod is part-mirrored.`;
  }
  if (outcome.removalsSkipped !== undefined) {
    line +=
      ` ${outcome.removalsSkipped} deletion(s) were NOT performed because a ` +
      `file could not be restored first — nothing was removed that we could ` +
      `not replace.`;
  }
  if (outcome.failures.length > 0) {
    const named = outcome.failures
      .slice(0, 3)
      .map((f) => `${f.path} (${f.why})`)
      .join("; ");
    line +=
      ` ${outcome.failures.length} could NOT be mirrored, so this mod does ` +
      `not match the curator's copy: ${named}`;
  }
  return line;
}
