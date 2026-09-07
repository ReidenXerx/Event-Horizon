/**
 * Build-time self-check: does the CURATOR's own staging folder match what the
 * archive and the FOMOD script say it should be?
 *
 * ─── WHAT THIS IS FOR ─────────────────────────────────────────────────
 * Everything downstream treats the curator's capture as the etalon. If Vortex
 * silently lost files during the CURATOR's install, the omission is baked into
 * the collection and every user reproduces it — or gets told their correct
 * install is wrong. The curator has no way to notice.
 *
 * This runs before that capture is trusted, and answers with references the
 * curator's disk cannot contaminate:
 *
 *   archive listing → the true bytes of every candidate file
 *   FOMOD replay    → which of them this install should have produced
 *
 * Found a real one on the profile it was developed against: a folder with six
 * files in the archive, three staged, three missing.
 *
 * ─── IT REPORTS, IT DOES NOT ACCUSE ───────────────────────────────────
 * Every degradation is explicit. Without recorded choices the FOMOD file set
 * cannot be derived, so the check falls back to containment (are the staged
 * BYTES from the archive) and says so. A low-confidence replay is never used to
 * claim a file is missing. Nothing here fails a build: a curator with an
 * unusual setup must not be blocked, only informed.
 */

import type { SevenZipApi } from "./sevenZip";
import type { ArchiveListing } from "./archiveContents";
import { listArchiveContents } from "./archiveContents";
import { findOmissionLeads } from "./omissionLeads";
import type { OmissionLead } from "./omissionLeads";
import { expandFomodPlan } from "./expandFomodPlan";
import type { RecordedStep } from "./fomodReplay";
import { replayFomod } from "./fomodReplay";
import { parseModuleConfig } from "./parseModuleConfig";
import type {
  ArchiveVerificationResult,
  StagedFileRef,
} from "./verifyAgainstArchive";
import { verifyStagingAgainstArchive } from "./verifyAgainstArchive";
import {
  UNEXPLAINED_EXAMPLES,
  classifyUnexplained,
  fingerprintUnexplained,
  type UnexplainedFile,
} from "./unexplainedFiles";

/** How thoroughly a mod could actually be checked. */
export type SelfCheckDepth =
  /** FOMOD replayed: we know exactly which files should exist. */
  | "replayed"
  /** Bytes checked against the archive; the expected SET is unknown. */
  | "containment"
  /** Nothing checked — no archive, unreadable, or no staging captured. */
  | "skipped";

export type SelfCheckReport = {
  modId: string;
  modName: string;
  depth: SelfCheckDepth;
  /** Why the depth is not `replayed`, or why it was skipped entirely. */
  notes: string[];
  /** Files the FOMOD says should exist and the curator does not have. */
  missing: string[];
  /** Staged files whose bytes are not in the archive (post-install tooling). */
  unexplained: number;
  /**
   * A few of those files, by path.
   *
   * The count alone cannot be acted on. A curator deciding whether 1608 files
   * are their own xLODGen output or something that went wrong needs to SEE
   * some of them, and asking them to go and look in the staging folder is how
   * a decision gets made by guessing instead.
   *
   * Capped: this is evidence for a human, not a manifest.
   */
  unexplainedExamples: UnexplainedFile[];
  /**
   * A stable name for the whole diverged set, not just the examples above.
   *
   * What a curator's answer is recorded against, so the question can reopen
   * when these files change and stay quiet when they do not.
   */
  unexplainedFingerprint?: string;
  /**
   * Archive files with no staged counterpart that the archive's own shape does
   * not explain — the omission signal for mods with no FOMOD script to replay.
   * Leads for a human to check, never a verdict. Empty when the archive
   * declares alternatives, because absence proves nothing there.
   */
  omissionLeads: OmissionLead[];
  stagedCount: number;
  expectedCount: number;
  /**
   * The archive carries a FOMOD script and Vortex recorded no answers for it.
   *
   * That combination is what a USER experiences as a dialog they cannot answer
   * correctly: there is nothing to replay, so Event Horizon must let the
   * installer ask, and the person answering has never seen the curator's
   * setup. Whatever they pick, the mod is theirs rather than the curator's,
   * and every file check downstream then passes on the wrong file set.
   *
   * It is not a defect in the mod or in the curator's profile — Vortex simply
   * does not always keep `installerChoices`, and a mod re-created as a variant
   * can lose them. It IS something the curator can fix before shipping, by
   * reinstalling the mod so the answers are recorded, or by bundling it.
   *
   * Separate from `unexplained` because the two do not overlap: a mod can
   * prompt with nothing unexplained at all, which is exactly the case the
   * post-processing question never asks about.
   */
  promptsUser?: boolean;
};

