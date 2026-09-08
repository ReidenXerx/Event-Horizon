/**
 * UserSideState builder + installTarget picker (Phase 3 slice 5).
 *
 *     buildUserSideState(input) → UserSideState
 *     pickInstallTarget(...)    → InstallTarget
 *
 * The Phase 3 install action handler is the only caller. It feeds:
 *   1. the parsed manifest (from readEhcoll),
 *   2. the install receipt (from installLedger.readReceipt),
 *   3. a freshly-hashed AuditorMod[] from the existing snapshot pipeline
 *      (getModsForProfile + enrichModsWithArchiveHashes),
 *   4. environment metadata pulled out of Vortex's Redux state.
 *
 * The builder shapes those inputs into the narrowed `UserSideState`
 * the resolver consumes, including the load-bearing
 * `installedMods[].eventHorizonInstall` lineage tags. The picker
 * decides between `current-profile` and `fresh-profile` install
 * targets.
 *
 * Spec: docs/business/USER_STATE.md
 *
 * ─── DESIGN ────────────────────────────────────────────────────────────
 * Two rules govern this file:
 *
 * 1. **Pure & sync.** No I/O, no Vortex API calls, no Date.now().
 *    Action-handler responsibility:
 *      - hashing installed-mod archives,
 *      - reading the receipt,
 *      - reading Vortex state.
 *    This file just shapes inputs into the resolver's contract.
 *
 * 2. **Receipt is the only lineage authority** (LOAD-BEARING).
 *    A mod gets `eventHorizonInstall` iff a receipt entry references
 *    its `vortexModId`. We never infer lineage from names, paths,
 *    or Nexus IDs — see docs/business/INSTALL_LEDGER.md for the
 *    rationale.
 *
 * ─── INVARIANTS the resolver relies on ────────────────────────────────
 * - `installTarget.kind === "current-profile"` ⇔ `receipt !== undefined`.
 * - `userState.previousInstall !== undefined` ⇔ `receipt !== undefined`.
 * - The two are co-determined; both come from the same single signal
 *   (does a receipt exist for `manifest.package.id`?).
 * - `pickInstallTarget` enforces the co-determination so the action
 *   handler can't accidentally desync them.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { types } from "@nexusmods/vortex-api";

import type { AuditorMod } from "../getModsListForProfile";
import type {
  EhcollManifest,
  VortexDeploymentMethod,
} from "../../types/ehcoll";
import type {
  InstallReceipt,
  InstallReceiptMod,
} from "../../types/installLedger";
import type {
  AvailableDownload,
  EnabledExtension,
  ExternalDependencyVerification,
  InstallTarget,
  InstalledMod,
  ModEventHorizonInstallTag,
  PreviousCollectionInstall,
  UserSideState,
} from "../../types/installPlan";

// ===========================================================================
// Public API
// ===========================================================================

/**
 * Inputs for {@link buildUserSideState}. Action handler collects each
 * field, then hands them in. Keep this narrow — adding fields here
 * means more state to plumb through the action.
 */
export type BuildUserSideStateInput = {
  /** Vortex's active gameId. Mirrors `selectors.activeGameId(state)`. */
  gameId: string;
  /** Best-effort game version. May be omitted ⇒ resolver emits "unknown". */
  gameVersion?: string;
  /** Vortex client version string. */
  vortexVersion: string;
  /** Resolved deployment method. Optional — resolver downgrades to "unknown". */
  deploymentMethod?: VortexDeploymentMethod;
  /**
   * Which store's copy of the game this user has — `steam`, `gog`, …
   *
   * Absent when Vortex cannot say, and absence is preserved: the store check
   * reports a mismatch only when BOTH sides are known.
   */
  store?: string;
  /** Vortex extensions currently enabled. */
  enabledExtensions: EnabledExtension[];
  /** Active profile id at the time the action ran. */
  activeProfileId: string;
  /** Active profile display name. UI-only. */
  activeProfileName: string;
  /**
   * The user's installed mods, already enriched with `archiveSha256`
   * by the action handler (via `enrichModsWithArchiveHashes`). The
   * builder DOES NOT hash; absence of `archiveSha256` on a mod is
   * forwarded as "byte-identity unknown" per the resolver's contract.
   */
  installedMods: AuditorMod[];
  /**
   * The most recent receipt covering `manifest.package.id`, or
   * `undefined` when none exists. Drives both
   * `userState.previousInstall` AND the {@link pickInstallTarget}
   * decision.
   */
  receipt: InstallReceipt | undefined;
  /**
   * Vortex downloads with known SHA-256, when the action handler has
   * chosen to enrich them. Optional — resolver behaves as if no
   * downloads exist when omitted.
   */
  availableDownloads?: AvailableDownload[];
  /**
   * External-dependency verification snapshot, when known. Optional
   * — resolver emits `not-verified` for every dep when omitted.
   */
  externalDependencyState?: ExternalDependencyVerification[];
};

