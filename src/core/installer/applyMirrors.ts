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
    if (signal?.aborted === true) return out;
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
  for (const rel of plan.remove) {
    if (signal?.aborted === true) return out;
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
    const dest = path.join(stagingRoot, ...relativePath.split(/[\\/]/));
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    // Replace rather than write in place: a partial write over a good file is
    // the one outcome worse than not restoring it.
    await fsp.rm(dest, { force: true });
    await fsp.copyFile(staged, dest);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
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
    outcome.failures.length === 0
  ) {
    return undefined;
  }
  const parts: string[] = [];
  if (outcome.restored > 0) parts.push(`${outcome.restored} file(s) written`);
  if (outcome.removed > 0) parts.push(`${outcome.removed} removed`);
  let line = `"${modName}": ${parts.join(", ")}.`;
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