export type SelfCheckInput = {
  sevenZip: SevenZipApi;
  modId: string;
  modName: string;
  /** Absolute path to the mod's source archive, when one is resolvable. */
  archivePath: string | undefined;
  /**
   * Whether Vortex has an `archiveId` on the mod at all.
   *
   * Distinguishes two different problems that used to report the same
   * sentence. No archiveId means Vortex never tracked a source for this mod,
   * and no amount of re-downloading changes that. An archiveId that does not
   * resolve to a path means the DOWNLOAD RECORD is gone, which is a different
   * repair. Measured on a real profile: 5 of the former, 10 of the latter, and
   * 225 genuinely-missing files — three fixes, one message.
   */
  hasArchiveRecord?: boolean;
  /** The curator's staging folder contents. */
  staged: StagedFileRef[];
  /** Vortex's recorded FOMOD choices; empty when the install had no branching. */
  recordedChoices: RecordedStep[];
  /**
   * Extract one entry to a temp dir and return its bytes. Injected so this
   * module stays testable without a real archive or filesystem.
   */
  readEntry: (archivePath: string, entryPath: string) => Promise<Buffer | undefined>;
  signal?: AbortSignal;
};

/** Where a FOMOD script lives. Case varies in the wild (`fomod`, `FOMod`). */
const MODULE_CONFIG_CANDIDATES = ["fomod/ModuleConfig.xml", "FOMod/ModuleConfig.xml"];

function findModuleConfigEntry(listing: ArchiveListing): string | undefined {
  const wanted = MODULE_CONFIG_CANDIDATES.map((c) => c.toLowerCase());
  const hit = listing.entries.find((e) => {
    const p = e.path.toLowerCase();
    return wanted.includes(p) || p.endsWith("/moduleconfig.xml");
  });
  return hit?.path;
}

/**
 * Check one mod. Never throws for a per-mod problem: an unreadable archive or
 * an unparseable script downgrades the depth and records a note, the same way
 * `enrichModsWithArchiveHashes` treats a failed hash as "no hash" rather than
 * aborting the batch.
 */
/**
 * The count and the evidence together, so a caller cannot record one without
 * the other. Eight return paths set this; a bare number at any of them would
 * be a mod the decision UI could show no reason for.
 */
function unexplainedFacts(
  containment: ArchiveVerificationResult,
  listing: ArchiveListing,
): {
  unexplained: number;
  unexplainedExamples: UnexplainedFile[];
  unexplainedFingerprint?: string;
} {
  // The WHOLE set, before the cap. The examples are evidence for a human;
  // the fingerprint has to cover every file the answer is about, or a change
  // past the cap would keep a stale decision alive.
  const all = containment.verdicts
    .filter((v) => v.kind === "unexplained")
    .map((v) => v.file);
  return {
    unexplained: containment.unexplained,
    // Classified against the archive rather than reported as bare paths: a
    // path alone cannot tell the curator whether declaring it means the user
    // goes WITHOUT the file or merely gets the archive's version of it.
    unexplainedExamples: classifyUnexplained(
      all.slice(0, UNEXPLAINED_EXAMPLES),
      listing,
    ),
    ...(all.length > 0
      ? { unexplainedFingerprint: fingerprintUnexplained(all) }
      : {}),
  };
}

