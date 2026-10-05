/**
 * ──────────────────────────────────────────────────────────────────────
 * Optional mods: absent is a normal outcome, never a divergence.
 *
 * Owner, 2026-10-05 (first use: Ivy's Creation Club patches). A curator marks
 * a mod optional in the collection config; the install preview lists it
 * ticked and the player may untick it; a failed download skips it. Either
 * way nothing reports it missing: not the install summary, not Doctor, not
 * the plugin order, not the mod rules.
 *
 * Installed, an optional mod may still lack files: it can depend on other
 * optional content the player has or not (extra Creation Club content in the
 * first case). Absent files are therefore a normal outcome too. A file whose
 * CONTENT differs is still a real problem and is still reported.
 * ──────────────────────────────────────────────────────────────────────
 */

import { parseModReference } from "../identity/compareKey";
import type { RulesApplicationReceipt } from "../../types/installLedger";

/** An optional mod this run did not install, and why, in the player's words. */
export type OptionalNotInstalled = { compareKey: string; name: string; reason: string };

/** compareKeys of the manifest's optional mods. */
export function optionalKeys(mods: ReadonlyArray<{ compareKey: string; state?: { optional?: true } }>): Set<string> {
  return new Set(mods.filter((m) => m.state?.optional === true).map((m) => m.compareKey));
}

/**
 * Does a rule source or reference name one of these mods?
 *
 * A reference is a compareKey-shaped string; `nexus:<modId>` names the page,
 * so it matches any of that page's files.
 */
export function namesAbsentMod(keyOrReference: string, absent: ReadonlySet<string>): boolean {
  if (absent.has(keyOrReference)) return true;
  const parsed = parseModReference(keyOrReference);
  if (parsed.kind !== "nexus-mod") return false;
  const prefix = `nexus:${parsed.nexusModId}:`;
  for (const k of absent) if (k.startsWith(prefix)) return true;
  return false;
}

/**
 * The receipt's rule record without the skips an absent optional mod caused.
 * A rule that could not land because its optional mod is not here is the
 * expected consequence of the player's choice, not a rule that failed.
 */
export function withoutOptionalSkips(
  rules: RulesApplicationReceipt,
  absent: ReadonlySet<string>,
): RulesApplicationReceipt {
  if (absent.size === 0) return rules;
  return {
    ...rules,
    skippedRules: rules.skippedRules.filter(
      (s) => !namesAbsentMod(s.source, absent) && !namesAbsentMod(s.reference, absent),
    ),
    skippedLoadOrderEntries: rules.skippedLoadOrderEntries.filter((s) => !absent.has(s.compareKey)),
  };
}

/** The Done screen's lines for optional mods that were not installed. */
export function describeOptionalNotInstalled(entries: readonly OptionalNotInstalled[]): string[] {
  return entries.map((e) => `${e.name}: ${e.reason}.`);
}
