/**
 * ──────────────────────────────────────────────────────────────────────
 * Does this verification failure actually justify a reinstall?
 *
 * `verifyModInstall` compares the user's staging against the CURATOR's
 * staging, and nothing else. That is a two-way comparison between two disks,
 * and it cannot tell apart the two situations it most needs to:
 *
 *   - the user's install went wrong, or
 *   - the CURATOR's staging diverged from its own archive.
 *
 * The second is not rare. Measured on a real 993-mod Fallout 4 profile, about
 * ELEVEN PERCENT of mods had staged files that legitimately differ from the
 * archive they came from — BA2 repacking, plugin cleaning, runtime-generated
 * config. For every one of those, on every user's machine, the driver saw a
 * mismatch, uninstalled, reinstalled from the archive, compared again against
 * the same post-processed reference, failed again, and recorded the mod as
 * broken. Twice the work, for files that were never wrong.
 *
 * The archive is the reference no one's extraction can corrupt, so it is the
 * tie-breaker. A user file that differs from the curator's copy but appears
 * IN THE ARCHIVE is not damaged — it is what a clean install produces, which
 * means reinstalling can only reproduce exactly what is already there.
 *
 * ─── WHAT THIS DELIBERATELY DOES NOT CLAIM ─────────────────────────────
 * "Explained by the archive" is not "correct", and "unexplained" is not
 * "corrupt" — a user may run their own optimiser too. This decides one narrow
 * question: whether spending a reinstall could possibly change the outcome.
 * When it cannot, the answer is no, whatever the cause.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as path from "path";

import { listArchiveNativeFirst } from "../manifest/listArchive";
import { crc32File } from "../manifest/readZip";
import {
  verifyStagingAgainstArchive,
  type StagedFileRef,
} from "../manifest/verifyAgainstArchive";
import { ehLog } from "../logging/ehLog";

import type { ArchiveListing } from "../manifest/archiveContents";

export type ReinstallJudgement =
  /**
   * Reinstalling could genuinely change the result.
   *
   * `archiveConsulted` says whether that verdict came from actually reading
   * the archive. It often does not: missing files are decided before the
   * archive is opened at all. The curator's report states "and they do not
   * match its archive either", and that sentence is only true when this is
   * true — a report claiming a comparison nobody made is worth less than no
   * report.
   */
  | { kind: "reinstall"; why: string; archiveConsulted: boolean }
  /**
   * The user's files are what the archive contains; the curator's copy is the
   * one that moved. A reinstall would reproduce exactly what is on disk.
   */
  | { kind: "curator-diverged"; explained: number; why: string }
  /**
   * The curator declared this mod post-processed, and the files the user lacks
   * are ones the archive cannot produce.
   *
   * Distinct from `curator-diverged`, which is about files that EXIST on both
   * sides with different bytes. This is about files that exist only on the
   * curator's disk — generator output written into a mod folder — where a
   * reinstall is not merely wasted but can never succeed.
   */
  | { kind: "curator-only"; excused: number; why: string }
  /**
   * We could not consult the archive, so we cannot tell. Falls back to
   * reinstalling — the behaviour that existed before this check — rather than
   * pretending an absent second opinion is a clean bill of health.
   */
  /**
   * The differing files all match archive content, but at PATHS the archive
   * could fill more than one way — the shape of a FOMOD variant.
   *
   * `verifyStagingAgainstArchive` matches purely on (size, crc) and never
   * compares paths, so a texture mod offering "2K" and "4K" at the same
   * relative paths produced `matched === refs.length` and was excused as
   * `curator-diverged`: "reinstalling would reproduce what is already on
   * disk". For a variant mismatch that is false — the user is running a
   * DIFFERENT build of the mod than the curator, and was told it verified.
   *
   * Reported rather than reinstalled, deliberately. A reinstall replays the
   * curator's recorded choices, and when those cannot be replayed (NS-8) it
   * would land the same variant again and again without converging. The
   * honest move is to name it and let the user decide.
   */
  | {
      kind: "variant-ambiguous";
      why: string;
      /** Staged paths the archive can fill with more than one content. */
      paths: string[];
    }
  | { kind: "undecidable"; why: string };