export function buildUserSideState(
  input: BuildUserSideStateInput,
): UserSideState {
  return {
    gameId: input.gameId,
    gameVersion: input.gameVersion,
    vortexVersion: input.vortexVersion,
    deploymentMethod: input.deploymentMethod,
    store: input.store,
    enabledExtensions: input.enabledExtensions,
    activeProfileId: input.activeProfileId,
    activeProfileName: input.activeProfileName,
    installedMods: projectInstalledMods(input.installedMods, input.receipt),
    availableDownloads: input.availableDownloads,
    externalDependencyState: input.externalDependencyState,
    previousInstall: previousInstallFromReceipt(input.receipt),
  };
}

/**
 * Pick the install target from a receipt + active-profile context.
 *
 * **The hard rule** (LOAD-BEARING):
 *   - receipt present ⇒ `current-profile` (in-place upgrade).
 *   - receipt missing ⇒ `fresh-profile` (forced isolated install).
 *
 * The function is pure and trivially small on purpose: it is THE
 * single place the rule lives, so no surprise call site can accidentally
 * pick the "wrong" target. The action handler never branches on the
 * receipt itself — it always asks this picker.
 */
export function pickInstallTarget(
  manifest: EhcollManifest,
  receipt: InstallReceipt | undefined,
  activeProfileId: string,
  activeProfileName: string,
  /**
   * The profile an INTERRUPTED attempt at this same collection was
   * installing into, when one exists and still does.
   *
   * Only consulted in the receipt-missing branch, and it does not change
   * which branch is taken — a resume is still `fresh-profile` mode, because
   * an attempt that never finished is not a previous install. It decides
   * only whether the driver makes a new profile or continues in the one
   * already half-filled. See {@link InstallIntoFreshProfile.resumeProfileId}
   * for what five restarts looked like without it.
   *
   * The CALLER checks the profile still exists. A user who deleted it meant
   * to, and a fresh profile is the right answer then.
   */
  interruptedProfile?: ResumableProfile,
): InstallTarget {
  if (receipt !== undefined) {
    /**
     * ─── A NEW REVISION GETS ITS OWN PROFILE ──────────────────────────
     * Re-running the SAME release is an in-place operation: a repair, or a
     * resumed upgrade. A DIFFERENT release is a new thing, and it gets a new
     * profile so the version that was working stays switchable.
     *
     * That costs almost nothing. In Vortex a mod lives in one pool per game
     * and a profile is only enablement, so a second profile is a row, not a
     * second copy of 40 GB of mods — and the mods the new revision shares
     * with the old are recognised and simply enabled.
     *
     * It also closes a hazard the in-place path had: `current-profile` uses
     * the ACTIVE profile, never the one the receipt names, so upgrading while
     * sitting on a vanilla profile merged the whole collection — plus a rules
     * purge and a plugins.txt rewrite — into it. The Doctor already called
     * that state "drifted" and offered to fix it while the installer walked
     * into it.
     */
    if (receipt.packageVersion !== manifest.package.version) {
      return {
        kind: "fresh-profile",
        suggestedProfileName: buildSuggestedProfileName(manifest),
        resumeRefusedWhy: "version-changed",
      };
    }
    return {
      kind: "current-profile",
      profileId: activeProfileId,
      profileName: activeProfileName,
    };
  }
  return {
    kind: "fresh-profile",
    suggestedProfileName: buildSuggestedProfileName(manifest),
    ...(interruptedProfile?.kind === "resume"
      ? {
          resumeProfileId: interruptedProfile.id,
          resumeProfileName: interruptedProfile.name,
        }
      : {
          // Carried so the driver's one profile-resolution log line can say
          // WHY it forked, instead of leaving five distinct reasons as the
          // same silence.
          resumeRefusedWhy: interruptedProfile?.why ?? "no-attempt",
          ...(interruptedProfile?.kind === "refused" &&
          interruptedProfile.attemptProfileId !== undefined
            ? { resumeRefusedProfileId: interruptedProfile.attemptProfileId }
            : {}),
        }),
  };
}

