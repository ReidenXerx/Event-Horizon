/**
 * ──────────────────────────────────────────────────────────────────────
 * Doctor findings a player keeps on purpose (owner poll, 2026-09-28).
 *
 * A player who plays a collection their own way — a mod removed, one added, a
 * different game version — sees the same findings on every Doctor visit, the
 * health score never recovers, and "Repair all" offers to undo their choices.
 * The curator's Build page already lets them mark a diverged mod as deliberate;
 * this is the player's side of the same idea.
 *
 * What is kept is the FINDING, exactly: the check and everything it lists. The
 * moment it changes — another mod goes missing, the game version moves — it is
 * a new finding and shows again. Kept per collection version, so an update of
 * the collection asks again too.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import * as path from "path";

import type { HealthCheck } from "./health";

/** The finding as it stands: which check, its verdict, and everything it lists. */
export function findingFingerprint(check: Pick<HealthCheck, "id" | "status" | "detail">): string {
  return JSON.stringify([check.id, check.status, [...check.detail].sort()]);
}

/** Checks with each still-matching kept finding shown as kept on purpose (healthy, and saying so). */
export function applyKept(checks: readonly HealthCheck[], kept: Readonly<Record<string, string>>): HealthCheck[] {
  return checks.map((c) => {
    const isProblem = c.status === "broken" || c.status === "drifted";
    if (!isProblem || kept[c.id] !== findingFingerprint(c)) return c;
    const { heal: _heal, ...rest } = c;
    return {
      ...rest,
      status: "healthy",
      summary: `Kept on purpose: ${c.summary}`,
      affectedCount: 0,
      keptOnPurpose: true,
    };
  });
}

type KeptFile = Record<string, Record<string, string>>;

const fileIn = (eventHorizonDir: string): string => path.join(eventHorizonDir, "doctor-kept.json");
/** Kept per collection VERSION: an update of the collection asks again. */
export const keptKey = (receipt: { packageId: string; packageVersion: string }): string =>
  `${receipt.packageId}@${receipt.packageVersion}`;

export function loadKept(eventHorizonDir: string, key: string): Record<string, string> {
  try {
    return (JSON.parse(fs.readFileSync(fileIn(eventHorizonDir), "utf8")) as KeptFile)[key] ?? {};
  } catch {
    return {};
  }
}

export function saveKept(eventHorizonDir: string, key: string, kept: Record<string, string>): void {
  let all: KeptFile = {};
  try {
    all = JSON.parse(fs.readFileSync(fileIn(eventHorizonDir), "utf8")) as KeptFile;
  } catch {
    all = {};
  }
  if (Object.keys(kept).length === 0) delete all[key];
  else all[key] = kept;
  fs.mkdirSync(eventHorizonDir, { recursive: true });
  fs.writeFileSync(fileIn(eventHorizonDir), JSON.stringify(all, null, 2));
}
