/**
 * ──────────────────────────────────────────────────────────────────────
 * Has a mod changed since WE installed it?
 *
 * When a collection is updated, most of its mods are untouched between
 * versions. Those should already be on disk exactly as the previous install
 * left them — and when one is not, something modified it in between: the user
 * editing an INI inside a mod folder, a tool rewriting a plugin, a game that
 * writes into its own mod directory, or a genuine corruption.
 *
 * ─── THE REFERENCE IS OUR OWN WORK, NEVER THE CURATOR'S DISK ───────────
 * This does not compare against the curator at all, and that is the whole
 * design. A curator's staging diverges from its archive in ways nobody
 * notices — post-install tooling on ~11% of a real 993-mod profile, plus
 * files Vortex silently lost during THEIR install — so treating it as the
 * etalon promotes their accident to truth for everyone.
 *
 * The receipt records a fingerprint of what the previous install left on THIS
 * machine, and only for mods whose verification passed, so the reference is
 * something we proved rather than something we assumed.
 *
 * ─── WHAT A MISMATCH MEANS, AND WHAT IT DOES NOT ───────────────────────
 * It means "this changed since we installed it". That is a fact.
 *
 * It does NOT mean "this is wrong". A user is entitled to edit a mod, and
 * plenty of mods edit themselves. So the result is offered, never enforced:
 * reinstall to return to the collection's version, or keep what is there.
 * Deciding for them would silently discard deliberate work.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { InstallReceiptMod } from "../../types/installLedger";
import type { EhcollMod, EhcollStagingFile } from "../../types/ehcoll";
import { ehLog } from "../logging/ehLog";
import { computeStagingPathSetHash } from "../manifest/stagingSetHash";

export type DriftCandidate = {
  compareKey: string;
  /** Name from the receipt — what the user called it when it was installed. */
  name: string;
  /** Vortex mod id recorded at install; where to look on disk. */
  vortexModId: string;
  /** The fingerprint the previous install left behind. */
  expectedHash: string;
};

/**
 * Which mods are worth checking for drift.
 *
 * Four conditions, and each excludes a case where a mismatch would mean
 * something other than drift:
 *
 *  1. The receipt recorded a hash. Absent means the previous install could not
 *     prove what it left — an older receipt, a "fast" package, or a mod that
 *     failed verification. Unknown is not "unchanged", and must not be
 *     reported as changed either.
 *
 *  2. The mod is STILL IN the new manifest. One that was dropped between
 *     versions is being removed, not drifting.
 *
 *  4. The recorded hash covered the SAME FILE LIST this version records — see
 *     the note inside. Conditions 3 and 4 are not the same question: the key
 *     is about the ARCHIVE, this is about which of its files are recorded.
 *
 *  3. Its identity is UNCHANGED — same `compareKey`, which encodes
 *     `nexus:modId:fileId` or `external:<sha256>`. A mod the curator UPDATED
 *     is supposed to differ; checking it would report drift on every upgraded
 *     mod in the collection, which is both wrong and the loudest possible way
 *     to be wrong.
 *
 * Pure: the caller does the hashing and decides what to do.
 */
export function selectDriftCandidates(args: {
  receiptMods: readonly InstallReceiptMod[];
  /** Mods in the NEW manifest — the version being installed now. */
  manifestMods: readonly EhcollMod[];
}): DriftCandidate[] {
  const stillPresent = new Set(args.manifestMods.map((m) => m.compareKey));
  /**
   * (4) The recorded hash covered the SAME FILE LIST this version records.
   *
   * Condition 3 reasons that an unchanged `compareKey` means an unchanged
   * list. It does not: the key encodes the ARCHIVE, so a curator who narrows
   * or widens which of that archive's files the collection records leaves it
   * untouched while the set changes underneath. The two sides then digest
   * different lists and differ by construction — the loud, confident,
   * completely wrong report that a folder nobody touched was edited, with
   * advice to reinstall it.
   *
   * Only decidable when the receipt says what its hash covered. Receipts
   * written before `stagingSetPaths` existed carry no answer, and unknown
   * leaves the candidate in: that is the behaviour those receipts already
   * had, and dropping them all would silently retire drift detection for
   * every player who has not reinstalled since.
   */
  const pathSetByKey = new Map<string, string | undefined>(
    args.manifestMods.map((m) => [
      m.compareKey,
      // Optional access deliberately: this whole module is a diagnostic that
      // must never fail an install, and a manifest entry with no `state` is
      // simply one with nothing recorded to compare.
      computeStagingPathSetHash(m.state?.stagingFiles ?? []),
    ]),
  );

  const out: DriftCandidate[] = [];
  let listChanged = 0;
  for (const mod of args.receiptMods) {
    if (mod.stagingSetHash === undefined) continue; // (1)
    if (!stillPresent.has(mod.compareKey)) continue; // (2) and (3)
    const nowPaths = pathSetByKey.get(mod.compareKey);
    if (
      mod.stagingSetPaths !== undefined &&
      nowPaths !== undefined &&
      mod.stagingSetPaths !== nowPaths
    ) {
      listChanged += 1;
      continue; // (4)
    }
    out.push({
      compareKey: mod.compareKey,
      name: mod.name,
      vortexModId: mod.vortexModId,
      expectedHash: mod.stagingSetHash,
    });
  }
  ehLog("debug", "staging-drift.candidates", {
    receiptMods: args.receiptMods.length,
    manifestMods: args.manifestMods.length,
    candidates: out.length,
    // Not drift and not health: the collection now records a different set of
    // files for these mods, so the two fingerprints are not comparable.
    listChanged,
  });
  return out;
}

