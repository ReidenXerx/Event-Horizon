/**
 * ──────────────────────────────────────────────────────────────────────
 * "Your staging did not change — your copy of the archive did not keep up."
 *
 * For an external mod, Event Horizon treats the archive in Vortex's download
 * folder as the thing players will get. It is not: the LINK is. The local
 * copy is a proxy, and it goes stale in a way nothing notices — the curator
 * regenerates a mod, uploads the new archive to their host, updates the link,
 * and never replaces the copy on their own machine.
 *
 * What that produced, on a real build: `bodyslides_f4_sd` compared its
 * September staging against a JULY archive and reported 1,176 files the
 * archive "cannot produce". Every word of that was true about the file on
 * disk and none of it was true about the file players download. The curator
 * was then offered mirror / bundle / declare — three answers to a question
 * that should never have been asked.
 *
 * And answering any of them would have been worse than the wasted payload,
 * because the manifest records the LOCAL archive's SHA-256 as the hash a
 * player's pick is checked against. Build on a stale copy and every player
 * who downloads the CORRECT file is told they have the wrong one.
 *
 * ─── THE SIGNAL, AND WHY IT IS THIS ONE ────────────────────────────────
 * Timestamps, because they are already on disk and cost one `stat`. A
 * regeneration rewrites staged files; it cannot rewrite the archive that was
 * built before it. So staged files NEWER than the archive, on exactly the
 * files that disagree with it, is the shape of "this archive predates this
 * staging" — measured on the real case as July 13 against September 18.
 *
 * It is a HINT and it is named one. A curator who edits one file by hand also
 * makes it newer than the archive, and that is a genuine divergence with a
 * genuine decision behind it. So this never refuses and never decides; it
 * adds one sentence naming the cheapest thing to try first, which the
 * decision screen cannot otherwise tell them.
 * ──────────────────────────────────────────────────────────────────────
 */

/** One diverging file, with the time it was last written. */
export type StagedFileTime = {
  path: string;
  mtimeMs: number;
};

export type StaleArchiveHint = {
  archiveMtimeMs: number;
  newestStagedMtimeMs: number;
  /** Diverging files written after the archive was. */
  newerCount: number;
  /** How many were looked at — the rest are not claimed about. */
  sampled: number;
  /** Total diverging files, so the sample can be read honestly. */
  diverging: number;
};

/**
 * A minute, to absorb filesystem timestamp granularity and a clock that moved
 * slightly between writing an archive and extracting from it. The real case
 * is two months apart, so nothing here needs to be sensitive.
 */
const SLACK_MS = 60_000;

/**
 * Do the diverging files look like they were written after the archive?
 *
 * `undefined` when there is nothing to say — no files, no archive, or the
 * archive is the newer one, which is the ordinary case and must stay silent.
 */
export function detectStaleArchive(input: {
  archiveMtimeMs: number;
  /** The files that disagree with the archive, with their mtimes. */
  diverging: readonly StagedFileTime[];
  /** How many diverge in total, when `diverging` is a sample of them. */
  divergingTotal?: number;
}): StaleArchiveHint | undefined {
  if (input.diverging.length === 0) return undefined;
  const newer = input.diverging.filter(
    (f) => f.mtimeMs > input.archiveMtimeMs + SLACK_MS,
  );
  if (newer.length === 0) return undefined;
  /**
   * EVERY sampled file, not merely most.
   *
   * A regeneration rewrites the whole output in one run, so a stale archive
   * shows up as all of them. A mix is a curator who edited some files by
   * hand, which is a real divergence with a real decision behind it — and
   * telling them to re-download would send them to replace an archive that
   * was never the problem.
   */
  if (newer.length !== input.diverging.length) return undefined;
  return {
    archiveMtimeMs: input.archiveMtimeMs,
    newestStagedMtimeMs: Math.max(...input.diverging.map((f) => f.mtimeMs)),
    newerCount: newer.length,
    sampled: input.diverging.length,
    diverging: input.divergingTotal ?? input.diverging.length,
  };
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * What to put in front of the curator, in the order they need it: what was
 * measured, what it probably means, and the cheapest thing to try.
 *
 * `url` is named when there is one, because "re-download it" is not actionable
 * without saying from where — and for a mod the curator must fetch by hand
 * there is no link to give, so the sentence says to replace the file instead.
 */
export function describeStaleArchive(
  modName: string,
  hint: StaleArchiveHint,
  url?: string,
): string {
  const where =
    url !== undefined && url.length > 0
      ? `Re-download it from ${url} and drop it into Vortex's download folder over the old file`
      : `Replace the copy in Vortex's download folder with the one you published`;
  const sample =
    hint.sampled < hint.diverging
      ? ` (checked ${hint.sampled} of them)`
      : "";
  return (
    `"${modName}": your copy of this archive is dated ${day(hint.archiveMtimeMs)} ` +
    `and every one of the ${hint.diverging} differing file(s) was written on or ` +
    `after ${day(hint.newestStagedMtimeMs)}${sample}. That is what it looks like ` +
    `when a mod was regenerated and re-uploaded but the copy on THIS machine was ` +
    `never replaced — in which case the archive players download already matches ` +
    `your staging and there is nothing to decide. ${where}, then build again. ` +
    `If the difference is real, the answers below still apply. Worth checking ` +
    `first because the build records THIS file's checksum as the one a player's ` +
    `download is held to: ship a stale one and everybody who fetches the right ` +
    `file is told it is wrong.`
  );
}
