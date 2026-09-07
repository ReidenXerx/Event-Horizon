import * as path from "path";

import { selectors } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";

import type { AuditorMod } from "../getModsListForProfile";
import type { EhcollManifest } from "../../types/ehcoll";
import { ehLog } from "../logging/ehLog";
import { AbortError } from "../../utils/abortError";
import { computeStagingSetHash } from "../manifest/stagingSetHash";
import { bundledArchiveFileName } from "../installer/modInstall";
import {
  installRootFor,
  installationPathFromState,
  stagingRootFromFolder,
} from "../stagingPath";
import {
  getDefaultHashConcurrency,
  hashStagingFiles,
  walkStagingFolder,
} from "../manifest/stagingFileWalker";

/**
 * User-side enrichment: compute `stagingSetHash` for installed mods
 * that name-match an external manifest entry carrying its own
 * `stagingSetHash`. The resolver's `findInstalledByStagingSetHash`
 * matcher reads this — without enrichment, archive-less external
 * mods cannot be matched as "already installed" on the user's side.
 *
 * ─── COST MODEL ───────────────────────────────────────────────────
 * Hashing every installed mod's staging folder would be wasteful
 * (hundreds of MB per mod, dozens to hundreds of mods). We bound
 * the work two ways:
 *
 *  1. **Manifest selection.** Only manifest mods with `kind === "external"`
 *     AND `stagingSetHash` defined drive enrichment. Archive-only
 *     external mods (`sha256` set, no `stagingSetHash`) match cheaply
 *     via `findInstalledBySha`; we don't pre-hash the user's mods
 *     for them.
 *
 *  2. **Name candidates.** Within the manifest-selected set, only
 *     installed mods whose name (case-insensitive, trimmed) exactly
 *     matches at least one manifest mod's name are hashed. Most
 *     manifest entries have 0–1 candidates per typical setup.
 *
 *     ─── KNOWN LIMITATION ────────────────────────────────────────
 *     Name matching is the WEAKEST link in the identity ladder.
 *     If the curator's "Better Combat (1.4)" was installed by the
 *     user as "Better Combat - Final" (Vortex permits per-mod
 *     renames, Nexus titles drift across versions, manual installs
 *     pick whatever the archive's `info.txt` says), we won't even
 *     consider that mod as a candidate — it'll fall through to
 *     "missing" and the user gets a needless prompt-user / install.
 *
 *     TODO(stagingSetHash): broaden the oracle once we have data
 *     on real curator/user name drift. Candidate strategies (in
 *     ascending cost):
 *       • alias map in `CollectionConfig` (curator hand-edits a
 *         "this mod has been renamed to X by users" hint),
 *       • token-set similarity (e.g. Jaccard ≥ 0.6 over normalized
 *         word tokens) — catches "(1.4)" vs "- Final" tail drift,
 *       • blanket-hash all installed mods on the user's machine
 *         (currently rejected as too expensive: 100 mods × ~2GB
 *         each = ~200GB read on first install).
 *     For now we ship name-match-only because it's good enough for
 *     ≥95% of pairings the curator vs user actually share, and the
 *     prompt-user fallback is functional rather than catastrophic.
 *
 * The result: O(name-matched mods) × (avg staging folder size)
 * per resolve, which is dominated by the user's deployed mod set
 * but bounded by name-match overlap. CPU-bound work runs through
 * {@link hashStagingFiles}'s adaptive concurrency (typically
 * `min(8, max(2, cpus-1))`), so wall-time scales with cores.
 *
 * ─── DOUBLE-VERIFICATION ──────────────────────────────────────────
 * Together with the post-install Tier-2 verifier, this gives us two
 * independent checkpoints:
 *
 *  - **Pre-install** (this function → resolver): "Does the user
 *    already have curator's exact bytes deployed?" If yes, skip;
 *    if no, install. If a name candidate's hash *mismatches* the
 *    manifest hash, we treat the mod as not-installed (bytes
 *    diverge — install the curator's version).
 *
 *  - **Post-install** (`verifyModInstall`): "Did the install land
 *    the bytes we expected?" Independent of whether we matched
 *    pre-install; catches partial extracts, lost files, corruption.
 *
 * Both checkpoints share `walkStagingFolder` + `hashStagingFiles`,
 * so the curator-side and user-side hashing paths agree byte-for-byte
 * on what counts as "the file set."
 *
 * ─── DESIGN ───────────────────────────────────────────────────────
 *  - **No-op when nothing to do.** If the manifest has zero external
 *    mods with `stagingSetHash`, this function returns the input
 *    array unchanged (same reference) without touching disk.
 *  - **Mutation-safe input.** Returns a fresh array; per-mod entries
 *    are spread copies so the caller's `AuditorMod[]` is untouched.
 *  - **Failure ⇒ undefined.** Per-mod errors (locked file, partial
 *    walk) surface to `onWarn` and leave the mod's `stagingSetHash`
 *    unset rather than failing the entire enrichment. The resolver
 *    treats absence as "byte-identity unknown."
 *  - **Aborts propagate.** `signal?.aborted` causes an `AbortError`
 *    to bubble out of any in-flight walk/hash, identical to the
 *    archive-hash enrichment path.
 */
