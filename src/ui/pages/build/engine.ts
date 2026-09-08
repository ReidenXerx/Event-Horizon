/**
 * Build pipeline engine for the React BuildPage.
 *
 * Mirrors the same call sequence used by the legacy toolbar action in
 * `src/actions/buildPackageAction.ts`, but factored so the UI can:
 *
 *   1. Pre-load the curator's environment (active game, profile, mods,
 *      existing collection config) to populate the form before the
 *      curator clicks Build.
 *   2. Run the full pipeline (manifest → package) given a curator
 *      input + per-mod override map, reporting progress along the way.
 *
 * The legacy action stays as a fallback (it still wires the toolbar
 * button), but the UI calls this engine directly so the core logic
 * doesn't get duplicated.
 *
 * Design rule: this module touches Vortex state via the api, but
 * never any UI code. The progress callback is the only side channel
 * to the React layer.
 */

import {
  mayBundle,
  shipsAsExternal,
} from "../../../core/manifest/shipsAsExternal";
import * as fsp from "fs/promises";

import {
  classifyMissingConfigEntry,
  describeDroppedEntry,
} from "../../../core/manifest/staleConfigEntries";
import * as path from "path";
import { util } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";

import {
  AbortError,
  enrichModsWithArchiveHashes,
  resolveModArchivePath,
} from "../../../core/archiveHashing";
import { captureDeploymentManifests } from "../../../core/deploymentManifest";
import type { AuditorMod } from "../../../core/getModsListForProfile";
import { isNexusSourced } from "../../../core/identity/nexusSourced";
import {
  getActiveGameId,
  getActiveProfileIdFromState,
  getModsForProfile,
} from "../../../core/getModsListForProfile";
import { captureLoadOrder } from "../../../core/loadOrder";
import { captureUserlist } from "../../../core/userlist";
import {
  discoveredStore,
  getCurrentPluginsTxtPath,
} from "../../../core/comparePlugins";
import { buildManifest } from "../../../core/manifest/buildManifest";
import { captureStagingFiles } from "../../../core/manifest/captureStagingFiles";
import { runSelfChecks,
  findModsThatPromptTheUser,
  findPostProcessingCandidates,
} from "../../../core/manifest/runSelfChecks";
import type { MirrorFileSpec } from "../../../core/manifest/packageZip";
import {
  installRootFor,
  stagingRootFromFolder,
} from "../../../core/stagingPath";
import type { PostProcessingCandidate } from "../../../core/manifest/runSelfChecks";
import {
  captureGameIni,
  describeMachineKept,
} from "../../../core/manifest/gameIni";
import {
  describeHashedCollisions,
  describeScope,
  findHashedIdentityCollisions,
  profileFingerprint,
  scopeCollectionMods,
} from "../../../core/manifest/collectionScope";
import { findModsWithNoArchivePath } from "../../../core/archiveRecovery";
import { resolveSevenZip } from "../../../core/manifest/sevenZip";
import { listArchiveContents } from "../../../core/manifest/archiveContents";
import {
  describeExternalDrift,
  detectExternalDrift,
  repackBundledExternals,
  type RepackedBundle,
  mergeRepackedBundles,
} from "../../../core/manifest/bundleFromStaging";
import {
  describeRootFolderReview,
  describeUnaccountedRootBinaries,
  describeScriptExtenderGap,
  findRootFolderMods,
} from "../../../core/manifest/rootFolderReview";
import {
  applyDependencyOverrides,
  describeMissingEngineFixesPart2,
  detectExternalDependencies,
  listRootBinaries,
  filesProvidedByDeployment,
  getGameDirectory,
} from "../../../core/manifest/externalDependencies";
import type {
  EhcollExternalDependency,
  GameVersionPolicy,
} from "../../../types/ehcoll";
import {
  applyCachedDownloadIds,
  applyCachedHashes,
  loadArchiveHashCache,
  makeHashLookup,
  mergeHashes,
  saveArchiveHashCache,
} from "../../../core/archiveHashCache";
import {
  packageEhcoll,
  type BundledArchiveSpec,
  type PackageEhcollResult,
} from "../../../core/manifest/packageZip";
import {
  listPublishedCollections,
  loadOrCreateCollectionConfig,
  reconcileExternalModsConfig,
  saveCollectionConfig,
  toBuildManifestExternalMods,
  type CollectionConfig,
  type ExternalModConfigEntry,
  type PublishedCollectionSummary,
  decidedPostProcessing,
  modsNewlyBundled,
  modsNoLongerBundled,
  choiceFromEntry,
} from "../../../core/manifest/collectionConfig";
import {
  collectExternalHints,
  countBy,
  describeUndeclared,
  diagnoseHintSources,
  downloadsFromState,
  modsFromState,
  undeclaredDependencies,
} from "../../../core/manifest/externalHints";
import type { ExternalHint } from "../../../core/manifest/externalHints";
import { getCollectionsConfigDir, getCollectionsDir, getVortexUserDataPath } from "../../../core/paths";
import { beginOp, ehLog } from "../../../core/logging/ehLog";
import type {
  SupportedGameId,
  VerificationLevel,
  VortexDeploymentMethod,
} from "../../../types/ehcoll";

// ===========================================================================
// Public types
// ===========================================================================

export const SUPPORTED_GAME_IDS: ReadonlySet<string> = new Set<SupportedGameId>([
  "skyrimse",
  "fallout3",
  "falloutnv",
  "fallout4",
  "starfield",
]);

export interface CuratorInput {
  name: string;
  version: string;
  author: string;
  description: string;
  /**
   * Game version this collection requires. Seeded from the detected version,
   * editable because detection can fail — and a requirement nobody can meet
   * is worse than no requirement at all.
   */
  gameVersion: string;
  /** `"exact"` blocks a mismatch; `"minimum"` blocks only older. */
  gameVersionPolicy: GameVersionPolicy;
}

/**
 * The curator-side environment, gathered before they fill in the form.
 * Drives the pre-populated fields (mod list, default name, etc.) and
 * is consumed unchanged by `runBuildPipeline`.
 */
export interface BuildContext {
  gameId: SupportedGameId;
  profileId: string;
  /**
   * Mods present in the active profile right now, with archive hashes
   * already filled in. The expensive hashing pass is done here so the
   * UI can show "ready to build" before opening the form, and the
   * actual build doesn't have to redo it (we keep the same array).
   */
  mods: AuditorMod[];
  /**
   * Prerequisites detected in the game folder that no mod accounts for — a
   * script extender, ENB, a preloader. Curator decides which to ship and what
   * to say about them; see `collectionConfig.externalDependencies`.
   */
  detectedDependencies: EhcollExternalDependency[];
  /**
   * Files the collection's own mods provide, from Vortex's deployment
   * manifests. Kept on the context so the Engine Fixes pairing check can be
   * re-evaluated against the list that actually SHIPS — the curator's
   * exclusions are applied at pack time, long after detection.
   */
  dependencyProvidedFiles: ReadonlySet<string>;
  /**
   * The game version this collection will REQUIRE, read from Vortex. Shown on
   * the form because it is a hard requirement the curator should see before
   * shipping, not a detail discovered by whoever installs it.
   */
  gameVersion: string;
  /**
   * Notes about what was left out or looks wrong in the profile itself —
   * duplicate identities, several enabled installs of one mod. Produced by
   * {@link scopeCollectionMods}; empty on a tidy profile.
   */
  scopeWarnings: string[];
  /**
   * What this collection puts beside the game executable, stated as fact.
   *
   * Deliberately NOT a warning list: on a healthy 1753-mod profile it is one
   * line naming SKSE. Its value is that a curator can look at it and notice
   * something they expected is absent — which is the only reliable way to
   * catch an engine injector Vortex is treating as an ordinary mod, because
   * nothing in a staging folder distinguishes one from a tool.
   */
  rootFolderReview: string[];
  /**
   * Subset of `mods` that are external (not on Nexus). These are the
   * only mods the curator can flag as bundled.
   */
  externalMods: AuditorMod[];
  /**
   * Suggested link/instructions per external mod id, from Vortex's own data.
   *
   * A SUGGESTION, never an answer: the curator's own text always wins, and
   * these are shown as something to accept rather than silently written into
   * their config. See core/manifest/externalHints.
   */
  externalHints: ReadonlyMap<string, ExternalHint>;
  /**
   * The on-disk per-collection state. Loaded from
   * `<appData>/Vortex/event-horizon/collections/.config/<slug>.json`,
   * or created fresh on first run. The config is the source of truth
   * for `package.id`, README/CHANGELOG, and per-mod overrides.
   *
   * `slug` is computed from `defaultName`; renaming the collection
   * later in the form will switch to a different slug → different
   * config file → different lineage.
   */
  collectionConfig: CollectionConfig;
  /** Path of the config file currently loaded. */
  configPath: string;
  /** Was the config file just created? Used to surface a "first build" hint. */
  configCreated: boolean;
  /** Best-effort default name (last build's name, or "My Collection"). */
  defaultName: string;
  /** Best-effort default version (last build's version, or "1.0.0"). */
  defaultVersion: string;
  /** Best-effort default author (last build's author, or empty). */
  defaultAuthor: string;
}

export type BuildProgressPhase =
  | "hashing-mods"
  | "inspecting-mods"
  | "capturing-deployment"
  | "capturing-load-order"
  | "capturing-userlist"
  | "reading-plugins-txt"
  | "writing-config"
  | "building-manifest"
  | "resolving-bundled-archives"
  | "packaging";

export interface BuildProgress {
  phase: BuildProgressPhase;
  message?: string;
  /**
   * For phases that iterate over a known number of items (today only
   * "hashing-mods"), the live counter so the UI can render an exact
   * "X / Y archives hashed" string. Omitted for non-iterative phases.
   */
  done?: number;
  total?: number;
  /** Human-readable name of the item currently being processed. */
  currentItem?: string;
}

export interface BuildPipelineResult {
  outputPath: string;
  outputBytes: number;
  /**
   * SHA-256 of the finished package, for the curator to publish beside it.
   *
   * A recipient asking "is my copy intact?" was previously answered by two
   * people running sha256sum and reading hex to each other over chat.
   */
  outputSha256: string;
  bundledCount: number;
  modCount: number;
  warnings: string[];
  /**
   * Counts of curator-authored rules + ordering surfaces baked into
   * the manifest. Surfaced in the build Done card so the curator
   * gets immediate feedback that their LOOT userlist + mod rules
   * + load order made it into the package — without these the
   * curator has to test on a fresh machine to verify round-trip.
   *
   * Read directly from `EhcollManifest` after `buildManifest`
   * returns; no separate computation. `pluginOrderCount` is the
   * `plugins.txt` baseline; `userlistPluginCount` and
   * `userlistGroupCount` are LOOT userlist scope.
   */
  ruleCount: number;
  loadOrderCount: number;
  pluginOrderCount: number;
  userlistPluginCount: number;
  userlistGroupCount: number;
  /**
   * What integrity level the build captured per mod. Surfaced in the
   * Done card so the curator can confirm "yes, my package will let
   * users detect Vortex's lost-file bug" or "I picked fast for speed
   * and accept the trade-off".
   */
  verificationLevel: VerificationLevel;
  /**
   * Total number of `stagingFiles` entries across all mods. Useful as
   * a "this build inspected N files" sanity check; zero when
   * verificationLevel is `"none"`.
   */
  stagingFileCount: number;
  /**
   * Mods whose staging holds files their archive cannot produce, undecided.
   *
   * Carried out of the pipeline as data rather than folded into `warnings`,
   * because this is the one finding the curator has to ANSWER. A sentence can
   * only be read; the Done card turns these into a per-mod decision with the
   * offending paths shown, so the answer comes from looking rather than from
   * agreeing with a paragraph.
   */
  postProcessingCandidates: PostProcessingCandidate[];
}

/**
 * Record one post-processing decision, immediately.
 *
 * Written the moment the curator answers, not gathered up for the next build.
 * The question is asked on the Done card — the curator has just been handed a
 * finished package and is deciding whether to ship it — and an answer held in
 * component state would be lost by the navigation that naturally follows.
 *
 * Goes through the same config file the build form writes, so a decision made
 * here shows up as the mod's setting everywhere else, and survives a restart.
 *
 * Returns the saved path so the caller can say where the answer went.
 */