/**
 * The profile a previous interrupted attempt at `packageId` was filling, if
 * that profile is still there.
 *
 * Reads the attempt record — which is why the record's own header now says it
 * decides WHERE a resume lands. It still decides nothing about WHAT to
 * install; that stays with the resolver's re-match against the disk, because
 * a dead run's list of what it managed is exactly the thing not to trust.
 *
 * Returns undefined for every honest reason there is no profile to resume:
 * no attempt, an attempt that never got as far as making one, a profile the
 * user has since deleted, or one belonging to a different game.
 */
export type ResumableProfile =
  | { kind: "resume"; id: string; name: string }
  | {
      kind: "refused";
      /**
       * The profile the attempt record named, when it named one.
       *
       * Without it "profile-deleted" is a claim the reader cannot check. A
       * tester forked a fourth profile and the log said only that the third
       * was gone — leaving "they deleted it" and "we looked for the wrong id"
       * indistinguishable, which is the difference between a user habit and a
       * bug in this function.
       */
      attemptProfileId?: string;
      why:
        | "no-attempt"
        | "attempt-has-no-profile"
        | "profile-deleted"
        | "profile-other-game"
        | "version-changed";
    };

export function resumableProfileFromAttempts(
  state: types.IState,
  gameId: string,
  packageId: string,
  packageVersion: string,
  attempts: ReadonlyArray<{
    packageId: string;
    packageVersion?: string;
    profileId?: string;
  }>,
): ResumableProfile {
  /**
   * ─── THE FIRST RESUMABLE ONE, NOT THE FIRST ONE ─────────────────────
   * This used to be `attempts.find(a => a.packageId === packageId)` and then
   * return a refusal from whatever that single record said. Preference was
   * implemented as EXCLUSION: an unusable candidate at the front of the list
   * silently hid a usable one behind it, and `resumeCandidates` deliberately
   * puts every attempt before every marker.
   *
   * Both refusal arms are reachable that way:
   *
   *  - a failed v1.0.0 attempt (attempts are cleared only on SUCCESS) sits in
   *    front of a v1.0.1 MARKER holding 700 installed mods, and `packageId` is
   *    per-collection rather than per-release — so the version guard refused
   *    and the marker was never examined;
   *  - an attempt written by a run that was cancelled at preflight carries no
   *    `profileId` at all, and refused the same way.
   *
   * Either one forks a fresh profile, and since enablement is per-profile the
   * user's 700 already-installed mods read as "Disabled" — the exact failure
   * markers were added to stop.
   *
   * So: judge every candidate, take the first that actually resumes, and only
   * when none does report the refusal from the highest-ranked one — which is
   * still the most specific claim about why nothing could be resumed.
   */
  const matching = attempts.filter((a) => a.packageId === packageId);
  if (matching.length === 0) return { kind: "refused", why: "no-attempt" };

  let firstRefusal: ResumableProfile | undefined;
  for (const candidate of matching) {
    const outcome = judgeResumeCandidate(
      state,
      gameId,
      packageVersion,
      candidate,
    );
    if (outcome.kind === "resume") return outcome;
    firstRefusal ??= outcome;
  }
  return firstRefusal ?? { kind: "refused", why: "no-attempt" };
}

/** One candidate, judged in isolation. See the caller for why that matters. */
function judgeResumeCandidate(
  state: types.IState,
  gameId: string,
  packageVersion: string,
  attempt: {
    packageId: string;
    packageVersion?: string;
    profileId?: string;
  },
): ResumableProfile {
  /**
   * ─── A DIFFERENT RELEASE IS NOT A RESUME ────────────────────────────
   * The attempt record carries `packageVersion` and this used to ignore it,
   * matching on `packageId` alone. So a failed v1.0.0 install made v1.0.1
   * resume into v1.0.0's profile — where orphan detection is off by
   * construction (fresh-profile mode) and nothing ever dispatches
   * `enabled: false`. The mods v1.0.1 dropped would stay installed AND
   * enabled, and the receipt would then claim an exact reproduction of a
   * profile that is a strict superset of it.
   *
   * For a tool whose product is a reproducible profile, that is a silent
   * correctness failure rather than untidiness. A new release gets its own
   * profile; the old one stays switchable.
   */
  if (
    attempt.packageVersion !== undefined &&
    attempt.packageVersion !== packageVersion
  ) {
    return { kind: "refused", why: "version-changed" };
  }

  const profileId = attempt.profileId;
  if (profileId === undefined) {
    return { kind: "refused", why: "attempt-has-no-profile" };
  }

  const profiles = (
    state as unknown as {
      persistent?: { profiles?: Record<string, { gameId?: string; name?: string }> };
    }
  ).persistent?.profiles;
  const profile = profiles?.[profileId];
  if (profile === undefined) {
    return { kind: "refused", why: "profile-deleted", attemptProfileId: profileId };
  }
  // Belonging to this game is checked, not assumed: a profile id that has
  // been reused by another game would send the whole install somewhere the
  // user never asked for.
  if (profile.gameId !== gameId) {
    return { kind: "refused", why: "profile-other-game", attemptProfileId: profileId };
  }

  return { kind: "resume", id: profileId, name: profile.name ?? profileId };
}

