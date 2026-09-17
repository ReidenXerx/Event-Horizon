/**
 * ──────────────────────────────────────────────────────────────────────
 * Verification, written down as it happens, so stopping does not throw it away.
 *
 * ─── THE FIELD FAILURE ─────────────────────────────────────────────────
 * A 3,236-mod collection, 2026-09-17. The install took 14.1 hours; the
 * verification pass that follows it took another 4.85. The tester stopped a
 * later run an hour into verification — `outcome: aborted, phase:
 * verifying-mods`, 1,258 of 3,236 checked — and every one of those 1,258 proofs
 * died with the process, because the verdicts lived in an array that the
 * receipt is only written from at the very end.
 *
 * Nothing was wrong with his install. He simply could not afford to finish
 * finding that out in one sitting, and the tool gave him no way to do it in
 * two.
 *
 * ─── WHAT THIS IS, AND WHAT IT IS NOT ──────────────────────────────────
 * One line per mod PROVEN clean, appended the moment it is proven. On the next
 * run the verify phase reads it and skips what it can still trust, so a
 * stopped verification continues instead of restarting.
 *
 * It records ONLY `ok`. A failure must be re-checked, because the recovery that
 * follows a failure — judge, reinstall, install alongside — happens in the same
 * loop iteration, and replaying a stale "fail" verdict would put a broken mod
 * in the receipt with nothing done about it. A skip is cheap to redo. So the
 * journal holds exactly the expensive, re-usable half.
 *
 * ─── WHEN A LINE STOPS BEING TRUE ──────────────────────────────────────
 * A proof is about files at a moment. Three things retire one, and all three
 * are checked before reuse (see {@link reusableVerifications}):
 *
 *   • The mod was re-installed after we proved it. Vortex's own `installTime`
 *     decides this, not us.
 *   • The collection moved on. A journal belongs to one package VERSION;
 *     a different one starts from nothing.
 *   • The level changed. A `fast` proof cannot stand in for a `thorough` one.
 *
 * And when a run completes, the receipt supersedes the journal and it is
 * deleted — the same lifecycle as {@link installJournal}, for the same reason.
 *
 * ─── DURABILITY ────────────────────────────────────────────────────────
 * Append-only JSONL, no fsync, failures swallowed and logged. A lost tail means
 * a resume re-verifies a few mods, which is the safe direction: the cost of
 * this file failing is time, never correctness.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fsp from "fs/promises";
import * as path from "path";

import { ehLog } from "../logging/ehLog";

/** The verification levels a collection can declare, minus "none". */
export type VerifyJournalLevel = "fast" | "thorough";

/** One mod, proven clean. */
export type VerifyJournalEntry = {
  /** Stable manifest identity — how the next run finds this mod again. */
  compareKey: string;
  /** The Vortex mod the proof is about. Both must match to be reused. */
  vortexModId: string;
  /** Package version the proof was made for. */
  packageVersion: string;
  /** A `fast` proof never satisfies a `thorough` demand. */
  level: VerifyJournalLevel;
  /** Files compared, carried into the receipt so the count stays honest. */
  verifiedFileCount: number;
  /** Files present that the curator did not record. Informational. */
  extraFileCount: number;
  /** Epoch ms. Compared against Vortex's installTime for the same mod. */
  at: number;
};

export function getVerifyJournalDir(appDataPath: string): string {
  return path.join(appDataPath, "event-horizon", "install-ledger", "verify");
}

function verifyJournalPath(appDataPath: string, packageId: string): string {
  return path.join(getVerifyJournalDir(appDataPath), `${packageId}.jsonl`);
}

