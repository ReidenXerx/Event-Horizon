/**
 * Install-plan resolver (Phase 3 slice 4).
 *
 *     resolveInstallPlan(manifest, userState, installTarget) → InstallPlan
 *
 * Pure transformation. No I/O, no Vortex API calls, no Date.now() (every
 * timestamp on the plan comes from inputs). The Phase 3 action handler
 * (slice 5) builds the inputs and the install driver (slice 6) consumes
 * the output; the resolver itself is the only piece that decides what
 * "should" happen.
 *
 * Spec: docs/business/RESOLVE_INSTALL_PLAN.md
 *
 * ─── DESIGN ────────────────────────────────────────────────────────────
 * Three rules govern every line below:
 *
 * 1. **Identity is SHA, not name.** Per
 *    docs/PROPOSAL_INSTALLER.md §5.5 (LOAD-BEARING) we never match by
 *    filename, mod display name, or version string. Nexus mods match
 *    on `(modId, fileId, sha256)` triples; external mods match on
 *    `sha256` alone. Anything else is a different mod.
 *
 * 2. **Conservative-policy invariant** (docs/business/INSTALL_PLAN_SCHEMA.md
 *    "v1 conservative-policy invariant"). Every `*-version-diverged`,
 *    `*-bytes-diverged`, and orphan recommendation is `"manual-review"`.
 *    The other values exist in the type set for future heuristics; the
 *    v1 resolver MUST NOT emit them. The driver never acts on a
 *    recommendation directly — the action handler converts each into a
 *    user-confirmed choice first.
 *
 * 3. **Install-target dictates conflict shape.** When
 *    `installTarget.kind === "fresh-profile"` the resolver collapses
 *    every diverged-decision branch into a fresh install — the new
 *    profile starts empty so there is nothing to diverge from. The
 *    user's drifted copies in their old profile are never referenced
 *    by the plan. Byte-exact reuse from the global mod pool still
 *    applies (deduplication is fine; it doesn't touch any other
 *    profile).
 *
 * ─── INVARIANTS the driver relies on ────────────────────────────────
 * - `plan.modResolutions.length === manifest.mods.length`.
 * - `plan.modResolutions[i].compareKey === manifest.mods[i].compareKey`.
 * - `plan.installTarget.kind === "current-profile"` ⇔
 *   `plan.previousInstall` defined.
 * - `plan.orphanedMods.length === 0` whenever
 *   `plan.installTarget.kind === "fresh-profile"`.
 * - In fresh-profile mode no `*-version-diverged` or `*-bytes-diverged`
 *   decision is emitted.
 * - All recommendations are `"manual-review"` in v1.
 * - The plan is JSON-serialisable (no functions, Dates, circular refs).
 * ──────────────────────────────────────────────────────────────────────
 */

import { gameVersionGuidance } from "./gameVersionGuidance";
import type {
  EhcollExternalDependency,
  EhcollManifest,
  EhcollMod,
  EhcollPlugins,
} from "../../types/ehcoll";
import type {
  AvailableDownload,
  CompatibilityReport,
  DeploymentMethodCheck,
  ExtensionCheckResult,
  ExternalDependencyDecision,
  ExternalDependencyVerification,
  ExternalDependencyFileMismatch,
  InstalledMod,
  InstallPlan,
  InstallTarget,
  ModDecision,
  ModResolution,
  OrphanedModDecision,
  PlanSummary,
  PluginOrderPlan,
  RulePlanEntry,
  UserSideState,
  VersionCheckResult,
  VortexVersionCheck,
} from "../../types/installPlan";

// ===========================================================================
// Public API
// ===========================================================================

/**
 * Build the {@link InstallPlan} for a given manifest, user-side state,
 * and install target. Pure. Throws only on contract violations the
 * caller is required to enforce upstream (e.g. mismatched
 * `installTarget` / `userState.previousInstall` co-determination).
 */
export function resolveInstallPlan(
  manifest: EhcollManifest,
  userState: UserSideState,
  installTarget: InstallTarget,
): InstallPlan {
  enforceInstallTargetInvariant(installTarget, userState);

  const compatibility = resolveCompatibility(manifest, userState);
  const modResolutions = resolveModResolutions(manifest, userState, installTarget);
  const orphanedMods = resolveOrphanedMods(manifest, userState, installTarget);
  const externalDependencies = resolveExternalDependencies(manifest, userState);
  const pluginOrder = resolvePluginOrder(manifest);
  const rulePlan = resolveRulePlan(manifest);
  const summary = summarize({
    manifest,
    compatibility,
    modResolutions,
    orphanedMods,
    externalDependencies,
  });

  return {
    manifest,
    installTarget,
    previousInstall: userState.previousInstall,
    compatibility,
    modResolutions,
    orphanedMods,
    externalDependencies,
    pluginOrder,
    rulePlan,
    summary,
  };
}

