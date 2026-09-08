/**
 * ──────────────────────────────────────────────────────────────────────
 * What THIS tool put on the disk, written as it happens.
 *
 * Event Horizon knew, at every moment of an install, exactly which mods it had
 * just created — and threw that away. Provenance came only from the RECEIPT,
 * and the receipt is written on success. So the instant a run was interrupted,
 * a mod we had installed twenty minutes earlier became indistinguishable from
 * a stranger's mod that happened to look similar.
 *
 * Three separate fixes then reconstructed that lost fact from three different
 * proxies, and each proxy was wrong in its own way:
 *
 *   - Nexus ids alone. Widened "already installed" from the mods we installed
 *     to every mod whose Vortex attributes CLAIM those ids — attributes an
 *     importer or a hand edit can set.
 *   - A mod's display name surviving a round trip through a temp filename.
 *     A colon in the name is enough to break it.
 *   - "the decision arm ends in already-installed". Population statistics
 *     standing in for evidence, and the one that let a repair UNINSTALL a mod
 *     the user brought themselves.
 *
 * A journal answers it directly. One line per mod as it lands, deleted when
 * the receipt supersedes it. It is deliberately NOT a receipt: it asserts
 * nothing about whether the collection is installed, only "this run created
 * this Vortex mod id from this source".
 *
 * ─── WHAT IT MAY AND MAY NOT BE USED FOR ───────────────────────────────
 * MAY: "did we install this?" — provenance. That is a fact about our own past
 * actions, and re-deriving it from disk is what made it fragile.
 *
 * MAY NOT: "are these the curator's bytes?" — identity. That stays with
 * verification against the manifest, because a journal entry records what we
 * INTENDED to install, and the whole purpose of this project is that Vortex
 * sometimes does not deliver what was intended.
 *
 * Every entry is confirmed against live Vortex state before it is trusted: a
 * mod the user has since deleted must not be reported as ours.
 *
 * ─── DURABILITY ────────────────────────────────────────────────────────
 * Append-only JSONL, no fsync, failures swallowed. A lost tail means a resume
 * redoes a few mods, which is the safe direction; making an install fail
 * because a log line could not be written is not.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fsp from "fs/promises";
import * as path from "path";

import { ehLog } from "../logging/ehLog";

/**
 * How this mod came to satisfy the collection. The distinction is the whole
 * safety property of the journal, so it is not a label:
 *
 *   "installed" — WE created this Vortex mod. It is ours to uninstall and
 *                 reinstall if it fails verification.
 *   "adopted"   — the user already had it and its bytes matched the curator's,
 *                 so we used theirs instead of installing a second copy.
 *                 Worth remembering (a resume can skip it without re-hashing,
 *                 and the resolver can prefer it over an unrelated namesake)
 *                 and NOT ours to destroy.
 *
 * A byte-identical mod today can be an edited mod next month. Recording an
 * adoption as though we installed it would quietly convert "the user's mod
 * that happens to match" into "our mod we may delete", and their edit would
 * be reverted by a repair they never asked for.
 */
export type JournalEntryKind = "installed" | "adopted";

/** One mod, as this tool created or adopted it. */
export type JournalEntry = {
  /** Stable manifest identity, so a re-plan can find this again. */
  compareKey: string;
  /** The Vortex mod id. Confirmed against live state on read. */
  vortexModId: string;
  /** See {@link JournalEntryKind}. Only "installed" grants repair rights. */
  kind: JournalEntryKind;
  /** Which decision arm produced it — for diagnosis, never for matching. */
  decision: string;
  /** ISO-8601 UTC. */
  at: string;
};

/**
 * Journals live beside the receipts and the attempts, one file per collection.
 * A `.jsonl` because it is appended to during a run that may be killed at any
 * moment — a rewritten JSON array would lose everything on a kill mid-write.
 */
export function getJournalDir(appDataPath: string): string {
  return path.join(appDataPath, "event-horizon", "install-ledger", "journals");
}

