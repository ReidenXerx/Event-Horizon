/**
 * Run the build-time self-check across every mod in a snapshot.
 *
 * ─── WHY IT IS AFFORDABLE ─────────────────────────────────────────────
 * Measured on the live 993-mod profile, an exhaustive check cost 2.41s per mod
 * — about 40 minutes — which is not acceptable on every build. Almost all of
 * that was walking the staging folder to CRC every file.
 *
 * The check that actually finds omissions does not need it. Deriving the
 * expected file set needs the archive HEADER (~0.02s), the FOMOD script, and
 * the recorded choices; comparing it to staging needs only the PATHS, which
 * `captureStagingFiles` has already collected. So this runs on paths and sizes
 * and skips content hashing entirely.
 *
 * Byte-level containment still degrades gracefully: without a CRC on the
 * staging side it falls back to size agreement, which `verifyStagingAgainstArchive`
 * reports as `size-only` and never as a match.
 *
 * ─── IT NEVER FAILS A BUILD ───────────────────────────────────────────
 * Every per-mod failure is contained. A build must not break because an archive
 * was deleted or a FOMOD script is exotic — the curator gets told what could
 * not be checked, and the build proceeds.
 */

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";

import type { types } from "@nexusmods/vortex-api";

import { resolveModArchivePath } from "../archiveHashing";
import type { AuditorMod } from "../getModsListForProfile";
import { ehLog } from "../logging/ehLog";
import type { SelfCheckReport } from "./selfCheckMod";
import type { UnexplainedFile } from "./unexplainedFiles";
import { selfCheckMod, summarizeSelfChecks } from "./selfCheckMod";
import { resolveSevenZip, sevenZipExtractFull } from "./sevenZip";
import type { SevenZipApi } from "./sevenZip";

export type RunSelfChecksOptions = {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, modName: string) => void;
  /**
   * Mods whose shipped archive IS their staging folder.
   *
   * A bundled mod is repacked from staging by `repackBundledExternals` and
   * re-keyed to the new archive's hash, so its staging and its archive are the
   * same bytes by construction — divergence is not merely unlikely, it is
   * impossible. Comparing one means comparing it against a download that is
   * not what ships for it, and every difference found is a false positive.
   *
   * It cost a real report its credibility: `sse_bodyslides_sd` was listed as
   * bundled AND as one of the three worst diverged mods in the same build,
   * over 144 files that could not have been wrong.
   *
   * Absent means "compare everything" — the honest default for a caller
   * that does not know which mods those are.
   */
  shipsOwnBytes?: (mod: AuditorMod) => boolean;
  /**
   * Mods already answered, and the fingerprint each was answered against.
   *
   * Built by the caller from the collection config — see
   * `decidedPostProcessing`. Absent means "derive what you can from the mods",
   * which is weaker: it cannot see a bundling decision and has no fingerprint
   * to reopen on.
   */
  decided?: ReadonlyMap<string, PostProcessingAnswer>;
};

/**
 * Mods whose staged files DIVERGE from their archive.
 *
 * The mirror image of the omission warnings: those say "you are missing files
 * the archive has", this says "you have files the archive does not" — which is
 * what post-install tooling produces. BA2 repacking, plugin cleaning, a mod
 * writing its own config the first time the game runs.
 *
 * ONE aggregate line, never one per mod. Measured at roughly a ninth of a real
 * 993-mod profile, so per-mod warnings would bury the omission findings under
 * a hundred entries the curator can do nothing about — and being buried is how
 * a real warning gets ignored.
 *
 * Phrased as information rather than fault. These files are usually exactly
 * what the curator intended. What matters is that they are now KNOWN: a user
 * installing this collection cannot check them against the archive, so the
 * installer accepts whatever a clean install produces rather than trying to
 * reproduce the curator's copy — which it would fail at, twice, per mod.
 *
 * Pure, so the policy can be tested without running a build.
 */
/**
 * The mods that will fail on every user's machine, and what to do about it.
 *
 * The only finding in this file that is not advisory. A staged file the
 * archive cannot produce is a file no user can ever have, so it fails
 * verification, gets reinstalled from the same archive, fails identically and
 * the mod is recorded broken — permanently, whatever the user does.
 *
 * Declaring the mod post-processed tells the driver those files are the
 * curator's; bundling it ships them instead. Doing neither ships a collection
 * that cannot verify, which is why this names the mods rather than counting
 * them: the curator has to go and act on each one.
 *
 * Declared mods drop out entirely. That is the point of declaring.
 */
