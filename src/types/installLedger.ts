/**
 * Install ledger — on-disk receipt schema (Phase 3 slice 5b).
 *
 * The ledger is the SINGLE source of truth for "did Event Horizon
 * install this collection on this machine, and which mods did it put
 * there?" Receipts live at:
 *
 *   <appData>/Vortex/event-horizon/installs/<package.id>.json
 *
 * One file per collection package id. Re-installs of the same
 * `package.id` (any version) overwrite the file — only the most
 * recent install of a given collection is tracked.
 *
 * The receipt is the input the action handler reads to populate
 * `UserSideState.previousInstall` and to tag
 * `UserSideState.installedMods[].eventHorizonInstall`. The install
 * driver writes it after a successful install completes.
 *
 * Specs:
 *  - business behavior:  docs/business/INSTALL_LEDGER.md
 *  - lineage policy:     docs/business/INSTALL_PLAN_SCHEMA.md
 *  - design rationale:   docs/PROPOSAL_INSTALLER.md "decision log" entry
 *                        2026-04-27 ("Cross-release lineage via install
 *                        ledger, not Vortex attributes")
 *
 * INVARIANTS:
 *  - This file is type-only. No runtime code. The runtime CRUD lives
 *    in `src/core/installLedger.ts`.
 *  - `packageId` is the manifest's `package.id` at install time.
 *  - `installedAt` is ISO-8601 UTC.
 *  - All `compareKey` strings on `mods[]` mirror what
 *    `manifest.mods[i].compareKey` was at install time. They are the
 *    only authority the resolver uses for orphan detection.
 *  - We NEVER trust Vortex mod attributes for lineage; the receipt is
 *    the only source.
 *  - Schema is additive: future v1.x revisions add fields, never
 *    rename or remove. Breaking changes bump
 *    {@link InstallLedgerSchemaVersion}.
 */

import type { SupportedGameId } from "./ehcoll";
import type { FomodReplayMode } from "../core/installer/fomodReplayMode";

/**
 * Schema version. Bumped only on breaking changes; additive field
 * changes leave this at 1.
 */
export const INSTALL_LEDGER_SCHEMA_VERSION = 1 as const;
export type InstallLedgerSchemaVersion =
  typeof INSTALL_LEDGER_SCHEMA_VERSION;

/**
 * The full on-disk shape. Written by the install driver, read by the
 * userState builder.
 */
