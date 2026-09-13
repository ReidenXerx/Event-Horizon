/**
 * ──────────────────────────────────────────────────────────────────────
 * Bundling a mod the curator maintains by hand.
 *
 * An external mod is not always a downloaded thing that sits untouched. Some
 * are the curator's own — a settings bundle, a merged patch, a tweaked config
 * pack — edited in place, in the staging folder, over months. Measured on a
 * real one: 188 files in the source archive, 179 in staging, with 12 removed
 * and 3 added. The archive stopped describing the mod a long time ago.
 *
 * Bundling used to ship the SOURCE ARCHIVE, which means shipping the version
 * the curator started from. The user's install then reproduces the archive, not
 * the mod: the curator's removals come back and their additions never arrive.
 * The manifest even records the correct staged hashes, so the installer detects
 * the mismatch perfectly — and has no way to fix it, because the bytes it was
 * given are the wrong ones.
 *
 * So bundling an external mod ships the STAGING FOLDER. What ships is what the
 * curator actually has.
 *
 * ## The identity has to move with the bytes
 *
 * A mod is identified by the sha256 of the archive that produces it. The
 * staging folder makes a different archive from the one the curator started
 * from, so that archive's hash becomes the mod's identity — otherwise the
 * manifest would promise one thing and the package would contain another,
 * which is the failure this whole module exists to end.
 *
 * ## One archive, the same on every machine
 *
 * That archive is the canonical bundle zip (bundleZip.ts): made from file paths
 * and bytes alone, in a fixed order, with no timestamps. The same staging
 * folder is the same identity on every build — a rebuild that changed nothing
 * cannot make a mod look changed — and the user's install writes those very
 * bytes back before Vortex sees them.
 *
 * ## Nothing is packed here
 *
 * Nexus quarantines an upload with an archive inside it, so a package carries a
 * bundled mod's files loose. The curator's build needs only the zip's hash, so
 * this reads the folder, keeps the number, and leaves the files where they are
 * for packaging to collect.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fsp from "fs/promises";
import * as path from "path";

import { selectors, types } from "@nexusmods/vortex-api";

import { isAbort } from "../../utils/abortError";
import { beginOp, ehLog } from "../logging/ehLog";
import {
  bundleRecordName,
  isLegacyBundleArchive,
  recordMatches,
  staleBundleRecordsFor,
  type CachedBundle,
} from "./bundleCache";
import {
  BUNDLE_ZIP_FORMAT,
  bundleFilesFromListing,
  listBundleFolder,
  writeBundleZip,
} from "./bundleZip";
import { computeStagingSetHash } from "./stagingSetHash";
import { declaresAlternatives } from "./omissionLeads";
import type { SevenZipApi } from "./sevenZip";
import type { AuditorMod } from "../getModsListForProfile";
import type { CollectionConfig } from "./collectionConfig";
import { installRootFor, stagingRootFromFolder } from "../stagingPath";

/** One bundled mod: the folder whose files ship, and the identity they make. */
export type MeasuredBundle = {
  modId: string;
  modName: string;
  /**
   * The mod's staging folder. Its files ship loose in the package, under
   * `bundled/<sha256>/`; nothing is copied or written here.
   */
  rootDir: string;
  /** sha256 of the canonical bundle zip those files make — see bundleZip.ts. */
  sha256: string;
  /** Size of that zip: roughly what the package carries, and what an install writes back. */
  bytes: number;
  files: number;
  /**
   * True when this build reused an earlier build's measurement of exactly
   * these files instead of reading them again.
   *
   * Reported so a curator watching a build finish in seconds can tell that
   * nothing was skipped — the files were simply already measured.
   */
  reused?: boolean;
};

/**
 * A mod flagged for bundling that could not be packed, and why.
 *
 * `reason` completes the sentence "... is flagged for bundling, but <reason>."
 * It is what the curator reads when the build refuses the mod.
 */
export type BundleFailure = { modId: string; modName: string; reason: string };

