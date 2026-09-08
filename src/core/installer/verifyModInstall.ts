import * as fs from "fs";

import { detectCaseSensitivity, pathKey, toPosix } from "../paths";
import { isVolatileFile, volatileReason } from "../volatileFiles";
import * as path from "path";

import { selectors } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";

import type {
  EhcollStagingFile,
  VerificationLevel,
} from "../../types/ehcoll";
import { hashFileSha256 } from "../archiveHashing";
import { AbortError } from "../../utils/abortError";
import {
  installRootFor,
  installationPathFromState,
  stagingRootFromFolder,
} from "../stagingPath";
import { getDefaultHashConcurrency } from "../manifest/stagingFileWalker";
import { pMap } from "../../utils/pMap";
import { ehLog } from "../logging/ehLog";

/**
 * Post-install integrity check.
 *
 * Walks the user-side staging folder for a mod that just finished
 * installing and compares the on-disk file set against the curator's
 * captured `stagingFiles` from the manifest. Detects three Vortex
 * failure modes:
 *
 *   1. **Missing files** — Vortex reports `did-install-mod` but
 *      didn't actually extract every file from the archive. This is
 *      the famous "Vortex randomly loses files" symptom.
 *   2. **Size mismatch** — file extracted but truncated / partial.
 *   3. **Hash mismatch** *(thorough mode only)* — file extracted at
 *      the right size but wrong content (corruption, mid-write
 *      crash, antivirus quarantine + restore, etc.).
 *
 * Files present on the user side but NOT in the curator's manifest
 * are recorded as `extraFiles` and treated informationally — they
 * happen legitimately when the user picks different FOMOD options
 * than the curator did.
 *
 * ### Failure semantics
 *
 * Returning a result is NOT failing — the caller decides what to
 * do. Recommended call pattern in `runInstall.ts`:
 *
 * ```ts
 * const verification = await verifyModInstall({...});
 * if (verification.kind === "fail") {
 *   // re-install with force=true, then verify again
 * }
 * if (verification.kind === "skip") {
 *   // manifest had no stagingFiles; pass through
 * }
 * ```
 *
 * ### Concurrency
 *
 * Hash mode reads file bytes via {@link pMap} (concurrency 4 by
 * default). Size-only mode is pure stat() calls and has no
 * concurrency knob — calling it is microseconds-fast.
 */

export type VerifyModInstallInput = {
  api: types.IExtensionApi;
  gameId: string;
  /**
   * Vortex's mod id from `state.persistent.mods[gameId][modId]`.
   * The user-side install pipeline produces this id when Vortex
   * fires `did-install-mod`.
   */
  vortexModId: string;
  /**
   * Curator-captured staging-folder snapshot from the manifest
   * (`mod.state.stagingFiles`). Empty / missing means we have
   * nothing to verify against and the caller should treat this as
   * a `"skip"` result.
   */
  expectedFiles: EhcollStagingFile[] | undefined;
  /**
   * Manifest's `package.verificationLevel`. Drives the verify
   * mode:
   *  - `"none"`   → skip without walking disk.
   *  - `"fast"`   → file count + per-file size match (no reads).
   *  - `"thorough"` → also re-hash every file with sha256.
   *
   * If the level says thorough but `expectedFiles` lacks `sha256`
   * (curator built fast, manifest hand-tweaked, etc.) we silently
   * downgrade per-file to size-only — never error.
   */
  level: VerificationLevel;
  /**
   * Max concurrent per-file SHA-256 hashes when `level === "thorough"`.
   * Defaults to {@link getDefaultHashConcurrency} (`min(8, max(2, cpus-1))`),
   * scaling with the user's machine while leaving a core for the UI.
   */
  hashConcurrency?: number;
  signal?: AbortSignal;
};

export type VerifyOk = {
  kind: "ok";
  /**
   * Files present on the user side that aren't in the curator's
   * manifest. Informational only (FOMOD divergence, mod version
   * differences). Always empty when the curator captured the full
   * archive set without FOMOD selections.
   */
  extraFiles: string[];
  /** Total files actually verified. */
  verifiedCount: number;
};