/** Record one mod as proven. Never throws, never blocks the install. */
export async function appendVerifyJournal(
  appDataPath: string,
  packageId: string,
  entry: VerifyJournalEntry,
): Promise<void> {
  try {
    await fsp.mkdir(getVerifyJournalDir(appDataPath), { recursive: true });
    await fsp.appendFile(
      verifyJournalPath(appDataPath, packageId),
      `${JSON.stringify(entry)}\n`,
      "utf8",
    );
  } catch (err) {
    // Costs time on the next run, never correctness — so it is logged at
    // `warn` and the install carries on.
    ehLog("warn", "verify.journal.append.failed", {
      packageId,
      compareKey: entry.compareKey,
      consequence: "this mod will be verified again if the run is interrupted",
      err,
    });
  }
}

/** Every proof recorded for this collection, newest last. */
export async function readVerifyJournal(
  appDataPath: string,
  packageId: string,
): Promise<VerifyJournalEntry[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(verifyJournalPath(appDataPath, packageId), "utf8");
  } catch {
    // No journal is the normal case: a first install, or one that finished.
    return [];
  }

  const out: VerifyJournalEntry[] = [];
  let unreadableLines = 0;
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    try {
      const p = JSON.parse(line) as Partial<VerifyJournalEntry>;
      if (
        typeof p.compareKey !== "string" ||
        typeof p.vortexModId !== "string" ||
        typeof p.packageVersion !== "string" ||
        (p.level !== "fast" && p.level !== "thorough") ||
        typeof p.at !== "number"
      ) {
        unreadableLines += 1;
        continue;
      }
      out.push({
        compareKey: p.compareKey,
        vortexModId: p.vortexModId,
        packageVersion: p.packageVersion,
        level: p.level,
        verifiedFileCount:
          typeof p.verifiedFileCount === "number" ? p.verifiedFileCount : 0,
        extraFileCount: typeof p.extraFileCount === "number" ? p.extraFileCount : 0,
        at: p.at,
      });
    } catch {
      // A truncated tail line: the run was killed mid-write. Everything
      // before it still counts, which is the entire point of JSONL here.
      unreadableLines += 1;
    }
  }
  if (unreadableLines > 0) {
    ehLog("info", "verify.journal.unreadable-lines", {
      packageId,
      unreadableLines,
      usable: out.length,
      consequence: "those mods will simply be verified again",
    });
  }
  return out;
}

/** The receipt supersedes the journal once a run finishes. */
export async function clearVerifyJournal(
  appDataPath: string,
  packageId: string,
): Promise<void> {
  try {
    await fsp.rm(verifyJournalPath(appDataPath, packageId), { force: true });
  } catch (err) {
    ehLog("info", "verify.journal.clear.failed", { packageId, err });
  }
}

/**
 * Which recorded proofs may be reused right now, keyed by compareKey.
 *
 * Pure, so the rules above are testable without a disk: given the journal,
 * the package version being installed, the level being demanded and Vortex's
 * own install times, it answers what still holds.
 *
 * A mod with NO known install time is reusable. Vortex does not always record
 * `installTime`, and refusing to trust the proof then would quietly disable
 * resumption for whole collections — the direction that costs hours to protect
 * against a re-install we have no evidence happened.
 */
export function reusableVerifications(input: {
  entries: readonly VerifyJournalEntry[];
  packageVersion: string;
  level: VerifyJournalLevel;
  /** Vortex mod id → epoch ms it was installed, from the live mod pool. */
  installedAt: ReadonlyMap<string, number>;
}): Map<string, VerifyJournalEntry> {
  const out = new Map<string, VerifyJournalEntry>();
  for (const e of input.entries) {
    if (e.packageVersion !== input.packageVersion) continue;
    // A thorough run cannot be satisfied by a fast proof. The other way round
    // is fine: thorough proves everything fast would have.
    if (input.level === "thorough" && e.level !== "thorough") continue;
    const installedAt = input.installedAt.get(e.vortexModId);
    if (installedAt !== undefined && installedAt > e.at) continue;
    // Later lines win: the same mod can be verified more than once across
    // resumed runs, and the newest proof is the one that stands.
    out.set(e.compareKey, e);
  }
  return out;
}