export type MeasureResult = {
  /** `archiveSha256` replaced for every bundled mod. */
  mods: AuditorMod[];
  bundles: MeasuredBundle[];
  warnings: string[];
  /**
   * Mods flagged for bundling that could NOT be packed.
   *
   * The caller has to know these by id, because the warning it used to get
   * said "It will not ship" and that was false. A failed bundle left the mod
   * out of `bundles`, and the packaging step's filter keyed off `bundles` — so
   * the mod fell through to being resolved by its ORIGINAL `archiveSha256` and
   * the untouched Nexus archive shipped in its place, from inside the package,
   * so the user never even downloaded from Nexus.
   *
   * A curator who answered "ship my copy" for a mod with a hand-added patch
   * was told it would not ship, and shipped the version without the patch.
   *
   * The reason travels with the id because the build stops on these, and what
   * the curator reads then is the error — not a warning list that a refused
   * build never shows.
   */
  failed: BundleFailure[];
};

export type MeasureOptions = {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, modName: string) => void;
  /**
   * Size, in bytes, above which a bundled mod is called out as large. It is a
   * WARNING and nothing more: the curator asked for this mod to ship, and a
   * 37GB collection is an unusual thing to want rather than an impossible one.
   * Refusing would be this module deciding what the curator is allowed to
   * publish. Default 2GB.
   */
  warnBytes?: number;
  /**
   * Default true. False reads every bundled mod's files again instead of
   * trusting an earlier build's measurement of them — what re-verifying
   * everything asks for, and the way out when a file changed without its size
   * or timestamp moving, which is the one change a record cannot notice.
   */
  reuseRecords?: boolean;
};

const DEFAULT_WARN_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * ─── A MOD TAKEN OFF BUNDLING GETS ITS OWN ARCHIVE HASH BACK ───────────
 * Measuring gives every bundled mod its bundle's hash as `archiveSha256`:
 * identity follows the bytes that ship. When the decisions step then took a
 * mod off bundling, the build dropped its bundle and nothing else, so the mod
 * went into the package still carrying the bundle's hash as the archive to
 * download — a hash no Nexus file has, so no user's install could find it.
 *
 * `before` holds each mod's `archiveSha256` from before measuring; a mod that
 * had none gets none back, and a mod it holds nothing for is left alone.
 */
export function restoreArchiveHashes(
  mods: readonly AuditorMod[],
  unbundled: ReadonlySet<string>,
  before: ReadonlyMap<string, string | undefined>,
): AuditorMod[] {
  const restored: string[] = [];
  const out = mods.map((mod) => {
    if (!unbundled.has(mod.id) || !before.has(mod.id)) return mod;
    const original = before.get(mod.id);
    if (mod.archiveSha256 === original) return mod;
    restored.push(mod.id);
    const next: AuditorMod = { ...mod };
    if (original === undefined) delete next.archiveSha256;
    else next.archiveSha256 = original;
    return next;
  });
  if (restored.length > 0) {
    ehLog("info", "bundle.measure.hash-restored", { modIds: restored });
  }
  return out;
}

/**
 * Measure every external mod the curator flagged as bundled — the canonical
 * zip its staging folder makes — and re-key the mod to that zip's hash.
 *
 * Never throws for a per-mod problem: a mod that cannot be measured keeps its
 * original identity and comes back in `failed` with the reason, so the build
 * can refuse it by name. Shipping without it would be a package whose manifest
 * says the mod is inside when it is not.
 */