export type VerifyFail = {
  kind: "fail";
  /** Files in manifest but absent from staging folder. */
  missingFiles: string[];
  /** Files where size differs from manifest. */
  sizeMismatches: Array<{
    path: string;
    expected: number;
    actual: number;
  }>;
  /** Files where sha256 differs (thorough mode only). */
  hashMismatches: Array<{
    path: string;
    expected: string;
    actual: string;
  }>;
  /** Files present on user side, not in manifest. Informational. */
  extraFiles: string[];
  /**
   * Total expected files (from manifest). Useful for percentage
   * calculations like "23 of 1234 missing".
   */
  expectedCount: number;
  /**
   * Absolute path of the user's staging folder for this mod.
   *
   * Carried so the caller can re-read the differing files WITHOUT recomputing
   * where they live. The driver needs their CRC-32 to ask the archive whether
   * the curator's copy is the one that moved — see judgeReinstall — and a
   * second derivation of this path is a second thing to get wrong.
   */
  stagingRoot: string;
};

/**
 * Skip — the manifest didn't carry `stagingFiles` for this mod, OR
 * the curator built with `verificationLevel = "none"`. Returning a
 * structured result rather than `undefined` keeps the caller's
 * code path uniform.
 */
export type VerifySkip = {
  kind: "skip";
  reason:
    | "no-staging-files-in-manifest"
    | "verification-level-none"
    | "vortex-mod-missing-from-state"
    | "install-path-unresolvable";
};

export type VerifyResult = VerifyOk | VerifyFail | VerifySkip;