export type DriftFinding = {
  compareKey: string;
  name: string;
  vortexModId: string;
};

/**
 * Hash each candidate's staging folder and report the ones that moved.
 *
 * Never throws, and a mod that cannot be read is NOT reported as drifted: a
 * folder that has been deleted, or is locked by the game, is a different
 * situation with a different answer, and calling it drift would tell the user
 * their files changed when what actually happened is that we could not look.
 *
 * The per-file hash cache does the heavy lifting — it keys on
 * `path|size|mtime`, so an untouched file costs a stat and a changed file is
 * the one thing worth reading. The cost is therefore proportional to what
 * actually moved, which for a collection nobody edited is almost nothing.
 */
export async function findDriftedMods(args: {
  candidates: readonly DriftCandidate[];
  /** Resolves a Vortex mod id to its absolute staging folder. */
  stagingRootFor: (vortexModId: string) => string | undefined;
  /**
   * The file list the recorded hash was built from.
   *
   * REQUIRED, and the reason is the whole correctness of this function. The
   * reference in the receipt is a hash of the MANIFEST'S file list. Measuring
   * by walking the folder instead would hash every file present — including
   * ones the manifest never listed — so the two sides would describe
   * different sets and differ by construction.
   *
   * verifyModInstall documents extra files as normal ("they happen
   * legitimately when the user picks different FOMOD options than the curator
   * did"), and Vortex leaves its own bookkeeping in staging folders, so that
   * mismatch would have fired on a large share of untouched mods. Hashing
   * exactly the recorded paths makes both sides describe the same set — and
   * costs less than the walk it replaces.
   *
   * Safe for a drift candidate specifically: `selectDriftCandidates` drops any
   * mod whose recorded path list differs from this version's (condition 4),
   * so both sides describe one set.
   */
  manifestFilesFor: (compareKey: string) => readonly EhcollStagingFile[] | undefined;
  /** Where the user's hash cache lives. Omit to hash everything afresh. */
  cacheDir?: string;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, name: string) => void;
}): Promise<DriftFinding[]> {
  const startedAt = Date.now();
  ehLog("info", "staging-drift.start", {
    candidates: args.candidates.length,
    caching: args.cacheDir !== undefined,
  });

  const { hashStagingFiles } = await import("../manifest/stagingFileWalker");
  const { computeStagingSetHash } = await import("../manifest/stagingSetHash");
  const { loadArchiveHashCache, saveArchiveHashCache, makeHashLookup } =
    await import("../archiveHashCache");

  // hashStagingFiles documents its cache as opt-in, because "reusing a
  // curator-era hash would be meaningless" on a user's staging folder. That
  // caution does not reach here: the key is `absolutePath|size|mtime` and this
  // loads the USER'S OWN cache from their appData, so a curator's entry
  // cannot appear in it, let alone be mistaken for one of these files.
  let cache;
  let lookup;
  let added;
  if (args.cacheDir !== undefined) {
    try {
      cache = await loadArchiveHashCache(args.cacheDir);
      // makeHashLookup returns the lookup ALONGSIDE the entries it accumulates
      // — the cache object itself is not mutated, so saving means merging what
      // this run added. Treating the wrapper as the lookup silently disables
      // caching, which is a performance bug that no test would ever notice.
      const made = makeHashLookup(cache);
      lookup = made.lookup;
      added = made.added;
    } catch (err) {
      ehLog("warn", "staging-drift.cache-load-failed", { err });
      lookup = undefined;
    }
  }

  const found: DriftFinding[] = [];
  let done = 0;
  for (const candidate of args.candidates) {
    if (args.signal?.aborted) break;
    done += 1;
    args.onProgress?.(done, args.candidates.length, candidate.name);

    const root = args.stagingRootFor(candidate.vortexModId);
    if (root === undefined) continue;
    const tracked = args.manifestFilesFor(candidate.compareKey);
    if (tracked === undefined || tracked.length === 0) continue;

    try {
      // Stat exactly the files the reference was built from — no walk. A file
      // the manifest lists that is now ABSENT is left out of `present`, which
      // shortens the set and therefore changes the hash: a deletion reads as
      // drift, which is what it is.
      const fsp = await import("fs/promises");
      const nodePath = await import("path");
      const present = [];
      for (const file of tracked) {
        const absolutePath = nodePath.join(root, ...file.path.split("/"));
        const stat = await fsp.stat(absolutePath).catch(() => undefined);
        if (stat === undefined || !stat.isFile()) continue;
        present.push({
          relativePath: file.path,
          absolutePath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      }

      const hashed = await hashStagingFiles(
        root,
        present,
        "thorough",
        undefined,
        args.signal,
        () => undefined,
        lookup,
      );
      const actual = computeStagingSetHash(hashed);
      // `undefined` means some file could not be hashed, so the set is not
      // describable — which is not the same as matching.
      if (actual !== undefined && actual !== candidate.expectedHash) {
        ehLog("debug", "staging-drift.mod-drifted", {
          compareKey: candidate.compareKey,
          name: candidate.name,
          trackedFiles: tracked.length,
          presentFiles: present.length,
        });
        found.push({
          compareKey: candidate.compareKey,
          name: candidate.name,
          vortexModId: candidate.vortexModId,
        });
      }
    } catch (err) {
      // Unreadable is not drifted. See the note above.
      ehLog("debug", "staging-drift.mod-unreadable", {
        compareKey: candidate.compareKey,
        name: candidate.name,
        err,
      });
    }
  }

  if (cache !== undefined && added !== undefined && args.cacheDir !== undefined) {
    // Every hash computed here is one a later run does not repeat. Merged
    // rather than written back directly: makeHashLookup collects additions
    // separately and leaves the loaded cache untouched.
    const { mergeHashes } = await import("../archiveHashCache");
    await saveArchiveHashCache(
      args.cacheDir,
      mergeHashes(cache, added, new Date().toISOString()),
    ).catch((err) => {
      ehLog("warn", "staging-drift.cache-save-failed", { err });
      return undefined;
    });
  }

  ehLog("info", "staging-drift.ok", {
    candidates: args.candidates.length,
    drifted: found.length,
    examples: found.slice(0, 5).map((f) => f.name),
    ms: Date.now() - startedAt,
  });
  return found;
}

/**
 * The user-facing summary, or `undefined` when nothing drifted.
 *
 * One aggregate line plus the names, on the same reasoning as the curator's
 * divergence report: a per-mod card for each of forty drifted mods buries
 * whatever else the screen was trying to say.
 *
 * Worded to describe rather than accuse, because we genuinely do not know
 * which of these the user did on purpose — and telling someone their
 * deliberate edit is damage is a good way to have them ignore the next one.
 */
export function describeStagingDrift(
  findings: readonly DriftFinding[],
): string[] | undefined {
  if (findings.length === 0) return undefined;

  const n = findings.length;
  const names = findings.slice(0, 10).map((f) => `  - ${f.name}`);
  if (n > 10) names.push(`  - ...and ${n - 10} more`);

  return [
    `${n} mod${n === 1 ? "" : "s"} on this machine changed since the ` +
      `collection last installed ${n === 1 ? "it" : "them"}, and ${
        n === 1 ? "it is" : "they are"
      } unchanged in this version of the collection. That usually means ` +
      `something edited ${n === 1 ? "it" : "them"} in between — you, a tool, ` +
      `or the game itself. Nothing here is necessarily wrong.`,
    ...names,
    `Reinstalling any of these returns it to the collection's version; ` +
      `leaving it keeps what is on disk. Event Horizon has changed nothing.`,
  ];
}