// ===========================================================================
// Invariant guard
// ===========================================================================

/**
 * The action handler is the sole authority on `installTarget`; it
 * picks the kind from the install ledger BEFORE calling the resolver.
 * Mismatches between `installTarget.kind` and `userState.previousInstall`
 * indicate a programming error in the caller, not a runtime data
 * problem. We throw rather than silently producing a bad plan.
 */
function enforceInstallTargetInvariant(
  installTarget: InstallTarget,
  userState: UserSideState,
): void {
  if (
    installTarget.kind === "current-profile" &&
    !userState.previousInstall
  ) {
    throw new Error(
      "resolveInstallPlan: installTarget is current-profile but " +
        "userState.previousInstall is undefined. Caller must read the " +
        "install ledger and pick installTarget atomically with " +
        "previousInstall (see docs/business/INSTALL_PLAN_SCHEMA.md).",
    );
  }
  /**
   * fresh-profile WITH a previousInstall is legal, and means one thing: a NEW
   * REVISION of a collection the user already has.
   *
   * This used to throw. The pairing it protected — current-profile <=>
   * previousInstall — is still enforced above, because that direction is what
   * keeps a caller from doing an in-place upgrade it has no lineage for. The
   * reverse is not a desync: the receipt is real, we know exactly which
   * release preceded this one, and we are deliberately giving the new one its
   * own profile so the old release stays switchable.
   *
   * Orphan detection stays off in this mode (`resolveOrphanedMods` returns []
   * for fresh-profile) and that is CORRECT here rather than a gap: mods the
   * new revision dropped are not orphans to uninstall, they simply stay
   * enabled in the OLD profile, which is what makes rollback work.
   */
}

// ===========================================================================
// Compatibility checks
// ===========================================================================

/**
 * Exported for tests: this is where a collection is declared installable or
 * not, and the difference between "warn" and "error" here is the difference
 * between a user proceeding and a user blocked. It deserves direct coverage
 * rather than being reached through a full install-plan fixture.
 */
export function resolveCompatibility(
  manifest: EhcollManifest,
  userState: UserSideState,
): CompatibilityReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  const gameMatches = userState.gameId === manifest.game.id;
  if (!gameMatches) {
    errors.push(
      `Game mismatch: this collection is built for "${manifest.game.id}" but the active game is "${userState.gameId}".`,
    );
  }

  const gameVersion = checkGameVersion(manifest, userState, errors, warnings);
  const extensions = checkExtensions(manifest, userState, errors);
  const vortexVersion = checkVortexVersion(manifest, userState, warnings);
  const deploymentMethod = checkDeploymentMethod(manifest, userState, warnings);

  return {
    gameMatches,
    gameVersion,
    extensions,
    vortexVersion,
    deploymentMethod,
    warnings,
    errors,
  };
}

/**
 * The Wine-specific half of the "no version" explanation, when it applies.
 *
 * Split out and returning "" off Wine so the message stays honest on
 * Windows, where an undetected version really is unusual and pointing at
 * Proton would be a red herring.
 */
function wineVersionNote(): string {
  try {
    // Local require keeps the resolver free of a UI/installer import cycle;
    // this module is otherwise pure.
    const { looksLikeWine } = require("../installer/checkSevenZipHealth") as {
      looksLikeWine: () => boolean;
    };
    return looksLikeWine()
      ? "On Wine/Proton this is common — Vortex reads the version out of the " +
          "game executable and that often fails in a prefix."
      : "";
  } catch {
    return "";
  }
}