/**
 * Pure projection: receipt → `PreviousCollectionInstall`. Returns
 * `undefined` for an absent receipt. Exported because the action
 * handler may want to surface this in dialog text before the resolver
 * runs.
 */
export function previousInstallFromReceipt(
  receipt: InstallReceipt | undefined,
): PreviousCollectionInstall | undefined {
  if (receipt === undefined) return undefined;
  return {
    ...(receipt.gameIniApplication !== undefined
      ? { gameIniApplication: receipt.gameIniApplication }
      : {}),
    packageId: receipt.packageId,
    packageVersion: receipt.packageVersion,
    installedAt: receipt.installedAt,
    modCount: receipt.mods.length,
  };
}

// ===========================================================================
// Vortex-state shape readers
// ===========================================================================
//
// Tiny narrowed accessors over Vortex's untyped Redux state. The
// build action has its own copies of resolveVortexVersion /
// resolveGameVersion / resolveDeploymentMethod; that duplication is
// intentional for now (slice 5 isn't a refactor of the build action).
// A later cleanup may consolidate them into a shared module.

export function resolveVortexVersion(state: types.IState): string {
  const app = (state as unknown as {
    app?: { appVersion?: string; version?: string };
  }).app;
  return app?.appVersion ?? app?.version ?? "unknown";
}

export function resolveGameVersion(
  state: types.IState,
  gameId: string,
): string | undefined {
  const persistent = (state as unknown as {
    persistent?: { gameSettings?: Record<string, { version?: string }> };
  }).persistent;
  const fromGameSettings = persistent?.gameSettings?.[gameId]?.version;
  if (typeof fromGameSettings === "string" && fromGameSettings.length > 0) {
    return fromGameSettings;
  }

  const settings = (state as unknown as {
    settings?: { gameMode?: { discovered?: Record<string, { version?: string }> } };
  }).settings;
  const fromDiscovery = settings?.gameMode?.discovered?.[gameId]?.version;
  if (typeof fromDiscovery === "string" && fromDiscovery.length > 0) {
    return fromDiscovery;
  }

  return undefined;
}

export function resolveDeploymentMethod(
  state: types.IState,
  gameId: string,
): VortexDeploymentMethod | undefined {
  const settings = (state as unknown as {
    settings?: { mods?: { activator?: Record<string, string> } };
  }).settings;
  const raw = settings?.mods?.activator?.[gameId];
  switch (raw) {
    case "hardlink_activator":
      return "hardlink";
    case "symlink_activator":
    case "symlink_activator_elevate":
      return "symlink";
    case "move_activator":
      return "copy";
    default:
      // Unlike the build action, we return `undefined` rather than
      // defaulting to "hardlink" — the resolver discriminates `unknown`
      // vs `ok`/`warn-mismatch` and we want it to see truth.
      return undefined;
  }
}

/**
 * Read the user's currently-enabled extensions from Vortex state.
 *
 * Vortex stores extensions in two related places:
 *  - `state.session.extensions.installed` — installed/loaded extensions,
 *    keyed by extension id, value `{ name, version, ... }`.
 *  - `state.app.extensions` — disabled-state record (in some Vortex
 *    builds), keyed by extension id, value `{ enabled: boolean }`.
 *
 * This reader is permissive: it considers extensions found in
 * `session.extensions.installed` as enabled by default, and applies
 * an explicit `enabled: false` from `state.app.extensions` only when
 * present. Extensions Vortex couldn't load (load errors) are not
 * reported by either field, which is consistent with how the resolver
 * treats them — "missing required extension."
 */
export function resolveEnabledExtensions(state: types.IState): EnabledExtension[] {
  const session = (state as unknown as {
    session?: {
      extensions?: {
        installed?: Record<string, { name?: string; version?: string }>;
      };
    };
  }).session;
  const installed = session?.extensions?.installed;
  if (!installed || typeof installed !== "object") return [];

  const disabledMap = readDisabledExtensionsMap(state);

  const out: EnabledExtension[] = [];
  for (const [id, entry] of Object.entries(installed)) {
    if (disabledMap.get(id) === false) continue;
    const version =
      typeof entry?.version === "string" && entry.version.length > 0
        ? entry.version
        : undefined;
    out.push(version ? { id, version } : { id });
  }
  return out;
}

