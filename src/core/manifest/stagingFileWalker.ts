import * as fs from "fs";
import {
  archiveFileCacheKey,
  type ArchiveHashLookup,
} from "../archiveHashCache";
import * as os from "os";
import * as path from "path";

import { toPosix } from "../paths";

import type { EhcollStagingFile, VerificationLevel } from "../../types/ehcoll";
import { hashFileSha256 } from "../archiveHashing";
import { AbortError } from "../../utils/abortError";
import { pMap } from "../../utils/pMap";

/**
 * Shared file-system primitives for hashing a Vortex staging folder.
 *
 * Two callers consume these:
 *  - {@link captureStagingFiles} on the curator side, building the
 *    manifest snapshot at package time.
 *  - {@link enrichInstalledModsWithStagingSetHashes} on the user
 *    side, computing the runtime fingerprint of mods whose name
 *    matches an external manifest entry without an `archiveSha256`.
 *
 * Both paths must agree byte-for-byte on:
 *  - Which files count (regular files only; symlinks resolved if
 *    they stay within `root`).
 *  - The shape of `relativePath` (POSIX separators, lexicographic
 *    order in the returned list).
 *  - SHA-256 of file contents.
 *
 * Any divergence breaks `stagingSetHash` parity between curator and
 * user — that's why the helpers live here, in one place, instead of
 * being duplicated.
 */

/**
 * Default file-hashing concurrency: one less than the number of
 * logical cores, with a floor of 2 and an explicit ceiling of 8.
 *
 * Rationale:
 *  - Most mod files are large enough that sha256 is bandwidth-bound
 *    on the disk, not CPU-bound, so adding more workers past ~4 has
 *    diminishing returns on a typical SSD.
 *  - Leaving one core for the Vortex UI / main thread keeps the
 *    progress bar responsive.
 *  - The ceiling of 8 prevents 32-core boxes from saturating
 *    process descriptors and starving the rest of Vortex.
 *
 * Caller can override via the `concurrency` parameter on
 * {@link hashStagingFiles}.
 */
export function getDefaultHashConcurrency(): number {
  const cpus = os.cpus().length;
  if (!Number.isFinite(cpus) || cpus < 2) {
    return 2;
  }
  return Math.min(8, Math.max(2, cpus - 1));
}

export type WalkedFile = {
  /** POSIX-style path relative to the staging root. */
  relativePath: string;
  /** Absolute path on disk. */
  absolutePath: string;
  size: number;
  /**
   * Last-modified time in ms. The walk already stats every file for its size,
   * so this costs nothing and is what lets a hash be reused across builds
   * instead of re-reading 205GB every time.
   */
  mtimeMs: number;
};

/**
 * Recursive directory walk that returns every regular file under
 * `root` with its size. Symlinks are followed only when they resolve
 * to files inside `root` (anti-loop guard); hardlinks are walked
 * normally as Vortex's primary deployment method produces them in
 * the *deploy* folder, not staging — staging is always real bytes.
 *
 * Returns an empty array if `root` doesn't exist (mod was concurrently
 * uninstalled — non-fatal, the build snapshot won't include it anyway).
 */
/**
 * ─── A FILE WE NEVER SAW LEAVES NO TRACE, AND THAT WAS LOAD-BEARING ─────
 * Three paths below give up on part of the tree: a directory that cannot be
 * listed, a symlink that cannot be resolved, a file that cannot be stat-ed.
 * Each used to `continue` in silence, so the walk returned a SHORTER list and
 * nothing anywhere said it was short.
 *
 * That is fine for a report and catastrophic for a mirror. `planMirror` only
 * deletes the user's extra files when the curator's listing is "provably
 * whole", and the proof it used was "every recorded entry carries a hash" — a
 * gap that only appears for a file that WAS walked and could not be READ. A
 * subtree that was never walked produces no entry, so no gap, so the guard
 * stays quiet and every one of those files is classified as the user's own
 * junk and deleted. A single unlistable `textures/` — a path over MAX_PATH, a
 * cloud placeholder, an AV handle — is enough to amputate a mod on every
 * user's machine and then certify the result as verified.
 *
 * So incompleteness is now REPORTED rather than inferred from an absence.
 * Callers that only summarise may ignore it; the ones that delete may not.
 */
export type UnreadablePath = {
  path: string;
  /** "dir" — a subtree was skipped whole. "file" — one entry was skipped. */
  kind: "dir" | "file" | "symlink";
  why: string;
};