export async function recordPostProcessingDecision(args: {
  collectionName: string;
  modId: string;
  patch: Partial<ExternalModConfigEntry>;
}): Promise<string> {
  const slug = slugify(args.collectionName);
  const configDir = path.join(getCollectionsDir(), ".config");
  const loaded = await loadOrCreateCollectionConfig({ configDir, slug });
  const config: CollectionConfig = {
    ...loaded.config,
    externalMods: {
      ...loaded.config.externalMods,
      // Merged, never replaced: this mod may already carry a URL, a mode or
      // instructions the curator typed into the build form, and a decision
      // about its staging is no reason to lose any of it.
      [args.modId]: {
        ...loaded.config.externalMods[args.modId],
        ...args.patch,
      },
    },
  };
  return saveCollectionConfig({ configDir, slug, config });
}

/**
 * Mods that genuinely cannot be identified, config in hand.
 *
 * A mod the curator marked `treatAsExternal` is NOT unidentified: it ships,
 * keyed by the SHA-256 of its deployed files, and `buildManifest` accepts it
 * without an archive.
 *
 * Takes the config as a PARAMETER for the same reason as
 * `applyPostProcessedDeclarations` below, and after the same bug. This was a
 * `.filter()` whose callback read `collectionConfig` from the enclosing scope
 * forty-two lines before it was declared, and it threw the moment a curator
 * opened the build form. TypeScript cannot see through a closure; it can see
 * an argument.
 */
export function findUnidentifiedMods(
  mods: readonly AuditorMod[],
  config: CollectionConfig,
): AuditorMod[] {
  return mods.filter(
    (m) =>
      m.archiveSha256 === undefined &&
      !shipsAsExternal(isNexusMod(m), config.externalMods[m.id]),
  );
}

/**
 * Overlay the curator's post-processing declarations onto the mod set.
 *
 * Takes the config as a PARAMETER rather than closing over it, and that is the
 * point rather than a style choice. This started life as a `.map()` inside
 * `runBuildPipeline` that read `collectionConfig` from the enclosing scope
 * — fifty-seven lines before that variable was declared. TypeScript cannot
 * prove execution order across a closure boundary, so it compiled cleanly and
 * threw "Cannot access 'collectionConfig' before initialization" the moment a
 * curator pressed Build. It caught the same mistake instantly elsewhere in
 * this file, where the reference happened to be direct.
 *
 * As an argument, calling it too early is a compile error again.
 */
/**
 * One mod's config answers, overlaid onto it.
 *
 * Both flags come from the same place and neither exists in Vortex, so they
 * are applied together rather than by two passes that could disagree about
 * which mods they saw.
 */
function declarationsFor(
  entry: ExternalModConfigEntry | undefined,
  mod: AuditorMod,
): AuditorMod {
  if (entry?.postProcessed !== true && entry?.mirrored !== true) return mod;

  /**
   * ─── AN INCOMPLETE CAPTURE REVOKES A STORED "MIRROR" ANSWER (NS-2) ──────
   * `stagingCaptureIncomplete` used to gate only the QUESTION: `runSelfChecks`
   * drops such a mod from `mirrorable`, so the curator is never re-asked. But
   * a mod answered "mirror" in an earlier build is already settled, and this
   * function copied that answer forward regardless.
   *
   * The result shipped a mirror instruction backed by a file list we KNOW is
   * short. On the user's machine `planMirror` sees nothing unverifiable and a
   * non-empty target, so neither withholding guard fires, and every real file
   * under the subtree the curator's walk could not read is classified as the
   * user's own junk and DELETED — files their archive installed correctly.
   * `mirrorProvesTarget` then certifies the amputated folder.
   *
   * So incompleteness has to veto the outcome, not just the offer. The mod
   * still ships; it ships un-mirrored, which is the safe direction.
   */
  const captureIncomplete =
    (mod as { stagingCaptureIncomplete?: boolean }).stagingCaptureIncomplete ===
    true;

  return {
    ...mod,
    ...(entry.postProcessed === true ? { postProcessed: true } : {}),
    ...(entry.mirrored === true && !captureIncomplete
      ? { mirrored: true }
      : {}),
  };
}

/**
 * Absolute source paths for every staged file of every mirrored mod.
 *
 * Content-addressed on the way out, so the same cleaned plugin shared by two
 * mods is carried once. A file with no recorded hash is skipped rather than
 * shipped: the install side verifies each blob against its own name before
 * writing it, and a blob that cannot be verified could never be used.
 */
export function collectMirrorPayload(
  state: types.IState,
  gameId: string,
  mods: readonly AuditorMod[],
  /**
   * The collection config, so this obeys the SAME precedence the curator was
   * shown. Optional only so existing callers and tests keep working; without
   * it a mod answered both ways ships its bytes twice.
   */
  config?: CollectionConfig,
): MirrorFileSpec[] {
  const installRoot = installRootFor(state, gameId);
  if (installRoot === undefined) return [];

  const out: MirrorFileSpec[] = [];
  const seen = new Set<string>();
  for (const mod of mods) {
    if (mod.mirrored !== true) continue;
    /**
     * A BUNDLED mod already ships its whole staging folder as an archive, so
     * collecting it again as mirror blobs writes the same bytes into the
     * package twice — on a 6 GB LOD mod that is 6 GB of nothing.
     *
     * The two flags are not mutually exclusive in the config: the decisions
     * screen clears the others when it writes one, but the build form's
     * source picker does not, so ticking "Bundled" on a mod already answered
     * "mirror" leaves both set. `choiceFromEntry` ranks bundle above mirror
     * and that is the verdict the curator is shown; this makes the packager
     * obey the same precedence instead of honouring both.
     */
    if (
      config !== undefined &&
      choiceFromEntry(config.externalMods[mod.id]) === "bundle"
    ) {
      continue;
    }
    const root = stagingRootFromFolder(installRoot, mod.installationPath);
    if (root === undefined) continue;
    for (const file of mod.stagingFiles ?? []) {
      if (file.sha256 === undefined || seen.has(file.sha256)) continue;
      seen.add(file.sha256);
      out.push({
        sourcePath: path.join(root, ...file.path.split("/")),
        sha256: file.sha256,
        // Carried so a build that fails on this file can name the mod.
        modName: mod.name,
      });
    }
  }
  return out;
}

export function applyPostProcessedDeclarations(
  mods: readonly AuditorMod[],
  config: CollectionConfig,
): AuditorMod[] {
  /**
   * ─── A DROPPED MOD LEAVES HERE ──────────────────────────────────────
   * The fourth answer, applied at the one point every later phase reads
   * from: the manifest, bundling, mirroring and the self-check all work off
   * this list, so removing the mod here removes it from all of them without
   * four separate filters that could disagree.
   *
   * Nothing is removed from the curator's Vortex. They keep the mod; the
   * collection stops carrying it.
   */
  const kept = mods.filter((m) => config.externalMods[m.id]?.dropped !== true);
  if (kept.length !== mods.length) {
    ehLog("info", "build.mods-dropped", {
      count: mods.length - kept.length,
      mods: mods
        .filter((m) => config.externalMods[m.id]?.dropped === true)
        .slice(0, 20)
        .map((m) => m.name),
    });
  }
  return kept.map((m) => declarationsFor(config.externalMods[m.id], m));
}

export interface BuildOverrides {
  /** modId → override to apply on top of the existing config entry. */
  externalMods: Record<string, ExternalModConfigEntry>;
  readme: string;
  changelog: string;
  /**
   * @deprecated Ignored. Every build verifies at `"thorough"`.
   *
   * It was a choice, and the choice was a trap: `"fast"` records paths and
   * sizes only, and `computeStagingSetHash` needs a sha256 on EVERY file — so
   * an external mod with no archive had no identity and could not be packaged
   * at all. `"none"` shipped a collection with no integrity data. Kept on the
   * type so existing drafts and saved configs still parse.
   */
  verificationLevel?: VerificationLevel;
  /**
   * Read every staged file again, ignoring cached hashes.
   *
   * Hashes are normally reused while a file's path, size and mtime all match,
   * which is what makes verifying 205GB affordable on every build. The one
   * thing that fingerprint cannot see is bytes rewritten IN PLACE without
   * changing either — disk rot rather than anything Vortex does. This forces
   * the full read for when the curator wants that guarantee rather than the
   * fast answer.
   */
  reverifyEverything?: boolean;
}

// ===========================================================================
// Errors
// ===========================================================================

export class BundleResolutionError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(
      errors.length === 1
        ? errors[0]
        : `Cannot resolve bundled archives (${errors.length} problems):\n  - ${errors.join(
            "\n  - ",
          )}`,
    );
    this.name = "BundleResolutionError";
    this.errors = errors;
  }
}

// ===========================================================================
// Public API
// ===========================================================================

/**
 * Pre-flight: read state, hash mods, load (or create) the collection
 * config. Returns the form-population shape the React BuildPage needs.
 *
 * Pass `signal` to make the (potentially long) hashing pass
 * cancellable. Cancellation rejects with `AbortError` from
 * `core/archiveHashing`. Hashing is read-only so abort is always safe.
 */
