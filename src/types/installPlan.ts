/**
 * Resolver input/output contract — `InstallPlan` and `UserSideState`.
 *
 * The Phase 3 resolver is a pure function:
 *
 *     resolveInstallPlan(manifest, userState) → InstallPlan
 *
 * - {@link UserSideState} is the narrowed projection of Vortex Redux
 *   state the resolver consumes. The Phase 3 action handler (slice 5)
 *   builds one from live state; the resolver never reads state itself.
 * - {@link InstallPlan} is the typed description of "what would happen
 *   if we installed this collection right now." It enumerates per-mod
 *   decisions, aggregate compatibility checks, plugin-order replacement
 *   intent, and external-dependency verification.
 *
 * The plan **describes intent**, never executes. The install driver
 * (slice 6) is the only thing that mutates filesystem or Vortex state,
 * and it reads from this plan exclusively.
 *
 * Specs:
 *  - business behavior:  docs/business/INSTALL_PLAN_SCHEMA.md
 *  - identity rule:      docs/PROPOSAL_INSTALLER.md §5.5 (LOAD-BEARING)
 *  - manifest contract:  docs/business/MANIFEST_SCHEMA.md
 *
 * INVARIANTS (enforced by the resolver, expected by the install driver):
 *  - This file is type-only. No runtime code, no enums-with-values, no
 *    consts. Adding runtime here changes the dependency graph; keep it
 *    inert.
 *  - Every per-mod decision is a discriminated union on `decision.kind`.
 *    Adding a new decision = adding a new arm of the union; the
 *    install driver's `switch` is forced to handle it.
 *  - Decisions describe intent, not commands. A `replace-existing`
 *    recommendation is a suggestion the action handler/UI surfaces to
 *    the user, not an instruction the driver executes blindly.
 *  - `compareKey` strings reference {@link EhcollManifest.mods} entries
 *    by their `compareKey`, same scheme as `docs/business/AUDITOR_MOD.md`.
 *  - All SHA-256 strings are lowercase hex, exactly 64 characters.
 */

import type {
  EhcollExternalDependency,
  EhcollManifest,
  GameVersionPolicy,
  ModRuleType,
  SupportedGameId,
  VortexDeploymentMethod,
} from "./ehcoll";
import type { GameIniApplicationReceipt } from "./installLedger";

// ===========================================================================
// USER-SIDE STATE (resolver input)
// ===========================================================================

/**
 * The full input the resolver consumes. Built by the Phase 3 action
 * handler from Vortex Redux state + a SHA-256 enrichment pass over
 * downloads. The resolver itself never reads Vortex state.
 *
 * INVARIANT: this is a *snapshot*. The resolver runs synchronously
 * over a frozen view; if the user installs another mod mid-resolve we
 * pick it up on the next plan recomputation.
 */
export type UserSideState = {
  /**
   * The Vortex `gameId` the user has active. Compared against
   * `manifest.game.id` — mismatch produces a categorical
   * compatibility error (the plan refuses to proceed).
   */
  gameId: string;

  /**
   * User's installed game version when known. Compared against
   * `manifest.game.version` per `manifest.game.versionPolicy`.
   * Optional because Vortex doesn't always know the version cleanly
   * (e.g. unmanaged installs).
   */
  gameVersion?: string;

  /** User's Vortex client version. Informational; warn-only mismatches. */
  vortexVersion: string;

  /**
   * User's Vortex deployment method. Informational — the driver
   * respects whatever the user has set; the resolver only cross-checks
   * against `manifest.vortex.deploymentMethod` for the warning list.
   */
  deploymentMethod?: VortexDeploymentMethod;

  /**
   * Which store's copy of the game the USER has — `steam`, `gog`, …
   *
   * Compared against `manifest.game.store`. The two stores ship identical
   * version numbers and different executables, so a script-extender plugin
   * built for one does not load on the other and an `exact` version check
   * passes regardless. Absent means Vortex could not say, and an unknown is
   * never reported as a mismatch.
   */
  store?: string;

  /**
   * Vortex extensions currently enabled (id + version when known).
   * Cross-checked against `manifest.vortex.requiredExtensions`.
   */
  enabledExtensions: EnabledExtension[];

  /**
   * Active Vortex profile id. The narrowed view of `installedMods`
   * (specifically each entry's `enabled` flag) is taken in the
   * scope of THIS profile — but the mod entries themselves come from
   * the global `state.persistent.mods[gameId]` pool, which is shared
   * across all profiles.
   *
   * Used by the resolver to populate `InstallPlan.installTarget`
   * when staying in-place, and by the action handler to decide
   * which profile to read enabled-state from.
   */
  activeProfileId: string;

  /** Display name of the active profile. UI-only. */
  activeProfileName: string;

  /**
   * Every mod currently installed in the user's active profile or in
   * `state.persistent.mods[gameId]` regardless of profile membership.
   * Used for "already installed" detection and conflict detection.
   *
   * The resolver matches against this list using the rules in
   * docs/PROPOSAL_INSTALLER.md §5.5: Nexus mods by
   * `(nexusModId, nexusFileId)`, external mods by `archiveSha256`.
   */
  installedMods: InstalledMod[];

  /**
   * Archives present in Vortex's downloads folder, keyed by archive
   * id. NOT necessarily installed as mods — this lets the resolver
   * say "skip download, the user already has this archive on disk."
   *
   * Building this list requires SHA-256 hashing every download (slow
   * on cold cache); the action handler decides when to do that work.
   * If this is `undefined`, the resolver behaves as if no downloads
   * are available — a conservative degradation that loses zero
   * correctness, only ergonomics.
   */
  availableDownloads?: AvailableDownload[];

  /**
   * Per-external-dependency verification snapshot, when known.
   * Filling this in requires hashing files at game-relative paths;
   * the action handler decides whether to do that on every plan or
   * only on user demand. `undefined` ⇒ resolver emits "not yet
   * verified" decisions for every external dep in the manifest.
   */
  externalDependencyState?: ExternalDependencyVerification[];

  /**
   * Lineage context: the most recent Event Horizon install of the
   * SAME `package.id` as the manifest being resolved, when known.
   *
   * Filled by the action handler from the install ledger
   * (`<appData>/Vortex/event-horizon/installs/<package.id>.json`,
   * written by the Phase 3 install driver — slice 6).
   *
   *  - `undefined` ⇒ first-time install, OR ledger missing/lost.
   *    Orphan detection produces an empty list; every per-mod
   *    decision is treated as a fresh install.
   *  - present ⇒ this is an upgrade (or a reinstall of the same
   *    version). The resolver:
   *      - tags `installedMods[].eventHorizonInstall` for mods the
   *        ledger references (the action handler does this; the
   *        resolver simply trusts the tag),
   *      - emits orphan decisions for mods the ledger lists but the
   *        new manifest doesn't,
   *      - flips conflict tone (the UI surfaces "upgrading from
   *        X to Y" rather than "you have a conflicting mod").
   */
  previousInstall?: PreviousCollectionInstall;
};

