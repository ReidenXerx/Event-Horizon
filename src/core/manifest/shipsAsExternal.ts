/**
 * ──────────────────────────────────────────────────────────────────────
 * The curator's "ship this as external" override, in one place.
 *
 * Three call sites decide whether a mod is external, and each one had its own
 * answer to a question with real consequences — the mod's identity in the
 * manifest, and whether its archive may be bundled:
 *
 *   1. `buildManifest.buildModEntry`        — nexus identity vs hash identity
 *   2. `engine.resolveBundles`      — may this archive be bundled?
 *   3. `buildPackageAction` (the same gate) — again, in the action path
 *
 * Teaching only the first about `treatAsExternal` produced exactly the failure
 * three copies of a rule always produce: the curator ticked "bundle" on ten
 * dead mods, the flag persisted correctly, the manifest honoured it — and the
 * build died on the two copies that had never heard of it, reporting "Only
 * external (non-Nexus) mods can be bundled" about mods the curator had just
 * declared external.
 *
 * ─── WHY THIS SHARES THE OVERRIDE AND NOT THE NEXUS TEST ───────────────
 * The obvious fix was one `isNexusSourced` for all three. It is wrong, and the
 * test suite said so within a minute: the three copies do not merely differ on
 * the override, they disagree about what "Nexus mod" MEANS. `buildManifest`
 * requires `source === "nexus"` as well as the ids; the two bundling gates
 * check only that the ids are positive numbers. Unifying them silently
 * reclassified every mod carrying Nexus ids without a `source` — changing
 * mods' identities in the manifest as a side effect of a bundling fix.
 *
 * So each caller keeps its own notion of Nexus, and shares only the part that
 * was actually duplicated and actually wrong. Narrower, and it cannot move a
 * mod between identities behind anyone's back.
 * ──────────────────────────────────────────────────────────────────────
 */

/** Whatever config or spec carries the curator's override. */
export interface ExternalityOverride {
  treatAsExternal?: boolean;
}

/**
 * Does this mod ship identified by HASH rather than by its Nexus ids?
 *
 * `isNexus` is the CALLER's determination — see the header for why it is not
 * computed here.
 *
 * `treatAsExternal` overrides perfectly valid Nexus ids, which is the point:
 * the ids are still true and no longer useful, because the file behind them is
 * gone. It is the curator's explicit call and is never inferred from an
 * availability check — a network result on the day the build ran must not
 * silently change what a mod IS.
 */
export function shipsAsExternal(
  isNexus: boolean,
  override: ExternalityOverride | undefined,
): boolean {
  return !isNexus || override?.treatAsExternal === true;
}

/**
 * May this mod's archive be bundled into the `.ehcoll`?
 *
 * The same question as {@link shipsAsExternal}, named for the caller that asks
 * it so the bundling gates cannot drift from the identity branch again.
 *
 * The rule they enforce is sound: bundling a Nexus mod is pointless weight,
 * because the user's own API key fetches it. That reasoning ends precisely
 * when the file is gone from Nexus — at which point bundling is the only way
 * anyone else gets the mod at all.
 */
export function mayBundle(
  isNexus: boolean,
  override: ExternalityOverride | undefined,
): boolean {
  return shipsAsExternal(isNexus, override);
}