function checkGameVersion(
  manifest: EhcollManifest,
  userState: UserSideState,
  errors: string[],
  warnings: string[],
): VersionCheckResult {
  const required = manifest.game.version;
  const installed = userState.gameVersion;
  const policy = manifest.game.versionPolicy;

  // A requirement the CURATOR could not determine cannot be enforced against
  // anybody. Shipped manifests carry `version: "unknown"` with policy
  // "exact" — taken literally that reads "your game must be version
  // 'unknown'", which every real install fails, blocking the collection for
  // everyone over a detection gap on one machine. Say it, do not enforce it.
  if (required.length === 0 || required === "unknown") {
    warnings.push(
      `This collection does not record which game version it was built on, ` +
        `so nothing could be checked${
          installed ? ` — you have "${installed}"` : ""
        }. If it misbehaves, a game-version mismatch is worth ruling out first.`,
    );
    return { status: "unknown", required };
  }

  if (!installed) {
    // Vortex is the only source for this: it reads the game executable's
    // version resource at discovery time and we read what it stored. When it
    // has nothing, we have nothing.
    //
    // Under Wine/Proton that is the ORDINARY case rather than a fault, and a
    // bare "version unknown" reads like something broke — an alpha tester
    // reported exactly that as a bug. Nothing IS broken: the check is
    // advisory, it never blocks, and the install proceeds unchanged. Say so,
    // and say what would actually fix it, instead of leaving them to guess.
    warnings.push(
      [
        `Could not check your game version against the collection's ` +
          `"${required}" (policy: ${policy}) — Vortex has not recorded a ` +
          `version for this game.`,
        wineVersionNote(),
        `This does not block the install and nothing is wrong with the ` +
          `collection; it only means a version mismatch cannot be ruled out ` +
          `if something misbehaves later.`,
      ]
        .filter((s) => s.length > 0)
        .join(" "),
    );
    return { status: "unknown", required };
  }

  if (installed === required) {
    return { status: "ok" };
  }

  // Versions differ. Severity depends on policy.
  if (policy === "exact") {
    errors.push(
      [
        `Game version mismatch: this collection needs "${required}" exactly, ` +
          `you have "${installed}".`,
        ...gameVersionGuidance({ gameId: manifest.game.id, required, installed }),
      ].join(" "),
    );
    return { status: "mismatch", required, installed, policy };
  }

  // Minimum policy: numeric semver compare. If installed >= required,
  // accept. If we can't parse either, downgrade to a warning rather
  // than block.
  const cmp = compareSemverLike(installed, required);
  if (cmp === undefined) {
    warnings.push(
      `Game version "${installed}" could not be compared to required "${required}" (policy: minimum). Treating as compatible.`,
    );
    return { status: "ok" };
  }
  if (cmp >= 0) {
    return { status: "ok" };
  }
  errors.push(
    [
      `Game version too old: this collection needs at least "${required}", ` +
        `you have "${installed}".`,
      ...gameVersionGuidance({ gameId: manifest.game.id, required, installed }),
    ].join(" "),
  );
  return { status: "mismatch", required, installed, policy };
}

function checkExtensions(
  manifest: EhcollManifest,
  userState: UserSideState,
  errors: string[],
): ExtensionCheckResult[] {
  return manifest.vortex.requiredExtensions.map((req) => {
    const installed = userState.enabledExtensions.find((e) => e.id === req.id);
    if (!installed) {
      errors.push(`Required Vortex extension missing: "${req.id}".`);
      return {
        id: req.id,
        required: { minVersion: req.minVersion },
        status: "missing",
      };
    }
    if (req.minVersion && installed.version) {
      const cmp = compareSemverLike(installed.version, req.minVersion);
      if (cmp !== undefined && cmp < 0) {
        errors.push(
          `Required Vortex extension "${req.id}" too old: have ${installed.version}, need >= ${req.minVersion}.`,
        );
        return {
          id: req.id,
          required: { minVersion: req.minVersion },
          status: "tooOld",
          installedVersion: installed.version,
        };
      }
    }
    return {
      id: req.id,
      required: { minVersion: req.minVersion },
      status: "ok",
      installedVersion: installed.version,
    };
  });
}

function checkVortexVersion(
  manifest: EhcollManifest,
  userState: UserSideState,
  warnings: string[],
): VortexVersionCheck {
  const required = manifest.vortex.version;
  const installed = userState.vortexVersion;
  if (installed === required) {
    return { required, installed, status: "ok" };
  }
  warnings.push(
    `Vortex version differs: collection built on ${required}, you are running ${installed}. (Informational.)`,
  );
  return { required, installed, status: "warn-mismatch" };
}

function checkDeploymentMethod(
  manifest: EhcollManifest,
  userState: UserSideState,
  warnings: string[],
): DeploymentMethodCheck {
  const curator = manifest.vortex.deploymentMethod;
  const user = userState.deploymentMethod;
  if (!user) {
    return { curator, user, status: "unknown" };
  }
  if (user === curator) {
    return { curator, user, status: "ok" };
  }
  warnings.push(
    `Deployment method differs: collection built with "${curator}", you are using "${user}". (Informational.)`,
  );
  return { curator, user, status: "warn-mismatch" };
}

// ===========================================================================
// Per-mod resolution
// ===========================================================================

function resolveModResolutions(
  manifest: EhcollManifest,
  userState: UserSideState,
  installTarget: InstallTarget,
): ModResolution[] {
  const inFreshProfile = installTarget.kind === "fresh-profile";
  const strict = manifest.package.strictMissingMods;
  return manifest.mods.map((mod) =>
    resolveSingleMod(mod, userState, inFreshProfile, strict),
  );
}

function resolveSingleMod(
  mod: EhcollMod,
  userState: UserSideState,
  inFreshProfile: boolean,
  strictMissingMods: boolean,
): ModResolution {
  const decision: ModDecision =
    mod.source.kind === "nexus"
      ? resolveNexusMod(mod, userState, inFreshProfile)
      : resolveExternalMod(mod, userState, strictMissingMods);

  return {
    compareKey: mod.compareKey,
    name: mod.name,
    sourceKind: mod.source.kind,
    decision,
  };
}