export async function selfCheckMod(input: SelfCheckInput): Promise<SelfCheckReport> {
  const notes: string[] = [];
  const base = {
    modId: input.modId,
    modName: input.modName,
    missing: [] as string[],
    unexplained: 0,
    unexplainedExamples: [] as UnexplainedFile[],
    omissionLeads: [] as OmissionLead[],
    stagedCount: input.staged.length,
    expectedCount: 0,
  };

  if (input.archivePath === undefined) {
    return {
      ...base,
      depth: "skipped",
      notes: [
        input.hasArchiveRecord === false
          ? "Mod has no source archive recorded in Vortex — it was installed " +
            "from something Vortex no longer tracks. Re-downloading will not " +
            "help; re-install it from an archive so the cache picks it up."
          : "Vortex has no download record for this mod's archive, so it " +
            "cannot be verified. Usually the archive is gone and needs " +
            "re-downloading; occasionally the file is still there and only the " +
            "record was lost, which a Downloads-tab rescan fixes.",
      ],
    };
  }
  if (input.staged.length === 0) {
    return { ...base, depth: "skipped", notes: ["No staging files captured."] };
  }

  let listing: ArchiveListing;
  try {
    listing = await listArchiveContents(input.sevenZip, input.archivePath, {
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
  } catch (err) {
    return {
      ...base,
      depth: "skipped",
      notes: [`Could not list archive: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  // Containment first — it works for every mod and needs nothing but the
  // archive, so a failure further down still leaves a usable answer.
  const containment = verifyStagingAgainstArchive(input.staged, listing);

  // Containment answers "did these bytes come from the archive?"; this answers
  // the opposite question, "is anything from the archive missing?", and needs a
  // different matcher — see omissionLeads.ts. Returns nothing for archives with
  // a FOMOD script, which the replay below handles authoritatively instead.
  const omission = findOmissionLeads(listing, input.staged.map((f) => f.path));
  const withLeads = { ...base, omissionLeads: omission.leads };

  const configEntry = findModuleConfigEntry(listing);
  if (configEntry === undefined) {
    notes.push("No FOMOD script in archive; expected file set unknown.");
    return { ...withLeads, depth: "containment", notes, ...unexplainedFacts(containment, listing) };
  }
  if (input.recordedChoices.length === 0) {
    // Vortex records nothing when an install had no branching. The script's
    // unconditional files could still be derived, but a wrong "missing" claim
    // is worse than no claim, so this stays containment-only for now.
    //
    // It is also the moment we learn this mod will INTERROGATE the user: the
    // archive branches and we have no answers to give the installer. See
    // `promptsUser`.
    notes.push("No recorded FOMOD choices; cannot derive the expected file set.");
    return {
      ...withLeads,
      depth: "containment",
      notes,
      promptsUser: true,
      ...unexplainedFacts(containment, listing),
    };
  }

  let raw: Buffer | undefined;
  try {
    raw = await input.readEntry(input.archivePath, configEntry);
  } catch (err) {
    notes.push(`Could not read ${configEntry}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (raw === undefined) {
    return { ...withLeads, depth: "containment", notes, ...unexplainedFacts(containment, listing) };
  }

  let expected;
  try {
    const parsed = await parseModuleConfig(raw);
    notes.push(...parsed.warnings);
    const replay = replayFomod(parsed.script, input.recordedChoices);
    notes.push(...replay.warnings);
    if (replay.confidence === "low") {
      // A replay we do not fully understand must never accuse a folder of
      // missing files.
      notes.push("Replay confidence low; not reporting missing files.");
      return { ...withLeads, depth: "containment", notes, ...unexplainedFacts(containment, listing) };
    }
    expected = expandFomodPlan(replay.sources, listing);
    if (expected.unmatchedSpecs.length > 0) {
      notes.push(
        `${expected.unmatchedSpecs.length} FOMOD spec(s) matched nothing in the archive; ` +
          `not reporting missing files.`,
      );
      return { ...withLeads, depth: "containment", notes, ...unexplainedFacts(containment, listing) };
    }
  } catch (err) {
    notes.push(`FOMOD replay failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ...withLeads, depth: "containment", notes, ...unexplainedFacts(containment, listing) };
  }

  const stagedPaths = new Set(input.staged.map((f) => f.path.toLowerCase()));
  const missing = expected.files
    .filter((f) => !stagedPaths.has(f.path.toLowerCase()))
    .map((f) => f.path);

  return {
    ...withLeads,
    depth: "replayed",
    notes,
    missing,
    ...unexplainedFacts(containment, listing),
    expectedCount: expected.files.length,
  };
}

/** Aggregate for logging and for the build summary. */
export function summarizeSelfChecks(reports: SelfCheckReport[]): {
  replayed: number;
  containment: number;
  skipped: number;
  modsWithMissing: number;
  missingFiles: number;
  modsWithOmissionLeads: number;
  highConfidenceLeads: number;
} {
  let replayed = 0;
  let containment = 0;
  let skipped = 0;
  let modsWithMissing = 0;
  let missingFiles = 0;
  let modsWithOmissionLeads = 0;
  let highConfidenceLeads = 0;
  for (const r of reports) {
    if (r.depth === "replayed") replayed += 1;
    else if (r.depth === "containment") containment += 1;
    else skipped += 1;
    if (r.missing.length > 0) {
      modsWithMissing += 1;
      missingFiles += r.missing.length;
    }
    const high = r.omissionLeads.filter((l) => l.confidence === "high").length;
    if (high > 0) {
      modsWithOmissionLeads += 1;
      highConfidenceLeads += high;
    }
  }
  return {
    replayed,
    containment,
    skipped,
    modsWithMissing,
    missingFiles,
    modsWithOmissionLeads,
    highConfidenceLeads,
  };
}