export type InstallReceipt = {
  schemaVersion: InstallLedgerSchemaVersion;
  /** Mirrors `manifest.package.id` at install time. UUIDv4. */
  packageId: string;
  /** Mirrors `manifest.package.version` at install time. Semver. */
  packageVersion: string;
  /** Mirrors `manifest.package.name` at install time. UI-only. */
  packageName: string;
  /** Mirrors `manifest.game.id` at install time. */
  gameId: SupportedGameId;
  /** ISO-8601 UTC of when the install completed. */
  installedAt: string;
  /**
   * The Vortex profile id the install lives in. For `current-profile`
   * mode this is the user's active profile at install time; for
   * `fresh-profile` mode it's the new profile the driver created.
   */
  vortexProfileId: string;
  /** UI-only display name of the profile. */
  vortexProfileName: string;
  /**
   * Which mode the driver used. Surfaced for the eventual UI's
   * "installed collections" view ("this collection lives in profile X
   * because we created it for the install").
   */
  installTargetMode: InstallTargetMode;
  /**
   * How the curator's FOMOD answers were replayed on this run.
   *
   * Recorded because the receipt stores the RESULT of an install and not the
   * answers that produced it — `stagingSetHash` alone cannot distinguish "the
   * curator's build" from "the curator's build with two boxes unticked". Under
   * `"supervised"` the user could change any answer, so this field is the only
   * trace that a difference from the collection may be deliberate rather than
   * corruption.
   *
   * It matters most when healing: the Doctor diagnoses against this receipt but
   * repairs from the manifest, so a heal restores the curator's answer over the
   * user's. This is what lets it say so first.
   *
   * Optional and additive: receipts written before the question was asked do
   * not have it, and absent means "not recorded", never "silent".
   */
  fomodReplayMode?: FomodReplayMode;
  /**
   * Per-mod install records. One entry per mod the driver put on
   * disk for this collection release. The list is the resolver's
   * orphan-detection key set.
   */
  mods: InstallReceiptMod[];
  /**
   * Slice 6c — Mod rule + LoadOrder application summary.
   *
   * Optional and additive: receipts written before slice 6c shipped
   * will not have it. Consumers must default to a zero-value record
   * when missing. Used by the post-install summary screen and as a
   * provenance trail when the user later asks "did the collection's
   * rules actually get applied on my machine?"
   */
  rulesApplication?: RulesApplicationReceipt;
  /**
   * Game INI settings written for this release, and the record that they
   * WERE written.
   *
   * Load-bearing beyond reporting: the collection states a starting
   * configuration once, on install or update, and never re-asserts it. The
   * user is free to change any of it afterwards, and a second apply would
   * silently undo that. So this entry's presence for a given
   * `packageVersion` is what stops it happening twice.
   *
   * Optional and additive: receipts written before game INI capture existed
   * do not have it, and absent means "never applied".
   */
  gameIniApplication?: GameIniApplicationReceipt;
  /**
   * Slice 6d — LOOT userlist application summary.
   *
   * Optional and additive: receipts written before slice 6d shipped
   * will not have it. Consumers must default to a zero-value record
   * when missing. The values mirror the
   * `ApplyUserlistResult` returned by `applyUserlist`, with
   * `skippedUserlistEntries` carrying verbose actionable reasons
   * (Vortex's reducer ignored our dispatch, action contract changed,
   * etc.) so the user (and our error reports) can audit which rules
   * landed.
   *
   * Plugin rules are dispatched additively (the reducer dedupes, see
   * `applyUserlist.ts`'s "Conflict policy" header), so this struct
   * does NOT carry an `overwrittenUserlistRuleCount`. The only
   * collection-wins overwrites are at the plugin-group level —
   * tracked separately as `overwrittenGroupAssignmentCount`.
   */
  userlistApplication?: UserlistApplicationReceipt;
  /**
   * Slice 7 — Per-mod file integrity verification summary.
   *
   * Optional and additive: receipts written before slice 7 shipped
   * will not have it. Consumers must default to `[]` when missing.
   *
   * One entry per installed mod that the driver attempted to verify
   * against the curator's `stagingFiles` snapshot from the manifest.
   * Entries with `kind === "skip"` are still recorded — they form
   * the audit trail for "we tried but the manifest didn't carry
   * verification data for this mod" cases (e.g. mod added by the
   * curator before slice 7's verification level was wired).
   *
   * Re-installs (one retry attempt per failing mod) collapse into a
   * single entry whose `kind` reflects the FINAL outcome, with the
   * intermediate failure recorded under `retryAttempted: true`.
   * This keeps the receipt's row count == installed mod count
   * regardless of how many recovery cycles ran.
   */
  verifications?: ModVerificationReceipt[];
};

/**
 * On-disk summary of what `applyModRules` + `applyLoadOrder` did. The
 * driver writes this at receipt time; the post-install summary surfaces
 * it. None of the fields drive future-release resolution — they exist
 * purely so the user (and our error reports) can audit slice 6c
 * outcomes after the fact.
 *
 * INVARIANT: this struct describes the *attempted* application, not
 * the current Vortex state. Re-running LOOT or the user dragging
 * plugins around in Vortex's UI does NOT update the receipt; the
 * receipt is a write-once record of what we dispatched.
 */