export type EnrichStagingSetHashesOptions = {
  /** Adaptive default — see {@link getDefaultHashConcurrency}. */
  hashConcurrency?: number;
  /**
   * Per-mod progress callback. Fires once per name-matched mod
   * (success, partial, skipped). Useful to drive a status line in
   * the install UI.
   */
  onProgress?: (done: number, total: number, mod: AuditorMod) => void;
  /**
   * Per-mod diagnostic warnings — non-fatal. Used for missing
   * staging folders, locked files, etc. Distinct from hard errors,
   * which throw.
   */
  onWarn?: (mod: AuditorMod, message: string) => void;
  signal?: AbortSignal;
};

export async function enrichInstalledModsWithStagingSetHashes(
  state: types.IState,
  gameId: string,
  manifest: EhcollManifest,
  installedMods: AuditorMod[],
  options: EnrichStagingSetHashesOptions = {},
): Promise<AuditorMod[]> {
  const { hashConcurrency, onProgress, onWarn, signal } = options;
  const startedAt = Date.now();
  ehLog("info", "resolver.staging-hashes.start", {
    gameId,
    manifestMods: manifest.mods.length,
    installedMods: installedMods.length,
  });

  // Gate 1: anything to match against?
  const wanted = collectExternalStagingSetHashTargets(manifest);
  if (wanted.size === 0) {
    ehLog("debug", "resolver.staging-hashes.done", {
      ms: Date.now() - startedAt,
      reason: "no-external-staging-set-hash-targets",
      enriched: 0,
    });
    return installedMods;
  }

  if (signal?.aborted) {
    ehLog("warn", "resolver.staging-hashes.aborted", {
      ms: Date.now() - startedAt,
      stage: "pre-scan",
    });
    throw new AbortError();
  }

  // Gate 2: which installed mods name-match? Only those get hashed.
  const out = installedMods.map((m) => ({ ...m }));
  const candidateIndices: number[] = [];
  for (let i = 0; i < out.length; i++) {
    const mod = out[i]!;
    const key = normalizeName(mod.name);
    if (key.length === 0) continue;
    if (wanted.has(key)) {
      candidateIndices.push(i);
    }
  }
  if (candidateIndices.length === 0) {
    /**
     * ─── WANTED > 0 AND NOT ONE CANDIDATE IS A BROKEN INVARIANT ────────
     * This exact line, at `debug`, was the whole diagnosis of a bug that ran
     * for months: `{"wanted":29,"candidates":0,"enriched":0}` on a machine
     * with 1,105 installed mods, every run. Twenty-nine external mods, never
     * a single candidate — a total failure of an identity rung, whispered
     * one level below its own `.start`.
     *
     * It is a warning, and it names what it was looking for. Comparing those
     * names against what is actually installed IS the diagnosis; without them
     * the next occurrence needs a curator to reason about temp filenames.
     */
    ehLog("warn", "resolver.staging-hashes.done", {
      ms: Date.now() - startedAt,
      wanted: wanted.size,
      candidates: 0,
      enriched: 0,
      why: "no installed mod name matched any external manifest entry",
      sampleWanted: [...wanted].slice(0, 5),
      sampleInstalled: out.slice(0, 5).map((m) => m.name),
    });
    return out;
  }

  const installRoot = installRootFor(state, gameId);
  if (installRoot === undefined) {
    ehLog("warn", "resolver.staging-hashes.no-install-root", {
      gameId,
      candidates: candidateIndices.length,
    });
    if (onWarn !== undefined) {
      onWarn(
        out[candidateIndices[0]!]!,
        `Could not resolve Vortex install path for game "${gameId}". ` +
          "Skipping staging-set-hash enrichment; archive-less external " +
          "mods will fall back to install-from-bundle / prompt-user.",
      );
    }
    ehLog("debug", "resolver.staging-hashes.done", {
      ms: Date.now() - startedAt,
      candidates: candidateIndices.length,
      enriched: 0,
      reason: "no-install-root",
    });
    return out;
  }

  const workers = hashConcurrency ?? getDefaultHashConcurrency();

  const total = candidateIndices.length;
  let done = 0;
  let enriched = 0;
  let warned = 0;

  for (const i of candidateIndices) {
    if (signal?.aborted) {
      ehLog("warn", "resolver.staging-hashes.aborted", {
        ms: Date.now() - startedAt,
        stage: "hashing",
        done,
        total,
        enriched,
        warned,
      });
      throw new AbortError();
    }
    const mod = out[i]!;

    const installationPath = installationPathFromState(state, gameId, mod.id);
    if (installationPath === undefined) {
      warned += 1;
      ehLog("debug", "resolver.staging-hashes.no-installation-path", {
        mod: mod.name,
      });
      onWarn?.(
        mod,
        `Mod "${mod.name}" has no installationPath in Vortex state. ` +
          "Cannot compute staging-set-hash for archive-less identity match.",
      );
      done += 1;
      onProgress?.(done, total, mod);
      continue;
    }

    // Guarded above, but joined through the shared helper anyway: the
    // point of one resolver is that no site decides for itself what a
    // usable folder name is.
    const stagingRoot = stagingRootFromFolder(installRoot, installationPath);
    if (stagingRoot === undefined) {
      warned += 1;
      ehLog("debug", "resolver.staging-hashes.no-staging-root", {
        mod: mod.name,
      });
      done += 1;
      onProgress?.(done, total, mod);
      continue;
    }
    try {
      const files = await walkStagingFolder(stagingRoot, signal);
      if (files.length === 0) {
        warned += 1;
        ehLog("debug", "resolver.staging-hashes.empty-staging-folder", {
          mod: mod.name,
        });
        onWarn?.(
          mod,
          `Staging folder for "${mod.name}" is empty or missing at ` +
            `"${stagingRoot}". Skipping staging-set-hash.`,
        );
        done += 1;
        onProgress?.(done, total, mod);
        continue;
      }
      // Always thorough — set-hash only matches on per-file sha256s.
      const stagingFiles = await hashStagingFiles(
        stagingRoot,
        files,
        "thorough",
        workers,
        signal,
        (relPath, err) => {
          ehLog("debug", "resolver.staging-hashes.file-hash-failed", {
            mod: mod.name,
            relPath,
            err,
          });
          onWarn?.(mod, `${relPath}: ${err.message}`);
        },
      );
      const setHash = computeStagingSetHash(stagingFiles);
      if (setHash !== undefined) {
        mod.stagingSetHash = setHash;
        enriched += 1;
      } else {
        // Either no files, or some had no sha (I/O error during walk).
        // computeStagingSetHash returns undefined to refuse partial
        // hashes — same conservative degradation, surfaced to the user.
        warned += 1;
        ehLog("debug", "resolver.staging-hashes.incomplete-hash", {
          mod: mod.name,
        });
        onWarn?.(
          mod,
          `Could not compute a complete staging-set-hash for "${mod.name}" ` +
            "(some files were unreadable). Falling back to no-match for " +
            "this mod.",
        );
      }
    } catch (err) {
      if (err instanceof AbortError) {
        ehLog("warn", "resolver.staging-hashes.aborted", {
          ms: Date.now() - startedAt,
          stage: "per-mod",
          mod: mod.name,
          done,
          total,
          enriched,
          warned,
        });
        throw err;
      }
      warned += 1;
      // Swallowed on purpose — the resolver treats this mod as unmatched
      // rather than failing the whole enrichment, but the swallow must say
      // what it ate.
      ehLog("warn", "resolver.staging-hashes.mod-failed", {
        mod: mod.name,
        err,
      });
      onWarn?.(
        mod,
        `Failed to enrich staging-set-hash for "${mod.name}": ${
          (err as Error).message
        }.`,
      );
    }

    done += 1;
    onProgress?.(done, total, mod);
  }

  ehLog("info", "resolver.staging-hashes.done", {
    ms: Date.now() - startedAt,
    candidates: total,
    enriched,
    warned,
  });
  return out;
}