/**
 * Look up the active profile's display name for the given profile id.
 * Returns `undefined` when the profile is not in state — callers
 * should fall back to the profile id as a UI label.
 */
export function resolveProfileName(
  state: types.IState,
  profileId: string,
): string | undefined {
  const profiles = (state as unknown as {
    persistent?: { profiles?: Record<string, { name?: string }> };
  }).persistent?.profiles;
  const name = profiles?.[profileId]?.name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

// ===========================================================================
// Internals — projection + lineage tagging
// ===========================================================================

/**
 * Project AuditorMod[] → InstalledMod[], attaching lineage tags from
 * the receipt where applicable.
 *
 * Lineage rule (load-bearing): a mod gets `eventHorizonInstall` iff
 * the receipt exists AND `receipt.mods[i].vortexModId === auditorMod.id`.
 * No name fallback, no path inference — only the receipt is authority.
 */
function projectInstalledMods(
  mods: AuditorMod[],
  receipt: InstallReceipt | undefined,
): InstalledMod[] {
  const tagsByVortexModId = receipt
    ? buildLineageTagIndex(receipt)
    : new Map<string, ModEventHorizonInstallTag>();

  return mods.map((mod): InstalledMod => {
    const out: InstalledMod = {
      id: mod.id,
      name: mod.name,
      enabled: mod.enabled,
    };

    const nexusModId = coerceNexusId(mod.nexusModId);
    if (nexusModId !== undefined) out.nexusModId = nexusModId;

    const nexusFileId = coerceNexusId(mod.nexusFileId);
    if (nexusFileId !== undefined) out.nexusFileId = nexusFileId;

    if (
      typeof mod.archiveSha256 === "string" &&
      mod.archiveSha256.length > 0
    ) {
      out.archiveSha256 = mod.archiveSha256;
    }

    if (
      typeof mod.stagingSetHash === "string" &&
      mod.stagingSetHash.length === 64
    ) {
      out.stagingSetHash = mod.stagingSetHash;
    }

    const tag = tagsByVortexModId.get(mod.id);
    if (tag) out.eventHorizonInstall = tag;

    return out;
  });
}

/**
 * Build the receipt → tag index keyed by `vortexModId`. Each entry
 * carries the same `collectionPackageId` / `collectionVersion` /
 * `installedAt` (from the receipt header) plus the mod-specific
 * `originalCompareKey` (from the mod entry).
 */
function buildLineageTagIndex(
  receipt: InstallReceipt,
): Map<string, ModEventHorizonInstallTag> {
  const map = new Map<string, ModEventHorizonInstallTag>();
  for (const m of receipt.mods) {
    map.set(m.vortexModId, lineageTagFor(receipt, m));
  }
  return map;
}

function lineageTagFor(
  receipt: InstallReceipt,
  m: InstallReceiptMod,
): ModEventHorizonInstallTag {
  return {
    collectionPackageId: receipt.packageId,
    collectionVersion: receipt.packageVersion,
    originalCompareKey: m.compareKey,
    installedAt: m.installedAt,
  };
}

/**
 * Vortex stores Nexus modId/fileId as numbers in normal Mods, but
 * AuditorMod's typing tolerates `number | string` because some
 * importers historically wrote strings. The resolver's contract is
 * `number | undefined` — coerce, drop unparseable.
 */
function coerceNexusId(raw: number | string | undefined): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.length > 0) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * Read the disabled-extensions map from `state.app.extensions`,
 * tolerating absence. Returns a map of `id → enabled?: boolean`. An
 * absent entry means "Vortex didn't say either way"; the caller
 * defaults absent to enabled.
 */
function readDisabledExtensionsMap(
  state: types.IState,
): Map<string, boolean | undefined> {
  const app = (state as unknown as {
    app?: { extensions?: Record<string, { enabled?: boolean }> };
  }).app;
  const ext = app?.extensions;
  if (!ext || typeof ext !== "object") return new Map();
  const out = new Map<string, boolean | undefined>();
  for (const [id, entry] of Object.entries(ext)) {
    out.set(id, typeof entry?.enabled === "boolean" ? entry.enabled : undefined);
  }
  return out;
}

/**
 * Default suggested profile name for fresh-profile installs:
 *
 *   "<package.name> (Event Horizon v<package.version>)"
 *
 * The driver may append a `(2)` / `(3)` collision suffix at install
 * time; the resolver doesn't know the final name, only the
 * suggestion.
 */
function buildSuggestedProfileName(manifest: EhcollManifest): string {
  return `${manifest.package.name} (Event Horizon v${manifest.package.version})`;
}