export async function loadBuildContext(
  api: types.IExtensionApi,
  opts?: {
    onProgress?: (p: BuildProgress) => void;
    /**
     * If provided, overrides the slug used to look up the collection
     * config. Useful when the curator has just renamed the collection
     * in the form and we want to load (or create) the new file.
     */
    nameOverride?: string;
    signal?: AbortSignal;
  },
): Promise<BuildContext> {
  const op = beginOp("build.load-context");
  const onProgress = opts?.onProgress;
  const signal = opts?.signal;
  const state = api.getState();

  const gameId = getActiveGameId(state);
  if (!gameId) {
    throw new Error(
      "No active game in Vortex. Switch to a supported Creation Engine game first.",
    );
  }

  if (!SUPPORTED_GAME_IDS.has(gameId)) {
    throw new Error(
      `Game "${gameId}" is not supported by Event Horizon. Supported: ${Array.from(
        SUPPORTED_GAME_IDS,
      ).join(", ")}.`,
    );
  }

  const profileId = getActiveProfileIdFromState(state, gameId);
  if (!profileId) {
    throw new Error(`No active profile for game "${gameId}".`);
  }

  // Vortex's staging folder is not the profile, and the profile is not the
  // collection: a profile IS its enabled mods, so anything switched off is not
  // being shipped. Scoping here rather than later means the disabled ones are
  // never hashed, walked or verified — and it removes duplicate-identity
  // collisions for free, because the superseded copy is the disabled one.
  const profileMods = getModsForProfile(state, gameId, profileId);
  const scope = scopeCollectionMods(profileMods);
  const rawModsFromVortex = scope.included;
  op.step("mods-scoped", {
    inProfile: profileMods.length,
    enabled: rawModsFromVortex.length,
    excludedDisabled: scope.excludedDisabled.length,
    collidingIdentities: scope.collidingIdentities.length,
    multipleEnabledInstalls: scope.multipleInstalls.length,
    ...(scope.multipleInstalls.length > 0
      ? {
          multipleInstallDetail: scope.multipleInstalls.slice(0, 25).map((g) => ({
            key: g.key,
            mods: g.mods.map((m) => `${m.name} (${m.version ?? "?"})`),
          })),
        }
      : {}),
  });

  // Read before the question is asked, not after. A recovered archive sits in
  // the download cache under an id of its own while the mod's record still
  // names the dead one, and this file is the only place that link survives —
  // so without it a successful recovery of 771 archives reports as 771 still
  // missing, one second into the next build.
  const ehDir = path.join(getVortexUserDataPath(), "event-horizon");
  const hashCache = await loadArchiveHashCache(ehDir);
  const rawMods = applyCachedDownloadIds(rawModsFromVortex, hashCache);

  // Costs nothing — pure state — and it answers in one second the question
  // that otherwise costs 15 minutes of hashing, or 45 minutes and a rejected
  // manifest: are the source archives even still there?
  const noArchivePath = findModsWithNoArchivePath(state, gameId, rawMods);
  if (noArchivePath.length > 0) {
    const fetchable = noArchivePath.filter(
      (m) => m.nexusModId !== undefined && m.nexusFileId !== undefined,
    ).length;
    op.step("archives-missing", {
      mods: noArchivePath.length,
      recoverableFromNexus: fetchable,
      noNexusSource: noArchivePath.length - fetchable,
      example: noArchivePath[0]?.name,
    });
  }

  onProgress?.({
    phase: "hashing-mods",
    message: `Hashing ${rawMods.length} mod archives...`,
    done: 0,
    total: rawMods.length,
  });
  op.step("hashing-start", { archives: rawMods.length });
  // Hashing ~900 archives is minutes of disk-bound work, and until this logged
  // anything the operation looked indistinguishable from a hang: `.start` with
  // no `.ok` and nothing in between. Throttled so a large profile adds a
  // bounded number of lines rather than one per mod.
  const hashLogEvery = Math.max(25, Math.ceil(rawMods.length / 20));
  let lastLogged = 0;
  const hashStartedAt = Date.now();
  const hashReuse = makeHashLookup(hashCache);
  const { lookup, added } = hashReuse;

  let mods = await enrichModsWithArchiveHashes(state, gameId, rawMods, {
    hashCache: lookup,
    concurrency: 4,
    signal,
    onProgress: (done, total, mod) => {
      if (done - lastLogged >= hashLogEvery || done === total) {
        lastLogged = done;
        const elapsed = Date.now() - hashStartedAt;
        op.step("hashing-progress", {
          done,
          total,
          ms: elapsed,
          // Rough remaining estimate, so a slow run can be told apart from a
          // stalled one without waiting for it to finish.
          etaMs: done > 0 ? Math.round((elapsed / done) * (total - done)) : undefined,
        });
      }
      onProgress?.({
        phase: "hashing-mods",
        message: `Hashing mod archives (${done} / ${total})...`,
        done,
        total,
        currentItem: mod.name,
      });
    },
  });
  op.step("hashing-done", {
    ms: Date.now() - hashStartedAt,
    // COUNTED, not inferred. This was first written as
    // `rawMods.length - added.size`, which reports "955 reused, 0 hashed" when
    // the cache is not consulted at all — the exact opposite of the truth, next
    // to an `ms` of seventeen minutes. A metric that cannot distinguish "it
    // worked" from "it never ran" is worse than no metric.
    reusedFromCache: hashReuse.hits,
    freshlyHashed: added.size,
    hashedArchives: rawMods.length,
  });

  // Persist what was computed, so the next build reuses it. Failure here costs
  // a repeat of the hashing pass, never the build itself.
  if (added.size > 0) {
    try {
      await saveArchiveHashCache(
        ehDir,
        mergeHashes(hashCache, added, new Date().toISOString()),
      );
    } catch (err) {
      op.step("hash-cache-write-failed", { err: String(err) });
    }
  }

  // Fill gaps left by archives Vortex no longer has, from hashes recovered on a
  // previous run. Applied AFTER hashing on purpose: anything hashed from a real
  // file this run keeps that value, so a stale cache entry can never contradict
  // bytes on disk.
  const cached = applyCachedHashes(mods, hashCache);
  mods = cached.mods;
  if (cached.filled > 0) {
    op.step("hashes-from-cache", {
      filled: cached.filled,
      cacheEntries: Object.keys(hashCache.entries).length,
    });
  }

  // Two external mods can be separate downloads of byte-identical archives, so
  // they only collide once a hash exists. buildManifest catches it, but not
  // until after the staging pass — 31 minutes later on this profile.
  const hashedCollisions = findHashedIdentityCollisions(mods);
  if (hashedCollisions.length > 0) {
    op.step("identity-collisions", {
      groups: hashedCollisions.length,
      detail: hashedCollisions.slice(0, 10).map((g) => ({
        key: g.key,
        mods: g.mods.map((m) => m.name),
      })),
    });
  }

  const appDataPath = getVortexUserDataPath();
  const configDir = getCollectionsConfigDir();

  // Default to the collection this curator most recently built FOR THIS GAME,
  // not a hard-coded "My Collection".
  //
  // The constant was a silent rollback: build "ivy", open a fresh draft, and
  // the form says "My Collection" again — and, worse than the label, it loads
  // that collection's config, so the bundle ticks, README and prerequisites
  // just set on "ivy" are not the ones on screen. The name is the identity
  // here (it picks the slug, which picks the config, which carries the
  // packageId), so getting it wrong is not cosmetic.
  let defaultName = opts?.nameOverride;
  if (defaultName === undefined) {
    try {
      defaultName = pickDefaultCollectionName(
        await listPublishedCollections(configDir),
        gameId,
      );
    } catch {
      defaultName = FALLBACK_COLLECTION_NAME;
    }
  }
  const slug = slugify(defaultName);
  const loaded = await loadOrCreateCollectionConfig({ configDir, slug });
  let collectionConfig = loaded.config;

  // What will ACTUALLY stop the manifest, now that both the disk and the cache
  // have had their say. The pre-hash probe above is an early estimate for the
  // log; this is the number the curator is told, and it is the one that shrinks
  // when archives are recovered.
  // A mod the curator marked `treatAsExternal` is NOT unidentified: it ships,
  // keyed by the SHA-256 of its deployed files, and `buildManifest` accepts it
  // without an archive. Counting it here produced "1 Nexus mod cannot be
  // packaged" for a mod that packages perfectly well — while the availability
  // panel three inches below correctly labelled the same mod "ships as an
  // external mod". Two answers to one question, on one screen.
  const unidentified = findUnidentifiedMods(mods, collectionConfig);

  // Computed HERE, after the config is loaded, because it now depends on it.
  //
  // A Nexus mod the curator marked `treatAsExternal` belongs in this table
  // too: its Nexus file is gone, so it needs exactly what an external mod
  // needs — a bundle, a link, or instructions. Reusing the existing table
  // rather than inventing a second one means it inherits the review that one
  // has already had.
  const forcedExternal = new Set(
    Object.entries(collectionConfig.externalMods)
      .filter(([, e]) => e.treatAsExternal === true)
      .map(([id]) => id),
  );
  const externalMods = mods.filter(
    (m) => !isNexusMod(m) || forcedExternal.has(m.id),
  );

  // Reconcile so the curator opens the form already showing every
  // external mod, even ones added since the last build.
  const reconciled = reconcileExternalModsConfig({
    config: collectionConfig,
    externalMods: externalMods.map((m) => ({ id: m.id, name: m.name })),
  });
  if (reconciled.changed) {
    collectionConfig = reconciled.config;
    await saveCollectionConfig({
      configDir,
      slug,
      config: collectionConfig,
    });
  }

  // Prerequisites that are NOT Vortex mods. Detected here rather than during
  // the build so the curator can see and edit them on the form, which is the
  // only moment they can actually write the instructions.
  //
  // "A file the collection installs is not a prerequisite" is answered from
  // Vortex's own deployment manifest — one read, authoritative, and it already
  // knows which mod won each file. Walking every staging folder would answer
  // the same question far more slowly and by inference.
  let detectedDependencies: EhcollExternalDependency[] = [];
  let dependencyProvidedFiles: ReadonlySet<string> = new Set<string>();
  const dependencyWarnings: string[] = [];
  let rootBinaryNotes: string[] = [];
  try {
    const gameDir = getGameDirectory(state, gameId);
    if (gameDir !== undefined) {
      const deployed = await captureDeploymentManifests(api, state, gameId);
      const providedByMods = filesProvidedByDeployment(deployed);
      dependencyProvidedFiles = providedByMods;
      detectedDependencies = await detectExternalDependencies(gameDir, gameId, {
        signal,
        providedByMods,
      });
      const unpaired = describeMissingEngineFixesPart2({
        gameId,
        declared: detectedDependencies,
        deployedFiles: providedByMods,
      });
      if (unpaired !== undefined) dependencyWarnings.push(unpaired);

      // Provable, unlike injector detection: SKSE plugins with no SKSE is a
      // collection that cannot work on any machine that lacks it already.
      const seGap = describeScriptExtenderGap({
        gameId,
        mods: rawMods,
        declared: detectedDependencies,
      });
      if (seGap !== undefined) dependencyWarnings.push(seGap);

      // Knows nothing about any particular mod: a directory listing filtered
      // to executable code, minus whatever is already accounted for. The
      // probes above can be wrong or missing; this cannot fail in that
      // direction, because it makes no claim about what the files are.
      rootBinaryNotes = describeUnaccountedRootBinaries({
        rootBinaries: await listRootBinaries(gameDir),
        providedByMods,
        declared: detectedDependencies,
      });
    }
    const gameDirKnown = getGameDirectory(state, gameId) !== undefined;
    op.step("external-deps-detected", {
      gameDirKnown,
      detected: detectedDependencies.map((d) => `${d.id}@${d.version}`),
    });
    /**
     * ─── "CANNOT CHECK" IS NOT "NOTHING INSTALLED" ─────────────────────
     * The whole scan sits inside `if (gameDir !== undefined)`. When Vortex
     * has not discovered the game, it fell through with an empty list and no
     * warning — so the curator built and shipped a collection declaring zero
     * prerequisites, with nothing on screen saying the scan had not run.
     * `getGameDirectory`'s own docblock says this must not happen; the
     * function honours it and the caller did not.
     */
    if (!gameDirKnown) {
      dependencyWarnings.push(
        `Could not find this game's install folder, so nothing was checked ` +
          `for script extenders, ENB or engine injectors. That is NOT the ` +
          `same as "none are needed" — if this collection depends on SKSE or ` +
          `similar, the package will not mention it. Point Vortex at the ` +
          `game and reopen this page to scan properly.`,
      );
    }
  } catch (err) {
    // Never fail a build context over a prerequisite scan — but never let it
    // fail quietly either. An empty list looks identical to a clean scan.
    op.step("external-deps-failed", { err: String(err) });
    dependencyWarnings.push(
      `The scan for script extenders and engine injectors did not complete ` +
        `(${String(err)}), so this package may declare fewer prerequisites ` +
        `than the collection actually needs.`,
    );
  }

  op.ok({
    gameId,
    profileId,
    mods: mods.length,
    externalDependencies: detectedDependencies.length,
    excludedDisabled: scope.excludedDisabled.length,
    externalMods: externalMods.length,
    // hashed < mods is the first number to look at when a build does not
    // reproduce: an unhashed external archive has no stable identity.
    hashed: mods.filter((m) => m.archiveSha256 !== undefined).length,
  });

  // Suggested download links/instructions for the external mods, from what
  // Vortex already knows. Computed HERE rather than only at build time,
  // because the curator edits these on the Build form and a suggestion that
  // only exists inside the built manifest is a suggestion they never see.
  const externalHints = collectExternalHints({
    modsInState: modsFromState(api, gameId),
    downloads: downloadsFromState(api),
    externalMods,
  });
  op.step("external-hints-available", {
    found: externalHints.size,
    ofExternal: externalMods.length,
    // Which fields Vortex actually holds for these mods. Distinguishes "there
    // is nothing to find" from "we are reading the wrong place" — field
    // NAMES only, never their contents.
    sources: diagnoseHintSources({
      modsInState: modsFromState(api, gameId),
      downloads: downloadsFromState(api),
      externalMods,
    }),
    // Which source answered. `found: 0` here means Vortex is holding nothing
    // for these mods — no collection download hints, no usable sourceURI, no
    // homepage — which is the difference between "the feature is broken" and
    // "there is nothing to find".
    via: countBy([...externalHints.values()].map((h) => h.via)),
  });

  return {
    gameId: gameId as SupportedGameId,
    profileId,
    mods,
    detectedDependencies,
    dependencyProvidedFiles,
    externalHints,
    gameVersion: await resolveGameVersion(state, gameId),
    scopeWarnings: [
      ...describeScope(scope),
      ...describeHashedCollisions(hashedCollisions),
      ...describeMissingArchives(unidentified),
      // A prerequisite the curator does not have themselves cannot be
      // detected, only deduced from what the collection ships.
      ...dependencyWarnings,
    ],
    rootFolderReview: [
      ...describeRootFolderReview({
        rootMods: findRootFolderMods(rawMods),
        declared: detectedDependencies,
      }),
      ...rootBinaryNotes,
    ],
    externalMods,
    collectionConfig,
    configPath: loaded.configPath,
    configCreated: loaded.created,
    defaultName,
    defaultVersion: "1.0.0",
    defaultAuthor: "",
  };
}

