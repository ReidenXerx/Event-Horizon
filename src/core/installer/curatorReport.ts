/**
 * ──────────────────────────────────────────────────────────────────────
 * The report a user sends the curator when a mod cannot be made to match.
 *
 * This is the last rung of the escalation ladder, and it only exists because
 * the rungs beneath it removed the noise. A mod reaches here having:
 *
 *   - failed verification against the curator's staging,
 *   - been checked against its ARCHIVE and found to match neither reference,
 *   - and survived a reinstall.
 *
 * That last point is what makes the report worth a curator's attention. The
 * ~11% of mods whose curator-side staging was merely post-processed never get
 * here — they are settled earlier, by judgeReinstall — so a report that does
 * arrive is a genuine anomaly rather than one of a hundred false alarms.
 *
 * ─── WHAT IT MUST NOT DO ───────────────────────────────────────────────
 * Accuse. "Your mod is broken" is a conclusion the evidence does not support:
 * the archive may have been re-uploaded under the same file id, the user may
 * run their own tooling, a mod may write its own files at runtime. The report
 * states what was expected, what was found, and what was tried, and leaves the
 * conclusion to the person who can actually check.
 *
 * Written to be PASTED — into a Discord message, a Nexus comment, a GitHub
 * issue. That rules out anything a chat client will mangle and anything the
 * sender would have to redact: no absolute paths (they carry the user's real
 * name often enough), no machine identifiers.
 * ──────────────────────────────────────────────────────────────────────
 */

export type CuratorReportInput = {
  /** Collection identity, so the curator knows WHICH build to look at. */
  packageName: string;
  packageVersion: string;
  /** The package's own sha256 — proves which artefact the user actually has. */
  packageSha256?: string;

  modName: string;
  /** `compareKey` from the manifest: "nexus:1234:567890", "external:<sha>". */
  modCompareKey: string;
  modVersion?: string;

  /** Files the curator recorded and the user does not have. */
  missingFiles: string[];
  /** Files present on both sides whose bytes differ. */
  differingFiles: string[];
  /** Files the user has that the curator never recorded. */
  extraFiles: string[];

  /** What the ladder tried, in order, before giving up. */
  attempts: string[];
  /** Why the archive could not settle it, when it could not. */
  archiveNote?: string;
  /**
   * Whether the mod's own archive was actually read.
   *
   * The report used to state "and they do not match its archive either"
   * unconditionally, which is a claim about a check that does not always
   * happen — the archive can be gone, unreadable, or on a machine where 7z
   * will not run. Asserting it anyway sends a curator to investigate a
   * comparison nobody made, in a document whose whole worth is that a stranger
   * can trust it.
   *
   * Defaults to false: an omitted flag must not be able to manufacture the
   * stronger claim.
   */
  archiveChecked?: boolean;
  /**
   * The user supplied this archive BY HAND and it is not the one the
   * collection was built from — with both hashes, because they are the whole
   * answer.
   *
   * ─── WHY THIS OVERRIDES EVERYTHING BELOW ────────────────────────────────
   * A tester's report named 11 differing and 248 extra files and closed with
   * "worth checking whether this mod still downloads the same archive it did
   * when the collection was built" — sending the curator to hunt a Nexus
   * re-upload. The install had already ANSWERED that: the file the tester
   * browsed to hashed to `76390867…` where the collection recorded
   * `51552edf…`, and the run logged both and warned him at the time.
   *
   * A report that asks a question the same run already answered wastes the
   * only person who can act on it. When this is set, that is the finding, and
   * the file lists below are its consequence rather than a mystery.
   */
  suppliedArchiveDiffers?: { expected: string; actual: string };

  /** Host description — "win32 (Wine/Proton)" is load-bearing information. */
  platform?: string;
};

/** How many example paths to show per category before summarising. */
const MAX_EXAMPLES = 8;

const list = (paths: string[]): string[] => {
  const shown = paths.slice(0, MAX_EXAMPLES).map((p) => `  - ${p}`);
  if (paths.length > MAX_EXAMPLES) {
    shown.push(`  - ...and ${paths.length - MAX_EXAMPLES} more`);
  }
  return shown;
};

/**
 * Build the pasteable report.
 *
 * Plain text, no markdown fences: a fenced block pasted into a Nexus comment
 * box arrives as literal backticks, and the one thing this must survive is
 * being pasted somewhere unknown.
 */
