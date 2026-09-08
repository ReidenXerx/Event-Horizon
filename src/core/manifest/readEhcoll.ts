/**
 * `.ehcoll` ZIP reader (Phase 3 slice 2).
 *
 * Mirror of {@link ./packageZip.packageEhcoll}. Takes one absolute path
 * to a `.ehcoll` ZIP, opens it with the project's own native ZIP reader
 * ({@link ./readZip}) — NOT 7-Zip, which used to spawn here and could not
 * on a Wine prefix, turning a healthy package into "7z failed to list" —
 * extracts and validates `manifest.json`, cross-checks the package
 * structure (`bundled/` directory, optional `README.md`/`CHANGELOG.md`,
 * Phase 5 `ini-tweaks/` placeholder), and returns a fully-typed result
 * the resolver/installer can consume.
 *
 * Spec: docs/business/READ_EHCOLL.md
 *
 * ─── ARCHITECTURE ──────────────────────────────────────────────────────
 * `readEhcoll` is the I/O wrapper over the pure {@link parseManifest}
 * validator. The split mirrors the producer side:
 *
 *   buildManifest   (pure)   ←mirror→   parseManifest  (pure)
 *   packageEhcoll   (I/O)    ←mirror→   readEhcoll     (I/O)  ← this file
 *
 * After this slice lands, anything `packageEhcoll` writes,
 * `readEhcoll` reads back losslessly. That round-trip is the gate
 * every Phase 3+ consumer (resolver, installer, drift report,
 * package inspector UI) sits on top of.
 *
 * I/O is structured as: list ZIP entries, then surgically extract
 * `manifest.json` only. Bundled archives are *not* extracted here —
 * resolving them is the resolver's job (slice 3+). We confirm they're
 * present in the central directory and that they line up with the
 * manifest's `bundled: true` mods, nothing more.
 *
 * ─── ERROR DISCIPLINE ──────────────────────────────────────────────────
 * Errors are accumulated and thrown together, same as the rest of the
 * Phase 2/3 pipeline. The two short-circuit gates are:
 *  1. The ZIP path doesn't exist / isn't a file.
 *  2. The ZIP central directory doesn't contain `manifest.json`.
 * Both are categorical "we have no document to read" conditions.
 *
 * Everything else — extra/missing bundled archives, missing optional
 * docs, Phase 5 ini-tweak placeholders — accumulates so the operator
 * gets a full diagnosis from one read.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fsp from "fs/promises";

import { toPosix } from "../paths";
import * as os from "os";
import * as path from "path";

import { ehLog } from "../logging/ehLog";
import type { EhcollManifest } from "../../types/ehcoll";
import { parseManifest, ParseManifestError } from "./parseManifest";
import {
  extractZipEntryToFile,
  listZipEntries as readZipCentralDirectory,
} from "./readZip";
import type { SevenZipApi, SevenZipListEntry } from "./sevenZip";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ReadEhcollOptions = {
  /**
   * Override the staging dir used for `manifest.json` extraction.
   * Defaults to `os.tmpdir()/event-horizon-read-<random>`. Useful for
   * tests that want a known location.
   */
  stagingDir?: string;
  /**
   * Default `true`. When `false`, the staging directory is left in
   * place after a successful read — useful for offline inspection.
   */
  cleanupOnSuccess?: boolean;
  // There is deliberately no `sevenZip` option here any more.
  //
  // One existed, documented as an injection point that "tests substitute a
  // fake" — and after the reader was rewritten to use readZip nothing read it.
  // A caller passing a fake 7-Zip to control this function got no error and no
  // effect, which is worse than the option not existing: it invites someone to
  // test a code path that is not running.
};

export type ReadEhcollResult = {
  manifest: EhcollManifest;
  /**
   * One entry per archive present in the package's `bundled/`
   * directory, after cross-check against `manifest.mods`.
   */
  bundledArchives: BundledArchiveEntry[];
  /** True iff a top-level `README.md` is present in the package. */
  hasReadme: boolean;
  /** True iff a top-level `CHANGELOG.md` is present in the package. */
  hasChangelog: boolean;
  /**
   * Files under `ini-tweaks/`. Phase 5 placeholder; should always be
   * empty for v1 producers. Kept here so a future installer can
   * stream-process them without re-listing the ZIP.
   */
  iniTweakFiles: string[];
  /**
   * Non-fatal issues. Forward of {@link parseManifest}'s warnings plus
   * package-shape warnings (missing optional README/CHANGELOG when the
   * manifest mentions them, unexpected files in unknown directories,
   * etc.).
   */
  warnings: string[];
};

