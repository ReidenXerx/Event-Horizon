/**
 * What one install run has learned so far.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * `runInstallImpl` declares around twenty-five mutable locals in a 200-line
 * preamble and then runs for 2,240 lines with every one of them in scope. That
 * is not a size problem, it is a coupling problem, and it is the reason each of
 * the last fifty fixes was appended inline instead of placed: there is no unit
 * smaller than the whole function that owns any of this state, so there is
 * nowhere else for a fix to go.
 *
 * This is the first piece of the decomposition — the state, before the phases.
 * Extracting phases first would only move `curatorReports` and its twenty
 * siblings into a parameter list.
 *
 * ─── WHAT IT DELIBERATELY DOES NOT OWN ──────────────────────────────────────
 * `installedMods` stays in the driver. It is INDEXED and reassigned in place —
 * `installedMods[i] = retried.installEntry` after a repair or an alongside
 * install — and the verify loop iterates it by position. Wrapping that in
 * accessors without moving the loop as well would hide the one invariant a
 * reader needs to see. It joins when its phase does.
 *
 * ─── THE STREAK COUNTERS ARE HERE BECAUSE THEY HAVE A RULE ──────────────────
 * They are the only pieces of this state with logic rather than storage: a
 * failure increments, a timeout increments only for a timeout, and a SUCCESS
 * resets both. That reset is the whole point — a streak means the cause is not
 * this mod — and it lived as three assignments 40 lines apart.
 */

import type {
  CarriedModReportEntry,
  FailedModReportEntry,
  RemovedModReportEntry,
  SkippedModReportEntry,
} from "../../types/installDriver";
import type { DownloadFailureShape } from "./downloadFailureShape";
import type { EhcollStagingFile } from "../../types/ehcoll";
import type { ModVerificationReceipt } from "../../types/installLedger";

/**
 * How a mod's install failed, for the streak rule.
 *
 * Reuses the driver's own classification rather than a narrower copy: the real
 * type also carries `"gone"` (Nexus answered fast and empty), and a local
 * two-value alias would have silently excluded it from the streak — which is
 * the shape that matters most, since a run of `gone` means the collection
 * references files that no longer exist rather than a wedged Vortex.
 */
export type FailureShape = DownloadFailureShape;

export class RunAccumulator {
  private readonly _failed: FailedModReportEntry[] = [];
  private readonly _skipped: SkippedModReportEntry[] = [];
  private readonly _removed: RemovedModReportEntry[] = [];
  private readonly _carried: CarriedModReportEntry[] = [];
  private readonly _verifications: ModVerificationReceipt[] = [];
  private readonly _curatorReports: string[] = [];
  private readonly _externalNotices: string[] = [];
  private readonly _damagedArchives: string[] = [];

  /**
   * Mods whose verification PASSED, and the file list that was proven.
   *
   * Only these earn a drift reference in the receipt. A mod that diverged from
   * the curator, or failed outright, has no proven description of its disk,
   * and inventing one would make every future drift check compare against a
   * fiction.
   */
  private readonly _verifiedOkKeys = new Set<string>();
  private readonly _expectedFiles = new Map<string, EhcollStagingFile[]>();

  private _consecutiveFailures = 0;
  private _consecutiveTimeouts = 0;

  // ── report collectors ────────────────────────────────────────────────────

  failed(entry: FailedModReportEntry): void {
    this._failed.push(entry);
  }
  skipped(entry: SkippedModReportEntry): void {
    this._skipped.push(entry);
  }
  removed(entry: RemovedModReportEntry): void {
    this._removed.push(entry);
  }
  carried(entry: CarriedModReportEntry): void {
    this._carried.push(entry);
  }
  verification(entry: ModVerificationReceipt): void {
    this._verifications.push(entry);
  }
  /** A finding the CURATOR should act on — their staging, not this machine. */
  reportToCurator(line: string): void {
    this._curatorReports.push(line);
  }
  /** Where to get an external archive this run could not fetch. */
  noteExternalArchive(line: string): void {
    this._externalNotices.push(line);
  }
  /** An archive that is broken on THIS machine. Not the curator's problem. */
  noteDamagedArchive(line: string): void {
    this._damagedArchives.push(line);
  }

  // ── proven-state bookkeeping ─────────────────────────────────────────────

  /**
   * Record that a mod's files were proven to match the manifest.
   *
   * Silently ignores an empty list, and that is deliberate: a "proof" over no
   * files is not a proof, and `computeStagingSetHash` would refuse it anyway.
   */
  noteVerifiedOk(
    compareKey: string,
    files: EhcollStagingFile[] | undefined,
  ): void {
    if (files === undefined || files.length === 0) return;
    this._verifiedOkKeys.add(compareKey);
    this._expectedFiles.set(compareKey, files);
  }

  get verifiedOkKeys(): ReadonlySet<string> {
    return this._verifiedOkKeys;
  }
  get expectedFilesByCompareKey(): ReadonlyMap<string, EhcollStagingFile[]> {
    return this._expectedFiles;
  }

  // ── the streak rule ──────────────────────────────────────────────────────

  /**
   * One mod failed. A timeout also extends the timeout streak; anything else
   * ends it, because "eight failures in a row" and "four TIMEOUTS in a row"
   * are different diagnoses and only the second one means Vortex is wedged.
   */
  noteModFailed(shape: FailureShape): void {
    this._consecutiveFailures += 1;
    // Only a TIMEOUT extends the timeout streak. `gone` and `unclear` both
    // end it — a missing file is a fact about the collection, not a sign that
    // Vortex is wedged, and conflating them stops a run for the wrong reason.
    this._consecutiveTimeouts =
      shape === "timed-out" ? this._consecutiveTimeouts + 1 : 0;
  }

  /** One mod succeeded. BOTH streaks reset — that is the whole rule. */
  noteModSucceeded(): void {
    this._consecutiveFailures = 0;
    this._consecutiveTimeouts = 0;
  }

  get consecutiveFailures(): number {
    return this._consecutiveFailures;
  }
  get consecutiveTimeouts(): number {
    return this._consecutiveTimeouts;
  }

  // ── what the receipt and the result read ─────────────────────────────────

  get failedMods(): readonly FailedModReportEntry[] {
    return this._failed;
  }
  get skippedMods(): readonly SkippedModReportEntry[] {
    return this._skipped;
  }
  get removedMods(): readonly RemovedModReportEntry[] {
    return this._removed;
  }
  get carriedMods(): readonly CarriedModReportEntry[] {
    return this._carried;
  }
  get verifications(): readonly ModVerificationReceipt[] {
    return this._verifications;
  }
  get curatorReports(): readonly string[] {
    return this._curatorReports;
  }
  get externalNotices(): readonly string[] {
    return this._externalNotices;
  }
  get damagedArchives(): readonly string[] {
    return this._damagedArchives;
  }
}
