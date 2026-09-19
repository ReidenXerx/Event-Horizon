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

import { existsSync } from "fs";

import { hashFileSha256 } from "../archiveHashing";
import {
  listArchiveContents,
  normalizeArchivePath,
  type ArchiveEntry,
} from "../manifest/archiveContents";
import { entrySitsAt } from "../manifest/mirrorPayload";
import {
  extractZipEntryToFile,
  listZipEntries,
  type ZipEntry,
} from "../manifest/readZip";
import {
  resolveSevenZip,
  sevenZipExtractFull,
  type SevenZipApi,
} from "../manifest/sevenZip";
import type { MirrorPlan, MirrorRestore } from "./mirrorStaging";

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
  /**
   * Files the package leaves to the mod's own archive that this run needed,
   * and how many it took from there — counted in `restored` as well. Absent
   * when the install produced every such file as recorded, the ordinary case.
   */
  fromArchive?: { wanted: number; restored: number };
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
  /**
   * The files this package leaves to the mod's own archive
   * (`state.mirrorFromArchive`), and where that archive is on this machine.
   *
   * A file named here is taken from the archive and never looked for in the
   * package, which does not carry it. Omitted for a mod that names none — and
   * for every package built before 0.1.157, which carries every file.
   */
  fromArchive?: {
    paths: ReadonlySet<string>;
    archivePath: string | undefined;
    /** Injection point for tests; defaults to Vortex's own 7-Zip. */
    sevenZip?: SevenZipApi;
  };
  signal?: AbortSignal;
}): Promise<MirrorOutcome> {
  const { stagingRoot, ehcollPath, plan, signal } = args;
  const out: MirrorOutcome = { restored: 0, removed: 0, failures: [] };

  const leftToArchive = args.fromArchive;
  const fromPackage =
    leftToArchive === undefined
      ? plan.restore
      : plan.restore.filter((r) => !leftToArchive.paths.has(r.path));
  const fromArchive =
    leftToArchive === undefined
      ? []
      : plan.restore.filter((r) => leftToArchive.paths.has(r.path));

  for (const file of fromPackage) {
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

  if (leftToArchive !== undefined && fromArchive.length > 0) {
    const taken = await restoreFromModArchive({
      stagingRoot,
      archivePath: leftToArchive.archivePath,
      restores: fromArchive,
      ...(leftToArchive.sevenZip !== undefined
        ? { sevenZip: leftToArchive.sevenZip }
        : {}),
      ...(signal !== undefined ? { signal } : {}),
    });
    out.restored += taken.restored;
    out.fromArchive = { wanted: fromArchive.length, restored: taken.restored };
    out.failures.push(...taken.failures);
    if (taken.aborted === true) {
      out.aborted = true;
      return out;
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
    await placeFile(staged, stagingRoot, relativePath);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Put a file whose bytes are already verified where the manifest says it
 * belongs. The package's blobs and a mod's own archive both come through
 * here, so both get the same path check and the same atomic write.
 */
async function placeFile(
  verified: string,
  stagingRoot: string,
  relativePath: string,
): Promise<void> {
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
    await fsp.copyFile(verified, tmp);
    await replaceFile(tmp, dest);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

const NOT_IN_ARCHIVE =
  "the package leaves this file to the mod's own archive, and that archive " +
  "has no file of this size at this path";

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

type ArchiveRestore = {
  restored: number;
  failures: { path: string; why: string }[];
  aborted?: boolean;
};

/**
 * ─── A FILE THE PACKAGE LEAVES TO THE MOD'S OWN ARCHIVE ─────────────────
 * The build proved the archive installs each such file byte for byte at its
 * path, so an ordinary install sends nothing here. This is for the rest: a
 * file Vortex lost on the way in, an installer answered differently, a folder
 * disturbed before a repair. The package used to carry these files and the
 * mirror healed them from it; taking them from the archive keeps that true
 * (NS-1) without re-hosting the author's files.
 *
 * Held to the package's bar: every candidate is hashed, and only the recorded
 * bytes are written, atomically, through `placeFile`. A ZIP is read natively,
 * which also works where 7-Zip will not start; anything else goes through
 * Vortex's 7-Zip in as few runs as the command line allows, since one run per
 * file decompresses a solid archive from its start every time.
 */
async function restoreFromModArchive(args: {
  stagingRoot: string;
  archivePath: string | undefined;
  restores: readonly MirrorRestore[];
  sevenZip?: SevenZipApi;
  signal?: AbortSignal;
}): Promise<ArchiveRestore> {
  const { stagingRoot, archivePath, restores, signal } = args;
  const out: ArchiveRestore = { restored: 0, failures: [] };
  if (archivePath === undefined) {
    for (const want of restores) {
      out.failures.push({
        path: want.path,
        why:
          "the package leaves this file to the mod's own archive, and Vortex " +
          "has no record of that archive on this machine",
      });
    }
    return out;
  }

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "eh-mirror-archive-"));
  try {
    /** Extracted copies of each restore's candidates, by the restore's path. */
    const copies = new Map<string, string[]>();
    /** Why a restore has no copy at all, where that is known. */
    const reasons = new Map<string, string>();
    let viaSevenZip: MirrorRestore[] = [...restores];

    const zip = await listZipIfNamesCertain(archivePath);
    if (zip !== undefined) {
      viaSevenZip = [];
      let n = 0;
      for (const want of restores) {
        if (signal?.aborted === true) return { ...out, aborted: true };
        const candidates = zip.filter(
          (e) =>
            !e.isDirectory &&
            e.uncompressedSize === want.size &&
            entrySitsAt(normalizeArchivePath(e.name), want.path),
        );
        if (candidates.length === 0) {
          reasons.set(want.path, NOT_IN_ARCHIVE);
          continue;
        }
        const files: string[] = [];
        let unreadable = false;
        for (const entry of candidates) {
          const file = path.join(tempDir, `zip-${n++}`);
          try {
            await extractZipEntryToFile(archivePath, entry.name, file);
            files.push(file);
          } catch {
            // Most likely a compression method this reader does not handle;
            // 7-Zip gets its turn at this file below.
            unreadable = true;
          }
        }
        copies.set(want.path, files);
        if (unreadable) viaSevenZip.push(want);
      }
    }

    if (viaSevenZip.length > 0) {
      const taken = await extractWithSevenZip({
        archivePath,
        restores: viaSevenZip,
        dest: path.join(tempDir, "7z"),
        ...(args.sevenZip !== undefined ? { sevenZip: args.sevenZip } : {}),
        ...(signal !== undefined ? { signal } : {}),
      });
      if (taken.aborted === true) return { ...out, aborted: true };
      for (const want of viaSevenZip) {
        const files = [
          ...(copies.get(want.path) ?? []),
          ...(taken.copies.get(want.path) ?? []),
        ];
        copies.set(want.path, files);
        const reason = taken.reasons.get(want.path);
        if (files.length === 0 && reason !== undefined) {
          reasons.set(want.path, reason);
        }
      }
    }

    for (const want of restores) {
      if (signal?.aborted === true) return { ...out, aborted: true };
      const files = copies.get(want.path) ?? [];
      try {
        let placed = false;
        for (const file of files) {
          if ((await hashFileSha256(file)) !== want.sha256) continue;
          await placeFile(file, stagingRoot, want.path);
          placed = true;
          break;
        }
        if (placed) {
          out.restored += 1;
          continue;
        }
        out.failures.push({
          path: want.path,
          why:
            reasons.get(want.path) ??
            (files.length === 0
              ? "the mod's own archive has this file, and it could not be extracted"
              : `the mod's own archive has ${files.length} file(s) of this size ` +
                `at this path, and none holds the bytes the curator recorded`),
        });
      } catch (err) {
        out.failures.push({ path: want.path, why: messageOf(err) });
      }
    }
    return out;
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * A ZIP's entries, when every name in it is the name 7-Zip would write.
 *
 * `undefined` for anything else — not a ZIP, unreadable, or a name in a code
 * page this reader can only guess at — which hands the archive to 7-Zip.
 */
async function listZipIfNamesCertain(
  archivePath: string,
): Promise<ZipEntry[] | undefined> {
  try {
    const entries = await listZipEntries(archivePath);
    return entries.every((e) => e.nameEncodingKnown) ? entries : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract every candidate for `restores` with Vortex's 7-Zip, into `dest`.
 *
 * Batched: 7-Zip takes the entries to extract as trailing arguments, and a
 * solid archive is decompressed from its start on every run. Batches stay far
 * below the Windows command-line limit.
 */
async function extractWithSevenZip(args: {
  archivePath: string;
  restores: readonly MirrorRestore[];
  dest: string;
  sevenZip?: SevenZipApi;
  signal?: AbortSignal;
}): Promise<{
  copies: Map<string, string[]>;
  reasons: Map<string, string>;
  aborted?: boolean;
}> {
  const copies = new Map<string, string[]>();
  const reasons = new Map<string, string>();
  const forEvery = (why: string) => {
    for (const want of args.restores) reasons.set(want.path, why);
    return { copies, reasons };
  };

  let sevenZip: SevenZipApi;
  try {
    sevenZip = args.sevenZip ?? resolveSevenZip();
  } catch (err) {
    return forEvery(
      `the file comes from the mod's own archive, and 7-Zip is not ` +
        `available to open it: ${messageOf(err)}`,
    );
  }
  let entries: ArchiveEntry[];
  try {
    entries = (
      await listArchiveContents(sevenZip, args.archivePath, {
        ...(args.signal !== undefined ? { signal: args.signal } : {}),
      })
    ).entries;
  } catch (err) {
    return forEvery(`the mod's own archive could not be read: ${messageOf(err)}`);
  }

  const candidatesOf = new Map<string, ArchiveEntry[]>();
  const wanted = new Set<string>();
  for (const want of args.restores) {
    const candidates = entries.filter(
      (e) =>
        e.size === want.size &&
        // Joined onto a temp folder below; an entry above it is not a file
        // this mod installs.
        isSafeRelativePath(e.path) &&
        entrySitsAt(e.path, want.path),
    );
    candidatesOf.set(want.path, candidates);
    if (candidates.length === 0) reasons.set(want.path, NOT_IN_ARCHIVE);
    for (const e of candidates) wanted.add(e.path);
  }

  let extractFailure: string | undefined;
  for (const batch of batchesOf([...wanted], 6000)) {
    if (args.signal?.aborted === true) return { copies, reasons, aborted: true };
    try {
      await sevenZipExtractFull(
        sevenZip,
        args.archivePath,
        args.dest,
        { raw: batch },
        args.signal,
      );
    } catch (err) {
      // Part of the batch may have landed anyway; what did not is reported
      // per file below.
      extractFailure = messageOf(err);
    }
  }

  for (const want of args.restores) {
    const candidates = candidatesOf.get(want.path) ?? [];
    const files = candidates
      .map((e) => path.join(args.dest, ...segmentsOf(e.path)))
      .filter((f) => existsSync(f));
    copies.set(want.path, files);
    if (files.length === 0 && candidates.length > 0) {
      reasons.set(
        want.path,
        `the file could not be extracted from the mod's own archive` +
          (extractFailure !== undefined ? `: ${extractFailure}` : ""),
      );
    }
  }
  return { copies, reasons };
}

/** Split names into runs whose joined length stays under `maxChars`. */
function batchesOf(names: readonly string[], maxChars: number): string[][] {
  const out: string[][] = [];
  let batch: string[] = [];
  let length = 0;
  for (const name of names) {
    // +3: the quotes and the space each argument costs on a command line.
    if (batch.length > 0 && length + name.length + 3 > maxChars) {
      out.push(batch);
      batch = [];
      length = 0;
    }
    batch.push(name);
    length += name.length + 3;
  }
  if (batch.length > 0) out.push(batch);
  return out;
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
  /**
   * Set when this mod was installed from a hand-supplied archive that is NOT
   * the one the collection was built from.
   *
   * ─── WHY THIS ARGUMENT EXISTS ──────────────────────────────────────
   * A mirrored mod may leave its UNCHANGED files to its own archive, so the
   * package does not re-host the author's bytes (`state.mirrorFromArchive`).
   * For a Nexus mod that is safe: modId + fileId + sha256 pin the file, so
   * the player's archive is the curator's. An EXTERNAL mod is supplied by
   * hand and `installFromLocalArchive` deliberately allows a different
   * build — "a mirror, a repack, a newer build the author replaced the page
   * with" — so those files simply are not in it, every candidate fails its
   * hash check, and the restore is refused.
   *
   * The run knew both halves and said only the second: the player read "4
   * files could not be restored from the mod's own archive" with nothing
   * connecting it to the download they chose. Naming the cause is the whole
   * difference between a dead end and a fix they can act on.
   */
  suppliedArchiveDiffers?: { expected: string; actual: string },
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
  if (outcome.restored > 0) {
    const taken = outcome.fromArchive?.restored ?? 0;
    parts.push(
      `${outcome.restored} file(s) written` +
        (taken > 0 ? ` (${taken} from the mod's own archive)` : ""),
    );
  }
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
    if (suppliedArchiveDiffers !== undefined) {
      line +=
        ` — the file you supplied for this mod is not the one the collection ` +
        `was built from (collection: ${suppliedArchiveDiffers.expected}, ` +
        `yours: ${suppliedArchiveDiffers.actual}), and these files could only ` +
        `have come from that archive. Re-run the install and pick the matching ` +
        `download to finish this mod.`;
    }
  }
  return line;
}