export type EnabledExtension = {
  id: string;
  /** Optional — Vortex doesn't always expose extension versions cleanly. */
  version?: string;
};

/**
 * The narrow projection of an installed mod the resolver consumes.
 * Subset of the existing `AuditorMod` shape (intentionally narrow —
 * the resolver doesn't need FOMOD selections, file overrides, etc.).
 */
export type InstalledMod = {
  /** Vortex's internal mod id. Stable per machine; never used for cross-machine identity. */
  id: string;
  /** Display name. UI-only. NEVER used for identity matching (see §5.5). */
  name: string;
  /** Nexus identity, when known. */
  nexusModId?: number;
  nexusFileId?: number;
  /**
   * SHA-256 of the source archive bytes. The resolver's identity
   * oracle for both Nexus and external mods. Optional because
   * un-enriched snapshots may lack it; absence is treated as
   * "byte-identity unknown" not "different bytes."
   */
  archiveSha256?: string;
  /**
   * Deterministic SHA-256 over the user's deployed staging folder
   * for this mod (file list aggregated by relative path + size +
   * sha256). The fallback identity oracle for external mods that
   * have no `archiveSha256` (Vortex didn't retain the original
   * archive — manual install, sideload, archive purged).
   *
   * Only populated when:
   *  1. the manifest carries `stagingSetHash` for at least one
   *     external mod (so there is something to match against), AND
   *  2. the action handler has chosen to enrich this mod's snapshot
   *     because its name matches an external manifest entry (we
   *     skip mods with no name candidate to bound the cost — see
   *     `enrichModsWithStagingSetHashes`).
   *
   * Absence is treated identically to `archiveSha256` absence:
   * "byte-identity unknown" — the resolver falls through to the
   * next ladder rung (bundled-install, prompt-user, etc.), never
   * "different bytes."
   *
   * Format: lowercase hex, exactly 64 characters when present.
   */
  stagingSetHash?: string;
  /** Whether the mod is currently enabled in the active profile. */
  enabled: boolean;
  /**
   * Lineage tag attached by the action handler when the install
   * ledger says THIS mod was put here by an Event Horizon install.
   *
   *  - `undefined` ⇒ either the ledger doesn't know about this mod
   *    (user installed it manually or with another tool), OR
   *    `userState.previousInstall` is itself undefined.
   *  - present ⇒ the resolver knows this mod is "ours." Used for
   *    orphan detection (mods we installed last release that the
   *    new manifest no longer references) and for upgrade-tone
   *    framing in the UI.
   *
   * INVARIANT: the resolver NEVER infers this tag itself — names,
   * paths, and Nexus IDs are insufficient. Only the install ledger
   * is authoritative. If the ledger is lost, lineage is lost; the
   * resolver degrades to fresh-install behavior, never guesses.
   */
  eventHorizonInstall?: ModEventHorizonInstallTag;
};

/**
 * Per-mod lineage tag derived from the install ledger. Identifies
 * a mod as having been installed by a specific previous release of
 * a specific Event Horizon collection.
 */
export type ModEventHorizonInstallTag = {
  /** `package.id` of the collection that installed this mod. */
  collectionPackageId: string;
  /** `package.version` (semver) of that release. */
  collectionVersion: string;
  /**
   * The `compareKey` the previous manifest used for this mod.
   * Cross-checked against the new manifest's `compareKey`s to
   * detect orphans and to disambiguate version drift.
   */
  originalCompareKey: string;
  /** ISO-8601 UTC of when the install completed. UI-only. */
  installedAt: string;
};

/**
 * Pointer to the previous Event Horizon install of the same
 * `package.id`. Carried into the resolver via `UserSideState`,
 * mirrored on `InstallPlan` so downstream consumers can surface
 * the upgrade context.
 */