/**
 * Tell the curator what a missing archive costs them, once, with a number —
 * rather than as N identical manifest errors after the build has run.
 */
/**
 * The phrases that let these two warnings be RECOGNISED again later.
 *
 * They are constants rather than inline prose because the one consumer that
 * matters reads them back: "Re-download archives" replaces these warnings with
 * freshly computed ones, and it can only do that if it can spot the old ones.
 *
 * That match used to be a hand-copied substring living in buildSession.ts. When
 * this message was split into its Nexus and external halves, the copy was left
 * describing a sentence that no longer existed anywhere — "no source archive in
 * Vortex's download cache" is a blend of the two replacements and matches
 * NEITHER. So nothing was ever removed, and the fresh warning was appended
 * beside the stale one.
 *
 * The curator who found it had just re-downloaded 771 archives and was still
 * told 771 were missing, with the true count sitting one line below.
 *
 * Splicing them INTO the message is what makes that unrepeatable: reword the
 * constant and both the sentence and the matcher move together.
 */
const NEXUS_ARCHIVE_MISSING = "the archive is not in Vortex's download cache";

const EXTERNAL_ARCHIVE_MISSING =
  "no source archive and no Nexus source to fetch one from";

/**
 * Did this warning come from `describeMissingArchives`?
 *
 * Lives beside the producer deliberately — a predicate that travels with the
 * strings it matches cannot drift away from them.
 */
export function isMissingArchiveWarning(warning: string): boolean {
  return (
    warning.includes(NEXUS_ARCHIVE_MISSING) ||
    warning.includes(EXTERNAL_ARCHIVE_MISSING)
  );
}

export function describeMissingArchives(missing: AuditorMod[]): string[] {
  if (missing.length === 0) return [];

  // The two halves fail COMPLETELY differently and used to share one sentence.
  //
  // A Nexus mod is identified by (modId, fileId, sha256) with no fallback, so
  // losing its archive genuinely blocks the build. An EXTERNAL mod falls back
  // to the sha256 of its deployed files, so it packages fine — the first real
  // build shipped all 955 mods with six of these present. Telling the curator
  // those six "cannot be packaged", and advising a verification level that is
  // now the only one there is, was wrong on both counts.
  const nexus = missing.filter(isNexusMod);
  const external = missing.filter((m) => !isNexusMod(m));
  const lines: string[] = [];

  if (nexus.length > 0) {
    lines.push(
      `${nexus.length} Nexus mod${nexus.length === 1 ? "" : "s"} cannot be ` +
        `packaged: a Nexus mod is identified by its archive's SHA-256 and ` +
        `${NEXUS_ARCHIVE_MISSING}. Fetch them with ` +
        `"Re-download archives" on the build form, or re-import them by hand.`,
    );
  }

  if (external.length > 0) {
    lines.push(
      `${external.length} mod${external.length === 1 ? "" : "s"} have ` +
        `${EXTERNAL_ARCHIVE_MISSING}. They still ship — they ` +
        `are identified by the SHA-256 of their deployed files instead — but ` +
        `that identity is weaker: a user whose copy differs even slightly will ` +
        `not match it, and will be asked to supply the mod themselves. ` +
        `Re-importing their archives into Vortex would give them a real identity.`,
    );
  }

  return lines;
}

/**
 * Run the full build pipeline using the curator's form input.
 * Persists the latest overrides back into the per-collection config
 * file before producing the package.
 *
 * Pass `signal` to allow cancellation between phases. The pipeline
 * is checkpointed at each phase boundary — if the signal is aborted
 * the pipeline throws `AbortError` from the next checkpoint and no
 * .ehcoll file is written. Phases that have already completed (e.g.
 * the per-collection config was just saved) are persistent, but
 * those writes are read-only-state changes that the curator can
 * trivially overwrite by clicking Build again.
 */
/**
 * The build refused to produce a package, and why.
 *
 * A distinct class so the page can render the reason as guidance rather than
 * as a crash — this is not a failure of the build, it is the build declining
 * to make something that would not work.
 */
export class BuildRefusedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BuildRefusedError";
    this.code = code;
  }
}

/**
 * One line for the whole build, not one per mod.
 *
 * A 900-mod build can produce forty-five of these, and forty-five near-
 * identical warnings in a summary is the same as none: the curator scrolls
 * past. The count is the fact — "45 mods ship without a staging record" — and
 * three examples are enough to find the cause.
 */
function summariseCaptureWarnings(warnings: readonly string[]): string[] {
  if (warnings.length === 0) return [];
  const examples = warnings.slice(0, 3).join("; ");
  return [
    `${warnings.length} mod${warnings.length === 1 ? "" : "s"} could not be ` +
      `fully inspected, so ${warnings.length === 1 ? "it ships" : "they ship"} ` +
      `with a weaker file record and will be verified only partially on a ` +
      `user's machine. First: ${examples}` +
      (warnings.length > 3 ? ` (+${warnings.length - 3} more)` : ""),
  ];
}

