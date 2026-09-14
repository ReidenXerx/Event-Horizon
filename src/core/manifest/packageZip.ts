/**
 * `.ehcoll` ZIP packager (Phase 2 slice 3).
 *
 * Takes an {@link EhcollManifest} produced by `buildManifest` plus the files of
 * its bundled and mirrored mods, stages them in a temp directory, and produces
 * a single `.ehcoll` file (ZIP-format under the hood) on disk.
 *
 * Spec: docs/business/PACKAGE_ZIP.md
 *
 * ─── NOTHING INSIDE A PACKAGE IS AN ARCHIVE ───────────────────────────
 * Nexus Mods quarantines any upload with an archive inside it: its virus scan
 * cannot see into one, and its own help tells authors to extract them. So a
 * bundled mod ships as its loose files under `bundled/<sha256>/` — the sha of
 * the canonical zip those files make (bundleZip.ts), which the user's install
 * writes back and checks — and a mirrored file ships loose as `mirror/<sha256>`.
 * A file that is itself an archive, judged by its first bytes whatever it is
 * called, stops the build with its mod and path named.
 *
 * Format choice — ZIP, not 7z:
 *  - ZIP can be inspected by Windows Explorer / WinRAR / `unzip` without
 *    any extra software, which matters when debugging a user-side install
 *    failure ("can you send me what your manifest.json looks like?").
 *  - The .ehcoll extension is opaque to end users in either case; format
 *    is an internal-only detail.
 *
 * Streaming: 7z reads the staged files off disk directly via its own I/O
 * pipe. Node.js never holds a mod's bytes in memory. We hardlink files into
 * the staging directory when possible (instant, free) and fall back to copy
 * on cross-volume / permissions errors.
 *
 * Identity — NOT byte-equal across rebuilds. A rebuild of the same
 * collection version may produce different bytes (different mtimes,
 * different 7z version, different filesystem enumeration order). The
 * canonical identity of a release is `(manifest.package.id,
 * manifest.package.version)`, both of which the schema already requires.
 * Don't add byte-determinism complexity to solve a problem that is
 * better solved at the metadata layer. A bundled MOD is the exception, and an
 * exact one: its identity is made from its files alone, so nothing this
 * package's own zip does can move it.
 *
 * The one stability concession: `manifest.json` keys are sorted via
 * `sortDeep` so unzipping two `.ehcoll` files and `diff`ing their
 * manifests highlights actual content changes, not key-order shuffles.
 */

import { isAbort } from "../../utils/abortError";
import * as fs from "fs";
import * as fsp from "fs/promises";
import { ehLog } from "../logging/ehLog";
import * as os from "os";
import * as path from "path";

