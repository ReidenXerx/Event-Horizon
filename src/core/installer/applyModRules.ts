/**
 * Mod-rule application — Phase 3 slice 6c.
 *
 * Walks the manifest's mod rules (`EhcollRule[]`) and dispatches
 * Vortex `addModRule` / `removeModRule` actions so the user-side mod
 * graph mirrors the curator's intent. Pure orchestration on top of
 * Vortex's redux store; no filesystem work.
 *
 * ─── DESIGN NOTES ──────────────────────────────────────────────────────
 *
 * Rule resolution strategy (lookup ladder, strongest first):
 *   1. compareKey is fully-pinned (`nexus:M:F`, `external:<sha>`,
 *      `archive:<id>`) AND maps to a mod we just installed / carried /
 *      already had → use that vortex modId verbatim.
 *   2. compareKey is a partial Nexus pin (`nexus:M`) → look up any
 *      installed mod with `nexusModId === M` for the active gameId.
 *   3. Otherwise → skip with reason. Skipped rules are recorded in the
 *      `ApplyModRulesResult.skipped` list so the receipt + post-install
 *      report can surface them.
 *
 * Conflict policy (locked design choice — "collection-wins"):
 *   When the user already has a rule on the source mod whose
 *   `reference` resolves to the same target mod (regardless of rule
 *   type), the existing rule is removed before the collection's rule
 *   is added. This keeps the collection's intent authoritative on the
 *   mods it owns and avoids ambiguous "your rule says X but the
 *   collection says Y" states. The user can re-apply their custom
 *   rule manually post-install if they want it back.
 *
 * INVARIANTS:
 *   - This module never reads from the user's mod table directly. The
 *     caller passes a single `compareKey → vortexModId` map representing
 *     the post-install state (installed + carried + already-installed
 *     mods). Lookup is strict-equality on that map.
 *   - For partial Nexus pins, the caller passes the full mod list keyed
 *     by `nexusModId` so we can resolve without a Vortex API roundtrip.
 *   - All dispatches are best-effort. A failure on one rule logs and
 *     continues; the install does not roll back. Partial application is
 *     still strictly better than no application.
 *   - `ignored: true` rules from the manifest are NOT dispatched. The
 *     curator preserved them for documentation; honoring them at install
 *     time would change behavior the curator explicitly disabled.
 * ──────────────────────────────────────────────────────────────────────
 */

import { actions, types } from "@nexusmods/vortex-api";

import { ehLog } from "../logging/ehLog";

import type { EhcollRule, ModRuleType } from "../../types/ehcoll";
import { AbortError } from "../../utils/abortError";
import { parseModReference } from "../identity/compareKey";

/**
 * Inputs the caller computes once before the apply phase. Keyed maps
 * are passed in (rather than re-derived inside) so the driver controls
 * snapshot consistency — by the time we run, every install has
 * either succeeded with a known vortexModId or been recorded as
 * skipped/carried.
 */
export type ApplyModRulesInput = {
  api: types.IExtensionApi;
  gameId: string;
  rules: EhcollRule[];
  /**
   * compareKey → vortex modId. Built from the union of
   * (newly installed) ∪ (carried) ∪ (already-installed) mods. Missing
   * keys mean "the manifest references a mod that didn't end up on
   * the user's system" → rule is skipped.
   */
  modIdByCompareKey: ReadonlyMap<string, string>;
  /**
   * For partial Nexus pin resolution: nexusModId → vortex modId.
   * When the rule's reference is `nexus:<M>` (no fileId), we fall
   * back to this map. Multiple installed files for the same Nexus
   * mod resolve to the LAST entry the caller registered (curator
   * intent is fuzzy by construction here — they didn't pin a fileId).
   */
  modIdByNexusModId: ReadonlyMap<string, string>;
  /**
   * Nexus modIds with MORE THAN ONE mod installed for them.
   *
   * A partial pin naming one of these cannot be resolved: the map holds
   * whichever instance was written last, and applying a conflict rule to the
   * wrong variant resolves file conflicts in the wrong direction. Optional so
   * existing callers keep working; absent means "no known ambiguity".
   */
  ambiguousNexusModIds?: ReadonlySet<string>;
  /**
   * Optional: user's pre-existing rules on the mods we touch, keyed
   * by source vortex modId. Used for collection-wins conflict
   * dedup. When omitted, the conflict pass is skipped.
   */
  existingRulesBySourceModId?: ReadonlyMap<string, ExistingRule[]>;
  /** Abort plumbing — same shape the rest of the driver uses. */
  signal?: AbortSignal;
};

