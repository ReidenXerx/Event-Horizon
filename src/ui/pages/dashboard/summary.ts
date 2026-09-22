/**
 * What the dashboard says about one installed collection, computed from the
 * records that already exist. Pure: every number here is read off a receipt
 * or off the Doctor's own checks, and nothing is estimated.
 *
 * ─── THE RULE THIS FILE EXISTS TO ENFORCE ───────────────────────────────
 * `HealthStatus` has five values on purpose, and `unknown` is load-bearing:
 * a receipt written before a feature existed cannot say anything about it.
 * A dashboard that folds unknown into the green number turns "we did not
 * check" into "it is fine" — on one screen, in one big figure, which is the
 * most convincing place in the app to be wrong. So unknown is excluded from
 * the percentage and reported beside it.
 */

import type { HealthCheck } from "../../../core/doctor/health";
import type { InstallReceipt } from "../../../types/installLedger";

export interface HealthRollup {
  /**
   * Share of the checks that could be judged and came back healthy, 0..100.
   * `undefined` when nothing could be judged at all — which is not 0%, and
   * not 100% either.
   */
  percent: number | undefined;
  healthy: number;
  drifted: number;
  broken: number;
  /** Checks that could not be judged. Never counted as passes. */
  unknown: number;
  notApplicable: number;
  /** healthy + drifted + broken: the denominator of `percent`. */
  judged: number;
  tone: "good" | "warn" | "bad" | "brand";
  /** One line for under the ring. */
  caption: string;
}

export function healthRollup(checks: readonly HealthCheck[]): HealthRollup {
  let healthy = 0, drifted = 0, broken = 0, unknown = 0, notApplicable = 0;
  for (const c of checks) {
    if (c.status === "healthy") healthy += 1;
    else if (c.status === "drifted") drifted += 1;
    else if (c.status === "broken") broken += 1;
    else if (c.status === "unknown") unknown += 1;
    else notApplicable += 1;
  }
  const judged = healthy + drifted + broken;
  const percent = judged === 0 ? undefined : Math.round((healthy / judged) * 100);
  const tone = broken > 0 ? "bad" : drifted > 0 ? "warn" : judged === 0 ? "brand" : "good";
  const bits: string[] = [];
  if (broken > 0) bits.push(`${broken} broken`);
  if (drifted > 0) bits.push(`${drifted} drifted`);
  if (unknown > 0) bits.push(`${unknown} not checked`);
  const caption =
    judged === 0
      ? unknown > 0
        ? `nothing could be checked · ${unknown} unknown`
        : "nothing to check"
      : bits.length === 0
        ? "everything checks out"
        : bits.join(" · ");
  return { percent, healthy, drifted, broken, unknown, notApplicable, judged, tone, caption };
}

export interface CollectionFigures {
  mods: number;
  fromNexus: number;
  supplied: number;
  /** Mods the install could not put on disk. Its presence makes the receipt partial. */
  failed: number;
  /** Plugins the curator's order recorded. `undefined` when the package shipped none. */
  plugins: number | undefined;
  /**
   * Plugins carrying the light ("ESL") flag. `undefined` when the flags cannot
   * be judged — a package that predates `baselineLightFlagBit` recorded them
   * from a bit that is not the light bit on every game.
   */
  esl: number | undefined;
  /** Files the install verified, and how many mods that covers. */
  verifiedFiles: number;
  verifiedMods: number;
  /** Mods whose verification failed or was skipped. */
  unverifiedMods: number;
  rules: number | undefined;
  userlist: number | undefined;
  /** Script-extender plugins, as judged for THIS player at install time. */
  nativePlugins: { loads: number; unverified: number; cannotLoad: number; unknown: number } | undefined;
  /** Set when the install ran on a game version other than the collection's. */
  versionMismatch: { required: string; installed: string } | undefined;
}

export function collectionFigures(receipt: InstallReceipt): CollectionFigures {
  const mods = receipt.mods ?? [];
  const verifications = receipt.verifications ?? [];
  const baseline = receipt.rulesApplication?.baselinePluginOrder ?? [];
  const lightJudgeable = receipt.rulesApplication?.baselineLightFlagBit !== undefined;
  let verifiedFiles = 0, verifiedMods = 0, unverifiedMods = 0;
  for (const v of verifications) {
    if (v.kind === "ok") {
      verifiedMods += 1;
      verifiedFiles += v.verifiedFileCount;
    } else unverifiedMods += 1;
  }
  return {
    mods: mods.length,
    fromNexus: mods.filter((m) => m.source === "nexus").length,
    supplied: mods.filter((m) => m.source !== "nexus").length,
    failed: (receipt.failedMods ?? []).length,
    plugins: baseline.length > 0 ? baseline.length : undefined,
    esl: baseline.length > 0 && lightJudgeable ? baseline.filter((p) => p.light === true).length : undefined,
    verifiedFiles,
    verifiedMods,
    unverifiedMods,
    rules: receipt.rulesApplication?.appliedRuleCount,
    userlist: receipt.userlistApplication?.appliedRuleCount,
    nativePlugins: receipt.nativePluginSummary,
    versionMismatch: receipt.installedOnMismatchedVersion,
  };
}

/** "2 days ago", "just now" — for a timestamp the user may have forgotten. */
export function since(iso: string | undefined, now: number = Date.now()): string | undefined {
  if (iso === undefined) return undefined;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return undefined;
  const mins = Math.floor((now - then) / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 6) return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? "" : "s"} ago`;
}
