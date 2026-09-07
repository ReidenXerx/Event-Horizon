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
 * So bundling an external mod now packs the STAGING FOLDER. What ships is what
 * the curator actually has.
 *
 * ## The identity has to move with the bytes
 *
 * A mod is identified by the sha256 of the archive that produces it. Repacking
 * produces different bytes, so the repacked archive's hash becomes the mod's
 * identity — otherwise the manifest would promise one thing and the package
 * would contain another, which is the failure this whole module exists to end.
 *
 * ## Determinism
 *
 * The archive is built from a sorted file list with 7z's timestamp-free zip
 * settings where available. Two builds from an unchanged staging folder should
 * produce the same bytes and therefore the same identity; a rebuild that
 * gratuitously changed every external mod's hash would make every collection
 * update look like every mod changed.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fsp from "fs/promises";
import * as path from "path";

import { selectors, types } from "@nexusmods/vortex-api";

import { hashFileSha256 } from "../archiveHashing";
import { beginOp, ehLog } from "../logging/ehLog";
import {
  bundleFileName,
  bundleSidecarPath,
  sanitizeModId,
  sidecarMatches,
  staleBundlesFor,
  type CachedBundle,
} from "./bundleCache";
import { computeStagingSetHash } from "./stagingSetHash";
import { declaresAlternatives } from "./omissionLeads";
import { sevenZipAdd, type SevenZipApi } from "./sevenZip";
import type { AuditorMod } from "../getModsListForProfile";
import type { CollectionConfig } from "./collectionConfig";
import { installRootFor, stagingRootFromFolder } from "../stagingPath";

/** One repacked mod: where the new archive is, and what it hashes to. */
export type RepackedBundle = {
  modId: string;
  modName: string;
  /** Absolute path to the archive built from staging. Temporary. */
  sourcePath: string;
  sha256: string;
  bytes: number;
  /**
   * True when this archive was reused from a previous build.
   *
   * Reported so a curator watching a build finish in seconds can tell that
   * nothing was skipped — the bytes were simply already packed.
   */
  reused?: boolean;
};

export type RepackResult = {
  /** `archiveSha256` replaced for every repacked mod. */
  mods: AuditorMod[];
  bundles: RepackedBundle[];
  warnings: string[];
  /**
   * Mods flagged for bundling whose repack FAILED.
   *
   * The caller has to know these by id, because the warning it used to get
   * said "It will not ship" and that was false. A failed repack leaves the mod
   * out of `bundles`, and the packaging step's filter keys off `bundles` — so
   * the mod fell through to being resolved by its ORIGINAL `archiveSha256` and
   * the untouched Nexus archive shipped in its place, from inside the package,
   * so the user never even downloaded from Nexus.
   *
   * A curator who answered "ship my copy" for a mod with a hand-added patch
   * was told it would not ship, and shipped the version without the patch.
   */
  failedRepackModIds: string[];
};

export type RepackOptions = {
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
};

const DEFAULT_WARN_BYTES = 2 * 1024 * 1024 * 1024;

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  const walk = async (d: string): Promise<void> => {
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch (err) {
      ehLog("debug", "bundle.staging-size.dir-unreadable", { err });
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else {
        try {
          total += (await fsp.stat(full)).size;
        } catch (err) {
          /* unreadable — not counted, not fatal */
          ehLog("debug", "bundle.staging-size.file-unreadable", {
            file: e.name,
            err,
          });
        }
      }
    }
  };
  await walk(dir);
  return total;
}

/**
 * Repack every external mod the curator flagged as bundled, from its staging
 * folder, and re-key it to the resulting archive.
 *
 * Never throws for a per-mod problem: a mod that cannot be repacked keeps its
 * original identity and produces a warning, because failing an entire build
 * over one bundle would cost the curator far more than shipping without it.
 */