/** Last path segment, for a "/"-separated archive or staging path. */
function baseName(p: string): string {
  const cut = p.replace(/\\/g, "/").lastIndexOf("/");
  return cut === -1 ? p : p.slice(cut + 1);
}

export type JudgeInput = {
  /**
   * The curator declared this mod's staging deliberately post-processed.
   *
   * Changes ONE thing: absent files are put to the archive instead of being
   * refused outright. See `ExternalModConfigEntry.postProcessed`.
   */
  postProcessed?: boolean;
  /** Files the curator recorded that the user does not have. */
  missingFiles: string[];
  /** Files present on both sides whose content differs. */
  differingPaths: string[];
  /** Absolute path of the user's staging folder for this mod. */
  stagingRoot: string;
  /** The archive this mod was installed from, when we can find it. */
  archivePath: string | undefined;
  /** Injection point for tests; defaults to Vortex's own SevenZip. */
  sevenZip?: import("../manifest/sevenZip").SevenZipApi;
  signal?: AbortSignal;
};

/**
 * Never throws. A judgement that fails is answered `undecidable`, which
 * reinstalls — the status quo. Turning a verification detail into an install
 * failure would be a worse trade than an unnecessary reinstall.
 */
export async function judgeReinstall(
  input: JudgeInput,
): Promise<ReinstallJudgement> {
  ehLog("info", "judge-reinstall.start", {
    missingCount: input.missingFiles.length,
    differingCount: input.differingPaths.length,
    postProcessed: input.postProcessed === true,
  });

  // Missing files are the one thing the curator's staging is unambiguously
  // the right reference for. Content mutation does not affect PRESENCE, so a
  // file the curator recorded and the user lacks is an omission regardless of
  // any post-processing — and that is the failure this project was built to
  // catch. Never explained away.
  if (input.missingFiles.length > 0 && input.postProcessed !== true) {
    ehLog("info", "judge-reinstall.verdict", {
      kind: "reinstall",
      reason: "missing-files",
      missingCount: input.missingFiles.length,
      examples: input.missingFiles.slice(0, 5),
      archiveConsulted: false,
    });
    return {
      kind: "reinstall",
      why: `${input.missingFiles.length} file(s) the curator recorded are absent`,
      // Decided before the archive is opened — presence is not a content
      // question, so there is nothing here the archive could add.
      archiveConsulted: false,
    };
  }

  // A DECLARED post-processed mod is the one case where the archive has
  // something to say about presence: if it cannot produce a file, no reinstall
  // can either, and the failure is permanent rather than repairable.
  //
  // The declaration does not excuse the whole mod. Files the archive DOES
  // contain must still arrive — that is the bug this project exists to catch,
  // and a curator flagging a mod is not claiming Vortex cannot drop its files.
  // So the flag buys a QUESTION, not an exemption.

  if (input.differingPaths.length === 0 && input.missingFiles.length === 0) {
    ehLog("info", "judge-reinstall.verdict", {
      kind: "reinstall",
      reason: "no-file-detail",
      archiveConsulted: false,
    });
    return {
      kind: "reinstall",
      why: "verification failed with no file detail",
      archiveConsulted: false,
    };
  }

  if (input.archivePath === undefined) {
    ehLog("info", "judge-reinstall.verdict", {
      kind: "undecidable",
      reason: "archive-not-located",
    });
    return {
      kind: "undecidable",
      why: "the archive this mod came from could not be located",
    };
  }

  // ZIP natively first, 7z only as the fallback — see listArchive.ts. This
  // check exists to stop ~11% of a collection being reinstalled for nothing,
  // and routing it solely through 7z meant it went silent on exactly the
  // prefix where 7z does not run.
  const attempt = await listArchiveNativeFirst({
    archivePath: input.archivePath,
    ...(input.sevenZip !== undefined ? { sevenZip: input.sevenZip } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  if (attempt.kind === "unreadable") {
    ehLog("warn", "judge-reinstall.verdict", {
      kind: "undecidable",
      reason: "archive-unreadable",
      why: attempt.why,
    });
    return {
      kind: "undecidable",
      why: `the archive could not be listed: ${attempt.why}`,
    };
  }
  const listing = attempt.listing;

  // An archive whose listing carries no CRCs can only be matched on size,
  // which is weak enough that calling a mod "fine" on its basis would be
  // guessing. Say so instead.
  if (listing.withCrc === 0) {
    ehLog("warn", "judge-reinstall.verdict", {
      kind: "undecidable",
      reason: "no-checksums-in-listing",
      entries: listing.entries.length,
    });
    return {
      kind: "undecidable",
      why: "the archive listing carries no checksums to compare against",
    };
  }

  // Missing files, for a declared post-processed mod. Matched by NAME, not by
  // content: the file is not on disk, so there are no bytes to checksum.
  //
  // Conservative in the only direction that matters. A name the archive does
  // not contain anywhere is provably unreproducible; a name it does contain
  // might be the real omission, so it is sent for reinstall exactly as before.
  // FOMOD installers relocate files, which is why the comparison is on the
  // basename rather than the full path.
  const excusedMissing: string[] = [];
  if (input.missingFiles.length > 0) {
    const archiveNames = new Set(
      listing.entries.map((e) => baseName(e.path).toLowerCase()),
    );
    const reproducible = input.missingFiles.filter((rel) =>
      archiveNames.has(baseName(rel).toLowerCase()),
    );
    if (reproducible.length > 0) {
      ehLog("info", "judge-reinstall.verdict", {
        kind: "reinstall",
        reason: "missing-files-in-archive",
        reproducibleCount: reproducible.length,
        missingCount: input.missingFiles.length,
        examples: reproducible.slice(0, 5),
        archiveConsulted: true,
      });
      return {
        kind: "reinstall",
        why:
          `${reproducible.length} of ${input.missingFiles.length} absent ` +
          `file(s) ARE in the archive, so they should have installed`,
        archiveConsulted: true,
      };
    }
    excusedMissing.push(...input.missingFiles);
  }

  const refs: StagedFileRef[] = [];
  for (const rel of input.differingPaths) {
    if (input.signal?.aborted) {
      return { kind: "undecidable", why: "cancelled" };
    }
    const abs = path.join(input.stagingRoot, ...rel.split("/"));
    try {
      const fsp = await import("fs/promises");
      const stat = await fsp.stat(abs);
      // CRC-32 specifically: it is what a ZIP central directory records, and
      // therefore the only hash that can ask whether these bytes are in that
      // archive. The sha256 verifyModInstall computed cannot answer it.
      const crc = await crc32File(abs, input.signal);
      refs.push({ path: rel, size: stat.size, crc });
    } catch (err) {
      // Unreadable now though it existed a moment ago. Do not explain it away.
      ehLog("warn", "judge-reinstall.verdict", {
        kind: "reinstall",
        reason: "read-back-failed",
        path: rel,
        err,
        archiveConsulted: true,
      });
      return {
        kind: "reinstall",
        why: `"${rel}" could not be read back for comparison`,
        // The archive listing succeeded above; what failed was re-reading the
        // staged file, so the comparison genuinely was attempted.
        archiveConsulted: true,
      };
    }
  }

  const result = verifyStagingAgainstArchive(refs, listing);

  // `size-only` is NOT counted as explained here, unlike in the build-side
  // report. Acting on it means skipping a repair, and sizes agreeing while
  // checksums were available on neither side is too thin a reason to do that.
  if (result.matched === refs.length) {
    if (excusedMissing.length > 0) {
      // Reported as its own verdict rather than folded into the one above:
      // "the curator's copy was modified" and "the curator has files the
      // archive never had" are different facts, and a curator reading the
      // report should be able to tell which one their collection did.
      const also =
        refs.length > 0
          ? `, and its ${refs.length} differing file(s) match the archive`
          : "";
      ehLog("info", "judge-reinstall.verdict", {
        kind: "curator-only",
        excusedCount: excusedMissing.length,
        matchedDiffering: refs.length,
        examples: excusedMissing.slice(0, 5),
      });
      return {
        kind: "curator-only",
        excused: excusedMissing.length,
        why:
          `${excusedMissing.length} absent file(s) are not in the archive at ` +
          `all, and this mod is declared post-processed${also} — no ` +
          `reinstall could produce them`,
      };
    }
    /**
     * Everything matched — but matched WHERE? If the archive holds two
     * different contents under one basename, "the bytes are in the archive"
     * stops meaning "the archive would produce these bytes at this path".
     */
    const ambiguous = ambiguousVariantPaths(refs, listing);
    if (ambiguous.length > 0) {
      ehLog("warn", "judge-reinstall.verdict", {
        kind: "variant-ambiguous",
        explainedCount: result.matched,
        ambiguousPaths: ambiguous.slice(0, 5),
        ambiguousCount: ambiguous.length,
      });
      return {
        kind: "variant-ambiguous",
        paths: ambiguous,
        why:
          `all ${result.matched} differing file(s) exist in the archive, but ` +
          `${ambiguous.length} of them sit at path(s) the archive can fill ` +
          `with more than one version — this looks like a different installer ` +
          `option (a texture size, an optional patch) rather than a damaged ` +
          `install, and reinstalling may simply land the same choice again`,
      };
    }

    ehLog("info", "judge-reinstall.verdict", {
      kind: "curator-diverged",
      explainedCount: result.matched,
    });
    return {
      kind: "curator-diverged",
      explained: result.matched,
      why:
        `all ${result.matched} differing file(s) match the archive exactly — ` +
        `the curator's copy was modified after extraction, so reinstalling ` +
        `would reproduce what is already on disk`,
    };
  }

  ehLog("info", "judge-reinstall.verdict", {
    kind: "reinstall",
    reason: "differs-from-archive",
    unexplainedCount: result.unexplained + result.sizeOnly,
    totalDiffering: refs.length,
    examples: input.differingPaths.slice(0, 5),
  });
  return {
    kind: "reinstall",
    why:
      `${result.unexplained + result.sizeOnly} of ${refs.length} differing ` +
      `file(s) are not accounted for by the archive`,
    // The one verdict that earns the report's "and they do not match its
    // archive either".
    archiveConsulted: true,
  };
}

/**
 * Staged paths the archive could fill with more than one content.
 *
 * ─── WHY BASENAME, AND WHY "MORE THAN ONE CONTENT" ─────────────────────────
 * A FOMOD does not ship its options at the paths they land on. It ships
 * `2K/textures/foo.dds` and `4K/textures/foo.dds` and the installer copies one
 * of them to `textures/foo.dds`. So the staged path never appears in the
 * archive at all, and comparing full paths would find nothing.
 *
 * What IS visible is that the archive holds two entries called `foo.dds` with
 * different (size, crc). That is the signal: whatever produced the user's copy
 * had a choice to make at this name, and the fact that the bytes exist
 * somewhere in the archive no longer proves the archive would produce THESE
 * bytes HERE.
 *
 * Deliberately narrow. Two entries with the SAME content under one name are
 * not ambiguous — a FOMOD that ships identical files in two option folders
 * offers no real choice. Only differing content counts.
 */
export function ambiguousVariantPaths(
  staged: readonly StagedFileRef[],
  listing: ArchiveListing,
): string[] {
  /** basename (lowercased) → the distinct contents the archive holds for it. */
  const contentsByName = new Map<string, Set<string>>();
  for (const entry of listing.entries) {
    if (entry.size === undefined) continue;
    const name = entry.path.split(/[\\/]/).pop()?.toLowerCase();
    if (name === undefined || name.length === 0) continue;
    // A missing crc cannot be shown to DIFFER from anything, so it is keyed by
    // size alone — the conservative direction here is to under-report, not to
    // invent an ambiguity out of an entry we could not read.
    const key = entry.crc !== undefined ? `${entry.size}:${entry.crc}` : `s${entry.size}`;
    const set = contentsByName.get(name);
    if (set === undefined) contentsByName.set(name, new Set([key]));
    else set.add(key);
  }

  const out: string[] = [];
  for (const file of staged) {
    const name = file.path.split(/[\\/]/).pop()?.toLowerCase();
    if (name === undefined) continue;
    if ((contentsByName.get(name)?.size ?? 0) > 1) out.push(file.path);
  }
  return out;
}