export type RulesApplicationReceipt = {
  /** Mod rules from the manifest the driver successfully dispatched. */
  appliedRuleCount: number;
  /**
   * Pre-existing user rules the driver removed because of the
   * collection-wins conflict policy. UI-only; surfaced so the user
   * understands why their custom rules may have changed.
   */
  overwrittenUserRuleCount: number;
  /**
   * Rules the driver could not apply (unresolvable compareKey,
   * curator-ignored, Vortex rejected dispatch). Each carries a
   * short reason for the post-install report.
   */
  skippedRules: ReceiptSkippedRule[];
  /** LoadOrder entries the driver successfully dispatched. */
  appliedLoadOrderCount: number;
  /** LoadOrder entries the driver dropped (unresolved compareKey). */
  skippedLoadOrderEntries: ReceiptSkippedLoadOrderEntry[];
  /**
   * Snapshot of the plugins.txt order we wrote at install time.
   * Used for the drift-detection helper that surfaces "your current
   * plugin order does not match what this collection installed" in
   * the post-install summary. Empty when the install was current-
   * profile-mode and we did not write plugins.txt, or when the game
   * does not use plugins.txt.
   */
  /**
   * The curator's plugin order, as shipped in the manifest.
   *
   * Recorded on every install and, as of today, READ BY NOTHING. Two comments
   * described it as feeding drift detection and the post-install summary;
   * neither was built. It is left in place because it is the one record of
   * what the order was SUPPOSED to be, and comparing it against the user's
   * actual plugins.txt after deploy is the check that would tell them whether
   * the collection reproduced their load order or merely something LOOT found
   * acceptable. That comparison does not exist yet.
   */
  baselinePluginOrder: ReceiptPluginEntry[];
};

/**
 * On-disk summary of what `applyUserlist` did. Same audit-trail role
 * as `RulesApplicationReceipt` but for the LOOT userlist (plugin-to-
 * plugin rules + groups).
 *
 * Same write-once invariant: this struct describes the dispatches we
 * issued at install time, not the current state. Subsequent user
 * edits to userlist (drag-drop in Plugins tab, manual `userlist.yaml`
 * edits, etc.) do NOT update this record.
 */
export type UserlistApplicationReceipt = {
  /** ADD_USERLIST_RULE dispatches we verified landed in state. */
  appliedRuleCount: number;
  /** SET_PLUGIN_GROUP dispatches we verified landed in state. */
  appliedGroupAssignmentCount: number;
  /**
   * SET_PLUGIN_GROUP dispatches that overwrote a different
   * pre-existing user group assignment for the same plugin. Subset
   * of `appliedGroupAssignmentCount` (not in addition to it).
   */
  overwrittenGroupAssignmentCount: number;
  /** ADD_PLUGIN_GROUP dispatches that created a new group. */
  appliedNewGroupCount: number;
  /** ADD_GROUP_RULE dispatches we verified landed in state. */
  appliedGroupRuleCount: number;
  /**
   * Manifest userlist entries we couldn't apply, with a verbose
   * actionable reason. See `SkippedUserlistEntry` in
   * `applyUserlist.ts` for shape semantics.
   */
  skippedUserlistEntries: ReceiptSkippedUserlistEntry[];
};

export type ReceiptSkippedUserlistEntry = {
  /** What kind of manifest entry we were trying to apply. */
  kind:
    | "plugin-rule"
    | "plugin-group"
    | "group-definition"
    | "group-rule";
  /** Human-readable identifier (plugin or group name). */
  subject: string;
  /** Optional: rule kind for plugin rules. */
  ruleKind?: "after" | "req" | "inc";
  /** Optional: reference (other plugin / other group) for plugin and group rules. */
  reference?: string;
  /** Verbose actionable explanation. */
  reason: string;
};

export type ReceiptSkippedRule = {
  ruleType: string;
  source: string;
  reference: string;
  reason: string;
};

export type ReceiptSkippedLoadOrderEntry = {
  compareKey: string;
  pos: number;
  reason: string;
};

export type ReceiptPluginEntry = {
  name: string;
  enabled: boolean;
  /**
   * The curator's ESL / "light" flag, when the package recorded one.
   *
   * Carried so Doctor can tell whether the flags are STILL right. The flag
   * lives in the plugin file's header, and under copy deployment a Vortex
   * purge rewrites those files from staging — silently undoing the repair.
   * With 1421 of 1607 plugins light on a real profile, losing them puts the
   * setup hundreds of plugins over the 254 limit and the game stops starting.
   *
   * Absent means the package recorded nothing, never "not light".
   */
  light?: boolean;
};