/**
 * Decision ladder for Nexus-sourced mods.
 *
 *   1. byte-exact installed (same modId+fileId+sha)  → already-installed
 *   2. download with matching sha                    → use-local-download
 *   3. (current-profile only) modId match, fileId different → version-diverged
 *   4. (current-profile only) modId+fileId match, sha differs → bytes-diverged
 *   5. otherwise                                     → download
 */
function resolveNexusMod(
  mod: EhcollMod,
  userState: UserSideState,
  inFreshProfile: boolean,
): ModDecision {
  if (mod.source.kind !== "nexus") {
    // Type guard for the call site; the dispatcher already discriminated.
    throw new Error("resolveNexusMod called on non-nexus mod");
  }
  const { modId, fileId, sha256, archiveName, gameDomain } = mod.source;

  const exact = findInstalledByNexusExact(userState.installedMods, modId, fileId, sha256);
  if (exact) {
    return { kind: "nexus-already-installed", existingModId: exact.id };
  }

  const localDownload = findDownloadBySha(userState.availableDownloads, sha256);
  if (localDownload) {
    return {
      kind: "nexus-use-local-download",
      archiveId: localDownload.archiveId,
      localPath: localDownload.localPath,
      sha256: localDownload.sha256,
    };
  }

  // Diverged decisions are current-profile-only. In fresh-profile mode
  // we collapse straight to "download fresh" — the new profile starts
  // empty, so there is nothing to diverge from.
  if (!inFreshProfile) {
    const versionDrift = findInstalledByNexusModId(
      userState.installedMods,
      modId,
      fileId,
    );
    if (versionDrift) {
      return {
        kind: "nexus-version-diverged",
        existingModId: versionDrift.id,
        existingFileId: versionDrift.nexusFileId ?? -1,
        requiredFileId: fileId,
        // v1 conservative policy: always defer to user.
        recommendation: "manual-review",
      };
    }

    const byteDrift = findInstalledByNexusFileMismatch(
      userState.installedMods,
      modId,
      fileId,
      sha256,
    );
    if (byteDrift) {
      return {
        kind: "nexus-bytes-diverged",
        existingModId: byteDrift.id,
        existingSha256: byteDrift.archiveSha256 ?? "",
        expectedSha256: sha256,
        recommendation: "manual-review",
      };
    }
  }

  return {
    kind: "nexus-download",
    gameDomain,
    modId,
    fileId,
    expectedSha256: sha256,
    archiveName,
  };
}

/**
 * Decision ladder for external-sourced mods. The same in both
 * install-target modes — there is no "diverged" case the v1 resolver
 * can emit (see {@link ExternalBytesDivergedDecision} doc), so the
 * mode flag is irrelevant here.
 *
 *   1. archive-sha match installed (cheap, archive-authoritative) → already-installed
 *   2. staging-set-hash match installed (fallback for archive-less) → already-installed
 *   3. download with matching archive sha                          → use-local-download
 *   4. bundled in the .ehcoll                                      → use-bundled
 *   5. strict mode + nothing else                                  → missing
 *   6. lenient mode + nothing else                                 → prompt-user
 *
 * IDENTITY ORACLES — load-bearing:
 * External mods carry one or both of:
 *  - `archiveSha256`: hash of the source archive bytes. Preferred —
 *    cheap to compare, authoritative against archive tampering, and
 *    works regardless of whether the mod is deployed yet.
 *  - `stagingSetHash`: deterministic SHA-256 over the curator's
 *    deployed file set (`{ path, size, sha256 }` per file, sorted).
 *    Required for mods whose archive Vortex doesn't retain (manual
 *    installs, sideloads, archives the user purged). The action
 *    handler enriches `InstalledMod.stagingSetHash` for installed
 *    mods that name-match an archive-less manifest entry — we don't
 *    blanket-hash every installed mod.
 *
 * The schema invariant guarantees at least one is set; the resolver
 * tries archive sha first, falls back to staging-set hash.
 */