export type PreviousCollectionInstall = {
  /** Always equal to `manifest.package.id` of the manifest being resolved. */
  packageId: string;
  /** Semver of the previously-installed release. */
  packageVersion: string;
  /** ISO-8601 UTC of when that install completed. */
  installedAt: string;
  /** Number of mods the ledger says were installed. UI-only. */
  modCount: number;
  /**
   * What the previous install did to the user's game INI, if anything.
   *
   * Read by `shouldApplyGameIni` to keep the promise its own user-facing text
   * makes — "this is done once per version and never re-applied". The field
   * did not exist, so that check compared `undefined !== undefined`, was
   * always false, and every re-run of the same release rewrote the user's INI
   * and reverted every edit they had made since. The parameter was typed
   * `unknown`, so nothing caught it.
   *
   * Absent means the previous install did NOT apply settings — including when
   * the phase was skipped because the user stopped the run, which must stay
   * distinguishable from "applied", or the fix turns into permanent
   * suppression.
   */
  gameIniApplication?: GameIniApplicationReceipt;
};

export type AvailableDownload = {
  /** Vortex archive id (key in `state.persistent.downloads.files`). */
  archiveId: string;
  /** Absolute path to the archive on disk. */
  localPath: string;
  /**
   * SHA-256 of the bytes. Mandatory — without a hash the download is
   * useless to the resolver (we can't trust filenames per §5.5).
   */
  sha256: string;
  /** Original filename hint, for UI display only. */
  fileName?: string;
};

/**
 * Result of hashing the files an external dependency declares it owns.
 * One entry per dependency, identified by `EhcollExternalDependency.id`.
 */
export type ExternalDependencyVerification = {
  /** Matches `EhcollExternalDependency.id` in the manifest. */
  id: string;
  /**
   * Per-file verification result. Keyed by `relPath` from the
   * manifest's external-dep file list. A file the user hasn't
   * installed yet shows up as `presence: "missing"`.
   */
  files: ExternalDependencyFileResult[];
};

export type ExternalDependencyFileResult = {
  relPath: string;
  presence: "present" | "missing";
  /** Defined when `presence === "present"`. */
  actualSha256?: string;
};

// ===========================================================================
// INSTALL TARGET (where the install will land)
// ===========================================================================

/**
 * Where this plan is going to be installed. Picked by the action
 * handler BEFORE the resolver runs, then mirrored on the plan.
 *
 * **The hard rule** (LOAD-BEARING):
 *  - Receipt present for `manifest.package.id` ⇒ `current-profile`.
 *    User has lineage; we know what's ours; we upgrade in-place
 *    with the conflict/orphan flow.
 *  - Receipt missing (first install OR ledger lost) ⇒
 *    `fresh-profile`. Forced. No "install into current profile
 *    anyway" escape hatch in v1 — the safety guarantee depends on
 *    isolation.
 *
 * The action handler does NOT consult the user about this choice:
 * if there's no receipt, the user gets a fresh profile, period.
 * (The eventual Phase 5 UI may surface an "I really want to install
 * into my current profile" advanced toggle. v1 does not.)
 *
 * Why fresh-profile is safe: Vortex's mod store
 * (`state.persistent.mods[gameId]`) is GLOBAL across profiles. What's
 * per-profile is only enabled-state, load order, and plugins.txt. A
 * fresh profile means:
 *   - Old profile is byte-untouched (same enabled set, same load order).
 *   - Collection's mods are added to the shared global pool.
 *   - Only the new profile has the collection's mods enabled.
 *   - Switching back to the old profile = collection becomes invisible.
 * Zero collision risk by construction.
 */
export type InstallTarget = InstallIntoCurrentProfile | InstallIntoFreshProfile;

/**
 * Upgrade / reinstall in-place. Picked iff the install ledger
 * carries a receipt for `manifest.package.id`. The plan can include
 * `*-version-diverged`, `*-bytes-diverged`, and orphan decisions —
 * the user will explicitly resolve each before the driver acts.
 */
export type InstallIntoCurrentProfile = {
  kind: "current-profile";
  /**
   * Vortex profile id we will install into: the one the RECEIPT names, which
   * is usually the active profile and is not required to be.
   *
   * It used to be defined as "equals `userState.activeProfileId`", and that
   * definition was the bug. Re-running the same release while sitting on a
   * different profile merged the whole collection — plus a rules purge and a
   * plugins.txt rewrite — into wherever the user happened to be. The Done
   * screen actively invites that: after a partial run it says to switch back
   * to your previous profile, and the retry it also recommends then landed
   * 978 mods there.
   *
   * The version-changed branch of {@link pickInstallTarget} already refuses
   * for this reason. The same-version branch did not.
   */
  profileId: string;
  /** Display name. UI-only. */
  profileName: string;
  /**
   * Set when `profileId` is NOT the profile Vortex is currently on, so the
   * driver switches before touching anything. Absent is the ordinary case.
   */
  switchFromProfileId?: string;
};

/**
 * Forced fresh profile. Picked iff no receipt covers
 * `manifest.package.id`. The driver:
 *   1. Creates a new Vortex profile with `suggestedProfileName`,
 *      appending `(2)` / `(3)` / ... on collision.
 *   2. Switches the user into the new profile (after successful
 *      install completion, with a "switch back to <previous>"
 *      undo notification).
 *   3. Installs every mod in the plan into the global pool, then
 *      enables only the collection's mods in the new profile.
 *   4. Writes `plugins.txt` for the new profile only — the user's
 *      old profile keeps its own.
 *   5. Writes a fresh receipt.
 *
 * In this mode the resolver never emits `*-diverged` decisions:
 * nothing is "already installed" in the new profile yet, so there's
 * nothing to diverge from. The only "already installed" arms it
 * still emits are byte-exact reuses (same Nexus IDs + same SHA, or
 * same external SHA already present in the global pool) — that's
 * deduplication, not collision.
 */