export async function measureBundledMods(args: {
  state: types.IState;
  gameId: string;
  mods: AuditorMod[];
  config: CollectionConfig;
  /**
   * Where earlier builds' measurements are kept. Shared by every collection
   * and owned by Event Horizon: the archives it held before bundles shipped
   * loose are deleted from it.
   */
  workDir: string;
  isExternal: (mod: AuditorMod) => boolean;
  options?: MeasureOptions;
}): Promise<MeasureResult> {
  const { state, gameId, mods, config, workDir, isExternal } = args;
  const options = args.options ?? {};
  const warnBytes = options.warnBytes ?? DEFAULT_WARN_BYTES;
  const reuseRecords = options.reuseRecords !== false;

  const wanted = mods.filter(
    (m) => isExternal(m) && config.externalMods[m.id]?.bundled === true,
  );
  if (wanted.length === 0) {
    ehLog("debug", "bundle.measure.skip", { reason: "no-mods-flagged" });
    return { mods, bundles: [], warnings: [], failed: [] };
  }

  const op = beginOp("bundle.measure", {
    gameId,
    candidates: wanted.length,
    reuseRecords,
  });

  const installRoot = installRootFor(state, gameId);
  if (!installRoot) {
    op.fail(new Error("Could not resolve Vortex's staging folder"), {
      gameId,
    });
    const reason =
      `Vortex's staging folder for "${gameId}" could not be resolved, so ` +
      `none of its files could be packed`;
    return {
      mods,
      bundles: [],
      warnings: [],
      failed: wanted.map((m) => ({ modId: m.id, modName: m.name, reason })),
    };
  }

  await fsp.mkdir(workDir, { recursive: true });
  await sweepLegacyArchives(workDir);

  const bundles: MeasuredBundle[] = [];
  const warnings: string[] = [];
  const failed: BundleFailure[] = [];
  const newSha = new Map<string, string>();
  /** modId → the record this build used, so that mod's older ones can be swept. */
  const keptByMod = new Map<string, string>();
  let done = 0;

  for (const mod of wanted) {
    if (options.signal?.aborted === true) break;
    done += 1;
    options.onProgress?.(done, wanted.length, mod.name);
    const modStartedAt = Date.now();
    const fail = (reason: string, err?: unknown): void => {
      ehLog("error", "bundle.measure.mod.fail", {
        modId: mod.id,
        modName: mod.name,
        reason,
        ms: Date.now() - modStartedAt,
        ...(err !== undefined ? { err } : {}),
      });
      failed.push({ modId: mod.id, modName: mod.name, reason });
    };

    const stagingDir = stagingRootFromFolder(installRoot, mod.installationPath);
    if (stagingDir === undefined) {
      fail("Vortex records no staging folder for it, so there are no files to pack");
      continue;
    }

    try {
      /**
       * The identity of the files about to be measured.
       *
       * `undefined` when any staged file lacks a hash, which is exactly the
       * case where an earlier record would be a guess rather than a fact. The
       * files are read then, and nothing is recorded.
       */
      const contentKey = computeStagingSetHash(mod.stagingFiles ?? []);
      const recordPath =
        contentKey === undefined
          ? undefined
          : path.join(workDir, bundleRecordName(mod.id, contentKey));
      const hit =
        recordPath !== undefined && reuseRecords
          ? await readBundleRecord(recordPath)
          : undefined;

      let measured: CachedBundle;
      if (hit !== undefined) {
        options.onProgress?.(done, wanted.length, `${mod.name} (already measured)`);
        measured = hit;
      } else {
        ehLog("debug", "bundle.measure.mod.start", {
          modId: mod.id,
          modName: mod.name,
          cacheable: recordPath !== undefined,
        });
        const listing = await listBundleFolder(stagingDir, options.signal);
        if (listing.length === 0) {
          fail(`its staging folder "${stagingDir}" holds no files to ship`);
          continue;
        }
        const zip = await writeBundleZip(
          await bundleFilesFromListing(listing, options.signal),
          undefined,
          options.signal !== undefined ? { signal: options.signal } : {},
        );
        measured = {
          format: BUNDLE_ZIP_FORMAT,
          sha256: zip.sha256,
          bytes: zip.bytes,
          files: zip.files,
        };
        // Written only once the measurement is complete, so a record never
        // describes a read that was interrupted.
        if (recordPath !== undefined) await writeBundleRecord(recordPath, measured);
      }

      if (measured.bytes > warnBytes) {
        // Said, not enforced. The curator chose to ship this.
        ehLog("warn", "bundle.measure.mod.large", {
          modId: mod.id,
          modName: mod.name,
          bytes: measured.bytes,
        });
        warnings.push(
          `"${mod.name}" is bundled and its files come to ` +
            `${(measured.bytes / 1024 ** 3).toFixed(1)} GB, so the .ehcoll will be at ` +
            `least that large and the build will spend a while packing it. ` +
            `That is fine if you meant it — if you did not, untick bundle and ` +
            `give users a download link instead.`,
        );
      }

      ehLog("info", "bundle.measure.mod.ok", {
        modId: mod.id,
        modName: mod.name,
        sha256: measured.sha256,
        bytes: measured.bytes,
        files: measured.files,
        reused: hit !== undefined,
        ms: Date.now() - modStartedAt,
      });
      bundles.push({
        modId: mod.id,
        modName: mod.name,
        rootDir: stagingDir,
        sha256: measured.sha256,
        bytes: measured.bytes,
        files: measured.files,
        ...(hit !== undefined ? { reused: true } : {}),
      });
      newSha.set(mod.id, measured.sha256);
      if (recordPath !== undefined) keptByMod.set(mod.id, recordPath);
    } catch (err) {
      if (isAbort(err, options.signal)) {
        ehLog("info", "bundle.measure.cancelled", { modId: mod.id, modName: mod.name });
        break;
      }
      fail(
        `its files could not be read from its staging folder (${
          err instanceof Error ? err.message : String(err)
        })`,
        err,
      );
    }
  }

  // One record per bundled mod: older ones go once the build has what it
  // needs, never before.
  await sweepStaleRecords(workDir, keptByMod);

  op.ok({
    bundled: bundles.length,
    reused: bundles.filter((b) => b.reused === true).length,
    failed: failed.length,
    bytes: bundles.reduce((n, b) => n + b.bytes, 0),
  });

  if (newSha.size === 0) {
    return { mods, bundles, warnings, failed };
  }

  return {
    failed,
    // Identity follows the bytes: the bundle is what the user gets, so it is
    // what the manifest must name.
    mods: mods.map((m) => {
      const sha = newSha.get(m.id);
      return sha !== undefined ? { ...m, archiveSha256: sha } : m;
    }),
    bundles,
    warnings,
  };
}