function resolveExternalMod(
  mod: EhcollMod,
  userState: UserSideState,
  strictMissingMods: boolean,
): ModDecision {
  if (mod.source.kind !== "external") {
    throw new Error("resolveExternalMod called on non-external mod");
  }
  const {
    sha256,
    stagingSetHash,
    expectedFilename,
    instructions,
    url,
    downloadMode,
    bundled,
  } = mod.source;

  // Rung 1: archive-sha match (preferred when the curator had archive
  // bytes and the user does too).
  if (sha256 !== undefined) {
    const installed = findInstalledBySha(userState.installedMods, sha256);
    if (installed) {
      return { kind: "external-already-installed", existingModId: installed.id };
    }
  }

  // Rung 2: staging-set-hash match (fallback — works for archive-less
  // mods OR when the user's archive was purged but the deployed files
  // remain). Only fires for installed mods the action handler has
  // chosen to enrich (those that name-match a manifest external mod);
  // un-enriched mods carry `stagingSetHash === undefined` and are
  // treated as "byte-identity unknown," not "different bytes."
  if (stagingSetHash !== undefined) {
    const installedByStaging = findInstalledByStagingSetHash(
      userState.installedMods,
      stagingSetHash,
    );
    if (installedByStaging) {
      return {
        kind: "external-already-installed",
        existingModId: installedByStaging.id,
      };
    }
  }

  // Rung 3: archive-sha matches a download in Vortex's cache.
  if (sha256 !== undefined) {
    const localDownload = findDownloadBySha(
      userState.availableDownloads,
      sha256,
    );
    if (localDownload) {
      return {
        kind: "external-use-local-download",
        sha256,
        archiveId: localDownload.archiveId,
        localPath: localDownload.localPath,
      };
    }
  }

  // Rung 4: archive bundled in the .ehcoll. Schema invariant
  // guarantees `bundled === true ⇒ sha256 set`, so the assertion is
  // safe even though TS can't infer it from the destructure.
  if (bundled) {
    const sha = sha256!;
    return {
      kind: "external-use-bundled",
      sha256: sha,
      zipPath: bundledZipPath(sha, expectedFilename),
    };
  }

  // Rung 5/6: nothing. Both decisions carry whichever identity
  // oracles the manifest provided (one or both). The driver / UI
  // inspects whichever is set.
  if (strictMissingMods) {
    return {
      kind: "external-missing",
      expectedFilename,
      ...(sha256 !== undefined ? { expectedSha256: sha256 } : {}),
      ...(stagingSetHash !== undefined
        ? { expectedStagingSetHash: stagingSetHash }
        : {}),
      instructions,
      ...(url !== undefined ? { url } : {}),
      ...(downloadMode !== undefined ? { downloadMode } : {}),
    };
  }
  return {
    kind: "external-prompt-user",
    expectedFilename,
    ...(sha256 !== undefined ? { expectedSha256: sha256 } : {}),
    ...(stagingSetHash !== undefined
      ? { expectedStagingSetHash: stagingSetHash }
      : {}),
    instructions,
    ...(url !== undefined ? { url } : {}),
    ...(downloadMode !== undefined ? { downloadMode } : {}),
  };
}

// ===========================================================================
// Orphan detection
// ===========================================================================

/**
 * A mod is orphaned when:
 *  - the install ledger says we put it there for the same package.id,
 *  - and the new manifest no longer references its `originalCompareKey`.
 *
 * No lineage ⇒ no orphans by definition. Fresh-profile mode also
 * never produces orphans (the new profile starts empty).
 */
function resolveOrphanedMods(
  manifest: EhcollManifest,
  userState: UserSideState,
  installTarget: InstallTarget,
): OrphanedModDecision[] {
  if (installTarget.kind === "fresh-profile") {
    return [];
  }
  if (!userState.previousInstall) {
    return [];
  }

  const manifestKeys = new Set(manifest.mods.map((m) => m.compareKey));
  const expectedPackageId = manifest.package.id;

  const orphans: OrphanedModDecision[] = [];
  for (const installed of userState.installedMods) {
    const tag = installed.eventHorizonInstall;
    if (!tag) continue;
    if (tag.collectionPackageId !== expectedPackageId) continue;
    if (manifestKeys.has(tag.originalCompareKey)) continue;
    orphans.push({
      existingModId: installed.id,
      name: installed.name,
      originalCompareKey: tag.originalCompareKey,
      installedFromVersion: tag.collectionVersion,
      // v1 conservative policy: never auto-uninstall.
      recommendation: "manual-review",
    });
  }
  return orphans;
}

// ===========================================================================
// External-dependency checks
// ===========================================================================

function resolveExternalDependencies(
  manifest: EhcollManifest,
  userState: UserSideState,
): ExternalDependencyDecision[] {
  return manifest.externalDependencies.map((dep) =>
    resolveSingleExternalDependency(dep, userState.externalDependencyState),
  );
}

function resolveSingleExternalDependency(
  dep: EhcollExternalDependency,
  state: ExternalDependencyVerification[] | undefined,
): ExternalDependencyDecision {
  const verification = state?.find((v) => v.id === dep.id);
  if (!verification) {
    // Action handler hasn't asked us to verify yet. UI surfaces a
    // "verify now" button.
    return {
      id: dep.id,
      name: dep.name,
      status: { kind: "not-verified" },
    };
  }

  const expectedFiles = dep.files;
  const allMissing =
    expectedFiles.length > 0 &&
    expectedFiles.every((f) => {
      const r = verification.files.find((rf) => rf.relPath === f.relPath);
      return !r || r.presence === "missing";
    });
  if (allMissing) {
    return {
      id: dep.id,
      name: dep.name,
      status: {
        kind: "missing",
        instructions: dep.instructions,
        instructionsUrl: dep.instructionsUrl,
      },
    };
  }

  const mismatches: ExternalDependencyFileMismatch[] = [];
  for (const f of expectedFiles) {
    const r = verification.files.find((rf) => rf.relPath === f.relPath);
    if (!r) {
      mismatches.push({
        relPath: f.relPath,
        expectedSha256: f.sha256,
      });
      continue;
    }
    if (r.presence === "missing") {
      mismatches.push({
        relPath: f.relPath,
        expectedSha256: f.sha256,
      });
      continue;
    }
    if (r.actualSha256 && r.actualSha256 !== f.sha256) {
      mismatches.push({
        relPath: f.relPath,
        expectedSha256: f.sha256,
        actualSha256: r.actualSha256,
      });
    }
  }

  if (mismatches.length > 0) {
    return {
      id: dep.id,
      name: dep.name,
      status: { kind: "files-mismatch", mismatches },
    };
  }
  return {
    id: dep.id,
    name: dep.name,
    status: { kind: "ok" },
  };
}