export async function walkStagingFolder(
  root: string,
  signal: AbortSignal | undefined,
  /**
   * Called for every path the walk had to skip. A caller that receives none
   * knows the listing is complete; that is the only way to know it.
   */
  onUnreadable?: (entry: UnreadablePath) => void,
): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];

  const stat = await fs.promises.stat(root).catch(() => undefined);
  if (stat === undefined || !stat.isDirectory()) {
    // The root itself. Not reported as unreadable: "the mod has no staging
    // folder" is a different fact, and every caller already handles an empty
    // list. Reporting it here would make every uninstalled mod look damaged.
    return out;
  }

  const stack: string[] = [root];
  const visited = new Set<string>();

  while (stack.length > 0) {
    if (signal?.aborted) throw new AbortError();
    const dir = stack.pop()!;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // The whole subtree, gone. The most consequential of the three.
      onUnreadable?.({
        path: dir,
        kind: "dir",
        why: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    for (const entry of entries) {
      if (signal?.aborted) throw new AbortError();
      const abs = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }

      if (entry.isSymbolicLink()) {
        const realPath = await fs.promises
          .realpath(abs)
          .catch(() => undefined);
        if (realPath === undefined) {
          onUnreadable?.({
            path: abs,
            kind: "symlink",
            why: "the link target could not be resolved",
          });
          continue;
        }
        if (!realPath.startsWith(root)) {
          // Deliberate and not a gap: a link out of the staging folder is not
          // part of this mod, and following it would capture someone else's
          // files. `visited` is loop protection, equally deliberate.
          continue;
        }
        if (visited.has(realPath)) continue;
        visited.add(realPath);
        const lstat = await fs.promises.stat(realPath).catch(() => undefined);
        if (lstat === undefined || !lstat.isFile()) continue;

        out.push({
          relativePath: toPosix(path.relative(root, abs)),
          absolutePath: abs,
          size: lstat.size,
          mtimeMs: lstat.mtimeMs,
        });
        continue;
      }

      if (entry.isFile()) {
        const lstat = await fs.promises.stat(abs).catch(() => undefined);
        if (lstat === undefined) {
          onUnreadable?.({
            path: abs,
            kind: "file",
            why: "the file could not be stat-ed",
          });
          continue;
        }
        out.push({
          relativePath: toPosix(path.relative(root, abs)),
          absolutePath: abs,
          size: lstat.size,
          mtimeMs: lstat.mtimeMs,
        });
      }
    }
  }

  out.sort((a, b) =>
    a.relativePath < b.relativePath
      ? -1
      : a.relativePath > b.relativePath
        ? 1
        : 0,
  );
  return out;
}

/**
 * Materialise a {@link WalkedFile} list into the manifest-shaped
 * {@link EhcollStagingFile} array. SHA-256 is computed iff
 * `level === "thorough"`. Per-file errors are surfaced to `onFileWarn`
 * and degrade silently to `{ path, size }` (no sha) for that one
 * file — partial captures are handled deterministically downstream
 * (e.g. {@link computeStagingSetHash} refuses to hash a file set
 * with any missing sha).
 *
 * `concurrency` defaults to {@link getDefaultHashConcurrency} (cpu-aware).
 * Callers that have a strong reason (e.g. running in a constrained
 * UI thread) can pass a smaller number explicitly.
 */
export async function hashStagingFiles(
  _root: string,
  files: WalkedFile[],
  level: VerificationLevel,
  concurrency: number | undefined,
  signal: AbortSignal | undefined,
  onFileWarn: (relativePath: string, err: Error) => void,
  /**
   * Optional. OPT-IN because the install side hashes a USER's staging folder,
   * where reusing a curator-era hash would be meaningless; only the build
   * passes one.
   */
  hashCache?: ArchiveHashLookup,
): Promise<EhcollStagingFile[]> {
  if (level === "fast") {
    return files.map<EhcollStagingFile>((f) => ({
      path: f.relativePath,
      size: f.size,
    }));
  }

  const workers = Math.max(
    1,
    concurrency ?? getDefaultHashConcurrency(),
  );

  const hashes = await pMap(
    files,
    workers,
    async (file) => {
      try {
        // 205GB re-read on every build is what made "thorough" a level the
        // curator had to opt into. A hash is reused only while path, size AND
        // mtime all match, so a file that changed is always re-read.
        const key =
          hashCache !== undefined
            ? archiveFileCacheKey(file.absolutePath, file.size, file.mtimeMs)
            : undefined;
        const cached = key === undefined ? undefined : hashCache!.get(key);
        if (cached !== undefined) {
          return { ok: true as const, sha256: cached };
        }
        const sha256 = await hashFileSha256(file.absolutePath, signal);
        if (key !== undefined) {
          hashCache!.set(key, sha256);
        }
        return { ok: true as const, sha256 };
      } catch (err) {
        if (err instanceof AbortError) throw err;
        onFileWarn(file.relativePath, err as Error);
        return { ok: false as const };
      }
    },
    signal,
  );

  return files.map<EhcollStagingFile>((f, i) => {
    const h = hashes[i]!;
    if (h.ok) {
      return { path: f.relativePath, size: f.size, sha256: h.sha256 };
    }
    return { path: f.relativePath, size: f.size };
  });
}