/**
 * An earlier build's measurement of exactly these files, if it can still be used.
 *
 * Every failure here answers "no record" rather than throwing: a missing,
 * unreadable, half-written or outdated record must cost a re-read, never a
 * build.
 */
async function readBundleRecord(recordPath: string): Promise<CachedBundle | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fsp.readFile(recordPath, "utf8"));
  } catch (err) {
    ehLog("debug", "bundle.cache.miss", { file: path.basename(recordPath), err });
    return undefined;
  }
  if (recordMatches(parsed, BUNDLE_ZIP_FORMAT)) return parsed;
  ehLog("debug", "bundle.cache.unusable", { file: path.basename(recordPath) });
  return undefined;
}

async function writeBundleRecord(recordPath: string, record: CachedBundle): Promise<void> {
  try {
    await fsp.writeFile(recordPath, JSON.stringify(record), "utf8");
  } catch (err) {
    // No record means the next build reads the files again. Slower, never wrong.
    ehLog("warn", "bundle.cache.write-failed", {
      file: path.basename(recordPath),
      err,
    });
  }
}

/** Drop every record of these mods except the one just used. */
async function sweepStaleRecords(
  workDir: string,
  keptByMod: ReadonlyMap<string, string>,
): Promise<void> {
  if (keptByMod.size === 0) return;
  let fileNames: string[];
  try {
    fileNames = await fsp.readdir(workDir);
  } catch (err) {
    ehLog("warn", "bundle.sweep.list-failed", { err });
    return;
  }
  let removed = 0;
  for (const [modId, keep] of keptByMod) {
    for (const stale of staleBundleRecordsFor({ fileNames, modId, keep })) {
      await fsp.rm(path.join(workDir, stale), { force: true }).catch((err) => {
        ehLog("debug", "bundle.sweep.remove-failed", { file: stale, err });
      });
      removed += 1;
    }
  }
  if (removed > 0) {
    ehLog("debug", "bundle.sweep.ok", { removed, mods: keptByMod.size });
  }
}

/**
 * Delete the archives this folder held before bundles shipped loose.
 *
 * Each was a 7-Zip copy of a bundled mod's staging folder — gigabytes, for a
 * LOD mod — and nothing reads them any more. Best-effort: a file that will not
 * go costs disk, never a build.
 */