export type BundledArchiveEntry = {
  /** Lowercase 64-char hex SHA-256 — the file basename without extension. */
  sha256: string;
  /**
   * Path of the entry inside the ZIP, normalized to forward slashes.
   * Always starts with `bundled/`.
   */
  zipPath: string;
  /**
   * File extension (without leading dot), e.g. `"zip"`, `"7z"`,
   * `"rar"`. Empty string when the archive entry had no extension.
   */
  extension: string;
  /**
   * Uncompressed size in bytes when 7z reports it. May be undefined for
   * archive types that don't expose it via the central directory.
   */
  size?: number;
};

export class ReadEhcollError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(
      errors.length === 1
        ? errors[0]
        : `Cannot read .ehcoll (${errors.length} problems):\n  - ${errors.join(
            "\n  - ",
          )}`,
    );
    this.name = "ReadEhcollError";
    this.errors = errors;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Open + validate a `.ehcoll` package on disk.
 *
 * Throws {@link ReadEhcollError} when the file can't be opened, when
 * `manifest.json` is missing or fails {@link parseManifest}, or when
 * the package structure violates the contract (e.g. duplicate bundled
 * sha256s).
 *
 * `parseManifest`'s thrown errors are wrapped into a `ReadEhcollError`
 * so the caller has one error type to catch.
 */