import { AbortError, hashFileSha256 } from "../archiveHashing";
import type { EhcollManifest } from "../../types/ehcoll";
import { sortDeep } from "../../utils/utils";
import { archiveFormatOfFile, type ArchiveFormat } from "./archiveInside";
import { bundleFolderInPackage } from "./bundleLayout";
import {
  bundleFilesFromPackage,
  listBundleFolder,
  writeBundleZip,
  type BundleFile,
  type BundleListing,
} from "./bundleZip";
import { crc32AndSha256File, openZipReader } from "./readZip";
import { DiskSpaceError, requireFreeSpace, type FreeBytesProbe } from "../../utils/diskSpace";
import type { EhcollStagingFile } from "../../types/ehcoll";
import { resolveSevenZip, sevenZipAdd, type SevenZipApi } from "./sevenZip";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** One bundled mod. Its files ship loose at `bundled/<sha256>/`. */
export type BundleSpec = {
  /** Absolute path of the mod's staging folder on the curator's disk. */
  rootDir: string;
  /**
   * Identity: the sha256 of the canonical zip these files make
   * (bundleZip.ts). Must equal exactly one external mod's `source.sha256` in
   * the manifest, and packaging refuses the build when the files it stages
   * make anything else.
   */
  sha256: string;
  /** The mod, for messages. */
  modName: string;
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
    | "checking-archives"
    | "writing-manifest"
    | "staging-mirror"
    | "staging-bundled"
    | "verifying-bundles"
    | "compressing"
    | "verifying-package"
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
  /** The bundled mods: one for each external mod the manifest marks `bundled`. */
  bundles: BundleSpec[];
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
  /**
   * Absolute path of the final `.ehcoll` file. A file already there is replaced
   * only by a finished, verified package; a refused or cancelled build leaves
   * it as it was.
   */
  outputPath: string;
  /**
   * Optional override for the temp staging directory. Defaults to
   * `os.tmpdir()/event-horizon-pack-<random>`. Useful for tests.
   */
  stagingDir?: string;
  /** Default true. When false, the staging directory is left in place. */
  cleanupOnSuccess?: boolean;
  /** Optional injection point for tests. Defaults to vortex-api's SevenZip. */
  sevenZip?: SevenZipApi;
  /** Optional injection point for tests: free bytes on a directory's drive. Defaults to the real probe. */
  freeBytes?: FreeBytesProbe;
  /**
   * Cooperative cancellation. When fired, the packager:
   *   1. Throws {@link AbortError} at the next checkpoint between phases.
   *   2. Sends SIGTERM to the spawned 7z child if packaging has started, so
   *      "cancel" doesn't have to wait for 7z to finish on its own.
   *   3. Cleans up the staging directory AND the unfinished
   *      `<outputPath>.partial`, so the curator's output folder doesn't
   *      accumulate half-zipped archives. A package already at `outputPath`
   *      is left as it was.
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
 * Build a `.ehcoll` archive from a manifest and its bundled and mirrored mods' files.
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
  // 7-Zip writes beside the output, and what it wrote takes the output's place
  // only once it is finished and proven. Written in place, a rebuild of the
  // same version that was refused or cancelled deleted the package the curator
  // already had.
  const partialPath = `${input.outputPath}.partial`;

  const onProgress = input.onProgress;
  const started = Date.now();
  ehLog("info", "package.start", {
    mods: input.manifest.mods.length,
    bundles: input.bundles.length,
    mirrorFiles: input.mirrorFiles?.length ?? 0,
    output: input.outputPath,
  });

  try {
    // Before anything is collected: a build that is going to be refused should
    // say so now, not after minutes of staging files.
    checkAbort();
    const bundles = await listBundles(input.bundles, signal);
    await refuseArchivesInside(bundles, input.mirrorFiles ?? [], signal, onProgress);

    checkAbort();
    onProgress?.({ step: "writing-manifest", message: "Writing the manifest..." });
    await writeManifestJson(stagingDir, input.manifest);

    checkAbort();
    await writeOptionalMarkdown(stagingDir, "README.md", input.readme);

    checkAbort();
    await writeOptionalMarkdown(stagingDir, "CHANGELOG.md", input.changelog);

    const mirrorFiles = input.mirrorFiles ?? [];
    checkAbort();
    await refuseShortSpace(stagingDir, input.outputPath, bundles, mirrorFiles, input.freeBytes);
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

    const bundledFiles = bundles.reduce((n, b) => n + b.files.length, 0);
    ehLog("info", "package.bundled.start", {
      bundles: bundles.length,
      files: bundledFiles,
    });
    const bundledMs = Date.now();
    await stageBundles(stagingDir, bundles, recordedFilesByBundle(input.manifest), signal, onProgress);
    ehLog("info", "package.bundled.ok", {
      bundles: bundles.length,
      files: bundledFiles,
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
      partialPath,
      stagingDir,
      input.sevenZip ?? resolveSevenZip(),
      signal,
    );
    ehLog("info", "package.compress.ok", { ms: Date.now() - compressMs });

    checkAbort();
    await verifyPackagedBundles(partialPath, bundles, signal, onProgress);

    checkAbort();
    const stat = await fsp.stat(partialPath);

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
    const outputSha256 = await hashFileSha256(partialPath, signal);
    ehLog("info", "package.hash.ok", {
      bytes: stat.size,
      ms: Date.now() - hashMs,
    });
    checkAbort();
    try {
      await fsp.rename(partialPath, input.outputPath);
    } catch (err) {
      ehLog("error", "package.replace.fail", { output: input.outputPath, err });
      throw new PackageEhcollError([
        `The finished package could not take the place of "${input.outputPath}" ` +
          `(${err instanceof Error ? err.message : String(err)}). Close whatever ` +
          `has that file open and build again.`,
      ]);
    }
    ehLog("info", "package.ok", {
      ms: Date.now() - started,
      bytes: stat.size,
      sha256: outputSha256,
      bundled: input.bundles.length,
    });

    return {
      outputPath: input.outputPath,
      outputBytes: stat.size,
      outputSha256,
      bundledCount: input.bundles.length,
      warnings,
    };
  } catch (err) {
    const cancelled = isAbort(err, signal);
    ehLog(cancelled ? "info" : "error", cancelled ? "package.cancelled" : "package.fail", {
      ms: Date.now() - started,
      output: input.outputPath,
      err,
    });
    // The staging dir and the unfinished package. Not `outputPath`: whatever
    // is there is the last package that succeeded, not something this run wrote.
    await safeRmDir(stagingDir);
    await safeRmFile(partialPath);

    // Preserve abort/package errors verbatim so callers can distinguish
    // "user cancelled" from "real failure" without digging through wrapped
    // messages. Anything thrown once Cancel was pressed is a cancel — it is
    // there only because the work was stopped — and callers recognise an
    // AbortError, not whatever the interrupted call threw.
    if (cancelled) {
      throw err instanceof AbortError ? err : new AbortError("Packaging cancelled by user");
    }
    if (err instanceof PackageEhcollError) throw err;

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
  // External mods with bundled=true MUST have a corresponding bundle in
  // input.bundles, and vice versa: every bundle MUST correspond to exactly
  // one such mod. Two bundles can't share a sha256 (would be a duplicate
  // identity).
  const expectedBundled = new Map<string, string>(); // sha256 → mod compareKey
  for (const mod of input.manifest.mods) {
    // Invariant (parser-enforced): bundled === true ⇒ source.sha256 set.
    if (mod.source.kind === "external" && mod.source.bundled) {
      expectedBundled.set(mod.source.sha256!, mod.compareKey);
    }
  }

  const seen = new Map<string, string>(); // sha256 → mod name
  for (const bundle of input.bundles) {
    if (!bundle.sha256 || !/^[0-9a-f]{64}$/.test(bundle.sha256)) {
      errors.push(
        `Bundled mod "${bundle.modName}" has an invalid sha256 ` +
          `(must be lowercase hex, exactly 64 chars). Got: "${bundle.sha256}".`,
      );
      continue;
    }

    const dup = seen.get(bundle.sha256);
    if (dup !== undefined) {
      errors.push(
        `Two bundled mods share sha256 "${bundle.sha256}": ` +
          `"${dup}" and "${bundle.modName}". Each external mod has a ` +
          `unique identity, so this should be impossible.`,
      );
      continue;
    }
    seen.set(bundle.sha256, bundle.modName);

    if (!expectedBundled.has(bundle.sha256)) {
      errors.push(
        `Bundled mod "${bundle.modName}" (sha256 ${bundle.sha256}) does not ` +
          `correspond to any external mod with bundled=true in the manifest. ` +
          `Drop it or flip the matching mod's bundled flag.`,
      );
    }

    if (!path.isAbsolute(bundle.rootDir)) {
      errors.push(
        `Bundled mod "${bundle.modName}" must name its folder by an absolute ` +
          `path. Got: "${bundle.rootDir}".`,
      );
    }
  }

  for (const [sha256, modKey] of expectedBundled) {
    if (!seen.has(sha256)) {
      errors.push(
        `External mod "${modKey}" is marked bundled=true in the manifest ` +
          `but no bundle with sha256 ${sha256} was provided. Either supply ` +
          `its files or flip the mod to bundled=false.`,
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
   * those hashes must be in the package — unless the manifest leaves that file
   * to the mod's own archive (`mirrorFromArchive`), which must then name one of
   * the mod's staged files.
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
    const fromArchive = new Set(mod.state.mirrorFromArchive ?? []);
    const stagedPaths = new Set(staged.map((f) => f.path));
    const stray = [...fromArchive].filter((p) => !stagedPaths.has(p));
    if (stray.length > 0) {
      errors.push(
        `"${mod.name}" leaves ${stray.length} file(s) to its own archive that ` +
          `are not among its staged files, "${stray[0]}" first. The manifest ` +
          `and the payload disagree; rebuild.`,
      );
      continue;
    }
    const absent = staged.filter(
      (f) => !fromArchive.has(f.path) && !mirrorShas.has(f.sha256!),
    ).length;
    if (absent > 0) {
      errors.push(
        `"${mod.name}" is marked mirrored=true but ${absent} of its ` +
          `${staged.length} file(s) were not collected into the package, and ` +
          `the manifest does not leave them to its archive either. Users ` +
          `would receive an incomplete copy of this mod.`,
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
 * A bundled mod's files, listed once so every later step agrees on what they are.
 */
type ListedBundle = { spec: BundleSpec; files: BundleListing[] };

/** How many archives a refusal names in its message; the log names every one. */
const ARCHIVES_NAMED = 50;

async function listBundles(
  specs: readonly BundleSpec[],
  signal: AbortSignal | undefined,
): Promise<ListedBundle[]> {
  const out: ListedBundle[] = [];
  for (const spec of specs) {
    if (signal?.aborted) throw new AbortError("Packaging cancelled by user");
    let files: BundleListing[];
    try {
      files = await listBundleFolder(spec.rootDir, signal);
    } catch (err) {
      if (isAbort(err, signal)) throw err;
      ehLog("error", "package.bundle.unreadable", {
        mod: spec.modName,
        folder: spec.rootDir,
        err,
      });
      throw new PackageEhcollError([
        `"${spec.modName}": its staging folder "${spec.rootDir}" could not be ` +
          `read (${err instanceof Error ? err.message : String(err)}). Rebuild ` +
          `once it is reachable.`,
      ]);
    }
    // The build refuses to measure a folder with no files, so none now means it
    // went missing or was emptied since. Said as that, rather than as the
    // "files changed" the identity check further on would report.
    if (files.length === 0) {
      ehLog("error", "package.bundle.empty", { mod: spec.modName, folder: spec.rootDir });
      throw new PackageEhcollError([
        `"${spec.modName}": its staging folder "${spec.rootDir}" is missing or ` +
          `holds no files now, though this build measured files in it. Rebuild ` +
          `once they are back, or stop bundling it.`,
      ]);
    }
    out.push({ spec, files });
  }
  return out;
}

/**
 * ─── NO ARCHIVE GOES INTO A PACKAGE ────────────────────────────────────
 * Nexus quarantines an upload with an archive inside it, whatever the archive
 * is called and however deep it sits. The build leaves archive files out of
 * the mods it ships (`listBundleFolder`, `leaveOutArchiveFiles`), so none should
 * arrive here. Every file is read again anyway, because the guarantee is the
 * package's: a file that became an archive after the build read its mod, or a
 * caller that skipped that step, is refused by name rather than shipped into a
 * quarantine.
 */
async function refuseArchivesInside(
  bundles: readonly ListedBundle[],
  mirrorFiles: readonly MirrorFileSpec[],
  signal: AbortSignal | undefined,
  onProgress?: (progress: PackageProgress) => void,
): Promise<void> {
  const candidates: Array<{ modName: string | undefined; shown: string; fullPath: string }> = [
    ...bundles.flatMap(({ spec, files }) =>
      files.map((f) => ({ modName: spec.modName, shown: f.path, fullPath: f.fullPath })),
    ),
    ...mirrorFiles.map((f) => ({
      modName: f.modName,
      shown: f.sourcePath,
      fullPath: f.sourcePath,
    })),
  ];
  const found: Array<{ modName: string | undefined; shown: string; format: ArchiveFormat }> = [];
  let done = 0;
  for (const candidate of candidates) {
    if (signal?.aborted) throw new AbortError("Packaging cancelled by user");
    done += 1;
    onProgress?.({
      step: "checking-archives",
      message: `Checking for archives among the files to ship (${done} / ${candidates.length})...`,
      done,
      total: candidates.length,
    });
    let format: ArchiveFormat | undefined;
    try {
      format = await archiveFormatOfFile(candidate.fullPath);
    } catch (err) {
      ehLog("error", "package.file.unreadable", {
        mod: candidate.modName,
        path: candidate.fullPath,
        err,
      });
      throw new PackageEhcollError([
        `${candidate.modName !== undefined ? `"${candidate.modName}": ` : ""}` +
          `the file "${candidate.fullPath}" was recorded at the start of this ` +
          `build and could not be read now (${
            err instanceof Error ? err.message : String(err)
          }). Rebuild so the package matches your current staging folder.`,
      ]);
    }
    if (format !== undefined) {
      found.push({ modName: candidate.modName, shown: candidate.shown, format });
    }
  }
  if (found.length === 0) {
    ehLog("info", "package.archives-inside.none", { files: candidates.length });
    return;
  }

  ehLog("error", "package.archives-inside", {
    count: found.length,
    files: found.map((f) => ({ mod: f.modName, path: f.shown, format: f.format })),
  });
  const one = found.length === 1;
  const lines = found
    .slice(0, ARCHIVES_NAMED)
    .map((f) => `  • ${f.modName !== undefined ? `"${f.modName}": ` : ""}${f.shown} (${f.format})`);
  if (found.length > ARCHIVES_NAMED) {
    lines.push(`  • and ${found.length - ARCHIVES_NAMED} more — the event-horizon log lists every one.`);
  }
  throw new PackageEhcollError([
    `${one ? "A file" : `${found.length} files`} this collection would ship ` +
      `${one ? "is an archive" : "are archives"}, and Nexus Mods quarantines any ` +
      `upload with an archive inside it. The build leaves archive files out of ` +
      `the mods it ships, so ${one ? "this one" : "these"} changed after the build ` +
      `read ${one ? "its mod" : "their mods"}. Rebuild.\n` +
      lines.join("\n"),
  ]);
}

/**
 * Stage every bundled mod's files at `stagingDir/bundled/<sha256>/<path>`,
 * then prove the staged files still make the bundle the manifest names.
 *
 * Strategy: hardlink (free, instant), fall back to copy on EXDEV / EPERM.
 *
 * The proof is not ceremony. The identity was measured before the decisions
 * gate, which sits between that and here for as long as the curator likes. A
 * file edited in that window would ship under an identity it no longer has,
 * and every user's install would refuse the mod — so the build refuses first,
 * once, naming it.
 */
async function stageBundles(
  stagingDir: string,
  bundles: readonly ListedBundle[],
  recordedFiles: ReadonlyMap<string, readonly EhcollStagingFile[]>,
  signal: AbortSignal | undefined,
  onProgress?: (progress: PackageProgress) => void,
): Promise<void> {
  const total = bundles.reduce((n, b) => n + b.files.length, 0);
  let done = 0;
  for (const { spec, files } of bundles) {
    const root = path.join(
      stagingDir,
      ...bundleFolderInPackage(spec.sha256).split("/").filter((s) => s.length > 0),
    );
    const made = new Set<string>();
    for (const file of files) {
      if (signal?.aborted) throw new AbortError("Packaging cancelled by user");
      done += 1;
      onProgress?.({
        step: "staging-bundled",
        message: `Collecting bundled mods' files (${done} / ${total})...`,
        done,
        total,
      });
      const dst = path.join(root, ...file.path.split("/"));
      const dir = path.dirname(dst);
      if (!made.has(dir)) {
        await fsp.mkdir(dir, { recursive: true });
        made.add(dir);
      }
      try {
        await stageOne(file.fullPath, dst);
      } catch (err) {
        ehLog("error", "package.bundle.stage-fail", { mod: spec.modName, path: file.path, err });
        throw new PackageEhcollError([
          `"${spec.modName}": "${file.path}" could not be collected into the package ` +
            `(${err instanceof Error ? err.message : String(err)}). Rebuild once the ` +
            `file is back.`,
        ]);
      }
    }

    onProgress?.({
      step: "verifying-bundles",
      message: `Checking "${spec.modName}" is still the mod this build measured...`,
    });
    // Made even when nothing was staged: a mod emptied since it was measured is
    // then a mismatch that says so, not a missing folder that says something else.
    await fsp.mkdir(root, { recursive: true });
    const staged = await listBundleFolder(root, signal);
    // One read of each file serves both checks: the CRC its zip entry records,
    // and the SHA-256 the manifest records for it.
    const digests: Array<{ crc32: number; sha256: string }> = [];
    for (const file of staged) {
      if (signal?.aborted) throw new AbortError("Packaging cancelled by user");
      digests.push(await crc32AndSha256File(file.fullPath, signal));
    }
    const zip = await writeBundleZip(
      staged.map((file, i) => ({
        path: file.path,
        size: file.size,
        crc32: digests[i]!.crc32,
        open: () => fs.createReadStream(file.fullPath),
      })),
      undefined,
      signal !== undefined ? { signal } : {},
    );
    if (zip.sha256 !== spec.sha256) {
      ehLog("error", "package.bundle.changed", {
        mod: spec.modName,
        expected: spec.sha256,
        actual: zip.sha256,
        listedFiles: files.length,
        stagedFiles: zip.files,
      });
      throw new PackageEhcollError([
        `"${spec.modName}": its files changed after this build measured them — ` +
          `it was ${spec.sha256} and its files now make ${zip.sha256}. Shipping ` +
          `it would make every user's install refuse this mod. Rebuild; if ` +
          `nothing changed, tick "Re-read every file" first, so that no earlier ` +
          `measurement is trusted.`,
      ]);
    }
    refuseStaleRecordedHashes(spec.modName, staged, digests, recordedFiles.get(spec.sha256));
    ehLog("debug", "package.bundle.verified", {
      mod: spec.modName,
      sha256: spec.sha256,
      files: zip.files,
    });
  }
}

/** Each bundled mod's files as the manifest records them, keyed by the bundle's sha256. */
function recordedFilesByBundle(manifest: EhcollManifest): Map<string, readonly EhcollStagingFile[]> {
  const out = new Map<string, readonly EhcollStagingFile[]>();
  for (const mod of manifest.mods) {
    if (mod.source.kind !== "external" || mod.source.bundled !== true) continue;
    if (mod.source.sha256 === undefined) continue;
    out.set(mod.source.sha256, mod.state?.stagingFiles ?? []);
  }
  return out;
}

/**
 * ─── THE MANIFEST'S HASHES MUST BE THE HASHES OF THE BYTES THAT SHIP ────
 * Every user's install checks a bundled mod file by file against the SHA-256
 * the manifest records, and the build takes those from a cache that trusts a
 * file whose path, size and modification time have not changed. A file
 * rewritten in place with all three intact ships its new bytes under its old
 * hash: every user's check of the mod fails, and a repair reinstalls the same
 * bytes, which fail again. The bundle's identity cannot catch it, since that
 * was measured from the bytes — so the bytes are hashed here, as they are packed.
 */
function refuseStaleRecordedHashes(
  modName: string,
  staged: readonly BundleListing[],
  digests: ReadonlyArray<{ sha256: string }>,
  recorded: readonly EhcollStagingFile[] | undefined,
): void {
  const byPath = new Map((recorded ?? []).map((f) => [f.path, f.sha256] as const));
  const stale = staged
    .map((file, i) => ({ path: file.path, recorded: byPath.get(file.path), actual: digests[i]!.sha256 }))
    .filter((f) => f.recorded !== undefined && f.recorded !== f.actual);
  if (stale.length === 0) return;
  ehLog("error", "package.bundle.stale-hashes", { mod: modName, files: stale });
  const one = stale.length === 1;
  throw new PackageEhcollError([
    `"${modName}": ${one ? "a file is" : `${stale.length} files are`} recorded with a SHA-256 ` +
      `${one ? "its" : "their"} bytes no longer have (first: "${stale[0]!.path}"), so every user's ` +
      `check of this mod would fail and no repair could fix it. Rebuild with "Re-read every file" ` +
      `ticked, so that no saved hash is trusted.`,
  ]);
}

/**
 * Headroom per entry in the package's zip: its name twice (a Windows path of
 * 260 UTF-16 units is at most 780 bytes of UTF-8), the local and central
 * headers, ZIP64 and timestamp extras, and a data descriptor, rounded up.
 */
const ZIP_ENTRY_BYTES_AT_MOST = 2048;

/**
 * The most bytes the package can take. A file costs at most its own size plus
 * deflate's framing — a few bytes a block, well under one byte in a thousand —
 * and each entry its headers.
 */
function packageBytesAtMost(fileBytes: number, entries: number): number {
  return fileBytes + Math.ceil(fileBytes / 1000) + entries * ZIP_ENTRY_BYTES_AT_MOST;
}

/** Bytes and files already written under a folder: here, the manifest and its notes. */
async function sizeOfTree(root: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const inner = await sizeOfTree(full);
      bytes += inner.bytes;
      files += inner.files;
    } else if (entry.isFile()) {
      bytes += (await fsp.stat(full)).size;
      files += 1;
    }
  }
  return { bytes, files };
}

