/**
 * `.ehcoll` ZIP packager (Phase 2 slice 3).
 *
 * Takes an {@link EhcollManifest} produced by `buildManifest` plus a list
 * of bundled archives, stages them in a temp directory, and produces a
 * single `.ehcoll` file (ZIP-format under the hood) on disk.
 *
 * Spec: docs/business/PACKAGE_ZIP.md
 *
 * Format choice — ZIP, not 7z:
 *  - Bundled archives are *already compressed* mod archives. The outer
 *    container's compression algorithm changes total size by a fraction
 *    of a percent — not worth giving up tooling compatibility.
 *  - ZIP can be inspected by Windows Explorer / WinRAR / `unzip` without
 *    any extra software, which matters when debugging a user-side install
 *    failure ("can you send me what your manifest.json looks like?").
 *  - The .ehcoll extension is opaque to end users in either case; format
 *    is an internal-only detail.
 *
 * Streaming: 7z reads bundled archives off disk directly via its own I/O
 * pipe. Node.js never holds bundled-archive bytes in memory. We hardlink
 * archives into the staging directory when possible (instant, free) and
 * fall back to copy on cross-volume / permissions errors.
 *
 * Identity — NOT byte-equal across rebuilds. A rebuild of the same
 * collection version may produce different bytes (different mtimes,
 * different 7z version, different filesystem enumeration order). The
 * canonical identity of a release is `(manifest.package.id,
 * manifest.package.version)`, both of which the schema already requires.
 * Don't add byte-determinism complexity to solve a problem that is
 * better solved at the metadata layer.
 *
 * The one stability concession: `manifest.json` keys are sorted via
 * `sortDeep` so unzipping two `.ehcoll` files and `diff`ing their
 * manifests highlights actual content changes, not key-order shuffles.
 */

import * as fsp from "fs/promises";
import { ehLog } from "../logging/ehLog";
import * as os from "os";
import * as path from "path";

import { AbortError, hashFileSha256 } from "../archiveHashing";
import type { EhcollManifest } from "../../types/ehcoll";
import { sortDeep } from "../../utils/utils";
import { resolveSevenZip, sevenZipAdd, type SevenZipApi } from "./sevenZip";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type BundledArchiveSpec = {
  /** Absolute path to the source archive on the curator's disk. */
  sourcePath: string;
  /**
   * Identity. Must equal exactly one external-mod's `source.sha256` in
   * the manifest. The packager refuses to bundle anything that doesn't
   * correspond to a `source.bundled === true` external mod entry.
   */
  sha256: string;
};

export type MirrorFileSpec = {
  /** Absolute path to the curator's file on disk. */
  sourcePath: string;
  /** Its SHA-256, which is also its name inside the package. */
  sha256: string;
  /**
   * Which mod this file belongs to, for the error message.
   *
   * Without it a vanished or altered source produced a raw Windows errno
   * naming a temp path, after every expensive phase of a fifty-minute build,
   * and the curator had to reverse-map a staging path to a mod by hand.
   */
  modName?: string;
};

/**
 * ──────────────────────────────────────────────────────────────────────
 * What packaging is doing, while it does it.
 *
 * This module ran for minutes behind a single unchanging "Packaging
 * .ehcoll..." and wrote nothing to any log. On a 9.4 GB collection the last
 * step alone — reading the finished package back to hash it — takes minutes
 * with no disk activity a curator can see, and it was reported as a freeze.
 * It was not frozen. It was working, silently, which from outside is the
 * same thing.
 *
 * `bytes` is carried where it is known, because "hashing the package" is a
 * puzzling wait and "hashing the package (9.4 GB)" is an explained one.
 * ──────────────────────────────────────────────────────────────────────
 */
export type PackageProgress = {
  step:
    | "writing-manifest"
    | "staging-mirror"
    | "staging-bundled"
    | "compressing"
    | "hashing-output";
  message: string;
  done?: number;
  total?: number;
  bytes?: number;
};