export async function readEhcoll(
  zipPath: string,
  options: ReadEhcollOptions = {},
): Promise<ReadEhcollResult> {
  const startedAt = Date.now();
  const zipName = path.basename(zipPath);
  ehLog("info", "ehcoll.read.start", { file: zipName });

  if (!path.isAbsolute(zipPath)) {
    ehLog("error", "ehcoll.read.invalid-path", { file: zipName });
    throw new ReadEhcollError([
      `zipPath must be an absolute path. Got: ${JSON.stringify(zipPath)}.`,
    ]);
  }

  await assertReadableFile(zipPath);

  // Phase 1 — central-directory listing. No 7z: see listZipEntries.
  const entries = await listZipEntries(zipPath);
  ehLog("debug", "ehcoll.read.entries", { file: zipName, count: entries.length });

  const layout = classifyEntries(entries);
  ehLog("info", "ehcoll.read.layout", {
    file: zipName,
    entries: entries.length,
    bundled: layout.bundledEntries.length,
    unrecognizedBundled: layout.unrecognizedBundled.length,
    iniTweakFiles: layout.iniTweakFiles.length,
    hasReadme: layout.hasReadme,
    hasChangelog: layout.hasChangelog,
    hasManifest: layout.hasManifest,
  });
  if (layout.unrecognizedBundled.length > 0) {
    // Every entry here failed the `bundled/<sha256>[.ext]` naming contract —
    // that is a rejected entry, and dropping it silently is exactly the case
    // that made a bad-but-plausible package unanswerable in a bug report.
    ehLog("warn", "ehcoll.read.bundled.unrecognized", {
      file: zipName,
      count: layout.unrecognizedBundled.length,
      entries: layout.unrecognizedBundled,
    });
  }

  if (!layout.hasManifest) {
    ehLog("error", "ehcoll.read.manifest-missing", { file: zipName });
    throw new ReadEhcollError([
      `Archive "${zipPath}" does not contain manifest.json at its root. ` +
        `This is not a valid Event Horizon collection package.`,
    ]);
  }

  // Phase 2 — surgical extract of manifest.json + parse.
  const stagingDir = await prepareStagingDir(options.stagingDir);
  const cleanupOnSuccess = options.cleanupOnSuccess !== false;

  let manifest: EhcollManifest;
  let parseWarnings: string[];

  try {
    await extractManifest(zipPath, stagingDir);

    const manifestPath = path.join(stagingDir, "manifest.json");
    const raw = await fsp.readFile(manifestPath, "utf8");

    try {
      const parsed = parseManifest(raw);
      manifest = parsed.manifest;
      parseWarnings = parsed.warnings;
      ehLog("info", "ehcoll.read.manifest.ok", {
        file: zipName,
        mods: manifest.mods.length,
        bytes: raw.length,
      });
      if (parseWarnings.length > 0) {
        ehLog("warn", "ehcoll.read.manifest.warnings", {
          file: zipName,
          count: parseWarnings.length,
          warnings: parseWarnings,
        });
      }
    } catch (err) {
      if (err instanceof ParseManifestError) {
        // The schema mismatch itself — which field, what was expected — lives
        // inside err.errors, produced by parseManifest. Log it verbatim rather
        // than just the wrapped ReadEhcollError message.
        ehLog("error", "ehcoll.read.manifest.invalid", {
          file: zipName,
          count: err.errors.length,
          errors: err.errors,
        });
        throw new ReadEhcollError(err.errors);
      }
      ehLog("error", "ehcoll.read.manifest.parse-fail", { file: zipName, err });
      throw err;
    }
  } finally {
    if (cleanupOnSuccess) {
      await safeRmDir(stagingDir);
    }
  }

  // Phase 3 — cross-check package structure against the manifest.
  const errors: string[] = [];
  const warnings = [...parseWarnings];

  const bundledArchives = crossCheckBundled(
    manifest,
    layout.bundledEntries,
    errors,
  );

  if (errors.length > 0) {
    // Each string here already names the offending mod compareKey or sha256 —
    // this is the "package is incomplete / has stray bytes" diagnosis, and it
    // is the whole reason to log before throwing.
    ehLog("error", "ehcoll.read.cross-check.fail", {
      file: zipName,
      count: errors.length,
      errors,
    });
    throw new ReadEhcollError(errors);
  }

  ehLog("info", "ehcoll.read.ok", {
    file: zipName,
    ms: Date.now() - startedAt,
    mods: manifest.mods.length,
    bundled: bundledArchives.length,
    hasReadme: layout.hasReadme,
    hasChangelog: layout.hasChangelog,
    iniTweakFiles: layout.iniTweakFiles.length,
    warnings: warnings.length,
  });

  return {
    manifest,
    bundledArchives,
    hasReadme: layout.hasReadme,
    hasChangelog: layout.hasChangelog,
    iniTweakFiles: layout.iniTweakFiles,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// File pre-flight
// ---------------------------------------------------------------------------

async function assertReadableFile(zipPath: string): Promise<void> {
  const zipName = path.basename(zipPath);
  let stat: import("fs").Stats;
  try {
    stat = await fsp.stat(zipPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      ehLog("error", "ehcoll.read.file.missing", { file: zipName });
      throw new ReadEhcollError([
        `No file at "${zipPath}". Has the package been moved or deleted?`,
      ]);
    }
    ehLog("error", "ehcoll.read.file.stat-fail", { file: zipName, err });
    throw new ReadEhcollError([
      `Cannot stat "${zipPath}": ${err instanceof Error ? err.message : String(err)}.`,
    ]);
  }
  if (!stat.isFile()) {
    ehLog("error", "ehcoll.read.file.not-a-file", { file: zipName });
    throw new ReadEhcollError([
      `"${zipPath}" is not a regular file ` +
        `(directory? symlink? device?). A .ehcoll must be a single ZIP file.`,
    ]);
  }
}

// ---------------------------------------------------------------------------
// Central directory enumeration — read directly, no subprocess
// ---------------------------------------------------------------------------

/**
 * Every entry in the package, read by parsing the ZIP ourselves.
 *
 * This used to shell out to Vortex's bundled 7z. That is a Windows executable
 * spawned as a child process, and under Wine/Proton it is the most fragile
 * step in the whole install — it failed for an alpha tester on a file proven
 * byte-identical to the curator's, which both `unzip` and a native 7z read
 * without complaint. node-7z could not even say why: `list` resolves with an
 * empty spec and discards `{code, errors}`, so "7z never started" and "the
 * archive is corrupt" arrived here indistinguishable.
 *
 * A `.ehcoll` is a plain ZIP, so none of that was ever necessary. See readZip.
 *
 * The result is still shaped as a {@link SevenZipListEntry} deliberately —
 * `classifyEntries` and everything downstream of it keep working unchanged,
 * which keeps this swap to one function instead of the six symbols that
 * depend on it.
 */
async function listZipEntries(
  zipPath: string,
): Promise<SevenZipListEntry[]> {
  try {
    const entries = await readZipCentralDirectory(zipPath);
    return entries.map((entry) => ({
      name: entry.name,
      size: entry.uncompressedSize,
      attr: entry.isDirectory ? "D" : "A",
      crc: entry.crc32,
    }));
  } catch (err) {
    // The reader explains itself for anything that IS a zip — truncated, an
    // entry that failed its checksum, an index pointing off the end. What it
    // cannot do is recognise a file that was never a zip at all, and "no
    // end-of-central-directory" is a poor way to say "this is an HTML error
    // page" or "this is a RAR". diagnoseArchive names those.
    const { diagnoseArchive, describeArchiveDiagnosis } = await import(
      "./diagnoseArchive"
    );
    const diagnosis = await diagnoseArchive(zipPath);

    ehLog("error", "ehcoll.read.zip-list.fail", {
      file: path.basename(zipPath),
      diagnosisKind: diagnosis.kind,
      err,
    });

    throw new ReadEhcollError(
      diagnosis.kind === "looks-like-a-zip"
        ? [(err as Error).message]
        : describeArchiveDiagnosis(diagnosis, zipPath),
    );
  }
}

// ---------------------------------------------------------------------------
// Layout classification
// ---------------------------------------------------------------------------

type ClassifiedLayout = {
  hasManifest: boolean;
  hasReadme: boolean;
  hasChangelog: boolean;
  iniTweakFiles: string[];
  /**
   * Each bundled file entry, parsed into its sha256 + extension. We
   * already drop unparseable entries here (and accumulate them as
   * warnings is the cross-check step's job; we just leave them out
   * of the typed list).
   */
  bundledEntries: ParsedBundledEntry[];
  /**
   * Raw bundled file paths whose basename did not parse as
   * `<64hex>[.ext]`. The cross-check step turns these into warnings
   * so an operator sees what's wrong.
   */
  unrecognizedBundled: string[];
};

type ParsedBundledEntry = {
  sha256: string;
  extension: string;
  zipPath: string;
  size?: number;
};

function classifyEntries(entries: SevenZipListEntry[]): ClassifiedLayout {
  let hasManifest = false;
  let hasReadme = false;
  let hasChangelog = false;
  const iniTweakFiles: string[] = [];
  const bundledEntries: ParsedBundledEntry[] = [];
  const unrecognizedBundled: string[] = [];

  for (const entry of entries) {
    if (isDirectoryEntry(entry)) continue;

    const normalized = normalizePath(entry.name);

    if (normalized === "manifest.json") {
      hasManifest = true;
      continue;
    }
    if (normalized === "README.md") {
      hasReadme = true;
      continue;
    }
    if (normalized === "CHANGELOG.md") {
      hasChangelog = true;
      continue;
    }
    if (normalized.startsWith("bundled/")) {
      const parsed = parseBundledFilename(normalized, entry.size);
      if (parsed === undefined) {
        unrecognizedBundled.push(normalized);
      } else {
        bundledEntries.push(parsed);
      }
      continue;
    }
    if (normalized.startsWith("ini-tweaks/")) {
      iniTweakFiles.push(normalized);
      continue;
    }
    // Other unknown top-level entries are tolerated — future schema
    // additions land at root, and we don't want a v1 reader to refuse
    // a v1.x package that the producer pre-shipped a forward-compat
    // file in. They surface as warnings during cross-check.
  }

  return {
    hasManifest,
    hasReadme,
    hasChangelog,
    iniTweakFiles,
    bundledEntries,
    unrecognizedBundled,
  };
}

function isDirectoryEntry(entry: SevenZipListEntry): boolean {
  // `D` is not necessarily the first attribute — real archives report `"RD"`.
  // See the same fix in archiveContents.ts.
  if (typeof entry.attr === "string" && entry.attr.includes("D")) return true;
  // 7z occasionally emits entries with trailing slashes for empty dirs.
  if (entry.name.endsWith("/") || entry.name.endsWith("\\")) return true;
  return false;
}

/**
 * 7z reports paths with the OS-native separator on Windows. Normalize to
 * forward slashes so cross-platform comparisons (and the eventual UI)
 * stay sane.
 */
function normalizePath(p: string): string {
  return toPosix(p);
}

/**
 * Parse `bundled/<sha256>.<ext>` (or `bundled/<sha256>` without
 * extension) into its parts. Returns `undefined` when the basename
 * doesn't match the contract — the cross-check step turns those into
 * warnings.
 */
function parseBundledFilename(
  zipPath: string,
  size: number | undefined,
): ParsedBundledEntry | undefined {
  const basename = zipPath.slice("bundled/".length);
  if (basename.length === 0 || basename.includes("/")) return undefined;

  const dot = basename.indexOf(".");
  const sha256 = dot === -1 ? basename : basename.slice(0, dot);
  const extension = dot === -1 ? "" : basename.slice(dot + 1);

  if (!/^[0-9a-f]{64}$/.test(sha256)) return undefined;

  return {
    sha256,
    extension,
    zipPath,
    ...(size !== undefined ? { size } : {}),
  };
}

// ---------------------------------------------------------------------------
// Cross-check: bundled/ entries vs manifest.mods bundled mods
// ---------------------------------------------------------------------------

function crossCheckBundled(
  manifest: EhcollManifest,
  parsedBundled: ParsedBundledEntry[],
  errors: string[],
): BundledArchiveEntry[] {
  // Build the expected set: every external mod with bundled=true.
  const expected = new Map<string, string>(); // sha256 → mod compareKey
  for (const mod of manifest.mods) {
    // Invariant (parser-enforced): bundled === true ⇒ source.sha256 set.
    if (mod.source.kind === "external" && mod.source.bundled) {
      const sha = mod.source.sha256!;
      const previous = expected.get(sha);
      if (previous !== undefined) {
        // The schema validator already warns about duplicate external
        // sha256s — we don't need to error here. The first mod claims
        // the archive; the second is informational.
        continue;
      }
      expected.set(sha, mod.compareKey);
    }
  }

  // Detect duplicate archives in the ZIP (two `bundled/<same-sha>.<ext>`
  // entries — shouldn't happen, but a hand-edit could cause it).
  const seen = new Map<string, ParsedBundledEntry>();
  for (const entry of parsedBundled) {
    const previous = seen.get(entry.sha256);
    if (previous !== undefined) {
      errors.push(
        `Two bundled archives share sha256 "${entry.sha256}": ` +
          `"${previous.zipPath}" and "${entry.zipPath}". ` +
          `Each external mod has a unique identity, so this should be impossible.`,
      );
      continue;
    }
    seen.set(entry.sha256, entry);
  }

  // Every expected sha256 must be present.
  for (const [sha256, modKey] of expected) {
    if (!seen.has(sha256)) {
      errors.push(
        `External mod "${modKey}" is marked bundled=true in the manifest ` +
          `but no archive with sha256 ${sha256} is present in the package's ` +
          `bundled/ directory. The package is incomplete.`,
      );
    }
  }

  // Every present sha256 must correspond to an expected mod.
  for (const [sha256, entry] of seen) {
    if (!expected.has(sha256)) {
      errors.push(
        `Archive "${entry.zipPath}" is present in the package but does not ` +
          `correspond to any external mod with bundled=true in the manifest. ` +
          `The package contains stray bytes.`,
      );
    }
  }

  // Convert the survivors into the public BundledArchiveEntry shape.
  // Sorted by sha256 for deterministic consumer output.
  return Array.from(seen.values())
    .filter((e) => expected.has(e.sha256))
    .sort((a, b) => (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0))
    .map((e) => ({
      sha256: e.sha256,
      zipPath: e.zipPath,
      extension: e.extension,
      ...(e.size !== undefined ? { size: e.size } : {}),
    }));
}

// ---------------------------------------------------------------------------
// 7z extract — surgical manifest.json pull
// ---------------------------------------------------------------------------

/**
 * Pull manifest.json out of the package.
 *
 * Also no longer a 7z call. The old one asked 7z to extract a single entry by
 * passing it as a trailing positional filter, which worked but carried the
 * whole subprocess failure mode for one small file.
 *
 * The read is verified: readZip checks the entry's CRC-32 against what the
 * archive recorded. That matters more here than anywhere else — a manifest
 * that decompressed to plausible-looking but wrong bytes would be trusted by
 * every stage after this one, and a collection is a reproduction contract.
 */
async function extractManifest(
  zipPath: string,
  stagingDir: string,
): Promise<void> {
  try {
    await extractZipEntryToFile(
      zipPath,
      "manifest.json",
      path.join(stagingDir, "manifest.json"),
    );
  } catch (err) {
    ehLog("error", "ehcoll.read.manifest.extract-fail", {
      file: path.basename(zipPath),
      err,
    });
    throw new ReadEhcollError([
      `Could not read manifest.json from "${zipPath}": ` +
        `${(err as Error).message}`,
    ]);
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
  const prefix = path.join(os.tmpdir(), "event-horizon-read-");
  return fsp.mkdtemp(prefix);
}

async function safeRmDir(dir: string): Promise<void> {
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch {
    // Best-effort. The OS will GC the temp dir eventually.
  }
}