export async function repackBundledExternals(args: {
  state: types.IState;
  gameId: string;
  mods: AuditorMod[];
  config: CollectionConfig;
  sevenZip: SevenZipApi;
  /** Directory for the temporary archives. Caller owns cleanup. */
  workDir: string;
  isExternal: (mod: AuditorMod) => boolean;
  options?: RepackOptions;
}): Promise<RepackResult> {
  const { state, gameId, mods, config, sevenZip, workDir, isExternal } = args;
  const options = args.options ?? {};
  const warnBytes = options.warnBytes ?? DEFAULT_WARN_BYTES;

  const wanted = mods.filter(
    (m) => isExternal(m) && config.externalMods[m.id]?.bundled === true,
  );
  if (wanted.length === 0) {
    ehLog("debug", "bundle.repack.skip", { reason: "no-mods-flagged" });
    return { mods, bundles: [], warnings: [], failedRepackModIds: [] };
  }

  const op = beginOp("bundle.repack", { gameId, candidates: wanted.length });

  const installRoot = installRootFor(state, gameId);
  if (!installRoot) {
    op.fail(new Error("Could not resolve Vortex's staging folder"), {
      gameId,
    });
    return {
      mods,
      bundles: [],
      warnings: [
        `Could not resolve Vortex's staging folder for "${gameId}", so no ` +
          `bundled mod could be repacked. None of them ship, so rebuild ` +
          `before releasing.`,
      ],
      failedRepackModIds: wanted.map((m) => m.id),
    };
  }

  await fsp.mkdir(workDir, { recursive: true });

  const bundles: RepackedBundle[] = [];
  const warnings: string[] = [];
  const failedRepackModIds: string[] = [];
  const newSha = new Map<string, string>();
  /** modId → the archive this build is using, so older ones can be swept. */
  const keptByMod = new Map<string, string>();
  let done = 0;

  for (const mod of wanted) {
    if (options.signal?.aborted === true) break;
    done += 1;
    options.onProgress?.(done, wanted.length, mod.name);
    const modStartedAt = Date.now();

    const stagingDirFor = stagingRootFromFolder(
      installRoot,
      mod.installationPath,
    );
    if (stagingDirFor === undefined) {
      ehLog("warn", "bundle.repack.mod.no-staging-dir", {
        modId: mod.id,
        modName: mod.name,
      });
      warnings.push(
        `"${mod.name}" is flagged for bundling but Vortex records no staging ` +
          `folder for it, so its current files cannot be packed.`,
      );
      continue;
    }
    const stagingDir = stagingDirFor;

    try {
      const size = await directorySize(stagingDir);
      if (size > warnBytes) {
        // Said, not enforced. The curator chose to ship this.
        ehLog("warn", "bundle.repack.mod.large", {
          modId: mod.id,
          modName: mod.name,
          bytes: size,
        });
        warnings.push(
          `"${mod.name}" is bundled and its staging folder is ` +
            `${(size / 1024 ** 3).toFixed(1)} GB, so the .ehcoll will be at ` +
            `least that large and the build will spend a while packing it. ` +
            `That is fine if you meant it — if you did not, untick bundle and ` +
            `give users a download link instead.`,
        );
      }

      /**
       * The identity of what is about to be packed.
       *
       * `undefined` when any staged file lacks a hash, which is exactly the
       * case where reusing a previous archive would be a guess rather than a
       * fact. The mod is repacked then, under a name nothing will match.
       */
      const contentKey = computeStagingSetHash(mod.stagingFiles ?? []);
      const out =
        contentKey === undefined
          ? path.join(workDir, `${sanitizeModId(mod.id)}-uncacheable.zip`)
          : path.join(workDir, bundleFileName(mod.id, contentKey));

      const hit =
        contentKey === undefined
          ? undefined
          : await readCachedBundle(out, options.signal);

      if (hit !== undefined) {
        options.onProgress?.(done, wanted.length, `${mod.name} (already packed)`);
        ehLog("info", "bundle.repack.mod.ok", {
          modId: mod.id,
          modName: mod.name,
          bytes: hit.bytes,
          reused: true,
          ms: Date.now() - modStartedAt,
        });
        bundles.push({
          modId: mod.id,
          modName: mod.name,
          sourcePath: out,
          sha256: hit.sha256,
          bytes: hit.bytes,
          reused: true,
        });
        newSha.set(mod.id, hit.sha256);
        keptByMod.set(mod.id, out);
        continue;
      }

      ehLog("debug", "bundle.repack.mod.start", {
        modId: mod.id,
        modName: mod.name,
        cacheable: contentKey !== undefined,
      });

      // `<dir>/*` so 7z stores paths relative to the staging root, matching
      // what the mod's own file list says. There is no cwd option in this
      // node-7z; see sevenZip.ts.
      await fsp.rm(out, { force: true });
      await fsp.rm(bundleSidecarPath(out), { force: true });
      await sevenZipAdd(
        sevenZip,
        out,
        [path.join(stagingDir, "*")],
        { raw: ["-tzip"], r: true },
        options.signal,
      );

      const sha256 = await hashFileSha256(out, options.signal);
      const bytes = (await fsp.stat(out)).size;
      // Written only after the archive exists and has been measured, so a
      // sidecar never describes a file that was interrupted on the way out.
      if (contentKey !== undefined) {
        await writeCachedBundle(out, { sha256, bytes });
      }
      ehLog("info", "bundle.repack.mod.ok", {
        modId: mod.id,
        modName: mod.name,
        bytes,
        reused: false,
        ms: Date.now() - modStartedAt,
      });
      bundles.push({ modId: mod.id, modName: mod.name, sourcePath: out, sha256, bytes });
      newSha.set(mod.id, sha256);
      keptByMod.set(mod.id, out);
    } catch (err) {
      ehLog("error", "bundle.repack.mod.fail", {
        modId: mod.id,
        modName: mod.name,
        ms: Date.now() - modStartedAt,
        err,
      });
      failedRepackModIds.push(mod.id);
      warnings.push(
        `"${mod.name}" is flagged for bundling but could not be packed from ` +
          `its staging folder: ${err instanceof Error ? err.message : String(err)}. ` +
          `It has been left out of this package — nothing for this mod ships, ` +
          `so rebuild before releasing.`,
      );
    }
  }

  // One archive per bundled mod: older versions go once the build has what
  // it needs, never before — a sweep that ran first would delete the copy
  // that makes a retry fast after a failure.
  await sweepStaleBundles(workDir, keptByMod);

  const reusedCount = bundles.filter((b) => b.reused === true).length;
  op.ok({
    repacked: bundles.length,
    reused: reusedCount,
    warnings: warnings.length,
  });

  if (newSha.size === 0) {
    return { mods, bundles, warnings, failedRepackModIds };
  }

  return {
    failedRepackModIds,
    // Identity follows the bytes: the repacked archive is what the user gets,
    // so it is what the manifest must name.
    mods: mods.map((m) => {
      const sha = newSha.get(m.id);
      return sha !== undefined ? { ...m, archiveSha256: sha } : m;
    }),
    bundles,
    warnings,
  };
}