// ===========================================================================
// Plugin order plan
// ===========================================================================

function resolvePluginOrder(manifest: EhcollManifest): PluginOrderPlan {
  const entries: EhcollPlugins["order"] = manifest.plugins.order;
  if (entries.length === 0) {
    return { kind: "none", manifestEntryCount: 0 };
  }
  // v1 always replaces. Backup path is set by the driver at install
  // time (it depends on game-specific plugins.txt location), not by
  // the resolver.
  return { kind: "replace", manifestEntryCount: entries.length };
}

// ===========================================================================
// Rule plan
// ===========================================================================

/**
 * Pre-resolves each manifest rule against the manifest's mod set.
 * The rule's `source` MUST be a compareKey present in `manifest.mods`
 * (parseManifest already warns on missing source). Targets may be
 * partially-pinned references the install driver matches at apply
 * time; we pass those through verbatim.
 */
function resolveRulePlan(manifest: EhcollManifest): RulePlanEntry[] {
  const modKeys = new Set(manifest.mods.map((m) => m.compareKey));
  return manifest.rules.map((rule, index): RulePlanEntry => {
    if (!modKeys.has(rule.source)) {
      return {
        manifestRuleIndex: index,
        type: rule.type,
        status: {
          kind: "skip",
          reason: `Rule source "${rule.source}" not present in this manifest's mod set.`,
        },
      };
    }
    if (rule.ignored) {
      return {
        manifestRuleIndex: index,
        type: rule.type,
        status: {
          kind: "skip",
          reason: `Rule was marked ignored on the curator's machine; preserved for traceability.`,
        },
      };
    }
    return {
      manifestRuleIndex: index,
      type: rule.type,
      status: {
        kind: "apply",
        sourceCompareKey: rule.source,
        targetCompareKey: rule.reference,
      },
    };
  });
}

// ===========================================================================
// Summary
// ===========================================================================

function summarize(input: {
  manifest: EhcollManifest;
  compatibility: CompatibilityReport;
  modResolutions: ModResolution[];
  orphanedMods: OrphanedModDecision[];
  externalDependencies: ExternalDependencyDecision[];
}): PlanSummary {
  const { manifest, compatibility, modResolutions, orphanedMods, externalDependencies } = input;

  let alreadyInstalled = 0;
  let willInstallSilently = 0;
  let needsUserConfirmation = 0;
  let missing = 0;

  for (const r of modResolutions) {
    const k = r.decision.kind;
    // alreadyInstalled buckets *-already-installed AND *-use-local-download
    // (both mean "no Nexus round-trip needed"). Per
    // PlanSummary.alreadyInstalled doc.
    if (
      k === "nexus-already-installed" ||
      k === "external-already-installed" ||
      k === "nexus-use-local-download" ||
      k === "external-use-local-download"
    ) {
      alreadyInstalled++;
    }
    // willInstallSilently buckets the four "no user action required to
    // unblock" arms — overlaps with alreadyInstalled by design.
    if (
      k === "nexus-download" ||
      k === "external-use-bundled" ||
      k === "nexus-use-local-download" ||
      k === "external-use-local-download"
    ) {
      willInstallSilently++;
    }
    if (
      k === "nexus-version-diverged" ||
      k === "nexus-bytes-diverged" ||
      k === "external-bytes-diverged" ||
      k === "external-prompt-user"
    ) {
      needsUserConfirmation++;
    }
    if (k === "nexus-unreachable" || k === "external-missing") {
      missing++;
    }
  }

  const strict = manifest.package.strictMissingMods;
  const extensionFailures = compatibility.extensions.some((e) => e.status !== "ok");
  const externalDepBlocking =
    strict &&
    externalDependencies.some(
      (d) => d.status.kind === "missing" || d.status.kind === "files-mismatch",
    );

  const canProceed =
    compatibility.errors.length === 0 &&
    !extensionFailures &&
    !(strict && missing > 0) &&
    !externalDepBlocking;

  return {
    totalMods: manifest.mods.length,
    alreadyInstalled,
    willInstallSilently,
    needsUserConfirmation,
    missing,
    orphans: orphanedMods.length,
    ruleCount: manifest.rules.length,
    loadOrderCount: manifest.loadOrder.length,
    pluginOrderCount: manifest.plugins.order.length,
    userlistPluginCount: manifest.userlist.plugins.length,
    userlistGroupCount: manifest.userlist.groups.length,
    canProceed,
  };
}