export type PackageEhcollInput = {
  /** Called as each packaging step begins, and as long ones advance. */
  onProgress?: (progress: PackageProgress) => void;
  manifest: EhcollManifest;
  bundledArchives: BundledArchiveSpec[];
  /**
   * Curator files a mirrored mod's archive cannot produce, staged at
   * `mirror/<sha256>`.
   *
   * Content-addressed and therefore deduplicated by construction: the same
   * cleaned plugin shared by two mods is carried once. No path is recorded
   * here because none is needed — the manifest's `stagingFiles` already says
   * where each hash belongs, and a second copy of that mapping is a second
   * thing to keep in sync.
   */
  mirrorFiles?: MirrorFileSpec[];
  /** Optional README markdown. Written as `README.md` at the package root. */
  readme?: string;
  /** Optional CHANGELOG markdown. Written as `CHANGELOG.md` at the package root. */
  changelog?: string;
  /** Absolute path of the final `.ehcoll` file. Existing file is overwritten. */
  outputPath: string;
  /**
   * Optional override for the temp staging directory. Defaults to
   * `os.tmpdir()/event-horizon-pack-<random>`. Useful for tests.
   */
  stagingDir?: string;
  /** Default true. When false, the staging directory is left in place. */
  cleanupOnSuccess?: boolean;
  /**
   * Default false (fast path). When true, every bundled archive is
   * re-hashed against {@link BundledArchiveSpec.sha256} before staging.
   * Slow on big archives but catches "curator's archive cache changed
   * since snapshot export."
   */
  verifyHashes?: boolean;
  /** Optional injection point for tests. Defaults to vortex-api's SevenZip. */
  sevenZip?: SevenZipApi;
  /**
   * Cooperative cancellation. When fired, the packager:
   *   1. Throws {@link AbortError} at the next checkpoint between phases.
   *   2. Sends SIGTERM to the spawned 7z child if packaging has started, so
   *      "cancel" doesn't have to wait for 7z to finish on its own.
   *   3. Cleans up the staging directory AND any partially-written
   *      `outputPath` so the curator's output folder doesn't accumulate
   *      corrupt half-zipped archives.
   */
  signal?: AbortSignal;
};

export type PackageEhcollResult = {
  outputPath: string;
  outputBytes: number;
  /**
   * SHA-256 of the finished `.ehcoll`.
   *
   * A package cannot contain its own hash, so this is how a curator gets one
   * to publish alongside it — and how a recipient's "is my copy intact?"
   * stops being a conversation.
   */
  outputSha256: string;
  bundledCount: number;
  /** Non-fatal issues (e.g. README too short, unusual file extensions). */
  warnings: string[];
};

export class PackageEhcollError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(
      errors.length === 1
        ? errors[0]
        : `Cannot pack .ehcoll (${errors.length} problems):\n  - ${errors.join(
            "\n  - ",
          )}`,
    );
    this.name = "PackageEhcollError";
    this.errors = errors;
  }
}

/**
 * Build a `.ehcoll` archive from a manifest + bundled-archive list.
 *
 * Returns when the archive is fully written and fsynced (delegated to
 * 7z). Throws {@link PackageEhcollError} on any validation or I/O error;
 * staging directory is cleaned up regardless.
 */