export async function runBuildPipeline(
  api: types.IExtensionApi,
  context: BuildContext,
  curator: CuratorInput,
  overrides: BuildOverrides,
  opts?: {
    onProgress?: (p: BuildProgress) => void;
    signal?: AbortSignal;
    /**
     * Called once, mid-build, when mods need a post-processing decision.
     *
     * The build WAITS on this promise. Whatever answers the handler records
     * into the collection config are picked up when it resolves, so they
     * apply to the package being built rather than the next one.
     *
     * Omit it and the build never pauses — the Done card asks afterwards,
     * exactly as before.
     */
    onDecisions?: (candidates: PostProcessingCandidate[]) => Promise<void>;
  },
): Promise<BuildPipelineResult> {
  const op = beginOp("build.pipeline", {
    gameId: context.gameId,
    name: curator.name,
    version: curator.version,
    mods: context.mods.length,
  });
  const onProgress = opts?.onProgress;
  const signal = opts?.signal;
  const onDecisions = opts?.onDecisions;
  const checkAbort = (): void => {
    if (signal?.aborted) {
      throw new AbortError("Build cancelled by user");
    }
  };

  checkAbort();
  const state = api.getState();
  const { gameId } = context;
  let mods = context.mods;

  // ── 0. The profile may have moved since the form opened ────────────────
  // `loadBuildContext` runs once, in `begin()`. Every build after that reused
  // its snapshot, so enabling or disabling a mod in Vortex and pressing Build
  // again shipped the OLD membership — and said nothing. Measured: a rebuild
  // produced a mod set identical to the previous one down to every
  // compareKey, with no load-context pass in the log at all.
  //
  // Re-read it here. Cheap: pure Redux state, and mods already known keep
  // their hashes, so only genuinely new ones are hashed (usually a cache hit).
  const membership = await refreshProfileMembership({
    state,
    gameId,
    profileId: context.profileId,
    known: mods,
    signal,
  });
  mods = membership.mods;
  if (membership.warnings.length > 0) {
    op.step("membership-refreshed", {
      added: membership.addedNames.length,
      removed: membership.removedNames.length,
      mods: mods.length,
    });
  }

  // ── 1. Apply form overrides on top of the loaded config ────────────────
  const slug = slugify(curator.name);
  const appDataPath = getVortexUserDataPath();
  const outputDir = getCollectionsDir();
  const configDir = path.join(outputDir, ".config");

  // If the curator renamed the collection, load (or create) the
  // config file for the NEW slug — the package id of the original
  // collection stays with the original name.
  let collectionConfig = context.collectionConfig;
  let configPath = context.configPath;
  const renameWarnings: string[] = [];
  if (slug !== slugify(context.defaultName)) {
    const reloaded = await loadOrCreateCollectionConfig({ configDir, slug });
    const forked = reloaded.config.packageId !== context.collectionConfig.packageId;
    collectionConfig = reloaded.config;
    configPath = reloaded.configPath;

    const reconciled = reconcileExternalModsConfig({
      config: collectionConfig,
      externalMods: context.externalMods.map((m) => ({
        id: m.id,
        name: m.name,
      })),
    });
    if (reconciled.changed) {
      collectionConfig = reconciled.config;
    }

    // The prerequisites the curator ticked live on the config, not the form,
    // and a rename swaps the config out from under them. They were being
    // silently reset to "none required" — the one part of a collection that
    // stops a user's game from launching at all.
    if (
      collectionConfig.externalDependencies === undefined &&
      context.collectionConfig.externalDependencies !== undefined
    ) {
      collectionConfig = {
        ...collectionConfig,
        externalDependencies: context.collectionConfig.externalDependencies,
      };
    }

    if (forked) {
      // Renaming does not rename anything — the name picks the slug, the slug
      // picks the config, and the config carries the packageId that ties
      // releases together. So this is a NEW collection, the old one is still
      // listed under its old name, and nobody who installed it will be
      // offered this as an update. That is a defensible design and a terrible
      // surprise, so it is said out loud.
      renameWarnings.push(
        `This built a NEW collection called "${curator.name}", not a new ` +
          `version of "${context.defaultName}". A collection's name is its ` +
          `identity here, so renaming forks it: "${context.defaultName}" is ` +
          `still on your dashboard with its own release history, and anyone ` +
          `who installed it will not see this as an update. If you meant to ` +
          `rename, delete the old one; if you meant to update it, build again ` +
          `under its original name.`,
      );
    }
  }

  // AFTER the rename block, which can swap the whole config out: applying the
  // curator's declarations to the old one would read answers that belong to a
  // different collection.
  mods = applyPostProcessedDeclarations(mods, collectionConfig);

  collectionConfig = {
    ...collectionConfig,
    externalMods: {
      ...collectionConfig.externalMods,
      ...overrides.externalMods,
    },
    readme: overrides.readme,
    changelog: overrides.changelog,
  };

  checkAbort();
  onProgress?.({ phase: "writing-config" });
  await saveCollectionConfig({ configDir, slug, config: collectionConfig });

  // ── 2. Capture deployment + load order + plugins.txt ───────────────────
  // ── 2a. Inspect curator staging folders (file-integrity capture) ──────
  // Walks `<install-path>/<mod.installationPath>` for each mod and
  // records `{path, size, sha256?}` into `mod.stagingFiles`. The
  // user-side `verifyModInstall` check uses this to detect Vortex's
  // "lost file" bug after a mod install completes.
  //
  // `level === "none"` skips the walk entirely (no allocations, no
  // I/O); chosen by the curator when they want fast builds and
  // accept losing the post-install integrity check.
  // ALWAYS thorough. The level used to be the curator's choice, and the choice
  // was a trap: `fast` records paths and sizes only, and `computeStagingSetHash`
  // needs a sha256 on every file — so an external mod with no archive had no
  // identity at all and simply could not be packaged. "Skip" shipped a
  // collection with no integrity data, which is the one thing this tool exists
  // to provide. What made thorough expensive was re-reading 205GB on every
  // build; the hash cache removes that, so there is nothing left to trade.
  const verificationLevel: VerificationLevel = "thorough";
  {
    checkAbort();
    onProgress?.({
      phase: "inspecting-mods",
      message: `Inspecting ${mods.length} mod folders (${verificationLevel})...`,
      done: 0,
      total: mods.length,
    });
    // 205GB of staging across 993 folders at `thorough` took 34 minutes with
    // NOT ONE log line — the same "cannot tell slow from hung" hole that was
    // fixed for archive hashing and left open on the larger pass. Throttled to
    // ~20 lines regardless of profile size, with an ETA from the observed rate.
    const stagingOp = beginOp("build.staging-capture", {
      mods: mods.length,
      level: verificationLevel,
    });
    const stagingLogEvery = Math.max(25, Math.ceil(mods.length / 20));
    let stagingLogged = 0;
    const stagingStartedAt = Date.now();

    // Re-verification deliberately passes NO cache, so every byte is read
    // again. That is the escape hatch for the one thing a fingerprint cannot
    // see: bytes rewritten in place without changing size or mtime.
    const stagingDir = path.join(getVortexUserDataPath(), "event-horizon");
    const stagingCache = await loadArchiveHashCache(stagingDir);
    // Re-verification ignores what is already cached, so every byte is read
    // again — but it still RECORDS what it computes. Skipping the cache
    // entirely was the first attempt, and it meant one re-verify threw away the
    // fast path permanently: 26 minutes of hashing, nothing written, and the
    // next ordinary build paying it all over again.
    const stagingReuse = makeHashLookup(stagingCache, {
      ignoreExisting: overrides.reverifyEverything === true,
    });

    mods = await captureStagingFiles(state, gameId, mods, {
      level: verificationLevel,
      signal,
      hashCache: stagingReuse.lookup,
      onProgress: (done, total, mod) => {
        if (done - stagingLogged >= stagingLogEvery || done === total) {
          stagingLogged = done;
          const elapsed = Date.now() - stagingStartedAt;
          stagingOp.step("progress", {
            done,
            total,
            ms: elapsed,
            etaMs: done > 0 ? Math.round((elapsed / done) * (total - done)) : undefined,
          });
        }
        onProgress?.({
          phase: "inspecting-mods",
          message:
            verificationLevel === "thorough"
              ? `Hashing files in mod folders (${done} / ${total})...`
              : `Inspecting mod folders (${done} / ${total})...`,
          done,
          total,
          currentItem: mod.name,
        });
      },
      onWarn: (mod, message) => {
        /**
         * These are the four ways a mod loses its staging record — no
         * installationPath, a path that will not resolve, a failed walk, an
         * incomplete one — and every one of them means the shipped package
         * cannot verify that mod on a user's machine.
         *
         * They used to reach `console.warn` and nothing else, so a build could
         * report success with a proud `stagingFileCount` while forty-five mods
         * shipped un-verifiable and the curator was never told. Into the log
         * AND into the warnings the build summary actually shows.
         */
        ehLog("warn", "build.capture.warn", {
          mod: mod.name,
          message,
          consequence:
            "this mod ships with a weaker staging record than the rest",
        });
        captureWarnings.push(`${mod.name}: ${message}`);
      },
    });
    // `stagingFiles` populated here is what buildManifest turns into
    // stagingSetHash and what the self-check compares against, so an empty
    // count is the thing to notice — it silently disables both.
    if (stagingReuse.added.size > 0) {
      try {
        await saveArchiveHashCache(
          stagingDir,
          mergeHashes(stagingCache, stagingReuse.added, new Date().toISOString()),
        );
      } catch (err) {
        stagingOp.step("cache-write-failed", { err: String(err) });
      }
    }

    const withStaging = mods.filter((m) => (m.stagingFiles?.length ?? 0) > 0).length;
    stagingOp.ok({
      mods: mods.length,
      withStagingFiles: withStaging,
      withoutStagingFiles: mods.length - withStaging,
      // Counted, not inferred — see the archive pass for why that matters.
      filesReusedFromCache: stagingReuse.hits,
      filesFreshlyHashed: stagingReuse.added.size,
      reverified: overrides.reverifyEverything === true,
    });
  }

  checkAbort();

  // ── External mods the curator maintains by hand ──────────────────────
  // A mod edited in place looks perfectly healthy — it installs, deploys and
  // runs — and the divergence is invisible until somebody ELSE installs the
  // collection and gets the original archive instead. So it is said out loud,
  // and bundling packs the staging folder rather than the stale archive.
  const driftOp = beginOp("build.external-drift", {});
  let repackedBundles: RepackedBundle[] = [];
  /**
   * Mods flagged for bundling whose repack failed.
   *
   * They must be excluded from `resolveBundledArchives` explicitly. The filter
   * there keys off SUCCESSFUL repacks, so a failed one fell through and was
   * resolved by its original `archiveSha256` — shipping the untouched Nexus
   * archive, from inside the package, for a mod whose whole point was the
   * files the curator added to it. The warning said "It will not ship".
   */
  const failedRepackIds = new Set<string>();
  const bundleWarnings: string[] = [];
  /**
   * Per-mod staging-capture problems, aggregated rather than one warning per
   * mod: on a 900-mod build the individual lines are unreadable, and the
   * number is the thing that matters.
   */
  const captureWarnings: string[] = [];
  bundleWarnings.push(...renameWarnings);
  bundleWarnings.push(...membership.warnings);

  // Shipping without a game version is allowed — enforcing one nobody can
  // meet is not. Say which of the two is happening rather than letting the
  // curator assume the check exists.
  if (curator.gameVersion.trim().length === 0) {
    bundleWarnings.push(
      context.gameVersion === "unknown"
        ? `No game version is recorded for this collection — Vortex could not ` +
          `read one from your install and none was typed in, so users will not ` +
          `be warned if their game version differs from yours. Fill in ` +
          `"Required game version" on the form if you know it.`
        : `No game version requirement was set, so users on any version can ` +
          `install this. Your own game is ${context.gameVersion} if you want ` +
          `to require it.`,
    );
  }
  const repackDir = path.join(getVortexUserDataPath(), "event-horizon", ".repack");
  try {
    const sevenZip = resolveSevenZip();
    const drift = await detectExternalDrift({
      state,
      gameId,
      mods,
      config: collectionConfig,
      sevenZip,
      // Includes mods the curator marked `treatAsExternal`: they are
      // identified by hash now, so they need exactly the archive checks a
      // born-external mod gets.
      isExternal: (m) =>
        shipsAsExternal(isNexusMod(m), collectionConfig.externalMods[m.id]),
      archivePathFor: (m) => resolveModArchivePath(state, m, gameId),
      listArchive: (p) => listArchiveContents(sevenZip, p),
      ...(signal !== undefined ? { signal } : {}),
    });
    bundleWarnings.push(...describeExternalDrift(drift));

  // Anything the curator's own Vortex collection says is needed that this
  // collection neither ships nor mentions. The prerequisite catalogue is a
  // closed list of seven tools found by their files; their collection is an
  // open list of the same thing, already written down with links.
  bundleWarnings.push(
    ...describeUndeclared(
      undeclaredDependencies({
        modsInState: modsFromState(api, gameId),
        includedMods: context.mods,
      }),
    ),
  );

    const repacked = await repackBundledExternals({
      state,
      gameId,
      mods,
      config: collectionConfig,
      sevenZip,
      workDir: repackDir,
      // Includes mods the curator marked `treatAsExternal`: they are
      // identified by hash now, so they need exactly the archive checks a
      // born-external mod gets.
      isExternal: (m) =>
        shipsAsExternal(isNexusMod(m), collectionConfig.externalMods[m.id]),
      options: {
        ...(signal !== undefined ? { signal } : {}),
        onProgress: (done, total, modName) =>
          onProgress?.({
            phase: "resolving-bundled-archives",
            message: `Packing "${modName}" from its staging folder (${done} / ${total})...`,
            done,
            total,
          }),
      },
    });
    mods = repacked.mods;
    repackedBundles = repacked.bundles;
    for (const id of repacked.failedRepackModIds) failedRepackIds.add(id);
    bundleWarnings.push(...repacked.warnings);

    driftOp.ok({
      diverged: drift.length,
      divergedUnbundled: drift.filter((d) => !d.bundled).length,
      repacked: repacked.bundles.length,
      repackedBytes: repacked.bundles.reduce((n, b) => n + b.bytes, 0),
      detail: drift.slice(0, 20).map((d) => ({
        mod: d.modName,
        removed: d.removed.length,
        added: d.added.length,
        bundled: d.bundled,
      })),
    });
  } catch (err) {
    /**
     * Drift detection and undeclared-dependency reporting really are not worth
     * failing a build over — they are diagnostics. REPACKING IS NOT: it is the
     * only thing in this block that changes the bytes that ship.
     *
     * A throw before the per-mod loop — `fsp.mkdir(workDir)` on a full volume,
     * a `.repack` path left as a file by an antivirus quarantine — left
     * `failedRepackIds` EMPTY. `resolveBundledArchives` then found each mod's
     * original archive on disk and bundled that, and because no repack had
     * changed any `archiveSha256` the packaging bijection matched and the
     * build succeeded. The curator shipped, from inside the .ehcoll, the exact
     * untouched Nexus archive they ticked "bundle" to avoid.
     *
     * So the catch now marks every mod the curator flagged for bundling as a
     * failed repack. `resolveBundledArchives` excludes those while the
     * manifest still says `bundled: true`, and packageZip's existing
     * bijection check turns that into the hard, named failure it already
     * knows how to raise — instead of a silent wrong package.
     */
    let flagged = 0;
    for (const [modId, entry] of Object.entries(collectionConfig.externalMods)) {
      if (entry?.bundled === true) {
        failedRepackIds.add(modId);
        flagged += 1;
      }
    }
    if (flagged > 0) {
      bundleWarnings.push(
        `Repacking the bundled mods did not run (${
          err instanceof Error ? err.message : String(err)
        }). ${flagged} mod${flagged === 1 ? "" : "s"} marked "bundle" cannot ` +
          `ship their staging folder, so this build will refuse rather than ` +
          `quietly ship the original archives.`,
      );
    }
    ehLog("error", "build.repack.block-failed", {
      flaggedForBundling: flagged,
      consequence:
        flagged > 0
          ? "the build will fail rather than ship stale archives"
          : "drift/undeclared diagnostics only — nothing that ships changed",
      err,
    });
    driftOp.fail(err);
  }

  // ── Prerequisites that are NOT Vortex mods ───────────────────────────
  // Deliberately AFTER the staging capture: the rule that keeps this from
  // doing harm is "a file the collection installs is not a prerequisite", and
  // answering that needs each mod's own file list. Detecting earlier would
  // declare the curator's F4SE mod as something every user must hand-install.
  // Detection already happened in loadBuildContext, so the curator saw and
  // edited these on the form. Only their decisions are applied here.
  const externalDependencies = applyDependencyOverrides(
    context.detectedDependencies,
    collectionConfig.externalDependencies,
  );
  beginOp("build.external-deps", { gameId }).ok({
    detected: context.detectedDependencies.length,
    included: externalDependencies.length,
    ids: externalDependencies.map((d) => `${d.id}@${d.version}`),
  });

  /**
   * ─── THE PAIRING WARNING HAS TO SEE WHAT SHIPS, NOT WHAT WAS FOUND ──
   * `describeMissingEngineFixesPart2` also runs during `loadBuildContext`,
   * against the RAW detection — before the curator has touched the form. So
   * detecting Part 2 silenced it permanently: unticking Part 2 afterwards
   * shipped a manifest declaring Part 1 alone, which is the exact silent
   * half-pairing the check exists to prevent, and no warning was ever raised
   * because the only evaluation had already happened against a list that
   * still contained it.
   *
   * Re-evaluated here, where the shipping list is finally known.
   */
  const pairingWarning = describeMissingEngineFixesPart2({
    gameId,
    declared: externalDependencies,
    deployedFiles: context.dependencyProvidedFiles,
  });
  if (pairingWarning !== undefined) {
    ehLog("warn", "build.engine-fixes-unpaired", { gameId, why: pairingWarning });
    bundleWarnings.push(pairingWarning);
  }

  // ── Self-check: is the CURATOR'S OWN staging what it should be? ──────
  // Everything downstream treats this capture as the etalon, so if Vortex lost
  // files during the curator's install the omission is baked into the
  // collection and every user reproduces it. Checked here, against references
  // the curator's disk cannot contaminate: the archive header and the FOMOD
  // script. Advisory only — it never fails a build.
  onProgress?.({
    phase: "inspecting-mods",
    message: "Checking mods against their archives...",
    done: 0,
    total: mods.length,
  });
  const selfCheckOp = beginOp("build.self-check", { mods: mods.length });
  let selfCheckWarnings: string[] = [];
  let postProcessingCandidates: PostProcessingCandidate[] = [];
  try {
    // Bundled mods ship the staging folder itself, so their archive IS their
    // staging and there is nothing to compare. Built from what was actually
    // repacked, not from the curator's intent, so a bundling that silently did
    // not happen still gets checked.
    const repackedIds = new Set(repackedBundles.map((b) => b.modId));
    const selfCheck = await runSelfChecks(state, gameId, mods, {
      shipsOwnBytes: (m) => repackedIds.has(m.id),
      // Every answer the curator has already given, and the diverged files
      // each was given about. Read from the config rather than the overlaid
      // mods: only `postProcessed` and `mirrored` reach a mod, so a bundling
      // decision was invisible here and got re-asked forever.
      decided: decidedPostProcessing(collectionConfig),
      ...(signal !== undefined ? { signal } : {}),
      onProgress: (done, total, modName) => {
        onProgress?.({
          phase: "inspecting-mods",
          message: `Checking mods against their archives (${done} / ${total})...`,
          done,
          total,
          currentItem: modName,
        });
      },
    });
    selfCheckWarnings = selfCheck.warnings;
    postProcessingCandidates = selfCheck.postProcessingCandidates;

    /**
     * ─── ASK BEFORE PACKING ────────────────────────────────────────────
     * The question used to be asked on the Done card, after the package was
     * sealed — so every answer applied to the NEXT build and the curator had
     * to build twice to ship one decision.
     *
     * The answers are written to the config by the caller while this awaits,
     * so everything after this point has to be re-derived from the config
     * rather than from what was loaded before the pause.
     *
     * Optional: with no handler the build runs exactly as it did, and the
     * Done card asks. That keeps every other caller — and the harness —
     * working unchanged.
     */
    if (
      postProcessingCandidates.some((c) => c.needsAnswer) &&
      onDecisions !== undefined
    ) {
      const configBefore = collectionConfig;
      await onDecisions(postProcessingCandidates);

      const reloaded = await loadOrCreateCollectionConfig({ configDir, slug });
      collectionConfig = reloaded.config;
      mods = applyPostProcessedDeclarations(mods, collectionConfig);

      // "Ship my copy" arrives after bundling has already run, because the
      // self-check has to come after bundling to mean anything. A second
      // pass over just the mods that gained the flag is what makes the
      // answer land in this build instead of the next one.
      // A verdict CHANGED away from bundling leaves an archive already
      // repacked on the first pass. Shipping it would put a bundled archive
      // in the package for a mod that is no longer meant to have one.
      const dropped = new Set(modsNoLongerBundled(configBefore, collectionConfig));
      if (dropped.size > 0) {
        repackedBundles = repackedBundles.filter((b) => !dropped.has(b.modId));
      }

      const newlyBundled = modsNewlyBundled(configBefore, collectionConfig);
      if (newlyBundled.length > 0) {
        try {
          const sevenZip = resolveSevenZip();
          const again = await repackBundledExternals({
            state,
            gameId,
            mods,
            config: collectionConfig,
            sevenZip,
            workDir: repackDir,
            isExternal: (m) =>
              shipsAsExternal(isNexusMod(m), collectionConfig.externalMods[m.id]),
            options: {
              ...(signal !== undefined ? { signal } : {}),
              onProgress: (done, total, modName) =>
                onProgress?.({
                  phase: "resolving-bundled-archives",
                  message: `Packing "${modName}" from its staging folder (${done} / ${total})...`,
                  done,
                  total,
                }),
            },
          });
          mods = again.mods;
          /**
           * ─── MERGE BY MOD, NEVER CONCATENATE ─────────────────────────
           * `repackBundledExternals` packs EVERY mod the config marks
           * bundled, not just the ones that changed — it takes the config,
           * not a list. So pass two returns an entry for each already-bundled
           * mod as well, served from the cache with the identical sha256.
           *
           * Concatenating those produced two entries with the same hash, and
           * `packageEhcoll`'s validation rejects that outright: "Two bundled
           * archives share sha256 ... this should be impossible." The build
           * died at packaging, after every expensive phase, for any curator
           * who already had one bundled mod and answered "ship my copy" for
           * one more — which is the ordinary case for this feature.
           */
          repackedBundles = mergeRepackedBundles(repackedBundles, again.bundles);
          for (const id of again.failedRepackModIds) failedRepackIds.add(id);
          bundleWarnings.push(...again.warnings);
        } catch (err) {
          // A failed second pass must not lose the build. The decision is
          // saved either way and the next build will honour it.
          bundleWarnings.push(
            `${newlyBundled.length} mod(s) you chose to ship could not be ` +
              `packed during this build (${
                err instanceof Error ? err.message : String(err)
              }). Your answer is saved — rebuild to include them.`,
          );
        }
      }

      // Cancelling on the gate must stop here. The next `checkAbort` is on
      // the far side of a full deployment-manifest capture, so without this a
      // cancelled build walks a 1,700-mod profile before it rewinds.
      checkAbort();

      // What is STILL unanswered. Recomputed from the same reports rather
      // than re-running the check: the staging did not change while the
      // curator was reading, only what they said about it.
      postProcessingCandidates = findPostProcessingCandidates(
        selfCheck.reports,
        decidedPostProcessing(collectionConfig),
        selfCheck.mirrorable,
      );
    }

    /**
     * ─── MODS THAT WILL STOP AND ASK THE USER ─────────────────────────
     * A FOMOD archive whose answers Vortex never recorded. Nothing to
     * replay, so the installer runs on the user's machine and the person
     * answering has never seen this collection.
     *
     * Logged rather than gated: it is not an error in the build, it is a
     * fact about what Vortex remembered, and the curator has two good
     * fixes — reinstall the mod so the answers are recorded, or bundle it.
     * A tester lost an evening to one of these, and nothing in the build
     * output had mentioned it.
     */
    /**
     * Carry the "they picked nothing, and we checked" verdict onto the mods
     * so the manifest can ship it. Without this the proof is computed, logged
     * and thrown away, and the user still gets the dialog.
     */
    const verifiedEmpty = new Set(
      selfCheck.reports
        .filter((r) => r.emptySelectionVerified === true)
        .map((r) => r.modId),
    );
    if (verifiedEmpty.size > 0) {
      mods = mods.map((m) =>
        verifiedEmpty.has(m.id) ? { ...m, emptySelectionVerified: true } : m,
      );
      ehLog("info", "build.empty-selection-verified", {
        mods: verifiedEmpty.size,
      });
    }

    const prompting = findModsThatPromptTheUser(selfCheck.reports);
    if (prompting.length > 0) {
      ehLog("warn", "build.mods-that-prompt-the-user", {
        count: prompting.length,
        unanswerable: prompting.filter((m) => m.shipsNothing).length,
        mods: prompting.slice(0, 20).map((m) => ({
          name: m.modName,
          staged: m.stagedCount,
          shipsNothing: m.shipsNothing,
        })),
      });
    }

    selfCheckOp.ok({
      replayed: selfCheck.summary.replayed,
      containment: selfCheck.summary.containment,
      skipped: selfCheck.summary.skipped,
      modsWithMissing: selfCheck.summary.modsWithMissing,
      missingFiles: selfCheck.summary.missingFiles,
      promptsUser: prompting.length,
      shipsNothing: prompting.filter((m) => m.shipsNothing).length,
    });
  } catch (err) {
    // A self-check problem is never a build problem.
    selfCheckOp.fail(err);
  }

  onProgress?.({ phase: "capturing-deployment" });
  const deploymentManifests = await captureDeploymentManifests(
    api,
    state,
    gameId,
  );

  checkAbort();
  onProgress?.({ phase: "capturing-load-order" });
  /**
   * Vortex keys `persistent.loadOrder` by PROFILE, not by game — see the note
   * on `captureLoadOrder`. Resolved here rather than threaded through the
   * pipeline because this is its only use in the build.
   */
  const loadOrderProfileId = getActiveProfileIdFromState(state, gameId);
  const loadOrder =
    loadOrderProfileId === undefined || loadOrderProfileId === ""
      ? []
      : captureLoadOrder(state, loadOrderProfileId);

  checkAbort();
  onProgress?.({ phase: "capturing-userlist" });
  const userlist = captureUserlist(state);

  checkAbort();
  onProgress?.({ phase: "reading-plugins-txt" });
  /**
   * The store decides the folder. A GOG Skyrim SE writes plugins.txt to
   * "Skyrim Special Edition GOG", and reading the Steam name found nothing —
   * so every package built on a non-Steam copy shipped an empty plugin order
   * and nothing said so.
   */
  const pluginsTxtContent = await readPluginsTxtIfPresent(
    gameId,
    discoveredStore(state, gameId),
  );

  // ESL/light flags, read from the DEPLOYED plugin headers.
  //
  // Load-bearing rather than cosmetic: only 254 regular plugins can load, and
  // light ones share the FE index for free — a collection of this size fits
  // only because most of its plugins are light. The flag lives INSIDE the
  // plugin file, so one the curator marked light after installing is a staged
  // file the archive does not contain; the user installs from that archive and
  // silently gets the unflagged copy, which nothing downstream can catch.
  checkAbort();
  const { capturePluginFlags, describePluginFlagCapture } = await import(
    "../../../core/manifest/capturePluginFlags"
  );
  const { REGULAR_PLUGIN_LIMIT } = await import(
    "../../../core/manifest/pluginFlags"
  );
  const { parsePluginsTxt } = await import("../../../core/comparePlugins");
  const { getGameDirectory } = await import(
    "../../../core/manifest/externalDependencies"
  );
  const flagGameDir = getGameDirectory(state, gameId);
  const flagPluginNames =
    pluginsTxtContent !== undefined
      ? parsePluginsTxt(pluginsTxtContent).map((p) => p.name)
      : [];
  const capturedFlags = await capturePluginFlags({
    pluginNames: flagPluginNames,
    dataDir:
      flagGameDir === undefined ? undefined : path.join(flagGameDir, "Data"),
  });
  const flagWarning = describePluginFlagCapture(
    capturedFlags,
    flagPluginNames.length,
    REGULAR_PLUGIN_LIMIT,
  );

  /**
   * ─── REFUSE, RATHER THAN SHIP SOMETHING BROKEN ──────────────────────
   * Both rules are checked here because this is the first point where the
   * answers exist, and BEFORE the manifest is assembled or anything is
   * written — so a refusal costs the curator a retry, not a rebuild.
   *
   * A package with no plugin order is not a degraded collection, it is a
   * broken one: the player installs many gigabytes, the load order is
   * whatever LOOT invents, and the ESL flags that let it load at all were
   * never recorded. That shipped ten times before the store bug was found,
   * and nothing failed on either side. This is the guard that makes the NEXT
   * cause of an empty order impossible to ship quietly, whatever it is.
   */
  const { preflightRefusal } = await import(
    "../../../core/manifest/buildPreflight"
  );
  const { supportsPluginsTxt } = await import("../../../core/comparePlugins");
  const refusal = preflightRefusal({
    gameId,
    usesPluginsTxt: supportsPluginsTxt(gameId),
    plugins:
      pluginsTxtContent === undefined
        ? []
        : parsePluginsTxt(pluginsTxtContent).map((entry) => ({
            name: entry.name,
            enabled: entry.enabled,
            // Absent stays absent: an unreadable header is an unknown, and
            // the limit check must never refuse a build over one.
            ...(capturedFlags.light[entry.name.toLowerCase()] !== undefined
              ? { light: capturedFlags.light[entry.name.toLowerCase()]! }
              : {}),
          })),
  });
  if (refusal !== undefined) {
    ehLog("error", "build.refused", {
      gameId,
      code: refusal.code,
      plugins: flagPluginNames.length,
    });
    throw new BuildRefusedError(refusal.code, refusal.message);
  }

  // ── 3. Build the manifest ──────────────────────────────────────────────
  checkAbort();
  onProgress?.({ phase: "building-manifest" });
  const snapshot = {
    exportedAt: new Date().toISOString(),
    gameId,
    profileId: context.profileId,
    count: mods.length,
    mods,
    deploymentManifests,
    loadOrder,
    userlist,
  };

  // The game's own settings — `Fallout4.ini` and friends. Machine-owned keys
  // (screen size, CPU threads, GPU model, audio device, FOV) are dropped
  // during capture, so the curator's hardware never enters the package.
  const gameIniCapture = await captureGameIni({
    gameId,
    documentsPath: (util as unknown as { getVortexPath?: (id: string) => string })
      .getVortexPath?.("documents") ?? "",
    // My Games is store-specific: a GOG Skyrim SE keeps its INIs under
    // "Skyrim Special Edition GOG", and the leftover Steam folder usually
    // still exists — so reading the wrong one ships stale settings rather
    // than none, which is harder to notice.
    ...(discoveredStore(state, gameId) !== undefined
      ? { store: discoveredStore(state, gameId)! }
      : {}),
  }).catch(() => ({ files: [], machineKept: [], missing: [] }));
  bundleWarnings.push(...describeMachineKept(gameIniCapture));
  if (gameIniCapture.files.length > 0) {
    op.step("game-ini-captured", {
      files: gameIniCapture.files.map((f) => f.fileName),
      shipped: gameIniCapture.files.reduce((n, f) => n + f.settings.length, 0),
      keptByUser: gameIniCapture.machineKept.length,
      missing: gameIniCapture.missing,
    });
  }

  // What does Vortex already know about where the external mods came from?
  //
  // Each one otherwise needs a link and instructions typed by hand, which on a
  // large collection is the most tedious part of publishing — and it is
  // tedious for information Vortex is usually already holding: the curator's
  // own Vortex-collection download hints, the URL the archive was fetched
  // from, the mod's homepage. Curator-written values always win; this only
  // fills gaps. See core/manifest/externalHints.
  // The same suggestions the form showed. Taken from the context rather than
  // recomputed so the manifest cannot end up carrying a different link from
  // the one the curator was looking at when they pressed Build.
  const externalHints = context.externalHints;
  if (externalHints.size > 0) {
    op.step("external-hints-filled", {
      filled: externalHints.size,
      ofExternal: context.externalMods.length,
      // Which source answered, so a build log says whether this is finding the
      // curator's own answers or falling back to scraped URLs.
      via: countBy([...externalHints.values()].map((h) => h.via)),
    });
  }

  const { manifest, warnings: manifestWarnings } = buildManifest({
    snapshot,
    package: {
      id: collectionConfig.packageId,
      name: curator.name,
      version: curator.version,
      author: curator.author,
      description: curator.description.length > 0 ? curator.description : undefined,
      strictMissingMods: false,
      verificationLevel,
    },
    game: {
      // What the curator asked for. Detected version is only the default the
      // form was seeded with — they may know better (a downgraded install
      // Vortex misreports) and they may have loosened the policy.
      version: curator.gameVersion,
      versionPolicy: curator.gameVersionPolicy,
    },
    vortex: {
      version: resolveVortexVersion(state),
      deploymentMethod: resolveDeploymentMethod(state, gameId),
    },
    pluginsTxtContent,
    pluginLightFlags: capturedFlags.light,
    externalMods: toBuildManifestExternalMods(collectionConfig, externalHints),
    // Mods whose archive we just built from staging. Their identity must not
    // be the repacked archive's hash — it encodes file mtimes, so an
    // unchanged mod would re-key itself and show up as an orphan on the next
    // update. See buildExternalMod's compareKey note.
    repackedModIds: new Set(repackedBundles.map((b) => b.modId)),
    externalDependencies,
    ...(gameIniCapture.files.length > 0 ? { gameIni: { files: gameIniCapture.files } } : {}),
  });

  // ── 4. Resolve bundled archives ────────────────────────────────────────
  checkAbort();
  onProgress?.({ phase: "resolving-bundled-archives" });
  // Anything repacked from staging is already resolved, and its identity is
  // the NEW archive's hash — so the archive-based resolver must not also try
  // to bundle the stale original for the same mod.
  const repackedIds = new Set(repackedBundles.map((b) => b.modId));
  const {
    bundledArchives: archiveBundles,
    errors: bundleErrors,
    warnings: staleConfigWarnings,
    droppedModIds: staleConfigModIds,
  } = resolveBundledArchives(
      state,
      gameId,
      {
        ...collectionConfig,
        externalMods: Object.fromEntries(
          Object.entries(collectionConfig.externalMods).filter(
            // Successful repacks are already carried below. FAILED ones are
            // excluded because falling through here resolved them to their
            // ORIGINAL archive — shipping the version without the curator's
            // changes, under a warning that said nothing would ship at all.
            ([modId]) =>
              !repackedIds.has(modId) && !failedRepackIds.has(modId),
          ),
        ),
      },
      mods,
    );
  if (bundleErrors.length > 0) {
    throw new BundleResolutionError(bundleErrors);
  }
  /**
   * Prune answers whose mod no longer exists, so the next build does not have
   * to re-discover them. Best-effort: a config we cannot rewrite is not worth
   * failing a finished build over, and the warning has already been recorded.
   */
  if (staleConfigModIds.length > 0) {
    bundleWarnings.push(...staleConfigWarnings);
    const pruned = { ...collectionConfig.externalMods };
    for (const id of staleConfigModIds) delete pruned[id];
    try {
      await saveCollectionConfig({
        configDir,
        slug,
        config: { ...collectionConfig, externalMods: pruned },
      });
      ehLog("info", "build.config.pruned", {
        removed: staleConfigModIds.length,
        remaining: Object.keys(pruned).length,
      });
    } catch (err) {
      ehLog("warn", "build.config.prune-failed", {
        removed: staleConfigModIds.length,
        consequence: "the same warning will appear on the next build",
        err,
      });
    }
  }
  const bundledArchives = [
    ...archiveBundles,
    ...repackedBundles.map((b) => ({ sourcePath: b.sourcePath, sha256: b.sha256 })),
  ];

  // ── 5. Package the .ehcoll ─────────────────────────────────────────────
  checkAbort();
  const outputFileName = buildOutputFileName(curator.name, curator.version);
  const outputPath = path.join(outputDir, outputFileName);
  onProgress?.({ phase: "packaging" });
  // The bytes a mirrored mod's archive cannot be trusted to reproduce.
  //
  // Every staged file, not just the ones the self-check called unexplained.
  // That check matches on SIZE alone here — the build passes staged refs with
  // no crc — so "explained" is a coincidence away from being wrong, and a
  // payload chosen on it would leave the user's mirror unable to finish for a
  // file we decided not to carry. Shipping the whole folder's files is bigger
  // and cannot be wrong, and only mods the curator explicitly asked to mirror
  // pay for it. Narrowing this needs real content matching, not a smaller
  // guess — see the note in mirrorStaging.ts.
  const mirrorFiles = collectMirrorPayload(state, gameId, mods, collectionConfig);
  if (mirrorFiles.length > 0) {
    beginOp("build.mirror-payload", {
      files: mirrorFiles.length,
      mods: mods.filter((m) => m.mirrored === true).length,
    }).ok({});
  }

  const result: PackageEhcollResult = await packageEhcoll({
    manifest,
    bundledArchives,
    mirrorFiles,
    readme: overrides.readme.length > 0 ? overrides.readme : undefined,
    changelog: overrides.changelog.length > 0 ? overrides.changelog : undefined,
    outputPath,
    signal,
    // The longest phase in the build used to sit behind one unchanging
    // "Packaging .ehcoll...". On a 9.4 GB collection the final step alone —
    // reading the package back to fingerprint it — runs for minutes while the
    // file on disk stops changing, and it was reported as a freeze. It was
    // working. Saying which step it is on is the whole difference.
    onProgress: (p) =>
      onProgress?.({
        phase: "packaging",
        message: p.message,
        ...(p.done !== undefined ? { done: p.done } : {}),
        ...(p.total !== undefined ? { total: p.total } : {}),
      }),
  });

  // ─── THE REPACK FOLDER IS A CACHE NOW, NOT A SCRATCH DIR ─────────────
  // This used to delete the whole directory here, which is why every build
  // re-packed every bundled mod: DynDOLOD output is commonly several GB and
  // almost never changes between two versions of a collection, and the bytes
  // were thrown away seconds after being produced.
  //
  // `repackBundledExternals` keeps exactly one archive per bundled mod, named
  // by the hash of the staging it came from, and sweeps that mod's older
  // versions itself once the build has what it needs. Deleting the folder
  // wholesale here would undo that sweep's entire point.
  //
  // Deliberately NOT extended to "anything not bundled in this build": the
  // folder is shared by every collection, so a build of one would throw away
  // another's cache. A mod that stops being bundled everywhere therefore
  // leaves its last archive behind — disk, not correctness.

  // ── 6. Stamp the config with last-built metadata ───────────────────────
  // Drives the curator dashboard's "Published" tab — `lastBuiltVersion`
  // shows what was last shipped, `lastBuiltAt` lets the dashboard sort
  // by recency. We persist AFTER the package is on disk so a failed
  // package doesn't poison the recorded version with a build that
  // never made it out.
  //
  // Best-effort: a failure here doesn't fail the build (the package
  // exists, the curator is happy). We log + continue.
  try {
    collectionConfig = {
      ...collectionConfig,
      lastBuiltVersion: curator.version,
      lastBuiltAt: new Date().toISOString(),
      lastBuiltName: curator.name,
      lastBuiltAuthor: curator.author,
      // What this build actually shipped, so the dashboard can tell a real
      // update from a rebuild of the same thing.
      lastBuiltProfileFingerprint: profileFingerprint(mods),
      // Pin the gameId at build time so the dashboard's "Update"
      // affordance can refuse cross-game updates (which would
      // silently rewrite the manifest's gameId and ship a malformed
      // package). Older configs may lack this field; the dashboard
      // treats missing as "unknown game" and shows the entry but
      // cannot enforce the gate.
      gameId,
    };
    await saveCollectionConfig({ configDir, slug, config: collectionConfig });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[Event Horizon] failed to stamp last-built metadata on ${configPath}:`,
      err,
    );
  }

  let stagingFileCount = 0;
  for (const m of manifest.mods) {
    stagingFileCount += m.state.stagingFiles?.length ?? 0;
  }

  op.ok({
    outputPath,
    outputBytes: result.outputBytes,
    // In the log too, not only the UI: when a package is questioned later,
    // the curator's own log is the record of what was actually produced.
    outputSha256: result.outputSha256,
    bundled: result.bundledCount,
    mods: manifest.mods.length,
    rules: manifest.rules.length,
    plugins: manifest.plugins.order.length,
    loadOrder: manifest.loadOrder.length,
    userlistPlugins: manifest.userlist.plugins.length,
    userlistGroups: manifest.userlist.groups.length,
    stagingFiles: stagingFileCount,
    warnings: [
      ...context.scopeWarnings,
      ...bundleWarnings,
      ...summariseCaptureWarnings(captureWarnings),
      ...manifestWarnings,
      ...result.warnings,
      ...selfCheckWarnings,
      // The only warning here that can mean the collection will not load on
      // ANY machine, the curator's included.
      ...(flagWarning !== undefined ? [flagWarning] : []),
    ],
  });

  return {
    postProcessingCandidates,
    outputPath,
    outputBytes: result.outputBytes,
    outputSha256: result.outputSha256,
    bundledCount: result.bundledCount,
    modCount: manifest.mods.length,
    warnings: [
      ...context.scopeWarnings,
      ...bundleWarnings,
      ...summariseCaptureWarnings(captureWarnings),
      ...manifestWarnings,
      ...result.warnings,
      ...selfCheckWarnings,
      // The only warning here that can mean the collection will not load on
      // ANY machine, the curator's included.
      ...(flagWarning !== undefined ? [flagWarning] : []),
    ],
    ruleCount: manifest.rules.length,
    loadOrderCount: manifest.loadOrder.length,
    pluginOrderCount: manifest.plugins.order.length,
    userlistPluginCount: manifest.userlist.plugins.length,
    userlistGroupCount: manifest.userlist.groups.length,
    verificationLevel,
    stagingFileCount,
  };
}

// ===========================================================================
// Validation
// ===========================================================================

export function validateCuratorInput(input: CuratorInput): string | undefined {
  if (input.name.trim().length === 0) return "Collection name cannot be empty.";
  if (input.author.trim().length === 0) return "Author cannot be empty.";
  if (!/^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/.test(input.version)) {
    return `Version "${input.version}" doesn't look like semver. Try e.g. "1.0.0" or "0.2.1-beta.1".`;
  }
  return undefined;
}