export async function verifyModInstall(
  input: VerifyModInstallInput,
): Promise<VerifyResult> {
  const {
    api,
    gameId,
    vortexModId,
    expectedFiles,
    level,
    hashConcurrency = getDefaultHashConcurrency(),
    signal,
  } = input;

  const startedAt = Date.now();
  ehLog("info", "verify-install.start", {
    vortexModId,
    gameId,
    level,
    expectedCount: expectedFiles?.length ?? 0,
  });

  if (level === "none") {
    ehLog("info", "verify-install.skip", {
      vortexModId,
      reason: "verification-level-none",
    });
    return { kind: "skip", reason: "verification-level-none" };
  }

  if (expectedFiles === undefined || expectedFiles.length === 0) {
    ehLog("info", "verify-install.skip", {
      vortexModId,
      reason: "no-staging-files-in-manifest",
    });
    return { kind: "skip", reason: "no-staging-files-in-manifest" };
  }

  if (signal?.aborted) throw new AbortError();

  const state = api.getState();
  // The two skip reasons are different diagnoses and are kept apart, so this
  // uses the pieces rather than `stagingRootForModId`, which collapses both
  // into undefined.
  const installRoot = installRootFor(state, gameId);
  if (installRoot === undefined) {
    ehLog("info", "verify-install.skip", {
      vortexModId,
      reason: "install-path-unresolvable",
    });
    return { kind: "skip", reason: "install-path-unresolvable" };
  }

  const stagingRoot = stagingRootFromFolder(
    installRoot,
    installationPathFromState(state, gameId, vortexModId),
  );
  if (stagingRoot === undefined) {
    ehLog("info", "verify-install.skip", {
      vortexModId,
      reason: "vortex-mod-missing-from-state",
    });
    return { kind: "skip", reason: "vortex-mod-missing-from-state" };
  }

  const onDiskAll = await collectOnDiskFiles(stagingRoot, signal);
  if (signal?.aborted) throw new AbortError();

  /**
   * ─── DROP WHAT NOTHING INSTALLS, ON BOTH SIDES ──────────────────────────
   * A runtime log or a `Thumbs.db` differs on every machine, so comparing it
   * only ever produces a failure nobody can act on — and that failure then
   * drives a reinstall of a mod that is perfectly healthy.
   *
   * Filtered on BOTH sides deliberately. The curator's side is what makes
   * this land without a repack: packages already in testers' hands still
   * record these files, and dropping them only from the on-disk side would
   * turn every one of them into a `missing` instead of a `sizeMismatch`.
   */
  const onDisk = onDiskAll.filter((f) => !isVolatileFile(f.relativePath));
  const expectedVerifiable = expectedFiles.filter((f) => !isVolatileFile(f.path));

  const skippedOnDisk = onDiskAll.length - onDisk.length;
  const skippedExpected = expectedFiles.length - expectedVerifiable.length;
  if (skippedOnDisk > 0 || skippedExpected > 0) {
    // Never a silent hole: an exclusion is a thing we chose not to check, and
    // the log has to say so or "verified" overstates what was verified.
    ehLog("debug", "verify-install.volatile-skipped", {
      vortexModId,
      fromManifest: skippedExpected,
      fromDisk: skippedOnDisk,
      examples: expectedFiles
        .filter((f) => isVolatileFile(f.path))
        .slice(0, 5)
        .map((f) => ({ path: f.path, why: volatileReason(f.path) })),
    });
  }

  /**
   * ─── KEYED BY IDENTITY, NOT BY SPELLING ─────────────────────────────────
   * These are Windows paths from two different machines and two different
   * extractions. `scripts/Foo.pex` and `Scripts/Foo.pex` are the same file;
   * the filesystem thinks so, the Creation Engine thinks so, and the mirror
   * pass in this very install already thought so — it has keyed by
   * lowercased path since it was written.
   *
   * Verification did not, and it cost a real run four false "could not be
   * reproduced" reports out of eight. The signature is unmistakable: missing
   * and extra counts identical, 30/30, 1/1, 16/16, 28/28, every pair the same
   * path in different case. Each told a user their mod was broken and handed
   * them a report to send the curator about a file that was present and
   * correct.
   *
   * The ORIGINAL spelling is still what gets reported — the key decides
   * sameness and nothing else.
   */
  /**
   * ASK the filesystem rather than assuming.
   *
   * Folding case is right on NTFS — a FOMOD writing `Scripts/` where the
   * curator recorded `scripts/` is the same file, and comparing verbatim
   * reported four healthy mods as broken on a real install. It is WRONG on the
   * ext4 under a Proton install, where those are two files that can both
   * exist: folding them there would pass verification on bytes the curator
   * never shipped.
   */
  const caseMode = await detectCaseSensitivity(stagingRoot);

  const onDiskByPath = new Map<string, OnDiskFile>();
  for (const f of onDisk) {
    onDiskByPath.set(pathKey(f.relativePath, caseMode), f);
  }

  const expectedByPath = new Map<string, EhcollStagingFile>();
  for (const f of expectedVerifiable) {
    expectedByPath.set(pathKey(f.path, caseMode), f);
  }

  const missingFiles: string[] = [];
  const sizeMismatches: VerifyFail["sizeMismatches"] = [];
  const hashCandidates: Array<{ expected: EhcollStagingFile; actual: OnDiskFile }> =
    [];

  for (const expected of expectedVerifiable) {
    const actual = onDiskByPath.get(pathKey(expected.path, caseMode));
    if (actual === undefined) {
      missingFiles.push(expected.path);
      continue;
    }
    if (actual.size !== expected.size) {
      sizeMismatches.push({
        path: expected.path,
        expected: expected.size,
        actual: actual.size,
      });
      continue;
    }
    if (level === "thorough" && expected.sha256 !== undefined) {
      hashCandidates.push({ expected, actual });
    }
  }

  const hashMismatches: VerifyFail["hashMismatches"] = [];
  if (hashCandidates.length > 0) {
    const results = await pMap(
      hashCandidates,
      Math.max(1, hashConcurrency),
      async (item) => {
        try {
          const actualSha = await hashFileSha256(item.actual.absolutePath, signal);
          if (actualSha !== item.expected.sha256) {
            return {
              path: item.expected.path,
              expected: item.expected.sha256!,
              actual: actualSha,
            };
          }
          return undefined;
        } catch (err) {
          if (err instanceof AbortError) throw err;
          ehLog("debug", "verify-install.hash-read-error", {
            vortexModId,
            path: item.expected.path,
            err,
          });
          return {
            path: item.expected.path,
            expected: item.expected.sha256!,
            actual: `<read error: ${(err as Error).message}>`,
          };
        }
      },
      signal,
    );
    for (const r of results) {
      if (r !== undefined) hashMismatches.push(r);
    }
  }

  const extraFiles: string[] = [];
  for (const f of onDisk) {
    // Reported with the spelling that is actually on disk; matched by identity.
    if (!expectedByPath.has(pathKey(f.relativePath, caseMode))) {
      extraFiles.push(f.relativePath);
    }
  }

  const hasFailures =
    missingFiles.length > 0 ||
    sizeMismatches.length > 0 ||
    hashMismatches.length > 0;

  if (hasFailures) {
    ehLog("info", "verify-install.fail", {
      vortexModId,
      level,
      expectedCount: expectedVerifiable.length,
      missingCount: missingFiles.length,
      sizeMismatchCount: sizeMismatches.length,
      hashMismatchCount: hashMismatches.length,
      extraCount: extraFiles.length,
      missingExamples: missingFiles.slice(0, 5),
      sizeMismatchExamples: sizeMismatches.slice(0, 5),
      hashMismatchExamples: hashMismatches.slice(0, 5).map((m) => m.path),
      ms: Date.now() - startedAt,
    });
    return {
      kind: "fail",
      missingFiles,
      sizeMismatches,
      hashMismatches,
      extraFiles,
      expectedCount: expectedVerifiable.length,
      stagingRoot,
    };
  }

  ehLog("info", "verify-install.ok", {
    vortexModId,
    level,
    // `expectedVerifiable`, not `expectedFiles`: the volatile filter above
    // removes runtime logs and OS junk from BOTH sides, and counting the
    // pre-filter total claims to have checked files that were deliberately
    // skipped. The fail path already used the filtered count, so the two
    // disagreed — and the Done card sums these into "files verified".
    verifiedCount: expectedVerifiable.length,
    skippedVolatile: expectedFiles.length - expectedVerifiable.length,
    extraCount: extraFiles.length,
    ms: Date.now() - startedAt,
  });
  return {
    kind: "ok",
    extraFiles,
    verifiedCount: expectedVerifiable.length,
  };
}