export type InstallIntoFreshProfile = {
  kind: "fresh-profile";
  /**
   * Suggested display name. Format: `"<collection-name> (Event
   * Horizon v<package.version>)"`. The driver may append a
   * disambiguating suffix on collision; the resolver doesn't know
   * the final name, only the suggestion.
   */
  suggestedProfileName: string;
  /**
   * ─── RESUME INTO THE PROFILE THE LAST ATTEMPT MADE ──────────────────
   * An interrupted install leaves no receipt — correctly, a half-finished
   * run has not earned the claim that the collection is installed — so the
   * next run takes this mode again and, until this field existed, created
   * ANOTHER profile. A tester who restarted five times got five profiles:
   * five `install.start` lines in one log, five different `profileId`s.
   *
   * That is worse than untidy. Enablement is per-profile, so every mod the
   * earlier runs installed reads "Disabled" in the newest profile until the
   * resume walks past it again — and Vortex reopens on whichever profile
   * was last active, so the user is often looking at a different one
   * entirely. They reasonably reported that Event Horizon installs mods
   * disabled. It does not; their log showed 1,106 of 1,106 enabled, in a
   * profile they were not looking at.
   *
   * Set only when a recorded attempt for this `package.id` names a profile
   * that STILL EXISTS for this game — the caller checks, because a user who
   * deleted it means it, and creating a fresh one is the right answer then.
   *
   * The mode stays `fresh-profile` deliberately. This says WHERE the run
   * lands, not that a previous RELEASE was installed: `previousInstall`
   * remains undefined and orphan detection stays off, because an interrupted
   * attempt is not a prior install and its mods are not orphans.
   */
  resumeProfileId?: string;
  /** Display name of {@link resumeProfileId}. UI-only. */
  resumeProfileName?: string;
  /**
   * Why no profile is being resumed, when none is.
   *
   * Set on the CREATE path so the log can say which of the reasons applied.
   * There are five, and all of them used to be the same silence — so a tester
   * who still got a new profile every run produced a log in which "the
   * attempt record had no profile id" was indistinguishable from "this build
   * does not have the fix".
   */
  /**
   * The profile id the attempt record named, when the resume was refused
   * because of it.
   *
   * So a reader can check the claim. "profile-deleted" without the id is
   * unfalsifiable: the curator cannot tell whether the profile really is gone
   * or whether we looked for the wrong one.
   */
  resumeRefusedProfileId?: string;
  resumeRefusedWhy?:
    | "no-attempt"
    | "attempt-has-no-profile"
    | "profile-deleted"
    | "profile-other-game"
    | "version-changed";
};

// ===========================================================================
// INSTALL PLAN (resolver output)
// ===========================================================================

/**
 * Top-level shape of the resolver's output. Carries every signal the
 * install driver, the action handler, and the eventual UI need.
 *
 * INVARIANT: `modResolutions.length === manifest.mods.length`, and
 * `modResolutions[i].compareKey === manifest.mods[i].compareKey`.
 * The resolver never reorders, drops, or duplicates mods.
 *
 * INVARIANT: when `previousInstall` is defined the plan represents
 * an upgrade/reinstall of `previousInstall.packageId` and
 * `installTarget.kind` MUST be `"current-profile"`; when undefined
 * it is a fresh install and `installTarget.kind` MUST be
 * `"fresh-profile"`. The two fields are co-determined by the
 * receipt; the action handler picks both atomically.
 */
export type InstallPlan = {
  /** The manifest the plan was resolved against. Carried by reference. */
  manifest: EhcollManifest;
  /**
   * Where this install will land. Co-determined with
   * `previousInstall`:
   *  - receipt present ⇒ `current-profile` + `previousInstall` set.
   *  - receipt missing ⇒ `fresh-profile` + `previousInstall`
   *    undefined (first install OR lineage lost; same protection
   *    either way).
   */
  installTarget: InstallTarget;
  /**
   * The previous Event Horizon install of the same `package.id`,
   * mirrored from `userState.previousInstall`. `undefined` ⇒ fresh
   * install (and `installTarget.kind === "fresh-profile"`). Surfaced
   * on the plan so consumers don't have to keep the `userState`
   * around.
   */
  previousInstall?: PreviousCollectionInstall;
  /** Aggregate environment compatibility (game id, game version, extensions, deploy method). */
  compatibility: CompatibilityReport;
  /** Per-mod decisions, in the same order as `manifest.mods`. */
  modResolutions: ModResolution[];
  /**
   * Mods the ledger says we installed for a previous release of the
   * SAME `package.id` but the new manifest no longer references.
   *
   * Empty when:
   *  - `previousInstall` is undefined (fresh install — nothing to
   *    orphan against), OR
   *  - the previous and new manifests reference the same set of
   *    `compareKey`s.
   *
   * Never auto-uninstalled. Every entry's `recommendation` is set by
   * the resolver to a value the action handler/UI MUST surface to
   * the user before any destructive action.
   */
  orphanedMods: OrphanedModDecision[];
  /** Per-external-dependency decisions, in the same order as `manifest.externalDependencies`. */
  externalDependencies: ExternalDependencyDecision[];
  /** Plugin-order replacement plan. Always present (may be a no-op). */
  pluginOrder: PluginOrderPlan;
  /** Mod-rule application plan. Pre-resolved against the user's mod set. */
  rulePlan: RulePlanEntry[];
  /** Aggregate counts and the final "can install proceed" verdict. */
  summary: PlanSummary;
};