function journalPath(appDataPath: string, packageId: string): string {
  return path.join(getJournalDir(appDataPath), `${packageId}.jsonl`);
}

/**
 * Record one mod this run installed. Never throws, never blocks the install.
 *
 * Called for mods we CREATED, not for ones we recognised: re-recording a mod
 * we merely matched would launder a guess into evidence on the next run.
 */
export async function appendJournalEntry(
  appDataPath: string,
  packageId: string,
  entry: JournalEntry,
): Promise<void> {
  try {
    await fsp.mkdir(getJournalDir(appDataPath), { recursive: true });
    await fsp.appendFile(
      journalPath(appDataPath, packageId),
      `${JSON.stringify(entry)}\n`,
      "utf8",
    );
  } catch (err) {
    /**
     * The WRITE is best-effort; the REPORT of it failing is not.
     *
     * A journal line that never lands means the next run cannot tell this mod
     * apart from one the user installed themselves, and NS-2 then correctly
     * refuses to touch it — so a mod Event Horizon created gets treated as
     * off-limits forever. That is a silent, permanent loss of a repair right,
     * and it must not be diagnosed by inference.
     */
    ehLog("error", "journal.append.failed", {
      packageId,
      compareKey: entry.compareKey,
      vortexModId: entry.vortexModId,
      kind: entry.kind,
      consequence:
        "this mod will not be recognised as ours on the next run and will " +
        "not be repairable",
      err,
    });
  }
}

/**
 * Everything this tool recorded installing for `packageId`, newest last.
 *
 * A malformed line is skipped rather than failing the read: the last line of a
 * journal is routinely a half-written record from the run that was killed, and
 * that is precisely the run whose earlier lines we most want.
 */
export async function readJournal(
  appDataPath: string,
  packageId: string,
): Promise<JournalEntry[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(journalPath(appDataPath, packageId), "utf8");
  } catch {
    // No journal is the normal case: a first install, or one that finished.
    return [];
  }

  const out: JournalEntry[] = [];
  let unreadableLines = 0;
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as Partial<JournalEntry>;
      if (
        typeof parsed.compareKey !== "string" ||
        typeof parsed.vortexModId !== "string"
      ) {
        unreadableLines += 1;
        continue;
      }
      out.push({
        compareKey: parsed.compareKey,
        vortexModId: parsed.vortexModId,
        // Anything that is not explicitly "installed" is treated as adopted —
        // the reading that withholds deletion rights. A record whose kind we
        // cannot read is exactly the one not to act destructively on.
        kind: parsed.kind === "installed" ? "installed" : "adopted",
        decision: typeof parsed.decision === "string" ? parsed.decision : "",
        at: typeof parsed.at === "string" ? parsed.at : "",
      });
    } catch {
      // A truncated tail line. Everything before it still counts.
      unreadableLines += 1;
    }
  }
  if (unreadableLines > 0) {
    /**
     * One unreadable line is the expected shape of a killed run: the last
     * record was half-written. SEVERAL means the file is damaged, and every
     * damaged line is a mod we installed that we can no longer prove we
     * installed. The count is what separates those two readings, so it is
     * logged once rather than per line.
     */
    ehLog(unreadableLines > 1 ? "warn" : "info", "journal.read.unreadable-lines", {
      packageId,
      unreadableLines,
      usable: out.length,
      consequence:
        unreadableLines > 1
          ? "those mods cannot be proven ours and will not be repaired"
          : "expected after an interrupted run - the final record was truncated",
    });
  }
  return out;
}

/**
 * Forget the journal for a collection. Never throws.
 *
 * Called after a SUCCESSFUL install, where the receipt takes over as the
 * record of what is installed. Keeping both would leave two answers to one
 * question, and the stale one would win whenever it was longer.
 */