async function sweepLegacyArchives(workDir: string): Promise<void> {
  let fileNames: string[];
  try {
    fileNames = await fsp.readdir(workDir);
  } catch (err) {
    ehLog("debug", "bundle.legacy-sweep.list-failed", { err });
    return;
  }
  let removed = 0;
  let bytes = 0;
  for (const name of fileNames.filter(isLegacyBundleArchive)) {
    const full = path.join(workDir, name);
    try {
      const { size } = await fsp.stat(full);
      await fsp.rm(full, { force: true });
      removed += 1;
      bytes += size;
    } catch (err) {
      ehLog("debug", "bundle.legacy-sweep.remove-failed", { file: name, err });
    }
  }
  if (removed > 0) ehLog("info", "bundle.legacy-sweep.ok", { removed, bytes });
}

/**
 * Which external mods no longer match the archive they came from.
 *
 * This is the message that has to reach the curator, because bundling is
 * useless if nobody knows to tick the box. A mod edited in place looks
 * completely healthy: it installs, it deploys, the game runs. The divergence is
 * invisible until somebody else installs the collection and gets the ORIGINAL
 * archive — the curator's removals back, their additions absent.
 *
 * Compared by path in both directions rather than by content. Content matching
 * answers "did these bytes come from the archive", which a curator's edited
 * copy of an existing file would fail for an uninteresting reason; the question
 * here is "does this archive still describe this mod", and files appearing or
 * disappearing is what answers it.
 */
export type ExternalDrift = {
  modId: string;
  modName: string;
  /**
   * In the archive, absent from staging — the curator removed them.
   *
   * Always empty when `declaredAlternatives` is true: an unselected FOMOD
   * option is absent for a reason that has nothing to do with the curator.
   */
  removed: string[];
  /** In staging, absent from the archive — the curator added them. */
  added: string[];
  /** Already flagged for bundling, so the drift is about to be shipped correctly. */
  bundled: boolean;
  /**
   * The archive carries a FOMOD script, so its file set is a menu rather than
   * a promise and `removed` was suppressed. Reported so the caller can say why
   * a mod is listed on one direction only.
   */
  declaredAlternatives: boolean;
};

/**
 * Compare each external mod's staging folder against its source archive.
 *
 * Costs one 7z header read per external mod — about 20ms each, so a profile
 * with thirty of them pays under a second. Mods with no archive on disk are
 * skipped: there is nothing to diverge from, and their identity already comes
 * from the staged files.
 */
export async function detectExternalDrift(args: {
  state: types.IState;
  gameId: string;
  mods: AuditorMod[];
  config: CollectionConfig;
  sevenZip: SevenZipApi;
  isExternal: (mod: AuditorMod) => boolean;
  archivePathFor: (mod: AuditorMod) => string | undefined;
  listArchive: (archivePath: string) => Promise<{ entries: Array<{ path: string }> }>;
  signal?: AbortSignal;
}): Promise<ExternalDrift[]> {
  // Availability gate only — this function compares captured stagingFiles
  // against archive entries and never touches disk.
  const installRoot = installRootFor(args.state, args.gameId);
  if (!installRoot) {
    ehLog("debug", "bundle.drift.no-install-root", { gameId: args.gameId });
    return [];
  }

  const op = beginOp("bundle.drift", { mods: args.mods.length });

  const out: ExternalDrift[] = [];
  for (const mod of args.mods) {
    if (args.signal?.aborted === true) break;
    if (!args.isExternal(mod)) continue;

    const archivePath = args.archivePathFor(mod);
    if (archivePath === undefined) continue;
    const staged = (mod.stagingFiles ?? []).map((f) => f.path.toLowerCase());
    if (staged.length === 0) continue;

    let entries: Array<{ path: string }>;
    try {
      entries = (await args.listArchive(archivePath)).entries;
    } catch (err) {
      // unreadable archive is the self-check's problem, not this one
      ehLog("debug", "bundle.drift.archive-unreadable", { modId: mod.id, err });
      continue;
    }

    const archived = entries.map((e) => e.path.toLowerCase());
    const stagedSet = new Set(staged);
    const archivedSet = new Set(archived);
    // Vortex strips a leading wrapper directory, so compare on tails the same
    // way omissionLeads does rather than demanding identical prefixes.
    const tailMatch = (needle: string, hay: Set<string>): boolean => {
      if (hay.has(needle)) return true;
      for (const h of hay) {
        if (h.endsWith(`/${needle}`) || needle.endsWith(`/${h}`)) return true;
      }
      return false;
    };

    // A FOMOD archive holds every option, and the curator installed one of
    // them. Measured on a real profile: 5 of 9 "drifted" mods were exactly
    // this — 391 unselected files in the Unofficial AAF Patch alone — and the
    // advice that followed (tick bundle) would have shipped one curator's
    // selections as a flat archive and skipped the installer for everybody
    // else. Absence proves nothing here, so only additions are read.
    const menu = declaresAlternatives({ entries: entries.map((e) => ({ path: e.path })) });
    const removed = menu ? [] : archived.filter((a) => !tailMatch(a, stagedSet));
    const added = staged.filter((sPath) => !tailMatch(sPath, archivedSet));
    if (removed.length === 0 && added.length === 0) continue;

    out.push({
      modId: mod.id,
      modName: mod.name,
      removed,
      added,
      bundled: args.config.externalMods[mod.id]?.bundled === true,
      declaredAlternatives: menu,
    });
  }
  op.ok({ drifted: out.length });
  return out;
}