/**
 * ─── ROOM FOR THE STAGED COPIES AND THE PACKAGE, CHECKED FIRST ─────────
 * Staging hardlinks a file when it can, and copies one kept on another drive
 * into the temp folder. 7-Zip then writes the new package beside the one it
 * replaces, which stays until the new one is proven. Running out of room in
 * either place surfaced minutes in, as a bare ENOSPC; this names the drive and
 * the numbers before anything is copied. A file that cannot be looked at here
 * is left to the step that reads it, which names it.
 */
async function refuseShortSpace(
  stagingDir: string,
  outputPath: string,
  bundles: readonly ListedBundle[],
  mirrorFiles: readonly MirrorFileSpec[],
  probe: FreeBytesProbe | undefined,
): Promise<void> {
  const stagingDrive = (await fsp.stat(stagingDir)).dev;
  const written = await sizeOfTree(stagingDir);
  let copied = 0;
  let shipped = written.bytes;
  let entries = written.files;
  for (const { spec, files } of bundles) {
    const bytes = files.reduce((n, f) => n + f.size, 0);
    shipped += bytes;
    entries += files.length;
    const root = await fsp.stat(spec.rootDir).catch(() => undefined);
    if (root !== undefined && root.dev !== stagingDrive) copied += bytes;
  }
  const seen = new Set<string>();
  for (const file of mirrorFiles) {
    if (seen.has(file.sha256)) continue;
    seen.add(file.sha256);
    const stat = await fsp.stat(file.sourcePath).catch(() => undefined);
    if (stat === undefined) continue;
    shipped += stat.size;
    entries += 1;
    if (stat.dev !== stagingDrive) copied += stat.size;
  }
  try {
    await requireFreeSpace(
      [
        { dir: stagingDir, bytes: copied, what: "copies of files kept on another drive" },
        { dir: path.dirname(outputPath), bytes: packageBytesAtMost(shipped, entries), what: "the new package" },
      ],
      probe,
    );
  } catch (err) {
    if (!(err instanceof DiskSpaceError)) throw err;
    ehLog("error", "package.space.short", { shortfalls: err.shortfalls });
    throw new PackageEhcollError([err.message]);
  }
}