// ===========================================================================
// Internals
// ===========================================================================

/**
 * Re-exported so the eight call sites here keep their import.
 *
 * The body moved to `core/identity/nexusSourced.ts`: it was duplicated
 * byte-for-byte in `buildPackageAction.ts`, which could not import it without
 * an action reaching into a UI page.
 */
export const isNexusMod = isNexusSourced;

function resolveBundledArchives(
  state: types.IState,
  gameId: string,
  config: CollectionConfig,
  mods: AuditorMod[],
): {
  bundledArchives: BundledArchiveSpec[];
  errors: string[];
  /** Curator-facing notes about answers that were dropped. */
  warnings: string[];
  /** Config keys whose mod no longer exists; safe to prune. */
  droppedModIds: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const droppedModIds: string[] = [];
  const bundledArchives: BundledArchiveSpec[] = [];
  const modById = new Map(mods.map((m) => [m.id, m]));
  const inCollection = new Set(modById.keys());
  /**
   * Every mod id Vortex holds for this game, enabled or not (NS-3).
   *
   * This is what separates "the curator deleted the mod" from "the curator
   * switched it off", and those two get different answers.
   */
  const inGamePool = new Set(
    Object.keys(
      (
        state as unknown as {
          persistent?: { mods?: Record<string, Record<string, unknown>> };
        }
      )?.persistent?.mods?.[gameId] ?? {},
    ),
  );

  for (const [modId, entry] of Object.entries(config.externalMods)) {
    if (entry.bundled !== true) continue;

    const mod = modById.get(modId);
    if (mod === undefined) {
      const kind = classifyMissingConfigEntry(modId, inCollection, inGamePool);
      if (kind === "deleted") {
        /**
         * The mod is gone from Vortex entirely, so this answer refers to
         * nothing and can never be satisfied. Failing here blocked every
         * future build until someone hand-edited a JSON file — for a mod the
         * curator had deliberately deleted. Drop it, say so, and prune the
         * entry so it does not come back.
         */
        warnings.push(describeDroppedEntry(modId, entry.name, "bundle"));
        droppedModIds.push(modId);
        ehLog("warn", "build.config.stale-entry-dropped", {
          modId,
          name: entry.name,
          answer: "bundled",
          why: "the mod is no longer in Vortex's mod pool for this game",
        });
        continue;
      }
      /**
       * `disabled` — still installed, just not in this collection's scope.
       * The answer is live and the absence is almost certainly an oversight:
       * a mod marked to ship that is not shipping. Keep failing.
       */
      errors.push(
        `Config flags modId "${modId}" as bundled, but that mod is installed ` +
          `and NOT enabled in this profile, so it is not in the collection. ` +
          `Enable it, or set bundled=false.`,
      );
      continue;
    }

    // `mayBundle`, not `isNexusMod`. A Nexus mod is normally not bundleable
    // because the user's own API key fetches it — but that stops being true
    // the moment the file is deleted from Nexus, which is exactly when the
    // curator marks it `treatAsExternal`.
    if (!mayBundle(isNexusMod(mod), entry)) {
      errors.push(
        `Config flags Nexus mod "${mod.name}" (id="${modId}") as bundled, ` +
          `but it is not marked as an external dependency. Nexus mods are ` +
          `downloaded with the user's own API key, so bundling one only ` +
          `makes sense once its file is gone from Nexus — use "ship as ` +
          `external" on the availability check first.`,
      );
      continue;
    }

    if (
      typeof mod.archiveSha256 !== "string" ||
      mod.archiveSha256.length === 0
    ) {
      errors.push(
        `External mod "${mod.name}" is flagged for bundling but has no archiveSha256.`,
      );
      continue;
    }

    const sourcePath = resolveModArchivePath(state, mod, gameId);
    if (sourcePath === undefined) {
      errors.push(
        `External mod "${mod.name}" is flagged for bundling but its source archive cannot be located on disk.`,
      );
      continue;
    }

    bundledArchives.push({
      sourcePath,
      sha256: mod.archiveSha256,
    });
  }

  return { bundledArchives, errors, warnings, droppedModIds };
}