// ---------------------------------------------------------------------------
// Compatibility (aggregate environment checks)
// ---------------------------------------------------------------------------

export type CompatibilityReport = {
  /** Categorical: does `userState.gameId` match `manifest.game.id`? */
  gameMatches: boolean;
  /**
   * Game-version check. Categorical "ok" / "mismatch" / "unknown" so
   * the UI can present each case differently. `unknown` means we
   * could not determine the user's version — informational, not fatal.
   */
  gameVersion: VersionCheckResult;
  /** One entry per `manifest.vortex.requiredExtensions`. */
  extensions: ExtensionCheckResult[];
  /** Vortex client version cross-check. Always warning-only. */
  vortexVersion: VortexVersionCheck;
  /** Deployment method cross-check. Always warning-only. */
  deploymentMethod: DeploymentMethodCheck;
  /**
   * Free-form warning lines for the UI. Layered on top of structured
   * checks above; the resolver never relies on this list to make
   * decisions. Things like "user is on hardlink, curator built with
   * symlink" land here.
   */
  warnings: string[];
  /**
   * Free-form fatal lines. When non-empty, `summary.canProceed` is
   * forced false. Things like "game id mismatch" or "required
   * extension X missing" land here.
   */
  errors: string[];
};

export type VersionCheckResult =
  | { status: "ok" }
  | {
      status: "mismatch";
      required: string;
      installed: string;
      policy: GameVersionPolicy;
    }
  | { status: "unknown"; required: string };

export type ExtensionCheckResult = {
  id: string;
  /** Matches the manifest entry. */
  required: { minVersion?: string };
  status: "ok" | "missing" | "tooOld";
  /** Defined when `status !== "missing"`. */
  installedVersion?: string;
};

export type VortexVersionCheck = {
  required: string;
  installed: string;
  status: "ok" | "warn-mismatch";
};

export type DeploymentMethodCheck = {
  /** From the manifest. */
  curator: VortexDeploymentMethod;
  /** From the user. `undefined` ⇒ Vortex didn't expose it. */
  user?: VortexDeploymentMethod;
  status: "ok" | "warn-mismatch" | "unknown";
};

// ---------------------------------------------------------------------------
// Per-mod resolution
// ---------------------------------------------------------------------------

export type ModResolution = {
  /** Mirrors the manifest entry's compareKey. */
  compareKey: string;
  /** Mirrors the manifest entry's display name. UI-only. */
  name: string;
  /**
   * Source kind from the manifest. Discriminator-shadow so consumers
   * can switch on this without walking into `decision.kind`. Always
   * matches `manifest.mods[i].source.kind`.
   */
  sourceKind: "nexus" | "external";
  /** The decision. Discriminated by `kind`. */
  decision: ModDecision;
};

/**
 * Every per-mod decision the resolver can emit. The discriminator is
 * `kind`; `nexus-*` decisions apply to Nexus-sourced mods only,
 * `external-*` to external-sourced.
 */
export type ModDecision =
  | NexusDownloadDecision
  | NexusUseLocalDownloadDecision
  | NexusAlreadyInstalledDecision
  | NexusVersionDivergedDecision
  | NexusBytesDivergedDecision
  | NexusUnreachableDecision
  | ExternalUseBundledDecision
  | ExternalUseLocalDownloadDecision
  | ExternalAlreadyInstalledDecision
  | ExternalBytesDivergedDecision
  | ExternalPromptUserDecision
  | ExternalMissingDecision;

// ----- Nexus arms ----------------------------------------------------------

/** No matching mod or download; queue a Nexus download via Vortex's integration. */
export type NexusDownloadDecision = {
  kind: "nexus-download";
  gameDomain: string;
  modId: number;
  fileId: number;
  /** Bytes the curator built against. Driver verifies after download. */
  expectedSha256: string;
  /** UI hint; not load-bearing for the download call. */
  archiveName: string;
};

/**
 * The exact archive bytes are already in Vortex's downloads folder.
 * Skip the network round-trip; install from the local archive.
 */
export type NexusUseLocalDownloadDecision = {
  kind: "nexus-use-local-download";
  archiveId: string;
  localPath: string;
  /** Already verified by the resolver against the manifest. */
  sha256: string;
};

/**
 * The user already has this exact mod installed (Nexus IDs match
 * AND archive sha256 matches). The driver re-uses the existing
 * mod entry; no download, no install.
 */
export type NexusAlreadyInstalledDecision = {
  kind: "nexus-already-installed";
  existingModId: string;
};

/**
 * The user has this Nexus mod installed but at a different file id.
 * The driver does NOT auto-replace — the action handler/UI must
 * confirm a recommendation with the user before any destructive op.
 *
 * **Only emitted when `installTarget.kind === "current-profile"`.**
 * In fresh-profile mode there's nothing to be diverged from
 * (the new profile starts empty); the resolver emits
 * `nexus-download` instead and the user's existing fileId
 * stays untouched in the global pool.
 */
export type NexusVersionDivergedDecision = {
  kind: "nexus-version-diverged";
  existingModId: string;
  existingFileId: number;
  requiredFileId: number;
  /**
   * Resolver's suggested action. Always one of these three:
   *  - `replace-existing`  → uninstall current, install required.
   *  - `keep-existing`     → leave it; will likely cause drift later.
   *  - `manual-review`     → no clear recommendation; ask the user.
   * The action handler/UI is the only authority that decides.
   */
  recommendation: ConflictRecommendation;
};