/** Bytes as something a waiting person reads. */
function describeBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export async function packageEhcoll(
  input: PackageEhcollInput,
): Promise<PackageEhcollResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  validateInput(input, errors);
  if (errors.length > 0) throw new PackageEhcollError(errors);

  const signal = input.signal;
  const checkAbort = (): void => {
    if (signal?.aborted) {
      throw new AbortError("Packaging cancelled by user");
    }
  };
  checkAbort();

  const stagingDir = await prepareStagingDir(input.stagingDir);
  const cleanupOnSuccess = input.cleanupOnSuccess !== false;

  const onProgress = input.onProgress;
  const started = Date.now();
  ehLog("info", "package.start", {
    mods: input.manifest.mods.length,
    bundled: input.bundledArchives.length,
    mirrorFiles: input.mirrorFiles?.length ?? 0,
    output: input.outputPath,
  });

  try {
    checkAbort();
    onProgress?.({ step: "writing-manifest", message: "Writing the manifest..." });
    await writeManifestJson(stagingDir, input.manifest);

    checkAbort();
    await writeOptionalMarkdown(stagingDir, "README.md", input.readme);

    checkAbort();
    await writeOptionalMarkdown(stagingDir, "CHANGELOG.md", input.changelog);

    const mirrorFiles = input.mirrorFiles ?? [];
    if (mirrorFiles.length > 0) {
      ehLog("info", "package.mirror.start", { files: mirrorFiles.length });
    }
    const mirrorMs = Date.now();
    await stageMirrorFiles(stagingDir, mirrorFiles, signal, onProgress);
    if (mirrorFiles.length > 0) {
      ehLog("info", "package.mirror.ok", {
        files: mirrorFiles.length,
        ms: Date.now() - mirrorMs,
      });
    }

    ehLog("info", "package.bundled.start", {
      archives: input.bundledArchives.length,
      verifyHashes: input.verifyHashes === true,
    });
    const bundledMs = Date.now();
    await stageBundledArchives(
      stagingDir,
      input.bundledArchives,
      input.verifyHashes === true,
      signal,
      onProgress,
    );
    ehLog("info", "package.bundled.ok", {
      archives: input.bundledArchives.length,
      ms: Date.now() - bundledMs,
    });

    checkAbort();
    onProgress?.({
      step: "compressing",
      message: "Compressing the package — this is the long part.",
    });
    ehLog("info", "package.compress.start", {});
    const compressMs = Date.now();
    await runSevenZipAdd(
      input.outputPath,
      stagingDir,
      input.sevenZip ?? resolveSevenZip(),
      signal,
    );
    ehLog("info", "package.compress.ok", { ms: Date.now() - compressMs });

    checkAbort();
    const stat = await fsp.stat(input.outputPath);

    if (cleanupOnSuccess) {
      await safeRmDir(stagingDir);
    }

    // The package's own identity.
    //
    // Nothing recorded this before, and its absence cost real hours: when an
    // alpha tester could not open a collection, the only way to establish that
    // his copy was intact was for two people to run sha256sum by hand and read
    // hex to each other over a chat client. A package that states its own hash
    // turns that into a glance.
    //
    // Computed from the FINISHED FILE rather than accumulated while writing:
    // what matters is the bytes that actually landed on disk, because those
    // are the bytes a recipient will hash.
    // ─── THE STEP THAT LOOKED LIKE A FREEZE ────────────────────────────
    // Reading 9.4 GB back off disk takes minutes and moves nothing a curator
    // can see: the .ehcoll already exists and has stopped growing. Said out
    // loud, with the size, so the wait is explained rather than alarming.
    onProgress?.({
      step: "hashing-output",
      message: `Fingerprinting the finished package (${describeBytes(stat.size)})...`,
      bytes: stat.size,
    });
    ehLog("info", "package.hash.start", { bytes: stat.size });
    const hashMs = Date.now();
    const outputSha256 = await hashFileSha256(input.outputPath, signal);
    ehLog("info", "package.hash.ok", {
      bytes: stat.size,
      ms: Date.now() - hashMs,
    });
    ehLog("info", "package.ok", {
      ms: Date.now() - started,
      bytes: stat.size,
      sha256: outputSha256,
      bundled: input.bundledArchives.length,
    });

    return {
      outputPath: input.outputPath,
      outputBytes: stat.size,
      outputSha256,
      bundledCount: input.bundledArchives.length,
      warnings,
    };
  } catch (err) {
    ehLog("error", "package.fail", {
      ms: Date.now() - started,
      output: input.outputPath,
      err,
    });
    // Cleanup BOTH the staging dir AND any partially-written output. Without
    // the second step, a failed/cancelled build leaves a corrupt .ehcoll on
    // disk that the curator might mistake for a real artifact.
    await safeRmDir(stagingDir);
    await safeRmFile(input.outputPath);

    // Preserve abort/package errors verbatim so callers can distinguish
    // "user cancelled" from "real failure" without digging through wrapped
    // messages.
    if (err instanceof AbortError) throw err;
    if (err instanceof PackageEhcollError) throw err;
    if (isAbortLikeError(err)) throw err;

    throw new PackageEhcollError([
      err instanceof Error ? err.message : String(err),
    ]);
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateInput(input: PackageEhcollInput, errors: string[]): void {
  if (!input.outputPath || !path.isAbsolute(input.outputPath)) {
    errors.push(
      `outputPath must be an absolute path. Got: ${JSON.stringify(input.outputPath)}.`,
    );
  }

  // Build the {sha256 → bundled-external-mod} index from the manifest.
  // External mods with bundled=true MUST have a corresponding archive in
  // input.bundledArchives, and vice versa: every bundled archive MUST
  // correspond to exactly one such mod. Two bundled archives can't share
  // a sha256 (would be a duplicate identity).
  const expectedBundled = new Map<string, string>(); // sha256 → mod compareKey
  for (const mod of input.manifest.mods) {
    // Invariant (parser-enforced): bundled === true ⇒ source.sha256 set.
    if (mod.source.kind === "external" && mod.source.bundled) {
      expectedBundled.set(mod.source.sha256!, mod.compareKey);
    }
  }

  const seen = new Map<string, string>(); // sha256 → archive sourcePath
  for (const archive of input.bundledArchives) {
    if (!archive.sha256 || !/^[0-9a-f]{64}$/.test(archive.sha256)) {
      errors.push(
        `Bundled archive at "${archive.sourcePath}" has an invalid sha256 ` +
          `(must be lowercase hex, exactly 64 chars). Got: "${archive.sha256}".`,
      );
      continue;
    }

    const dup = seen.get(archive.sha256);
    if (dup !== undefined) {
      errors.push(
        `Two bundled archives share sha256 "${archive.sha256}": ` +
          `"${dup}" and "${archive.sourcePath}". Each external mod has a ` +
          `unique identity, so this should be impossible.`,
      );
      continue;
    }
    seen.set(archive.sha256, archive.sourcePath);

    if (!expectedBundled.has(archive.sha256)) {
      errors.push(
        `Bundled archive at "${archive.sourcePath}" (sha256 ${archive.sha256}) ` +
          `does not correspond to any external mod with bundled=true in the ` +
          `manifest. Drop the archive or flip the matching mod's bundled flag.`,
      );
    }

    if (!path.isAbsolute(archive.sourcePath)) {
      errors.push(
        `Bundled archive sourcePath must be absolute. Got: "${archive.sourcePath}".`,
      );
    }
  }

  for (const [sha256, modKey] of expectedBundled) {
    if (!seen.has(sha256)) {
      errors.push(
        `External mod "${modKey}" is marked bundled=true in the manifest ` +
          `but no archive with sha256 ${sha256} was provided. Either supply ` +
          `the archive or flip the mod to bundled=false.`,
      );
    }
  }

  /**
   * ─── THE SAME BIJECTION, FOR MIRRORS ───────────────────────────────────
   * Bundling has been checked both ways since the beginning; mirroring was
   * not checked at all, and it fails in a quieter direction.
   *
   * A mod ships `mirrored: true` and contributes NO blobs whenever one of its
   * staged files could not be hashed — a locked file, an antivirus handle —
   * because the payload collector skips hashless entries. The build succeeds.
   * On every user's machine `planMirror` then marks the whole target
   * unverifiable, which disables deletion for that mod and reconciles
   * nothing. The feature is off, silently, on both sides.
   *
   * So: a mirrored mod must have a hash for every staged file, and each of
   * those hashes must be in the package.
   */
  const mirrorShas = new Set(input.mirrorFiles?.map((f) => f.sha256) ?? []);
  for (const mod of input.manifest.mods) {
    if (mod.state?.mirrored !== true) continue;
    const staged = mod.state.stagingFiles ?? [];
    if (staged.length === 0) {
      errors.push(
        `"${mod.name}" is marked mirrored=true but no staged files were ` +
          `recorded for it, so there is nothing to reproduce on the user's ` +
          `machine. Re-run the build, or change this mod's answer.`,
      );
      continue;
    }
    const hashless = staged.filter((f) => f.sha256 === undefined).length;
    if (hashless > 0) {
      errors.push(
        `"${mod.name}" is marked mirrored=true but ${hashless} of its ` +
          `${staged.length} staged file(s) could not be hashed, so they ` +
          `cannot be reproduced. A locked or unreadable file is the usual ` +
          `cause. Close whatever holds it and rebuild, or change this mod's ` +
          `answer.`,
      );
      continue;
    }
    const absent = staged.filter((f) => !mirrorShas.has(f.sha256!)).length;
    if (absent > 0) {
      errors.push(
        `"${mod.name}" is marked mirrored=true but ${absent} of its ` +
          `${staged.length} file(s) were not collected into the package. ` +
          `Users would receive an incomplete copy of this mod.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

async function prepareStagingDir(override?: string): Promise<string> {
  if (override !== undefined) {
    await fsp.rm(override, { recursive: true, force: true });
    await fsp.mkdir(override, { recursive: true });
    return override;
  }

  const prefix = path.join(os.tmpdir(), "event-horizon-pack-");
  return fsp.mkdtemp(prefix);
}

async function writeManifestJson(
  stagingDir: string,
  manifest: EhcollManifest,
): Promise<void> {
  // Sort object keys recursively so that unzipping two .ehcoll files and
  // `diff`ing their manifests reflects real content changes, not JSON
  // serialization key-order shuffles. Cheap; useful when debugging.
  const sorted = sortDeep(manifest);
  const json = JSON.stringify(sorted, null, 2) + "\n";
  await fsp.writeFile(path.join(stagingDir, "manifest.json"), json, "utf8");
}

async function writeOptionalMarkdown(
  stagingDir: string,
  name: string,
  content: string | undefined,
): Promise<void> {
  if (content === undefined) return;
  // Trailing newline is conventional for markdown; ensures consistent
  // bytes whether or not the curator's source had one.
  const normalized = content.endsWith("\n") ? content : content + "\n";
  await fsp.writeFile(path.join(stagingDir, name), normalized, "utf8");
}

/**
 * Stage every bundled archive into `stagingDir/bundled/<sha256>.<ext>`.
 *
 * Strategy: hardlink (free, instant), fall back to copy on EXDEV / EPERM.
 */
async function stageBundledArchives(
  stagingDir: string,
  archives: BundledArchiveSpec[],
  verifyHashes: boolean,
  signal: AbortSignal | undefined,
  onProgress?: (progress: PackageProgress) => void,
): Promise<void> {
  const bundledDir = path.join(stagingDir, "bundled");
  await fsp.mkdir(bundledDir, { recursive: true });

  let done = 0;
  for (const archive of archives) {
    if (signal?.aborted) {
      throw new AbortError("Packaging cancelled by user");
    }
    done += 1;
    onProgress?.({
      step: "staging-bundled",
      message: `Collecting bundled archives (${done} / ${archives.length})...`,
      done,
      total: archives.length,
    });

    /**
     * Unconditional, and `verifyHashes` no longer gates it.
     *
     * The flag defaulted to false and NO production caller ever set it, so
     * `verifyArchiveHash` was dead code in every real build — while the
     * docblock justifying the mirror re-hash cited it as established
     * precedent: "Bundled archives have been re-hashed before staging since
     * the beginning; mirror files were hardlinked and trusted." That was not
     * true of a single shipped package.
     *
     * The window it guards is real and larger here than for mirror files: a
     * curator can repack or replace a bundled archive during the decisions
     * gate, and nothing on the read side hashes it either. Under NS-1 the
     * read costs nothing worth counting.
     */
    await verifyArchiveHash(archive);

    const ext = stripDot(path.extname(archive.sourcePath));
    const fileName = ext.length > 0
      ? `${archive.sha256}.${ext}`
      : archive.sha256;
    const dst = path.join(bundledDir, fileName);

    await stageOne(archive.sourcePath, dst);
  }
}

/**
 * Stage every mirrored file into `stagingDir/mirror/<sha256>`.
 *
 * Deduplicated on the way in: two mods that both carry the same cleaned
 * plugin name the same blob, and staging it twice would fail on EEXIST for a
 * reason that has nothing wrong with it.
 */
async function stageMirrorFiles(
  stagingDir: string,
  files: readonly MirrorFileSpec[],
  signal: AbortSignal | undefined,
  onProgress?: (progress: PackageProgress) => void,
): Promise<void> {
  if (files.length === 0) return;
  const mirrorDir = path.join(stagingDir, "mirror");
  await fsp.mkdir(mirrorDir, { recursive: true });

  const staged = new Set<string>();
  let done = 0;
  for (const file of files) {
    if (signal?.aborted) throw new AbortError("Packaging cancelled by user");
    done += 1;
    onProgress?.({
      step: "staging-mirror",
      message: `Collecting mirrored files (${done} / ${files.length})...`,
      done,
      total: files.length,
    });
    if (staged.has(file.sha256)) continue;
    staged.add(file.sha256);
    await verifyMirrorHash(file);
    await stageOne(file.sourcePath, path.join(mirrorDir, file.sha256));
  }
}

/**
 * ─── THE BYTES MUST STILL BE THE BYTES WE NAMED ────────────────────────
 * Bundled archives have been re-hashed before staging since the beginning;
 * mirror files were hardlinked to `mirror/<recorded sha>` and trusted.
 *
 * The window is not a race, it is human-scale. The hashes are computed during
 * the inspect pass; packaging runs after the self-check, the deployment
 * capture, the bundling repack, AND the decisions gate — a modal the curator
 * can sit on for as long as they like. Clean a plugin in xEdit in that window
 * and the file ships under a name that is no longer its hash.
 *
 * The user side catches it and refuses to write, which is the right failure
 * direction — but it fails on every tester's machine instead of once on the
 * curator's, and the tester has no idea what to do about it. Better to fail
 * the build, here, naming the mod and the file.
 *
 * Deduplication makes it worse without this: two mods sharing a blob stage it
 * once, so ONE stale source silently breaks the mirror for a mod that never
 * changed.
 */
async function verifyMirrorHash(file: MirrorFileSpec): Promise<void> {
  const { hashFileSha256 } = await import("../archiveHashing");
  let actual: string;
  try {
    actual = await hashFileSha256(file.sourcePath);
  } catch (err) {
    throw new PackageEhcollError([
      `${file.modName !== undefined ? `"${file.modName}": ` : ""}` +
        `the file "${file.sourcePath}" was recorded at the start of this ` +
        `build and could not be read now (${
          err instanceof Error ? err.message : String(err)
        }). Rebuild so the package matches your current staging folder.`,
    ]);
  }
  if (actual !== file.sha256) {
    throw new PackageEhcollError([
      `${file.modName !== undefined ? `"${file.modName}": ` : ""}` +
        `the file "${file.sourcePath}" changed during this build — it was ` +
        `recorded as ${file.sha256} and is now ${actual}. Shipping it under ` +
        `the old name would make every user refuse to write it. Rebuild.`,
    ]);
  }
}

function stripDot(ext: string): string {
  return ext.startsWith(".") ? ext.slice(1) : ext;
}

async function stageOne(src: string, dst: string): Promise<void> {
  try {
    await fsp.link(src, dst);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      // Should not happen — staging dir is freshly created. Re-throw.
      throw err;
    }
    // EXDEV (cross-volume), EPERM (no hardlink permission), ENOSYS (FS
    // doesn't support hardlinks): fall through to copy.
  }

  await fsp.copyFile(src, dst);
}

async function verifyArchiveHash(archive: BundledArchiveSpec): Promise<void> {
  const { hashFileSha256 } = await import("../archiveHashing");
  const actual = await hashFileSha256(archive.sourcePath);
  if (actual !== archive.sha256) {
    throw new PackageEhcollError([
      `Bundled archive sha256 mismatch at "${archive.sourcePath}". ` +
        `Expected ${archive.sha256}, got ${actual}. ` +
        `The archive may have been replaced since the snapshot was exported. ` +
        `Re-export the snapshot and try again.`,
    ]);
  }
}

// ---------------------------------------------------------------------------
// 7z invocation
// ---------------------------------------------------------------------------

async function runSevenZipAdd(
  outputPath: string,
  stagingDir: string,
  sevenZip: SevenZipApi,
  signal: AbortSignal | undefined,
): Promise<void> {
  // Overwrite any existing .ehcoll at outputPath. 7z's `add` would APPEND
  // to an existing archive, which is never what we want.
  await fsp.rm(outputPath, { force: true });
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });

  // The .ehcoll extension would default 7z to its native .7z format —
  // force ZIP explicitly via `-tzip` so any tool can inspect the package.
  // Compression level is left at 7z's default (5); bundled archives are
  // already compressed so tweaking it changes total size by a fraction
  // of a percent.
  //
  // Source is an ABSOLUTE wildcard rather than `"*"` plus a working
  // directory: this node-7z spawns without a `cwd`, so there is no
  // `workingDir` option to honour one. 7z stores entries relative to the
  // wildcard's directory, which gives the same relative layout.
  const cancelled = (): boolean => signal?.aborted === true;
  if (cancelled()) {
    throw new AbortError("Packaging cancelled by user");
  }

  await sevenZipAdd(
    sevenZip,
    outputPath,
    [path.join(stagingDir, "*")],
    { raw: ["-tzip"], r: true },
    signal,
  );

  // Cancellation is cooperative: `sevenZipAdd` kills the spawned 7z child
  // from the progress callback (the only hook this node-7z exposes — it
  // never attaches a ChildProcess to the returned promise). A killed run
  // still resolves, so the abort is turned into an error here.
  if (cancelled()) {
    throw new AbortError("Packaging cancelled by user");
  }
}

async function safeRmDir(dir: string): Promise<void> {
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup. Failure here is purely cosmetic; the OS will
    // GC the temp dir eventually.
  }
}

async function safeRmFile(filePath: string): Promise<void> {
  try {
    await fsp.rm(filePath, { force: true });
  } catch {
    // Best-effort. If the file can't be removed (locked by AV?), the next
    // build will overwrite it via 7z's own `rm -f` step.
  }
}

/**
 * Match plain DOMException-style abort errors from Node's stream APIs and
 * any error whose `name === "AbortError"`. We don't have a single ancestor
 * class — Node, the DOM, and our own {@link AbortError} all use the
 * convention of `.name === "AbortError"`.
 */
function isAbortLikeError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "AbortError"
  );
}