/**
 * One entry per PROBLEM, not per line.
 *
 * The caller counts this array — the build page shows `warnings.length` — so
 * returning the headline and its per-mod detail as separate entries made one
 * problem read as five. A build with six things worth saying announced "10
 * warnings", which is not a rounding error: it is the difference between a
 * curator scanning the list and a curator deciding the build is a mess.
 * Detail lines are newline-joined into the entry they belong to.
 */
export function describeExternalDrift(drift: ExternalDrift[]): string[] {
  const unbundled = drift.filter((d) => !d.bundled);
  if (unbundled.length === 0) return [];

  const worst = [...unbundled].sort(
    (a, b) => b.removed.length + b.added.length - (a.removed.length + a.added.length),
  );
  const one = unbundled.length === 1;
  const lines = [
    `${unbundled.length} external mod${one ? "" : "s"} no longer match ` +
      `the archive ${one ? "it" : "they"} came from — files have been added or ` +
      `removed in the staging folder since. Right now the collection ships the ` +
      `ARCHIVE, so whoever installs it gets the original, not your version. ` +
      `Tick "bundle" on ${one ? "it" : "them"} to pack your actual files into ` +
      `the .ehcoll instead.`,
  ];
  for (const d of worst.slice(0, 5)) {
    const parts: string[] = [];
    if (d.added.length > 0) {
      parts.push(
        `${d.added.length} staged file(s) are not in the archive` +
          ` (e.g. ${d.added[0]})`,
      );
    }
    if (d.removed.length > 0) {
      parts.push(`${d.removed.length} file(s) in the archive are not staged`);
    }
    // Say why only one direction was read, or the curator reads the silence as
    // "nothing was removed" and trusts a check that never ran.
    const note = d.declaredAlternatives
      ? ` (its archive is a FOMOD, so unselected options were not counted)`
      : "";
    lines.push(`  • "${d.modName}": ${parts.join(", ")}${note}.`);
  }
  if (worst.length > 5) {
    lines.push(`  • and ${worst.length - 5} more; see the event-horizon log.`);
  }
  return [lines.join("\n")];
}


/**
 * ──────────────────────────────────────────────────────────────────────
 * Fold a second measuring pass into the first, one entry per mod.
 *
 * `measureBundledMods` measures every mod the CONFIG marks bundled — it takes
 * the config, not a list of ids — so a second pass run after the curator
 * answers mid-build returns an entry for each already-bundled mod too, served
 * from the cache with an identical sha256.
 *
 * Concatenating produced two entries with the same hash, and `packageEhcoll`
 * rejects that outright: "Two bundled mods share sha256 ... this should be
 * impossible." The build died at packaging, after every expensive phase, for
 * any curator who already had one bundled mod and answered "ship my copy" for
 * one more — the ordinary case for this feature.
 *
 * The second pass wins: it read the config the curator's answers just wrote.
 * ──────────────────────────────────────────────────────────────────────
 */
export function mergeMeasuredBundles(
  first: readonly MeasuredBundle[],
  second: readonly MeasuredBundle[],
): MeasuredBundle[] {
  const byModId = new Map(first.map((b) => [b.modId, b] as const));
  for (const bundle of second) byModId.set(bundle.modId, bundle);
  return [...byModId.values()];
}