export function buildCuratorReport(input: CuratorReportInput): string {
  const lines: string[] = [];

  lines.push(`Event Horizon — mod could not be reproduced`);
  lines.push(``);
  lines.push(
    `Collection: ${input.packageName} v${input.packageVersion}`,
  );
  if (input.packageSha256 !== undefined) {
    // Proves WHICH build this is. A curator with two packages in circulation
    // otherwise has to guess, and the answer changes what the report means.
    lines.push(`Package sha256: ${input.packageSha256}`);
  }
  lines.push(`Mod: ${input.modName}${input.modVersion ? ` (${input.modVersion})` : ""}`);
  lines.push(`Mod id: ${input.modCompareKey}`);
  if (input.platform !== undefined) {
    lines.push(`Installed on: ${input.platform}`);
  }
  lines.push(``);

  lines.push(`What happened`);
  lines.push(
    input.archiveChecked === true
      ? `After installing, this mod's files did not match what the collection ` +
          `recorded, and they do not match its archive either.`
      : // The weaker sentence, because it is the one we can stand behind. The
        // archive line under "What was already tried" says why it could not be
        // read; claiming the comparison happened would make this report worth
        // less than nothing to the person acting on it.
        `After installing, this mod's files did not match what the collection ` +
          `recorded. It was not possible to compare them against the mod's own ` +
          `archive on this machine (see below), so that check is missing rather ` +
          `than failed.`,
  );
  lines.push(``);

  if (input.missingFiles.length > 0) {
    lines.push(`Missing (${input.missingFiles.length}) — recorded, not installed:`);
    lines.push(...list(input.missingFiles));
    lines.push(``);
  }
  if (input.differingFiles.length > 0) {
    lines.push(
      `Different (${input.differingFiles.length}) — installed, but not the recorded bytes:`,
    );
    lines.push(...list(input.differingFiles));
    lines.push(``);
  }
  if (input.extraFiles.length > 0) {
    // Informational, and said so: different FOMOD answers produce these
    // legitimately, and a curator reading a bare list will think otherwise.
    lines.push(
      `Extra (${input.extraFiles.length}) — present here, not in the collection. ` +
        `Often harmless (different installer options):`,
    );
    lines.push(...list(input.extraFiles));
    lines.push(``);
  }

  lines.push(`What was already tried`);
  for (const attempt of input.attempts) lines.push(`  - ${attempt}`);
  if (input.archiveNote !== undefined) lines.push(`  - ${input.archiveNote}`);
  lines.push(``);

  lines.push(`What this does and does not mean`);
  if (input.suppliedArchiveDiffers !== undefined) {
    /**
     * The cause is known, so the report states it instead of speculating.
     * Nothing below it about re-uploads or a machine altering files applies:
     * a different archive explains every differing and extra file at once.
     */
    lines.push(
      `This one is explained. The archive supplied for this mod on that ` +
        `machine is NOT the one the collection was built from:`,
    );
    lines.push(`  collection built from: ${input.suppliedArchiveDiffers.expected}`);
    lines.push(`  file supplied here:    ${input.suppliedArchiveDiffers.actual}`);
    lines.push(
      `Different bytes install different files, so the lists above are the ` +
        `consequence of that and not a separate fault. The person installing ` +
        `was warned at the time and chose to continue, which is allowed — a ` +
        `mirror or a repack is sometimes the only file still available.`,
    );
    lines.push(``);
    lines.push(
      `Worth checking: whether the original file is still downloadable at ` +
        `all. If it is not, bundling or mirroring this mod is what makes the ` +
        `collection reproducible for everyone else.`,
    );
  } else {
    lines.push(
      `It does NOT prove the mod is broken. The archive may have been ` +
        `re-uploaded under the same file id since the collection was built, or ` +
        `something on this machine may be altering the files.`,
    );
    lines.push(
      `It DOES mean a clean install here cannot reproduce what the collection ` +
        `recorded, so anyone else installing it will most likely see the same.`,
    );
    lines.push(``);
    lines.push(
      `Worth checking: whether this mod still downloads the same archive it did ` +
        `when the collection was built.`,
    );
  }

  return lines.join("\n");
}