/** How many missing or unexpected files a refusal names; the log names every one. */
const DIFFERENCES_NAMED = 5;

/**
 * ─── THE PACKAGE IS CHECKED, NOT ONLY WHAT WAS HANDED TO 7-ZIP ────────
 * Staging proves the files given to 7-Zip make each bundle. A user installs
 * what 7-Zip WROTE, and the two can differ: 7-Zip left to its defaults stores
 * a name that fits the machine's code page — "Cópia", "cú" — in that code page
 * with no UTF-8 flag, which no install can read back as the same path. A file
 * missing from what it wrote is caught here too, whatever 7-Zip's exit code
 * said (one it could not open exits 1, which already fails the build).
 *
 * So every bundle is rebuilt here exactly as an install rebuilds it, out of
 * the finished package, and must make its sha. A build that passes this is a
 * package every user's install accepts.
 */
async function verifyPackagedBundles(
  packagePath: string,
  bundles: readonly ListedBundle[],
  signal: AbortSignal | undefined,
  onProgress?: (progress: PackageProgress) => void,
): Promise<void> {
  if (bundles.length === 0) return;
  const reader = await openZipReader(packagePath);
  try {
    let done = 0;
    for (const { spec, files: staged } of bundles) {
      if (signal?.aborted) throw new AbortError("Packaging cancelled by user");
      done += 1;
      onProgress?.({
        step: "verifying-package",
        message: `Checking the package reproduces "${spec.modName}" (${done} / ${bundles.length})...`,
        done,
        total: bundles.length,
      });
      const folder = bundleFolderInPackage(spec.sha256);
      let packaged: BundleFile[];
      let actual: string;
      try {
        packaged = bundleFilesFromPackage(reader, folder);
        const zip = await writeBundleZip(
          packaged,
          undefined,
          signal !== undefined ? { signal } : {},
        );
        actual = zip.sha256;
      } catch (err) {
        if (isAbort(err, signal)) throw err;
        ehLog("error", "package.bundle.unreadable-in-package", {
          mod: spec.modName,
          folder,
          err,
        });
        throw new PackageEhcollError([
          `"${spec.modName}" cannot be read back out of the package 7-Zip wrote ` +
            `(${err instanceof Error ? err.message : String(err)}), so no user could ` +
            `install it. Rebuild; if it happens again, the event-horizon log has the details.`,
        ]);
      }
      if (actual !== spec.sha256) {
        const inPackage = new Set(packaged.map((f) => f.path));
        const listed = new Set(staged.map((f) => f.path));
        const missing = [...listed].filter((p) => !inPackage.has(p));
        const unexpected = [...inPackage].filter((p) => !listed.has(p));
        ehLog("error", "package.bundle.not-reproduced", {
          mod: spec.modName,
          expected: spec.sha256,
          actual,
          missing,
          unexpected,
        });
        const named = (paths: readonly string[]): string =>
          paths.slice(0, DIFFERENCES_NAMED).join(", ") +
          (paths.length > DIFFERENCES_NAMED ? ` and ${paths.length - DIFFERENCES_NAMED} more` : "");
        throw new PackageEhcollError([
          `The package 7-Zip wrote does not reproduce "${spec.modName}": its files ` +
            `there make ${actual}, not ${spec.sha256}` +
            (missing.length > 0 ? `; missing from the package: ${named(missing)}` : "") +
            (unexpected.length > 0 ? `; in the package but not staged: ${named(unexpected)}` : "") +
            `. No user could install it. Rebuild; the event-horizon log lists every difference.`,
        ]);
      }
    }
    ehLog("info", "package.bundles.reproduced", { bundles: bundles.length });
  } finally {
    await reader.close();
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

async function stageOne(src: string, dst: string): Promise<void> {
  // A hardlink to a symbolic link is another symbolic link. One with an
  // absolute target points back into the mod's own folder, outside the
  // package's, where the staged check does not follow it — so link the file
  // it names.
  const from = (await fsp.lstat(src)).isSymbolicLink() ? await fsp.realpath(src) : src;
  try {
    await fsp.link(from, dst);
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

  await fsp.copyFile(from, dst);
}

// ---------------------------------------------------------------------------
// 7z invocation
// ---------------------------------------------------------------------------

async function runSevenZipAdd(
  archivePath: string,
  stagingDir: string,
  sevenZip: SevenZipApi,
  signal: AbortSignal | undefined,
): Promise<void> {
  // Whatever a build that crashed left here: 7z's `add` would APPEND to it.
  await fsp.rm(archivePath, { force: true });
  await fsp.mkdir(path.dirname(archivePath), { recursive: true });

  // Neither .partial nor .ehcoll names a format 7z knows, and it would default
  // to its native .7z — force ZIP explicitly via `-tzip` so any tool can
  // inspect the package.
  //
  // `-mcu=on` stores every non-ASCII name as UTF-8, flagged. Left to its
  // defaults 7-Zip keeps a name that fits the machine's code page ("Cópia")
  // in that code page, unflagged, and an install reads it back as a different
  // path — so the bundle it belongs to could not be reproduced on any machine.
  //
  // Compression level is left at 7z's default (5).
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
    archivePath,
    [path.join(stagingDir, "*")],
    { raw: ["-tzip", "-mcu=on"], r: true },
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
    // build removes it before 7-Zip starts.
  }
}