/**
 * Nexus IDs match but the bytes don't. The user's archive cache
 * contains different bytes from what the curator built against —
 * Nexus may have silently re-uploaded the file under the same id
 * (rare but documented), or the user's archive is corrupt.
 *
 * **Only emitted when `installTarget.kind === "current-profile"`.**
 * In fresh-profile mode the resolver re-downloads to get the
 * curator's exact bytes; the user's drifted copy is left in place.
 */
export type NexusBytesDivergedDecision = {
  kind: "nexus-bytes-diverged";
  existingModId: string;
  existingSha256: string;
  expectedSha256: string;
  recommendation: ConflictRecommendation;
};

/**
 * The mod cannot be reached. The resolver doesn't actually call
 * Nexus — it flags structural issues like "manifest's gameDomain
 * doesn't match the user's active gameId family" or "manifest entry
 * is missing the modId/fileId pair the resolver requires."
 *
 * `reason` is a short, plain-English summary the UI can show.
 */
export type NexusUnreachableDecision = {
  kind: "nexus-unreachable";
  reason: string;
};

// ----- External arms -------------------------------------------------------

/** Archive is in the .ehcoll's `bundled/<sha256>.<ext>` entry. */
export type ExternalUseBundledDecision = {
  kind: "external-use-bundled";
  sha256: string;
  /** Path inside the .ehcoll, e.g. `"bundled/abc...123.zip"`. */
  zipPath: string;
};

/**
 * Archive is in Vortex's downloads folder with a matching SHA-256.
 * The driver installs from there; no user prompt, no bundled extract.
 */
export type ExternalUseLocalDownloadDecision = {
  kind: "external-use-local-download";
  sha256: string;
  archiveId: string;
  localPath: string;
};

/** User already has this exact external mod installed (SHA-256 match). */
export type ExternalAlreadyInstalledDecision = {
  kind: "external-already-installed";
  existingModId: string;
};

/**
 * The user has an external mod *installed* whose name matches but
 * whose bytes don't. The discriminator from `external-already-installed`:
 * here, the `archiveSha256` differs.
 *
 * Detection requires the resolver to find a candidate match. Today
 * the only candidate ladder we trust is "any installed external mod
 * with the same `compareKey` after the manifest's `compareKey` is
 * synthesized as `external:<sha256>`" — which by construction means
 * the SHA matched, so this branch is currently *unreachable through
 * compareKey matching alone*. It exists in the type set for future
 * heuristics (e.g. matching by archiveName + version metadata) and to
 * make the discriminated union exhaustive.
 *
 * The Phase 3 slice 4 resolver will not emit this until that future
 * heuristic lands; included here so the install driver's switch is
 * forced to compile against it.
 */
export type ExternalBytesDivergedDecision = {
  kind: "external-bytes-diverged";
  existingModId: string;
  existingSha256: string;
  expectedSha256: string;
  recommendation: ConflictRecommendation;
};

/**
 * Archive is not bundled, not in downloads, not installed. The user
 * must point us at a local file. The driver opens a file picker
 * pre-filled with `expectedFilename`; if the user picks something
 * with the wrong sha, the driver re-prompts up to 3× (per §5.5)
 * before failing.
 */
export type ExternalPromptUserDecision = {
  kind: "external-prompt-user";
  expectedFilename: string;
  /**
   * Archive sha256 the manifest pinned, when known. Absent for
   * archive-less external mods (curator has no archive bytes; the
   * mod is identified solely by `expectedStagingSetHash`).
   */
  expectedSha256?: string;
  /**
   * Staging-set hash the manifest pinned, when known. Used as the
   * fallback identity oracle when `expectedSha256` is absent (or as
   * a secondary check when both are present).
   */
  expectedStagingSetHash?: string;
  /** Curator's free-form prose for the prompt. */
  instructions?: string;
  /** Where to get it, when the manifest carries a link. http(s) only. */
  url?: string;
  /** What kind of link `url` is. See ExternalModSource.downloadMode. */
  downloadMode?: "direct" | "browse" | "manual";
};

/**
 * The mod cannot be obtained without external action. Distinguished
 * from `external-prompt-user` by intent: this kind appears when
 * `manifest.package.strictMissingMods === true` and the resolver has
 * already concluded the user can't supply the file. In strict mode
 * `summary.canProceed` is forced false.
 *
 * In lenient mode this kind is never emitted by the resolver —
 * `external-prompt-user` is used instead, deferring the decision to
 * install time when the driver can re-prompt.
 */
export type ExternalMissingDecision = {
  kind: "external-missing";
  expectedFilename: string;
  /**
   * Archive sha256 the manifest pinned, when known. Absent for
   * archive-less external mods.
   */
  expectedSha256?: string;
  /**
   * Staging-set hash the manifest pinned, when known. Used as the
   * fallback identity oracle when `expectedSha256` is absent.
   */
  expectedStagingSetHash?: string;
  instructions?: string;
  /** Where to get it, when the manifest carries a link. http(s) only. */
  url?: string;
};