/**
 * On-disk per-mod verification record. The driver writes one of
 * these for every mod in `installedMods` (and never for skipped /
 * carried mods — those weren't installed by this run, so verifying
 * them would conflate "did Vortex truncate during this install"
 * with "is the user's mod folder still pristine months later").
 *
 * `kind === "ok"` ⇒ everything matched. `verifiedFileCount` is the
 *   number of files we cross-referenced. `extraFileCount` (always
 *   ≥ 0) reports user-side files outside the manifest's snapshot —
 *   informational, not a problem (FOMOD divergence, mod version
 *   drift, etc.).
 *
 * `kind === "skip"` ⇒ we did not run the comparison. `reason` says
 *   why (manifest had no stagingFiles for this mod, or
 *   verificationLevel="none").
 *
 * `kind === "fail"` ⇒ at least one mismatch was detected.
 *   `missingFileCount` / `sizeMismatchCount` / `hashMismatchCount`
 *   are the bucketed counts; `examples` carries up to 10 sample
 *   paths PER bucket so the user gets actionable detail in the
 *   Done card without bloating the receipt JSON for huge mods.
 *   `retryAttempted` is true when we attempted a reinstall+reverify
 *   cycle. `retrySucceeded` is true when that recovery worked
 *   (even though the FINAL `kind` is "fail" — we keep `kind` as
 *   "fail" only when the LAST verify still failed; recovered mods
 *   surface as `kind === "ok"` with `retryAttempted: true`).
 */
export type ModVerificationReceipt =
  | ModVerificationOkReceipt
  | ModVerificationSkipReceipt
  | ModVerificationFailReceipt;

export type ModVerificationOkReceipt = {
  vortexModId: string;
  compareKey: string;
  /** Display name. UI-only, captured at verify time. */
  name: string;
  kind: "ok";
  /** verificationLevel that was actually run for this mod. */
  level: "fast" | "thorough";
  verifiedFileCount: number;
  /** Files on disk not in the manifest snapshot (FOMOD divergence). */
  extraFileCount: number;
  /**
   * True when the initial verify failed but a one-shot reinstall
   * recovered the mod. Surfaced in the Done card as a soft
   * warning ("we re-installed mod X to fix lost files").
   */
  retryAttempted?: boolean;
};

export type ModVerificationSkipReceipt = {
  vortexModId: string;
  compareKey: string;
  name: string;
  kind: "skip";
  reason: ModVerificationSkipReason;
};

export type ModVerificationSkipReason =
  | "no-staging-files-in-manifest"
  | "verification-level-none"
  | "vortex-mod-missing-from-state"
  | "install-path-unresolvable"
  /**
   * The curator answered "ship my files" for this mod, so the package carries
   * its exact bytes and a later phase writes them.
   *
   * Not "ok" and not "fail": at the moment verification runs, the folder is
   * genuinely wrong AND is genuinely about to be corrected. Calling it "fail"
   * cost an uninstall, a re-download and a curator report for a mod nobody
   * needed to fix; calling it "ok" would claim a check that had not happened.
   * The mirror pass reports what it actually did.
   */
  | "pending-mirror"
  | "errored";

export type ModVerificationFailReceipt = {
  vortexModId: string;
  compareKey: string;
  name: string;
  kind: "fail";
  level: "fast" | "thorough";
  expectedFileCount: number;
  missingFileCount: number;
  sizeMismatchCount: number;
  hashMismatchCount: number;
  /** Up to ~30 representative paths across all buckets. */
  examples: ModVerificationFailExample[];
  /** True when a reinstall+reverify cycle was attempted. */
  retryAttempted: boolean;
  /**
   * True when retry FIXED the mismatch. When this is true, callers
   * should expect `kind === "ok"` instead — the type system can't
   * narrow that automatically, but the runtime always upgrades the
   * record on success. Surfaced as `false` here purely for receipts
   * representing genuine post-retry failures.
   */
  retrySucceeded: boolean;
  /**
   * The repair uninstalled this mod and could not reinstall it, so it is no
   * longer on the machine.
   *
   * Its own field because it collapsed into `retryAttempted: true` alongside
   * two outcomes that mean the opposite — "reinstalled, still mismatching"
   * and "reinstalled under a new id, re-check errored" both leave a working
   * mod on disk. Only this one means the user lost it, and a receipt that
   * cannot tell those apart is not a report.
   */
  modRemoved?: boolean;
};