export async function clearJournal(
  appDataPath: string,
  packageId: string,
): Promise<void> {
  try {
    await fsp.unlink(journalPath(appDataPath, packageId));
  } catch {
    // Absent is the normal case.
  }
}

/**
 * The Vortex mod ids this tool installed for `packageId` that STILL EXIST.
 *
 * The existence check is the point. A journal entry is a record of something
 * we did, not a promise the mod is still there — the user may have deleted it
 * in Vortex since. Reporting a deleted mod as ours would let the repair path
 * uninstall whatever now holds that id.
 *
 * `liveModIds` comes from Vortex's own state, so this stays a pure function
 * and is testable without a Vortex.
 */
export function ownedModIds(
  journal: readonly JournalEntry[],
  liveModIds: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  for (const entry of journal) {
    // ADOPTED mods are excluded on purpose: we remember them, we prefer them,
    // we never destroy them.
    if (entry.kind !== "installed") continue;
    if (liveModIds.has(entry.vortexModId)) out.add(entry.vortexModId);
  }
  return out;
}

/**
 * Every mod id this collection's runs have recorded, installed OR adopted,
 * that still exists.
 *
 * Used to disambiguate, never to authorise. When the user has two copies of a
 * mod with the same Nexus ids — theirs and the one we installed alongside it —
 * `Array.find` in the resolver picks whichever Vortex happens to list first.
 * Without this, a resume can adopt THEIRS again, fail verification again, and
 * install a THIRD copy; repeat per restart.
 */
export function knownModIds(
  journal: readonly JournalEntry[],
  liveModIds: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  for (const entry of journal) {
    if (liveModIds.has(entry.vortexModId)) out.add(entry.vortexModId);
  }
  return out;
}

/**
 * Log what the journal contributed, once per run.
 *
 * Without this line the journal is invisible: a resume that recognises
 * everything and a resume that read an empty journal look identical from the
 * outside, and "the feature is not in this build" is indistinguishable from
 * "it had nothing to say".
 */
export function logJournalSummary(
  packageId: string,
  journal: readonly JournalEntry[],
  liveModIds: ReadonlySet<string>,
): void {
  /**
   * ─── COUNT THE TWO KINDS SEPARATELY ──────────────────────────────────
   * The previous version reported `journal.length - owned.size` as
   * `goneSinceRecorded`, where `owned` is deliberately INSTALLED-ONLY
   * (`ownedModIds` skips adopted entries by design, because we never destroy
   * an adopted mod). Subtracting an installed-only set from a total that also
   * counts adopted ones makes every adopted mod look deleted.
   *
   * A real run showed it: 1755 entries, 164 installed, 1591 adopted, and the
   * log claimed `goneSinceRecorded: 1591` — "the user removed 1591 mods
   * between runs" — when in truth every one of the 164 we installed was still
   * there and nothing had been removed at all. A confidently wrong number is
   * worse than no number, because someone acts on it.
   *
   * So each kind is counted against the live pool on its own terms, and no
   * figure here mixes them.
   */
  let installedByUs = 0;
  let installedStillPresent = 0;
  let adopted = 0;
  let adoptedStillPresent = 0;
  for (const entry of journal) {
    const live = liveModIds.has(entry.vortexModId);
    if (entry.kind === "installed") {
      installedByUs += 1;
      if (live) installedStillPresent += 1;
    } else {
      adopted += 1;
      if (live) adoptedStillPresent += 1;
    }
  }

  ehLog("info", "install.journal.read", {
    packageId,
    entries: journal.length,
    installedByUs,
    installedStillPresent,
    // Mods WE created that have since disappeared. This is the number that
    // changes what a resume should expect to find.
    installedGone: installedByUs - installedStillPresent,
    adopted,
    adoptedStillPresent,
    // Mods we merely recognised that are gone. Informational: we never had
    // the right to touch these, so their absence changes nothing we may do.
    adoptedGone: adopted - adoptedStillPresent,
  });
}