/**
 * Suggested action for a conflict.
 *
 * **v1 POLICY (LOAD-BEARING)**: the resolver ALWAYS emits
 * `"manual-review"` for every conflict arm. The two other values are
 * reserved for future heuristics (e.g. "the user's installed file is
 * archived on Nexus and can't be redownloaded — recommend keep") but
 * v1 never fires them.
 *
 * Even when a future heuristic fires `"replace-existing"`, the
 * action handler/UI is contractually required to confirm with the
 * user before the install driver acts. This is defense-in-depth:
 *  1. Resolver suggests (v1: never destructive).
 *  2. Action handler/UI surfaces the suggestion + user picks.
 *  3. Driver ONLY acts on a user-confirmed decision, never on
 *     `recommendation` directly.
 *
 * The driver's contract: if it sees ANY `*-diverged` decision in the
 * plan and the action handler did not pass an explicit user choice
 * for that mod, it MUST skip the mod and surface a drift entry.
 * "Replace existing" is never an automatic outcome.
 *
 * Why so conservative: per the user's design intent, this installer
 * exists because Vortex's vanilla collections "always do" destructive
 * version upgrades silently. Our v1 stance is the opposite: nothing
 * destructive happens without an explicit user click.
 */
export type ConflictRecommendation =
  | "replace-existing"
  | "keep-existing"
  | "manual-review";

// ---------------------------------------------------------------------------
// External-dependency decisions
// ---------------------------------------------------------------------------

export type ExternalDependencyDecision = {
  /** Matches `EhcollExternalDependency.id` in the manifest. */
  id: string;
  /** Display name from the manifest. UI-only. */
  name: string;
  /** Discriminated by `kind`. */
  status: ExternalDependencyStatus;
};

export type ExternalDependencyStatus =
  | { kind: "ok" }
  | {
      kind: "files-mismatch";
      /**
       * Per-file mismatch detail. Empty array iff the dep is missing
       * entirely (in which case `kind` is `"missing"`, not this).
       */
      mismatches: ExternalDependencyFileMismatch[];
    }
  | {
      kind: "missing";
      /**
       * UI hint — what the user needs to do. Mirrors
       * `EhcollExternalDependency.instructions`.
       */
      instructions: string;
      instructionsUrl?: string;
    }
  | {
      /**
       * The user has not yet been asked to verify; the action handler
       * deferred the I/O. The UI surfaces a "verify now" button.
       */
      kind: "not-verified";
    };

export type ExternalDependencyFileMismatch = {
  relPath: string;
  expectedSha256: string;
  /** May be `undefined` when the file is missing entirely. */
  actualSha256?: string;
};

// ---------------------------------------------------------------------------
// Orphaned-mod decisions (cross-release lineage)
// ---------------------------------------------------------------------------

/**
 * A mod the install ledger says we put there for a previous release
 * of the same `package.id`, but the new manifest no longer
 * references. Surfaced so the user can decide what to do; never
 * auto-uninstalled.
 *
 * INVARIANT: the resolver only emits these when
 * `userState.previousInstall` is defined (i.e.
 * `installTarget.kind === "current-profile"`) AND the user's
 * `installedMods[i].eventHorizonInstall.collectionPackageId` matches
 * the manifest's `package.id`. If the ledger is absent or doesn't
 * cover a particular mod, that mod is invisible to orphan detection
 * — it appears as a regular installed-mod the resolver doesn't
 * touch. In fresh-profile mode `orphanedMods` is always `[]` by
 * construction.
 */
export type OrphanedModDecision = {
  /** Vortex mod id of the orphan. The driver uses this to act. */
  existingModId: string;
  /** Display name from the previous install. UI-only. */
  name: string;
  /**
   * The `compareKey` the previous manifest used. Surfaced for
   * provenance ("this came from `nexus:1234:5000` in collection v1.0
   * but isn't in v1.1").
   */
  originalCompareKey: string;
  /** Semver of the release that installed it. UI-only. */
  installedFromVersion: string;
  /**
   * What the resolver suggests doing.
   *
   *  - `"keep-installed"` ⇒ leave it alone; user wants the mod
   *    independently of the collection.
   *  - `"recommend-uninstall"` ⇒ since we put it there and the
   *    curator dropped it, suggest removing.
   *  - `"manual-review"` ⇒ no clear opinion.
   *
   * **v1 POLICY**: the resolver ALWAYS emits `"manual-review"`.
   * Same defense-in-depth as {@link ConflictRecommendation}. The
   * action handler/UI is required to confirm before any
   * uninstall.
   */
  recommendation: OrphanRecommendation;
};

export type OrphanRecommendation =
  | "keep-installed"
  | "recommend-uninstall"
  | "manual-review";

// ---------------------------------------------------------------------------
// Plugin order plan
// ---------------------------------------------------------------------------

/**
 * Tells the install driver whether the curator's plugin order needs applying.
 *
 * NOTE — this no longer describes writing `plugins.txt`. The driver pins the
 * order through Vortex (`set-plugin-list` → `autosort-plugins`) and Vortex
 * persists the file; see `applyPluginOrder.ts`. Writing the file directly is
 * pointless because `PluginPersistor` rewrites it from its own state.
 */
export type PluginOrderPlan = {
  /**
   *  - `"replace"` ⇒ the curator's order becomes the order. Plugins the user
   *     has that the collection does not know about are integrated LOOT-style
   *     rather than appended last.
   *  - `"merge"`   ⇒ never emitted. Retained so an older plan still parses;
   *     the merging it was reserved for now happens inside `"replace"`, which
   *     is what collapsed the distinction.
   *  - `"none"`    ⇒ no plugin work needed (manifest has no plugins, or the
   *     user's order already matches).
   */
  kind: "replace" | "merge" | "none";
  /**
   * Number of plugin entries the manifest declares. Surfaced in the
   * UI so the user knows the scope of the change.
   */
  manifestEntryCount: number;
};