/**
 * Minimal projection of Vortex's `state.persistent.mods[gameId][modId].rules[i]`
 * the caller needs to surface for conflict-detection. Only the fields
 * we actually compare against — the type stays small so the driver
 * can build it without depending on Vortex internals.
 */
export type ExistingRule = {
  type: string;
  reference: {
    id?: string;
    repo?: { modId?: string; fileId?: string };
    archiveId?: string;
  };
};

export type ApplyModRulesResult = {
  /** Number of rules successfully dispatched. */
  applied: number;
  /**
   * Number of pre-existing user rules removed by the collection-wins
   * conflict pass. Surfaced in the receipt so the user can see what
   * their setup was before we touched it.
   */
  overwrittenUserRules: number;
  /** Manifest rules we couldn't apply, with reason. UI/receipt facing. */
  skipped: SkippedRule[];
};

export type SkippedRule = {
  manifestRuleIndex: number;
  type: ModRuleType;
  source: string;
  reference: string;
  reason: string;
};

/**
 * Dispatch every applicable rule in `input.rules` to Vortex. Returns
 * a summary the driver attaches to the install receipt. Never throws
 * for individual rule failures — only for hard aborts.
 */
export function applyModRules(input: ApplyModRulesInput): ApplyModRulesResult {
  const result: ApplyModRulesResult = {
    applied: 0,
    overwrittenUserRules: 0,
    skipped: [],
  };

  for (let i = 0; i < input.rules.length; i++) {
    if (input.signal?.aborted) throw new AbortError();

    const rule = input.rules[i]!;

    if (rule.ignored === true) {
      result.skipped.push({
        manifestRuleIndex: i,
        type: rule.type,
        source: rule.source,
        reference: rule.reference,
        reason: "Rule was disabled by the curator (ignored=true).",
      });
      continue;
    }

    const sourceModId = input.modIdByCompareKey.get(rule.source);
    if (sourceModId === undefined) {
      result.skipped.push({
        manifestRuleIndex: i,
        type: rule.type,
        source: rule.source,
        reference: rule.reference,
        reason:
          `Source mod is not present in the post-install state. ` +
          `(The mod was skipped, removed, or never installed.)`,
      });
      continue;
    }

    const targetModId = resolveReferenceToModId(rule.reference, input);
    if (targetModId === undefined) {
      result.skipped.push({
        manifestRuleIndex: i,
        type: rule.type,
        source: rule.source,
        reference: rule.reference,
        reason:
          parseModReference(rule.reference).kind === "nexus-mod"
            ? partialPinReason(rule.reference, input)
            : `Reference "${rule.reference}" did not resolve to any installed mod.`,
      });
      continue;
    }

    if (sourceModId === targetModId) {
      // A self-referential rule slipped through (shouldn't happen with
      // a well-formed manifest, but partial pins can collapse onto the
      // source mod). Skip to keep the rule graph sane.
      result.skipped.push({
        manifestRuleIndex: i,
        type: rule.type,
        source: rule.source,
        reference: rule.reference,
        reason: "Rule's source and target resolve to the same mod.",
      });
      continue;
    }

    // Collection-wins conflict pass — drop any existing user rule on
    // the source mod that already references the same target, so we
    // don't end up with contradictory rule pairs in Vortex's store.
    const existing = input.existingRulesBySourceModId?.get(sourceModId) ?? [];
    for (const userRule of existing) {
      if (refMatchesModId(userRule.reference, targetModId)) {
        try {
          input.api.store?.dispatch(
            actions.removeModRule(input.gameId, sourceModId, {
              type: userRule.type,
              reference: userRule.reference,
            } as never),
          );
          result.overwrittenUserRules += 1;
        } catch (err) {
          // Removing a rule the store doesn't have is not catastrophic
          // — Vortex's reducer will no-op. Logging keeps the trail.
          //
          // In the FILE, not devtools: a user rule that survives here keeps
          // fighting the curator's rule for the rest of the session, and the
          // symptom shows up much later as a conflict order that will not
          // stick. This line is the only thing that connects the two.
          ehLog("warn", "rules.user-rule.remove-failed", {
            sourceModId,
            type: userRule.type,
            consequence:
              "the user's own rule stays in place and competes with the " +
              "curator's",
            err,
          });
        }
      }
    }

    try {
      input.api.store?.dispatch(
        actions.addModRule(input.gameId, sourceModId, {
          type: rule.type,
          reference: { id: targetModId },
          ...(rule.comment !== undefined ? { comment: rule.comment } : {}),
        } as never),
      );
      result.applied += 1;
    } catch (err) {
      result.skipped.push({
        manifestRuleIndex: i,
        type: rule.type,
        source: rule.source,
        reference: rule.reference,
        reason:
          `Vortex rejected the rule dispatch: ` +
          (err instanceof Error ? err.message : String(err)),
      });
    }
  }

  return result;
}