/**
 * Build the set of normalized names the manifest cares about for
 * staging-set-hash matching. Manifest mods without `stagingSetHash`
 * (archive-only externals or all Nexus mods) are excluded — their
 * identity is established cheaply via archive sha alone.
 */
/**
 * Exported for the round-trip test: this set IS the fix, and asserting the
 * sanitiser's output instead of this membership is what let the original bug
 * ship green.
 */
export function collectStagingSetHashTargetsForTest(
  manifest: EhcollManifest,
): Set<string> {
  return collectExternalStagingSetHashTargets(manifest);
}

function collectExternalStagingSetHashTargets(
  manifest: EhcollManifest,
): Set<string> {
  const names = new Set<string>();
  for (const mod of manifest.mods) {
    if (
      mod.source.kind === "external" &&
      typeof mod.source.stagingSetHash === "string" &&
      mod.source.stagingSetHash.length === 64
    ) {
      /**
       * ─── BOTH SPELLINGS OF THE NAME ─────────────────────────────────
       * A bundled external mod is extracted under a SANITISED form of this
       * name (see `bundledArchiveFileName`), because the file name becomes
       * the Vortex mod name. `normalizeName` does not undo that sanitising,
       * so every transform it applies used to put the mod straight back into
       * the `candidates: 0` hole this matcher exists to climb out of:
       *
       *     "Skyrim: Special Edition Patch" -> "Skyrim_ Special Edition Patch"
       *     "A|B"                           -> "A_B"
       *     a name over 120 chars           -> truncated
       *
       * Colons and pipes are ordinary in mod titles, so this was not an edge
       * case. Registering the sanitised spelling ALONGSIDE the raw one makes
       * the match independent of what the sanitiser does now or later,
       * instead of depending on it being the identity function.
       */
      for (const candidate of [
        mod.name,
        bundledInstallName(mod.name),
      ]) {
        const normalized = normalizeName(candidate);
        if (normalized.length > 0) {
          names.add(normalized);
        }
      }
    }
  }
  return names;
}

/**
 * The name Vortex will give a mod installed from its bundled archive.
 *
 * `bundledArchiveFileName` decides the file name; Vortex derives the mod name
 * from it by dropping the extension. Reproducing that here — rather than
 * re-deriving the rules — means the two can never drift apart silently, which
 * is the failure mode that made this matcher return zero for months.
 */
function bundledInstallName(modName: string): string {
  // The entry's extension is irrelevant to the STEM, and any archive
  // extension produces the same stem, so a representative one is enough.
  const fileName = bundledArchiveFileName("bundled/x.zip", modName);
  const lastDot = fileName.lastIndexOf(".");
  return lastDot <= 0 ? fileName : fileName.slice(0, lastDot);
}

/**
 * Lowercase + collapse whitespace for case-insensitive name matching.
 * This is intentionally permissive — Vortex display names go through
 * a few hands (Nexus → mod author → curator → installer) and trivial
 * whitespace differences shouldn't block a match. Identity remains
 * load-bearing on the hash, not the name.
 */
function normalizeName(raw: string | undefined): string {
  if (typeof raw !== "string") return "";
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}