export type ModVerificationFailExample = {
  bucket: "missing" | "size" | "hash";
  path: string;
  /** For size: the manifest's expected size. For hash: expected sha256. */
  expected?: string;
  /** For size: the on-disk size. For hash: actual sha256. */
  actual?: string;
};

export type InstallTargetMode = "current-profile" | "fresh-profile";

/**
 * A single mod the driver installed (or marked as already-installed
 * and re-used) as part of this collection release.
 *
 * The shape is deliberately narrow — only what the resolver and the
 * eventual UI need. The full mod state lives on the Vortex side; the
 * receipt only carries the lineage tag.
 */
export type InstallReceiptMod = {
  /**
   * Vortex's internal mod id at install time. Stable per-machine;
   * the resolver uses this to find the matching `InstalledMod` in
   * Vortex state.
   */
  vortexModId: string;
  /**
   * The `compareKey` the manifest used at install time. The resolver
   * cross-checks this against the new manifest's compareKeys to
   * detect orphans.
   */
  compareKey: string;
  /** Mirrors `manifest.mods[i].source.kind`. UI-only. */
  source: "nexus" | "external";
  /** UI-only snapshot of the mod's display name at install time. */
  name: string;
  /** ISO-8601 UTC of when this specific mod was installed. */
  installedAt: string;
  /**
   * Fingerprint of this mod's staged files AS WE LEFT THEM.
   *
   * The reference for drift detection on a later update — and deliberately a
   * reference to OUR OWN work on THIS machine, never to the curator's disk.
   * A curator's staging can diverge from its archive in ways nobody notices
   * (post-install tooling, a file Vortex silently lost during their install),
   * so using it as the etalon would promote their accident to truth. This
   * hash makes only one claim, and it is one we can stand behind: this is
   * what the collection put here.
   *
   * A later mismatch therefore means "this changed since we installed it",
   * which is a fact — never "this is wrong", which would not be.
   *
   * Optional: absent on receipts written before it existed, and on a
   * "fast"-level install with no per-file sha256 to build one from. Absent
   * means UNKNOWN, and must never be read as "unchanged".
   */
  stagingSetHash?: string;

  /**
   * Did Event Horizon PUT this mod here, or did it merely recognise one the
   * user already had?
   *
   * ─── WHY THIS EXISTS (NS-2) ───────────────────────────────────────────
   * The receipt describes "what this collection controls on this machine",
   * and until now it could not say who created any of it. `buildReceipt`
   * folds installed and carried mods into one array, and for an
   * `*-already-installed` decision the entry's `vortexModId` is the USER'S
   * mod id — so "Uninstall this collection" walked the whole list and
   * uninstalled every one. On a real run that is 1,755 mods of which 1,591
   * were adopted: the tool would have deleted 1,591 mods it never installed.
   *
   * The install journal knows this, but it is deleted on success, so the
   * fact has to live somewhere durable. Here.
   *
   * `"installed"` — this run (or an earlier run of this collection) created
   *   the mod. Safe to remove on uninstall.
   * `"adopted"` — the mod was already in the user's pool and we reused it.
   *   MUST NOT be removed.
   *
   * Optional: absent on receipts written before this field existed. Absent
   * means UNKNOWN, and an unknown must be treated as adopted — refusing to
   * delete something we cannot prove is ours is the only safe direction.
   */
  ownership?: "installed" | "adopted";
};

/** What the install wrote into the user's INI files, and what it left. */
export type GameIniApplicationReceipt = {
  /** Settings whose value this install changed or added. */
  appliedCount: number;
  /** Settings already at the collection's value — nothing to do. */
  alreadyMatchedCount: number;
  /** Per-file, human-readable `key: before → after` lines. */
  changes: string[];
  /** Files the collection had settings for but that could not be written. */
  failed: Array<{ fileName: string; reason: string }>;
};