/**
 * One mod the curator has to decide about, with the evidence to decide on.
 *
 * A warning string can only be read. This can be acted on — which matters,
 * because the decision is not "acknowledge this", it is "do your users need
 * these files or not", and those have opposite answers and opposite fixes.
 */
import type {
  DecidedChoice,
  PostProcessingAnswer,
} from "./collectionConfig";

export type PostProcessingCandidate = {
  modId: string;
  modName: string;
  /** How many staged files the archive cannot produce. */
  unexplained: number;
  /**
   * EVERY file this mod stages is one the archive cannot produce, so a user
   * who installs it from that archive receives nothing the curator has.
   *
   * The degenerate corner of curator divergence, and it needs its own name
   * because the ordinary answers are all wrong here. "Declare" settles what
   * VERIFICATION should do — the user is no worse off without these files —
   * and says nothing about whether the mod is worth installing at all. So a
   * curator can answer the question correctly and still ship a mod that makes
   * every user perform an install to obtain nothing.
   *
   * Measured on a real 1,755-mod collection: exactly one mod, staging a
   * single 74-byte placeholder. Its Nexus archive is a FOMOD, so reproducing
   * it meant a dialog the user could not answer — and answering it the way
   * the curator had, by selecting nothing, made Vortex fail with ENOENT
   * because an install that selects nothing creates no folder.
   *
   * Bundling or mirroring would "fix" it by shipping the placeholder, which is
   * why this is surfaced as its own finding: the useful answer is almost
   * always to drop the mod from the collection.
   */
  shipsNothing: boolean;
  /**
   * A few of them, classified, so the answer comes from looking.
   *
   * Not bare paths: a path cannot tell the curator whether declaring means the
   * user goes WITHOUT the file or simply receives the archive's version of it,
   * and those have opposite consequences.
   */
  files: UnexplainedFile[];
  /**
   * Whether this mod CAN be mirrored.
   *
   * Mirroring reconciles against per-file hashes, and a build at `fast`
   * verification records sizes only. Offering the choice then would accept an
   * answer the build cannot honour — the curator would tick it, ship, and the
   * user's folder would be reconciled against nothing.
   */
  canMirror: boolean;
  /**
   * A stable name for the diverged files being asked about.
   *
   * Recorded with the answer so the question can reopen when they change, and
   * stay shut when they do not.
   */
  fingerprint?: string;
  /**
   * This mod was answered before, and its diverged files have changed since.
   *
   * The old answer is not silently reapplied: for "users don't need them"
   * that would withhold a file the curator added afterwards, with nothing to
   * see. So it is asked again, and said to be a re-ask rather than a new one.
   */
  reopened: boolean;
  /**
   * The answer this mod currently carries, if any.
   *
   * Answered mods used to be dropped from this list entirely, which made the
   * screen unreviewable: a curator could see what still needed deciding and
   * nothing about what they had already decided, so a verdict given once was
   * unreachable for ever. They are listed now, with their verdict, and the UI
   * lets it be changed.
   */
  decision?: DecidedChoice;
  /**
   * Whether this mod is still waiting on the curator.
   *
   * `false` for one already answered about these exact files. The build only
   * pauses when something needs an answer — listing a settled mod is for
   * review, not a reason to stop.
   */
  needsAnswer: boolean;
};

/**
 * The mods that still need an answer.
 *
 * Declared mods are gone from this list, which is what makes answering feel
 * like progress rather than an annotation the curator has to keep re-reading.
 */