async function readPluginsTxtIfPresent(
  gameId: string,
  store?: string,
): Promise<string | undefined> {
  let pluginsPath: string;
  try {
    pluginsPath = getCurrentPluginsTxtPath(gameId, store);
  } catch {
    return undefined;
  }
  try {
    // latin1, matching what Vortex writes. utf8 mangles every non-ASCII
    // plugin name into U+FFFD — see the note above parsePluginsTxt.
    return await fsp.readFile(pluginsPath, "latin1");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw err;
  }
}

function resolveVortexVersion(state: types.IState): string {
  const app = (state as unknown as { app?: { appVersion?: string; version?: string } }).app;
  return app?.appVersion ?? app?.version ?? "unknown";
}

/**
 * Which mods the profile has enabled RIGHT NOW, reconciled against the set the
 * build context was opened with.
 *
 * The context is a snapshot taken once, when the form opens. Everything else in
 * the build re-reads the disk each run — staging folders are re-walked and
 * re-hashed — but membership was frozen, so a mod toggled in Vortex between
 * opening the form and pressing Build was invisible. That is the one kind of
 * staleness a fingerprinted cache cannot catch, because nothing about the files
 * changed; what changed was which files count.
 *
 * Mods already known keep their enriched entry, hashes and all. Only mods that
 * appeared are hashed, and the hash cache usually answers that instantly.
 */
