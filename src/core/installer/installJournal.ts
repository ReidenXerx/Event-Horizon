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

/** One mod, as this tool created it. */
export type JournalEntry = {
  /** Stable manifest identity, so a re-plan can find this again. */
  compareKey: string;
  /** The Vortex mod id we produced. Confirmed against live state on read. */
  vortexModId: string;
  /** Which decision arm created it — for diagnosis, never for matching. */
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
  } catch {
    // Deliberately silent — see the header. A lost line costs a redone mod.
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
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as Partial<JournalEntry>;
      if (
        typeof parsed.compareKey !== "string" ||
        typeof parsed.vortexModId !== "string"
      ) {
        continue;
      }
      out.push({
        compareKey: parsed.compareKey,
        vortexModId: parsed.vortexModId,
        decision: typeof parsed.decision === "string" ? parsed.decision : "",
        at: typeof parsed.at === "string" ? parsed.at : "",
      });
    } catch {
      // A truncated tail line. Everything before it still counts.
    }
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
  owned: ReadonlySet<string>,
): void {
  ehLog("info", "install.journal.read", {
    packageId,
    entries: journal.length,
    stillPresent: owned.size,
    // A large gap means the user removed mods between runs, which changes what
    // a resume should expect to find.
    goneSinceRecorded: journal.length - owned.size,
  });
}