export function findPostProcessingCandidates(
  reports: readonly SelfCheckReport[],
  /**
   * modId → the fingerprint that mod was answered against.
   *
   * A key with an `undefined` value means "answered, before fingerprints were
   * recorded" and closes the question. A key whose value differs from the
   * report's current fingerprint reopens it.
   */
  decided: ReadonlyMap<string, PostProcessingAnswer>,
  /** Mod ids whose staging was captured with a hash for every file. */
  mirrorable: ReadonlySet<string> = new Set(),
): PostProcessingCandidate[] {
  return (
    reports
      .filter((r) => r.unexplained > 0)
      .map((r) => {
        const settled = isSettled(r, decided);
        const answer = decided.get(r.modId);
        return {
          modId: r.modId,
          modName: r.modName,
          unexplained: r.unexplained,
          // Every staged file unexplained ⇒ nothing of this mod survives a
          // plain install. `stagedCount > 0` because a mod that stages no
          // files at all is a different (and harmless) shape.
          shipsNothing: r.stagedCount > 0 && r.unexplained >= r.stagedCount,
          files: r.unexplainedExamples,
          canMirror: mirrorable.has(r.modId),
          ...(r.unexplainedFingerprint !== undefined
            ? { fingerprint: r.unexplainedFingerprint }
            : {}),
          reopened: !settled && answer !== undefined,
          ...(answer !== undefined ? { decision: answer.choice } : {}),
          needsAnswer: !settled,
        };
      })
      // What still needs a decision comes first; within each group, the mods
      // with most at stake. A settled mod is on the list to be reviewed, not
      // to be waded through on the way to the ones that are not.
      .sort((a, b) => {
        if (a.needsAnswer !== b.needsAnswer) return a.needsAnswer ? -1 : 1;
        return b.unexplained - a.unexplained;
      })
  );
}

/** Answered, and about the same files it was answered about. */
function isSettled(
  report: SelfCheckReport,
  decided: ReadonlyMap<string, PostProcessingAnswer>,
): boolean {
  if (!decided.has(report.modId)) return false;
  const answeredFor = decided.get(report.modId)?.fingerprint;
  // Answered before fingerprints were recorded, or against a report that
  // could not produce one. Honour it rather than nag.
  if (answeredFor === undefined) return true;
  if (report.unexplainedFingerprint === undefined) return true;
  return answeredFor === report.unexplainedFingerprint;
}

export function describeUndeclaredPostProcessing(
  reports: readonly SelfCheckReport[],
  /** Same map as `findPostProcessingCandidates`: any answer closes this. */
  decided: ReadonlyMap<string, PostProcessingAnswer>,
): string | undefined {
  const undeclared = reports
    .filter((r) => r.unexplained > 0 && !isSettled(r, decided))
    .sort((a, b) => b.unexplained - a.unexplained);
  if (undeclared.length === 0) return undefined;

  const names = undeclared
    .slice(0, 3)
    .map((r) => `"${r.modName}" (${r.unexplained})`)
    .join(", ");
  return (
    `${undeclared.length} mod(s) have staged file(s) their archive cannot ` +
    `produce and are NOT declared post-processed — ${names}. A user ` +
    `installing from those archives can never have those files, so each mod ` +
    `will fail its integrity check, be reinstalled once, fail again and be ` +
    `recorded as broken. Set "postProcessed": true on them in the collection ` +
    `config if the edits are deliberate, or mark them Bundled to ship your ` +
    `copy instead.`
  );
}

export function describeDivergedMods(
  reports: readonly SelfCheckReport[],
): string | undefined {
  const diverged = reports
    .filter((r) => r.unexplained > 0)
    .sort((a, b) => b.unexplained - a.unexplained);
  if (diverged.length === 0) return undefined;

  const files = diverged.reduce((n, r) => n + r.unexplained, 0);
  const examples = diverged
    .slice(0, 3)
    .map((r) => `"${r.modName}" (${r.unexplained})`)
    .join(", ");

  return (
    `${diverged.length} mod(s) have ${files} staged file(s) that differ from ` +
    `their archives — most often ${examples}. This is normal if you repack ` +
    `BA2s, clean plugins, or run the game before building: those files are ` +
    `yours, not the archive's. Where a user's own copy of a file matches the ` +
    `archive, Event Horizon accepts it rather than trying to reproduce yours. ` +
    `Files you ADDED are the case to watch: a user's archive cannot ` +
    `produce those at all, so those mods are listed separately with the ` +
    `file names, for you to decide what happens to them.`
  );
}