export async function refreshProfileMembership(args: {
  state: types.IState;
  gameId: string;
  profileId: string;
  known: AuditorMod[];
  signal?: AbortSignal;
  /** Substitutable so the refresh can be tested without a Vortex state. */
  readProfileMods?: (
    state: types.IState,
    gameId: string,
    profileId: string,
  ) => AuditorMod[];
}): Promise<{
  mods: AuditorMod[];
  warnings: string[];
  addedNames: string[];
  removedNames: string[];
}> {
  const { state, gameId, profileId, known, signal } = args;
  const quiet = { mods: known, warnings: [], addedNames: [], removedNames: [] };

  let fresh: AuditorMod[];
  try {
    const read = args.readProfileMods ?? getModsForProfile;
    fresh = scopeCollectionMods(read(state, gameId, profileId)).included;
  } catch {
    // Re-reading is an improvement, not a precondition. If Vortex's state
    // cannot be read here, build what the form was opened with rather than
    // failing a build that would otherwise have succeeded.
    return quiet;
  }

  const diff = diffProfileMembership(known, fresh);
  const { appeared } = diff;
  if (!diff.changed) return quiet;
  let merged = diff.merged;

  if (appeared.length > 0) {
    const ehDir = path.join(getVortexUserDataPath(), "event-horizon");
    try {
      const hashCache = await loadArchiveHashCache(ehDir);
      const { lookup, added } = makeHashLookup(hashCache);
      const hashed = await enrichModsWithArchiveHashes(state, gameId, appeared, {
        hashCache: lookup,
        concurrency: 4,
        ...(signal !== undefined ? { signal } : {}),
      });
      const byId = new Map(hashed.map((m) => [m.id, m]));
      merged = merged.map((m) => byId.get(m.id) ?? m);
      merged = applyCachedHashes(merged, hashCache).mods;
      if (added.size > 0) {
        await saveArchiveHashCache(
          ehDir,
          mergeHashes(hashCache, added, new Date().toISOString()),
        );
      }
    } catch {
      // An unhashable newcomer still ships, on its staged-file identity.
      // Losing the build over it would be the worse trade.
    }
  }

  return {
    mods: merged,
    addedNames: diff.addedNames,
    removedNames: diff.removedNames,
    warnings: describeMembershipChange(diff, merged.length),
  };
}

export type MembershipDiff = {
  changed: boolean;
  /** Fresh membership, keeping the enriched (hashed) copy where one existed. */
  merged: AuditorMod[];
  /** In the profile now, absent from the snapshot — these need hashing. */
  appeared: AuditorMod[];
  addedNames: string[];
  removedNames: string[];
};

/**
 * Compare the membership the form was opened with against the profile now.
 *
 * Pure, and the whole point of the refresh: an enriched mod carries an archive
 * hash that cost real time, so a mod still enabled must keep its existing entry
 * rather than being replaced by a bare one from the fresh read.
 */
export function diffProfileMembership(
  known: AuditorMod[],
  fresh: AuditorMod[],
): MembershipDiff {
  const knownById = new Map(known.map((m) => [m.id, m]));
  const freshIds = new Set(fresh.map((m) => m.id));
  const appeared = fresh.filter((m) => !knownById.has(m.id));
  const vanished = known.filter((m) => !freshIds.has(m.id));
  return {
    changed: appeared.length > 0 || vanished.length > 0,
    merged: fresh.map((m) => knownById.get(m.id) ?? m),
    appeared,
    addedNames: appeared.map((m) => m.name),
    removedNames: vanished.map((m) => m.name),
  };
}

/** One warning, or none. Says what moved and which membership was used. */
export function describeMembershipChange(
  diff: MembershipDiff,
  finalCount: number,
): string[] {
  if (!diff.changed) return [];
  const list = (names: string[]): string =>
    names.slice(0, 5).map((n) => `"${n}"`).join(", ") +
    (names.length > 5 ? `, and ${names.length - 5} more` : "");
  const parts: string[] = [];
  if (diff.addedNames.length > 0) {
    parts.push(`${diff.addedNames.length} added (${list(diff.addedNames)})`);
  }
  if (diff.removedNames.length > 0) {
    parts.push(
      `${diff.removedNames.length} no longer enabled (${list(diff.removedNames)})`,
    );
  }
  return [
    `Your profile changed after this form was opened — ${parts.join(", ")}. ` +
      `The build used the profile as it is NOW (${finalCount} mods), not as it ` +
      `was when you opened the form. Reopen the form if you want the mod list ` +
      `on screen to match.`,
  ];
}

export const FALLBACK_COLLECTION_NAME = "My Collection";

/**
 * Which collection a fresh draft should start from.
 *
 * The most recently built one for this game. It was a constant, and the
 * constant was a silent rollback: build "ivy", open a new draft, and the form
 * says "My Collection" — and then loads THAT collection's config, so the
 * bundle ticks, README and prerequisites on screen belong to a different
 * collection than the one just built. The name is the identity here (it picks
 * the slug, which picks the config, which carries the packageId), so a wrong
 * default is not a cosmetic default.
 *
 * Collections built for another game are skipped; one never built has no name
 * worth restoring.
 */
export function pickDefaultCollectionName(
  published: readonly PublishedCollectionSummary[],
  gameId: string,
): string {
  const candidates = published
    .filter((c) => c.gameId === undefined || c.gameId === gameId)
    .filter((c) => c.lastBuiltAt !== undefined)
    .sort((a, b) => (a.lastBuiltAt! < b.lastBuiltAt! ? 1 : -1));
  const best = candidates[0];
  const name = best?.lastBuiltName ?? best?.slug;
  return name !== undefined && name.length > 0 ? name : FALLBACK_COLLECTION_NAME;
}

/**
 * The curator's installed game version, or `"unknown"`.
 *
 * Both state paths below came back empty on a real Fallout 4 install, which
 * shipped a manifest requiring version `"unknown"` *exactly* — a requirement
 * no user can ever satisfy. Vortex knows the answer even when its state does
 * not: each game extension implements `getInstalledVersion`, which reads the
 * executable. That is the authority, so ask it before giving up.
 */
async function resolveGameVersion(
  state: types.IState,
  gameId: string,
): Promise<string> {
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
  const discovery = settings?.gameMode?.discovered?.[gameId];
  const fromDiscovery = discovery?.version;
  if (typeof fromDiscovery === "string" && fromDiscovery.length > 0) {
    return fromDiscovery;
  }
  try {
    const game = (util as unknown as {
      getGame?: (id: string) => {
        getInstalledVersion?: (d: unknown) => PromiseLike<string>;
      } | undefined;
    }).getGame?.(gameId);
    if (game?.getInstalledVersion !== undefined && discovery !== undefined) {
      const fromGame = await game.getInstalledVersion(discovery);
      if (typeof fromGame === "string" && fromGame.length > 0) return fromGame;
    }
  } catch {
    /* a game extension that cannot answer is not a build failure */
  }
  return "unknown";
}

function resolveDeploymentMethod(
  state: types.IState,
  gameId: string,
): VortexDeploymentMethod {
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
      return "hardlink";
  }
}

function buildOutputFileName(name: string, version: string): string {
  const slug = slugify(name);
  const safeVersion = version.replace(/[^a-zA-Z0-9.-]/g, "-");
  return `${slug}-${safeVersion}.ehcoll`;
}

/**
 * Name to slug. Exported because the slug IS the collection's identity — the
 * dashboard has to derive it exactly as the build does, or it will decide a
 * config is unused while the build is about to write to it.
 */
export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "collection"
  );
}