// ===========================================================================
// Identity-match helpers (LOAD-BEARING)
// ===========================================================================

/**
 * Byte-exact Nexus match. Identity is the (modId, fileId) pair the
 * curator pinned, verified by SHA-256.
 *
 * `archiveSha256` is optional on `InstalledMod` because un-enriched
 * snapshots may lack it; absence is treated as "byte-identity unknown,"
 * NOT "different bytes." That means a mod with no SHA never matches
 * here — it falls through to one of the diverged branches (or to a
 * fresh download in fresh-profile mode).
 */
function findInstalledByNexusExact(
  installed: InstalledMod[],
  modId: number,
  fileId: number,
  sha256: string,
): InstalledMod | undefined {
  /**
   * ─── AN ABSENT HASH IS UNKNOWN, NOT DIFFERENT ───────────────────────
   * `InstalledMod.archiveSha256` says so itself: "Optional because
   * un-enriched snapshots may lack it; absence is treated as 'byte-identity
   * unknown' not 'different bytes'." This function required it to be present
   * AND equal, which is the opposite, and the contradiction cost a tester
   * their evening.
   *
   * Vortex does not reliably keep an archive hash on an INSTALLED mod — it is
   * enriched from the download, and a download that has been cleaned up, or
   * never hashed, leaves the attribute missing. So a mod this tool had
   * installed itself minutes earlier failed the check, fell through to
   * "download it again", and Vortex met it with "X is already installed on
   * your system — replace, or install as a variant?" for the user to answer
   * by hand.
   *
   * Measured in their log: 1,993 install starts for 1,107 distinct mods, and
   * only 95 recognised as already installed. On the final resume, 754 mods
   * were re-installed and 89 recognised. One mod was recognised in run 4 and
   * re-installed in run 5, which is what makes this an identity bug rather
   * than a state one.
   *
   * `(modId, fileId)` IS the identity — a Nexus file id is immutable and
   * refers to one uploaded file forever. The hash adds proof that the LOCAL
   * bytes were not swapped, which is worth having when we have it: a KNOWN
   * hash that differs still refuses, and falls through to the bytes-diverged
   * rung below. Only "we never recorded one" now matches.
   *
   * The safe direction is this one. A wrong "already installed" is caught by
   * the verification pass, which compares real files against the manifest. A
   * wrong "not installed" costs a re-download, a modal, and a mod installed
   * twice.
   */
  return installed.find(
    (m) =>
      m.nexusModId === modId &&
      m.nexusFileId === fileId &&
      (m.archiveSha256 === undefined || m.archiveSha256 === sha256),
  );
}

/**
 * Same Nexus modId but different fileId. The "version drift" case.
 */
function findInstalledByNexusModId(
  installed: InstalledMod[],
  modId: number,
  fileId: number,
): InstalledMod | undefined {
  return installed.find(
    (m) =>
      m.nexusModId === modId &&
      typeof m.nexusFileId === "number" &&
      m.nexusFileId !== fileId,
  );
}

/**
 * Same Nexus modId and fileId but different SHA. The "Nexus
 * silently re-uploaded" case. Only fires when the user's mod has a
 * SHA we can compare against — we never claim drift on SHA-unknown
 * mods.
 */
function findInstalledByNexusFileMismatch(
  installed: InstalledMod[],
  modId: number,
  fileId: number,
  sha256: string,
): InstalledMod | undefined {
  return installed.find(
    (m) =>
      m.nexusModId === modId &&
      m.nexusFileId === fileId &&
      typeof m.archiveSha256 === "string" &&
      m.archiveSha256 !== sha256,
  );
}

/**
 * External match by SHA-256 alone (per §5.5).
 */
function findInstalledBySha(
  installed: InstalledMod[],
  sha256: string,
): InstalledMod | undefined {
  return installed.find((m) => m.archiveSha256 === sha256);
}

/**
 * External match by staging-set hash — the fallback identity oracle
 * for archive-less mods. Only fires when the action handler has
 * pre-enriched `InstalledMod.stagingSetHash` for the relevant
 * candidates (we never blanket-hash every installed mod to bound
 * the cost; see `enrichInstalledModsWithStagingSetHashes`).
 *
 * Mods with `stagingSetHash === undefined` are treated as "byte-
 * identity unknown," not "different bytes" — same conservative
 * convention as `archiveSha256`.
 */