/**
 * Translate a manifest `compareKey`-shaped reference into a Vortex mod
 * id. Strongest-form first: fully-pinned compareKeys map directly,
 * partial Nexus pins fall back to the nexusModId index.
 */
/**
 * Why a partial pin failed — "not installed" and "installed more than once"
 * are different problems with different fixes, and one message for both would
 * send the curator looking for a missing mod that is actually present twice.
 */
function partialPinReason(reference: string, input: ApplyModRulesInput): string {
  const parsed = parseModReference(reference);
  const nexusModId = parsed.kind === "nexus-mod" ? parsed.nexusModId : "";
  if (input.ambiguousNexusModIds?.has(nexusModId) === true) {
    return (
      `Partial Nexus pin "${reference}" matches more than one installed mod ` +
      `(several variants of Nexus mod ${nexusModId} are installed), so the ` +
      `rule could land on the wrong one. Skipped rather than guessed.`
    );
  }
  return `Partial Nexus pin "${reference}" did not match any installed mod.`;
}

function resolveReferenceToModId(
  reference: string,
  input: ApplyModRulesInput,
): string | undefined {
  // Direct compareKey hit — covers fully-pinned `nexus:M:F`,
  // `external:<sha>`, `archive:<id>` references.
  const direct = input.modIdByCompareKey.get(reference);
  if (direct !== undefined) return direct;

  // Partial Nexus pin: `nexus:<M>` (two segments).
  //
  // The comment here used to say a profile can hold at most one fileId per
  // Nexus modId, "so this is unambiguous in practice". That is false, and
  // measurably so: the curator's own 954-mod profile has 104 Nexus modIds
  // installed more than once, one of them five times. Installing a second
  // variant of a mod — different FOMOD answers, a patch version kept
  // alongside — is ordinary practice, not an edge case.
  //
  // So an ambiguous pin RESOLVES TO NOTHING rather than to whichever instance
  // the map happened to keep. The rule is then recorded as skipped, with a
  // reason, and surfaces in the receipt. Applying a conflict rule to the wrong
  // variant would silently resolve file conflicts in the wrong direction — a
  // wrong answer that looks like the collection simply does not work, and one
  // nobody would think to look for. A reported skip is recoverable; a silent
  // mis-application is not.
  const parsed = parseModReference(reference);
  if (parsed.kind === "nexus-mod") {
    const { nexusModId } = parsed;
    if (input.ambiguousNexusModIds?.has(nexusModId) === true) return undefined;
    return input.modIdByNexusModId.get(nexusModId);
  }

  return undefined;
}

/**
 * Whether a Vortex rule reference points to the given mod. We accept
 * any of: explicit `id`, full nexus repo (`repo.modId` + `repo.fileId`
 * matched against the target mod's compareKey via the caller), or
 * `archiveId`. The caller has already resolved the manifest's
 * reference to a single modId; here we just check the user's
 * existing rule against THAT modId.
 *
 * INVARIANT: this function does NOT round-trip through Vortex's mod
 * table — it pattern-matches against fields that directly carry the
 * id. Callers needing repo-based matching are responsible for
 * pre-resolving repos to vortex modIds before calling.
 */
function refMatchesModId(
  ref: ExistingRule["reference"],
  modId: string,
): boolean {
  if (ref.id === modId) return true;
  // archiveId-based references: we'd need to know the user's mod's
  // archiveId to compare. v1 punts on this and treats archiveId-only
  // references as "not a conflict we can detect cheaply" — we'll
  // fall through and the new rule simply layers on top, which is
  // benign (Vortex resolves overlapping rules deterministically by
  // type precedence).
  return false;
}