export type SelfCheckRunResult = {
  reports: SelfCheckReport[];
  summary: ReturnType<typeof summarizeSelfChecks>;
  /** Lines suitable for the build's warning list. Empty when nothing to say. */
  warnings: string[];
  /**
   * Mods whose staging holds files their archive cannot produce, and which the
   * curator has not decided about yet. Rendered as a decision, not a warning.
   */
  postProcessingCandidates: PostProcessingCandidate[];
  /**
   * Mod ids whose staging carries a hash for every file.
   *
   * Returned so a caller that re-derives the candidate list after the curator
   * answers — a build paused mid-flight — reaches the same verdict about
   * which mods can be mirrored, instead of quietly offering the choice to a
   * mod the build cannot honour it for.
   */
  mirrorable: ReadonlySet<string>;
};

/**
 * Extract one entry to a temp dir and read it.
 *
 * 7z writes to disk — there is no in-memory entry read in the node-7z surface
 * Vortex exposes — so the temp dir is created and removed per call. The files
 * involved are FOMOD scripts, a few KB.
 */
function makeReadEntry(sevenZip: SevenZipApi) {
  return async (archivePath: string, entryPath: string): Promise<Buffer | undefined> => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "eh-selfcheck-"));
    try {
      // `raw` carries the entry name as a trailing positional filter, which
      // is how this node-7z cherry-picks. `-y` (suppress the overwrite prompt
      // that would hang a headless extraction) is already on by default.
      await sevenZipExtractFull(sevenZip, archivePath, dir, {
        raw: [entryPath],
      });
      // extractFull preserves paths, so the nested location is the real one;
      // the basename is kept as a fallback for odd archives.
      const candidates = [
        path.join(dir, entryPath.split("/").join(path.sep)),
        path.join(dir, path.basename(entryPath)),
      ];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return await fsp.readFile(candidate);
      }
      return undefined;
    } catch {
      return undefined;
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

export async function runSelfChecks(
  state: types.IState,
  gameId: string,
  mods: AuditorMod[],
  opts?: RunSelfChecksOptions,
): Promise<SelfCheckRunResult> {
  let sevenZip: SevenZipApi;
  try {
    sevenZip = resolveSevenZip();
  } catch (err) {
    // Outside Vortex (tests, smoke runs) there is no SevenZip. Not an error.
    ehLog("warn", "selfcheck.unavailable", { err });
    return {
      reports: [],
      summary: summarizeSelfChecks([]),
      warnings: [],
      postProcessingCandidates: [],
      mirrorable: new Set<string>(),
    };
  }
  const readEntry = makeReadEntry(sevenZip);

  // Split rather than skipped inside the loop: these are not mods we FAILED to
  // check, they are mods the check has no question to ask about, and folding
  // them into `skipped` would report them as archives that could not be read.
  const shipsOwnBytes = opts?.shipsOwnBytes;
  const comparable =
    shipsOwnBytes === undefined ? mods : mods.filter((m) => !shipsOwnBytes(m));
  const ownBytesCount = mods.length - comparable.length;

  const reports: SelfCheckReport[] = [];
  const total = comparable.length;
  let done = 0;

  for (const mod of comparable) {
    if (opts?.signal?.aborted === true) break;
    done += 1;
    opts?.onProgress?.(done, total, mod.name);

    const staged = (mod.stagingFiles ?? []).map((f) => ({ path: f.path, size: f.size }));
    const archivePath = resolveModArchivePath(state, mod, gameId);

    try {
      reports.push(
        await selfCheckMod({
          sevenZip,
          modId: mod.id,
          modName: mod.name,
          archivePath,
          hasArchiveRecord:
            mod.archiveId !== undefined ||
            mod.recoveredDownloadId !== undefined,
          staged,
          recordedChoices: mod.fomodSelections ?? [],
          readEntry,
          ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
        }),
      );
    } catch (err) {
      // selfCheckMod contains its own failures; this is belt and braces so one
      // pathological mod can never take a build down.
      ehLog("warn", "selfcheck.mod-threw", { mod: mod.name, err });
    }
  }

  const summary = summarizeSelfChecks(reports);

  // WHY a mod was not fully checked is the whole diagnostic value when the
  // numbers come back flat. The first real run reported skipped:993 in 112ms
  // and the reasons were sitting unread in each report's notes — a summary
  // that cannot explain itself is not a summary.
  const reasonCounts: Record<string, number> = {};
  for (const report of reports) {
    if (report.depth === "replayed") continue;
    const reason = report.notes[0] ?? "(no reason recorded)";
    reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  }
  const topReasons = Object.entries(reasonCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => `${count}x ${reason}`);

  // One concrete example, so a wrong path or id is visible rather than inferred.
  const firstSkipped = reports.find((r) => r.depth === "skipped");

  const warnings: string[] = [];
  const withMissing = reports.filter((r) => r.missing.length > 0);

  for (const report of withMissing) {
    warnings.push(
      `"${report.modName}" is missing ${report.missing.length} file(s) its FOMOD should have ` +
        `installed (e.g. ${report.missing[0]}). Reinstalling that mod before shipping is ` +
        `advisable — a collection built from it reproduces the gap.`,
    );
  }
  // Leads, phrased as leads. The measured rate is ~2.6% of mods on a real
  // 623-mod profile, so this is a short list to eyeball rather than an alarm —
  // and some entries are always legitimate (debug symbols, tool resources,
  // runtime-generated config).
  const withLeads = reports
    .filter((r) => r.omissionLeads.some((l) => l.confidence === "high"))
    .sort(
      (a, b) =>
        b.omissionLeads.filter((l) => l.confidence === "high").length -
        a.omissionLeads.filter((l) => l.confidence === "high").length,
    );
  for (const report of withLeads.slice(0, 10)) {
    const high = report.omissionLeads.filter((l) => l.confidence === "high");
    warnings.push(
      `"${report.modName}" is missing ${high.length} file(s) that its archive ` +
        `contains and its own folders suggest should be there ` +
        `(e.g. ${high[0]!.path}). ${high[0]!.reason} Worth opening before shipping.`,
    );
  }
  if (withLeads.length > 10) {
    warnings.push(
      `${withLeads.length - 10} further mod(s) have similar gaps; see the ` +
        `event-horizon log for the full list.`,
    );
  }

  const divergedWarning = describeDivergedMods(reports);
  if (divergedWarning !== undefined) warnings.push(divergedWarning);

  // The one finding here that is not advisory.
  //
  // A staged file the archive cannot produce is a file no user can ever have,
  // so every one of them fails verification, is reinstalled from the same
  // archive, fails identically, and is recorded broken. Declaring the mod
  // post-processed is what tells the driver those files are yours; bundling it
  // ships them instead. Doing neither ships a collection that cannot verify.
  /**
   * What the curator has already answered.
   *
   * Supplied by the caller, which holds the collection config. The fallback
   * derives what it can from the overlaid mods so a caller that passes
   * nothing keeps the old behaviour rather than re-asking everything.
   */
  const decided =
    opts?.decided ??
    new Map<string, PostProcessingAnswer>(
      mods
        .filter((m) => m.postProcessed === true || m.mirrored === true)
        .map(
          (m) =>
            [
              m.id,
              { choice: m.mirrored === true ? "mirror" : "declare" },
            ] as const,
        ),
    );
  const undeclaredWarning = describeUndeclaredPostProcessing(reports, decided);
  if (undeclaredWarning !== undefined) warnings.push(undeclaredWarning);
  // A mod can only be mirrored when every one of its staged files carries a
  // hash — i.e. when the build ran `thorough`. Offering the choice otherwise
  // accepts an answer the build cannot honour.
  const mirrorable = new Set(
    mods
      .filter(
        (m) =>
          (m.stagingFiles?.length ?? 0) > 0 &&
          m.stagingFiles!.every((f) => f.sha256 !== undefined),
      )
      .map((m) => m.id),
  );
  const postProcessingCandidates = findPostProcessingCandidates(
    reports,
    decided,
    mirrorable,
  );

  if (summary.skipped > 0) {
    warnings.push(
      `${summary.skipped} mod(s) could not be checked against their archive ` +
        `(archive missing from disk, or unreadable).`,
    );
  }

  if (ownBytesCount > 0) {
    // Said out loud rather than silently omitted: a curator reading a count of
    // checked mods should be able to account for every mod in the collection.
    warnings.push(
      `${ownBytesCount} bundled mod(s) were not compared against an archive — ` +
        `they ship your staging folder itself, so there is nothing for them ` +
        `to differ from.`,
    );
  }

  // NAME the findings in the log, at the moment they are produced.
  //
  // They used to live only in the returned `warnings`, which the build pipeline
  // hands back at the very end — so when a LATER phase threw (a manifest error,
  // say), 48 minutes of checking was discarded along with it and the run
  // reported "3 mods are missing 13 files" without saying which. A finding that
  // does not survive an unrelated failure is not a finding.
  if (withMissing.length > 0 || withLeads.length > 0) {
    ehLog("info", "selfcheck.findings", {
      replayMissing: withMissing.slice(0, 25).map((r) => ({
        mod: r.modName,
        missing: r.missing.length,
        staged: r.stagedCount,
        expected: r.expectedCount,
        files: r.missing.slice(0, 12),
      })),
      omissionLeads: withLeads.slice(0, 25).map((r) => {
        const high = r.omissionLeads.filter((l) => l.confidence === "high");
        return {
          mod: r.modName,
          high: high.length,
          files: high.slice(0, 8).map((l) => l.path),
        };
      }),
    });
  }

  ehLog("info", "selfcheck.done", {
    mods: reports.length,
    replayed: summary.replayed,
    containment: summary.containment,
    skipped: summary.skipped,
    modsWithMissing: summary.modsWithMissing,
    missingFiles: summary.missingFiles,
    modsWithOmissionLeads: summary.modsWithOmissionLeads,
    highConfidenceLeads: summary.highConfidenceLeads,
    reasons: topReasons,
    ...(firstSkipped !== undefined
      ? {
          exampleSkipped: {
            mod: firstSkipped.modName,
            stagedCount: firstSkipped.stagedCount,
            notes: firstSkipped.notes,
          },
        }
      : {}),
  });

  return { reports, summary, warnings, postProcessingCandidates, mirrorable };
}

/**
 * ──────────────────────────────────────────────────────────────────────
 * Mods that will INTERROGATE the user during their install.
 *
 * The archive branches — it carries a FOMOD script — and Vortex kept no record
 * of what the curator answered, so Event Horizon has nothing to replay and the
 * installer must ask. The person answering has never seen the curator's setup,
 * so whatever they pick, the mod they end up with is theirs.
 *
 * ─── WHY THIS IS NOT THE POST-PROCESSING QUESTION ──────────────────────
 * That question is asked about `unexplained > 0` — staged files the archive
 * cannot produce. These two populations barely overlap. A mod can prompt with
 * nothing unexplained at all, and on a real 1,755-mod collection the mod that
 * broke a tester's install was flagged by neither in a way that helped: the
 * curator was asked about its one placeholder file, answered "declare"
 * correctly, and the mod still went on to prompt every user and fail.
 *
 * Deliberately not a build refusal. It is not an error in the collection, it
 * is a fact about what Vortex remembered, and the curator has two good fixes:
 * reinstall the mod so the answers are recorded, or bundle it so no installer
 * runs on the user's machine at all.
 * ──────────────────────────────────────────────────────────────────────
 */
export type PromptingMod = {
  modId: string;
  modName: string;
  /** Staged files, so a curator can see how much of their build is at stake. */
  stagedCount: number;
  /**
   * Every file this mod stages is one the archive cannot produce.
   *
   * Then the prompt is not merely risky, it is unanswerable: no combination of
   * choices reproduces the curator's folder, so the mod has to be bundled or
   * dropped. This is the exact shape that failed on a real install.
   */
  shipsNothing: boolean;
};

export function findModsThatPromptTheUser(
  reports: readonly SelfCheckReport[],
): PromptingMod[] {
  return reports
    .filter((r) => r.promptsUser === true)
    .map((r) => ({
      modId: r.modId,
      modName: r.modName,
      stagedCount: r.stagedCount,
      shipsNothing: r.stagedCount > 0 && r.unexplained >= r.stagedCount,
    }))
    // Unanswerable first: those cannot be fixed by the user being careful.
    .sort((a, b) =>
      a.shipsNothing !== b.shipsNothing
        ? a.shipsNothing
          ? -1
          : 1
        : b.stagedCount - a.stagedCount,
    );
}