function findInstalledByStagingSetHash(
  installed: InstalledMod[],
  stagingSetHash: string,
): InstalledMod | undefined {
  return installed.find((m) => m.stagingSetHash === stagingSetHash);
}

function findDownloadBySha(
  downloads: AvailableDownload[] | undefined,
  sha256: string,
): AvailableDownload | undefined {
  if (!downloads) return undefined;
  return downloads.find((d) => d.sha256 === sha256);
}

// ===========================================================================
// Bundled archive path
// ===========================================================================

/**
 * Reconstructs the path to a bundled archive inside the .ehcoll ZIP.
 * Convention from {@link ../manifest/packageZip.packageEhcoll}:
 *   bundled/<sha256><ext>
 * where `<ext>` is the lowercased extension of `expectedFilename`,
 * defaulting to `.zip` if none is detectable.
 */
function bundledZipPath(sha256: string, expectedFilename: string): string {
  return `bundled/${sha256}${extractExtension(expectedFilename)}`;
}

/**
 * ──────────────────────────────────────────────────────────────────────
 * The decision that would REINSTALL a mod we already matched as installed.
 *
 * `*-already-installed` is not an install instruction — it says "re-use what
 * is on disk", and it carries no archive, no download id, nothing to act on.
 * That is correct for the plan and useless for a repair, because the mod we
 * want to repair is exactly the one that decision pointed at.
 *
 * So when verification proves those files are wrong, the repair needs an
 * install decision built from the MANIFEST instead — the same one the
 * resolver would have produced had it never found a match:
 *
 *   nexus            → download it again (Vortex re-uses its cached archive
 *                      when it still has one, so this is usually local)
 *   external+bundled → extract it from the package we are installing from
 *   external, no bundle → nothing. There is no archive on this machine and
 *                      no way to fetch one, so the honest answer is that we
 *                      cannot repair it, not a decision that fails later.
 *
 * Deliberately NOT `*-use-local-download`: that needs an archiveId from the
 * user state, which the plan does not retain, and inventing one would be a
 * guess where a re-download is merely slow.
 * ──────────────────────────────────────────────────────────────────────
 */
export function repairDecisionFor(mod: EhcollMod): ModDecision | undefined {
  const src = mod.source;

  if (src.kind === "nexus") {
    return {
      kind: "nexus-download",
      gameDomain: src.gameDomain,
      modId: src.modId,
      fileId: src.fileId,
      expectedSha256: src.sha256,
      archiveName: src.archiveName,
    };
  }

  if (src.bundled === true && src.sha256 !== undefined) {
    return {
      kind: "external-use-bundled",
      sha256: src.sha256,
      zipPath: bundledZipPath(src.sha256, src.expectedFilename),
    };
  }

  return undefined;
}

function extractExtension(filename: string): string {
  // Special-case multi-part archive extensions the packager preserves.
  const lower = filename.toLowerCase();
  if (lower.endsWith(".tar.gz")) return ".tar.gz";
  if (lower.endsWith(".tar.bz2")) return ".tar.bz2";
  if (lower.endsWith(".tar.xz")) return ".tar.xz";

  const lastDot = filename.lastIndexOf(".");
  const lastSep = Math.max(filename.lastIndexOf("/"), filename.lastIndexOf("\\"));
  if (lastDot <= lastSep || lastDot === -1) {
    return ".zip";
  }
  const ext = filename.substring(lastDot).toLowerCase();
  // Sanity: extensions over 8 chars are almost certainly not extensions.
  if (ext.length > 8) {
    return ".zip";
  }
  return ext;
}

// ===========================================================================
// Semver comparison (intentionally tiny)
// ===========================================================================

/**
 * Numeric major.minor.patch compare. Returns -1/0/1 like sortcmp, or
 * `undefined` if either side fails to parse.
 *
 * We intentionally don't handle prerelease / build metadata — Vortex
 * extension versions and game versions in the wild rarely use them,
 * and falling back to "treat as equal" via `undefined → ok` is the
 * right conservative behavior.
 */
function compareSemverLike(a: string, b: string): number | undefined {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return undefined;
  if (pa[0] !== pb[0]) return pa[0] < pb[0] ? -1 : 1;
  if (pa[1] !== pb[1]) return pa[1] < pb[1] ? -1 : 1;
  if (pa[2] !== pb[2]) return pa[2] < pb[2] ? -1 : 1;
  return 0;
}

function parseSemver(v: string): [number, number, number] | undefined {
  const trimmed = v.trim().replace(/^v/i, "");
  const parts = trimmed.split(/[.\-+]/);
  if (parts.length === 0) return undefined;
  const nums: number[] = [];
  for (let i = 0; i < 3; i++) {
    const n = parts[i] === undefined ? 0 : Number.parseInt(parts[i], 10);
    if (!Number.isFinite(n) || n < 0) return undefined;
    nums.push(n);
  }
  return [nums[0], nums[1], nums[2]];
}