type OnDiskFile = {
  relativePath: string;
  absolutePath: string;
  size: number;
};

/**
 * Walk the user-side staging folder. Returns an empty array if the
 * folder doesn't exist (caller will surface that as
 * `expectedCount === N, missingFiles === all of them`).
 *
 * Mirrors {@link captureStagingFiles}'s walker: same anti-loop
 * symlink guard, same POSIX-style relative paths, same sort.
 */
async function collectOnDiskFiles(
  root: string,
  signal: AbortSignal | undefined,
): Promise<OnDiskFile[]> {
  const out: OnDiskFile[] = [];
  const stat = await fs.promises.stat(root).catch(() => undefined);
  if (stat === undefined || !stat.isDirectory()) return out;

  const stack: string[] = [root];
  const visited = new Set<string>();

  while (stack.length > 0) {
    if (signal?.aborted) throw new AbortError();
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      ehLog("debug", "verify-install.readdir-failed", {
        relativeDir: toPosix(path.relative(root, dir)) || ".",
        err,
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
        if (
          realPath === undefined ||
          !realPath.startsWith(root) ||
          visited.has(realPath)
        ) {
          continue;
        }
        visited.add(realPath);
        const lstat = await fs.promises.stat(realPath).catch(() => undefined);
        if (lstat === undefined || !lstat.isFile()) continue;
        out.push({
          relativePath: toPosix(path.relative(root, abs)),
          absolutePath: abs,
          size: lstat.size,
        });
        continue;
      }
      if (entry.isFile()) {
        const lstat = await fs.promises.stat(abs).catch(() => undefined);
        if (lstat === undefined) continue;
        out.push({
          relativePath: toPosix(path.relative(root, abs)),
          absolutePath: abs,
          size: lstat.size,
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
 * Human-readable summary suited for log lines and toast messages.
 * Used by `runInstall.ts` when surfacing a verification failure to
 * the user.
 */
export function summarizeVerifyFail(fail: VerifyFail): string {
  const parts: string[] = [];
  if (fail.missingFiles.length > 0) {
    parts.push(`${fail.missingFiles.length} missing`);
  }
  if (fail.sizeMismatches.length > 0) {
    parts.push(`${fail.sizeMismatches.length} size mismatch`);
  }
  if (fail.hashMismatches.length > 0) {
    parts.push(`${fail.hashMismatches.length} corrupt`);
  }
  return `${parts.join(", ")} of ${fail.expectedCount} expected files`;
}