// ---------------------------------------------------------------------------
// Mod-rule application plan
// ---------------------------------------------------------------------------

/**
 * One entry per `manifest.rules[i]`. The resolver pre-resolves each
 * rule's `source` / `reference` to a `compareKey` in the user's
 * eventual mod set (after install). Rules whose targets cannot be
 * resolved produce `kind: "skip"` entries with a reason; the driver
 * doesn't apply them but the report surfaces them so the curator
 * knows.
 */
export type RulePlanEntry = {
  /** Index into `manifest.rules` for traceability. */
  manifestRuleIndex: number;
  type: ModRuleType;
  status: RulePlanStatus;
};

export type RulePlanStatus =
  | {
      kind: "apply";
      /** compareKey of the rule's source mod (must be in `manifest.mods`). */
      sourceCompareKey: string;
      /**
       * compareKey of the rule's target mod. May be a partially-pinned
       * reference (e.g. `nexus:1234`) when the manifest used one;
       * the install driver matches against whatever fits at apply time.
       */
      targetCompareKey: string;
    }
  | {
      kind: "skip";
      /** Plain-English description of why the rule cannot be applied. */
      reason: string;
    };

// ---------------------------------------------------------------------------
// Plan summary
// ---------------------------------------------------------------------------

export type PlanSummary = {
  /** `manifest.mods.length`. */
  totalMods: number;
  /**
   * Mods whose decision is `*-already-installed` or
   * `nexus-use-local-download` / `external-use-local-download`. No
   * download work; possibly some install work (when matching only
   * sha matched but the install state needs adjusting).
   */
  alreadyInstalled: number;
  /**
   * Mods that will install without further user input.
   * (`nexus-download`, `external-use-bundled`, `nexus-use-local-download`,
   * `external-use-local-download`.)
   */
  willInstallSilently: number;
  /**
   * Mods that need user action before install can proceed.
   * (`nexus-version-diverged`, `nexus-bytes-diverged`,
   * `external-bytes-diverged`, `external-prompt-user`.)
   */
  needsUserConfirmation: number;
  /**
   * Mods that the resolver concluded cannot be installed.
   * (`nexus-unreachable`, `external-missing`.)
   */
  missing: number;
  /**
   * `orphanedMods.length`. Mods the previous release of THIS
   * collection installed that the new manifest no longer references.
   * Non-blocking — orphans never affect `canProceed`. Surfaced for
   * UI counts only.
   */
  orphans: number;
  /**
   * `manifest.rules.length`. Mod-to-mod rules (file conflict
   * resolution, dependencies) the curator authored. Surfaced in
   * the Preview tile group so users see the scope of curator
   * intent before clicking install.
   *
   * Note: counts ALL rules in the manifest including ones the
   * curator marked as ignored — `applyModRules` filters those at
   * apply time. The pre-install number is a "this collection ships
   * N rules" signal, not a "N rules WILL apply" guarantee. Use the
   * post-install `rulesApplication.appliedRuleCount` for the
   * actual landed count.
   */
  ruleCount: number;
  /**
   * `manifest.loadOrder.length`. Vortex-generic LoadOrder entries
   * (distinct from plugins.txt — this is the per-game LoadOrder API
   * used by games without bethesda-style plugin files).
   */
  loadOrderCount: number;
  /**
   * `manifest.plugins.order.length`. Number of plugins the curator
   * captured in their plugin order baseline. Under the rules-only
   * strategy these are not written manually — LOOT computes the
   * final order from userlist rules — but the count gives users a
   * sense of "this is a 200-plugin collection vs a 5-plugin one".
   */
  pluginOrderCount: number;
  /**
   * `manifest.userlist.plugins.length`. Number of LOOT userlist
   * plugin entries the curator captured (each may carry multiple
   * after/req/inc rules + an optional group assignment).
   */
  userlistPluginCount: number;
  /**
   * `manifest.userlist.groups.length`. Number of LOOT userlist
   * group definitions the curator captured. Surfaced separately
   * because adding new groups is more invasive than per-plugin
   * rules — the user's other collection installs (or hand-authored
   * groups) coexist with these.
   */
  userlistGroupCount: number;
  /**
   * Final verdict. `false` iff:
   *  - `compatibility.errors.length > 0`, OR
   *  - any `compatibility.extensions[i].status !== "ok"` for a required
   *    extension, OR
   *  - `manifest.package.strictMissingMods === true` AND `missing > 0`,
   *    OR
   *  - `manifest.package.strictMissingMods === true` AND any
   *    external-dep status is `missing` or `files-mismatch`.
   *
   * **NOTE**: `needsUserConfirmation > 0` does NOT block
   * `canProceed`. Conflicts (version drift, byte drift, prompt-user)
   * are gated by the action handler/UI, not by the plan: the user
   * must explicitly resolve each one before the driver runs. The
   * plan simply reports them.
   *
   * The action handler/UI uses `canProceed` to gate the "Install"
   * button; conflicts are surfaced as a separate "you have N
   * decisions to make first" gate.
   */
  canProceed: boolean;
};

// ===========================================================================
// Re-exports for one-stop import
// ===========================================================================

export type {
  EhcollManifest,
  EhcollExternalDependency,
  GameVersionPolicy,
  ModRuleType,
  SupportedGameId,
  VortexDeploymentMethod,
};