/**
 * A previously packed archive, if it is still exactly what it claims.
 *
 * Every failure here answers "no cache" rather than throwing: a missing,
 * unreadable or half-written sidecar must cost a repack, never a build.
 */
async function readCachedBundle(
  archivePath: string,
  signal?: AbortSignal,
): Promise<CachedBundle | undefined> {
  void signal;
  try {
    const stat = await fsp.stat(archivePath);
    if (!stat.isFile() || stat.size === 0) return undefined;
    const raw = await fsp.readFile(bundleSidecarPath(archivePath), "utf8");
    const parsed = JSON.parse(raw) as CachedBundle;
    return sidecarMatches(parsed, stat.size) ? parsed : undefined;
  } catch (err) {
    ehLog("debug", "bundle.cache.miss", {
      file: path.basename(archivePath),
      err,
    });
    return undefined;
  }
}

async function writeCachedBundle(
  archivePath: string,
  cached: CachedBundle,
): Promise<void> {
  try {
    await fsp.writeFile(
      bundleSidecarPath(archivePath),
      JSON.stringify(cached),
      "utf8",
    );
  } catch (err) {
    // No sidecar means the next build repacks. Wasteful, never wrong.
    ehLog("warn", "bundle.cache.write-failed", {
      file: path.basename(archivePath),
      err,
    });
  }
}

/** Drop every cached archive of these mods except the one just used. */
async function sweepStaleBundles(
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
    for (const stale of staleBundlesFor({ fileNames, modId, keep })) {
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
 * Fold a second repack pass into the first, one entry per mod.
 *
 * `repackBundledExternals` packs every mod the CONFIG marks bundled — it takes
 * the config, not a list of ids — so a second pass run after the curator
 * answers mid-build returns an entry for each already-bundled mod too, served
 * from the cache with an identical sha256.
 *
 * Concatenating produced two entries with the same hash, and `packageEhcoll`
 * rejects that outright: "Two bundled archives share sha256 ... this should be
 * impossible." The build died at packaging, after every expensive phase, for
 * any curator who already had one bundled mod and answered "ship my copy" for
 * one more — the ordinary case for this feature.
 *
 * The second pass wins: it read the config the curator's answers just wrote.
 * ──────────────────────────────────────────────────────────────────────
 */
export function mergeRepackedBundles(
  first: readonly RepackedBundle[],
  second: readonly RepackedBundle[],
): RepackedBundle[] {
  const byModId = new Map(first.map((b) => [b.modId, b] as const));
  for (const bundle of second) byModId.set(bundle.modId, bundle);
  return [...byModId.values()];
}
