/**
 * Snapshot → `.ehcoll` manifest converter (Phase 2 slice 2).
 *
 * Pure transform: takes a curator-side `ExportedModsSnapshot` plus
 * environmental inputs (game/vortex versions, plugins.txt contents, etc.)
 * and produces a fully-typed {@link EhcollManifest}. No I/O, no state
 * access — that lives in the toolbar action (slice 4).
 *
 * Spec: docs/business/BUILD_MANIFEST.md
 * Schema: src/types/ehcoll.ts + docs/business/MANIFEST_SCHEMA.md
 *
 * Errors:
 *  - Fatal validation problems (unknown gameId, missing archive hashes,
 *    duplicate compareKeys, ...) are collected and thrown as a single
 *    {@link BuildManifestError}. The packager UI can show all problems
 *    at once instead of forcing the curator to fix them one at a time.
 *  - Non-fatal issues (rules referencing unknown mods, deployment entries
 *    whose source mod isn't in the snapshot, ...) are returned as
 *    {@link BuildManifestResult.warnings} for the UI to surface.
 */

import { shipsAsExternal } from "./shipsAsExternal";

import { toPosix } from "../paths";
import type {
  AuditorMod,
  CapturedModRule,
  CapturedRuleReference,
  FomodSelectionStep,
} from "../getModsListForProfile";
import type { CapturedDeploymentManifest } from "../deploymentManifest";
import type { CapturedLoadOrderEntry } from "../loadOrder";
import type { CapturedUserlist } from "../userlist";
import { parsePluginsTxt } from "../comparePlugins";
import { computeStagingSetHash } from "./stagingSetHash";
import type { ExportedModsSnapshot } from "../../utils/utils";
import {
  archiveReference,
  externalArchiveCompareKey,
  externalStagingCompareKey,
  nexusCompareKey,
  nexusFileReference,
  nexusModReference,
} from "../identity/compareKey";
import type {
  EhcollExternalDependency,
  EhcollGameIni,
  EhcollLoadOrderEntry,
  EhcollManifest,
  EhcollMod,
  EhcollPluginEntry,
  EhcollRule,
  EhcollUserlist,
  EhcollUserlistGroup,
  EhcollUserlistPlugin,
  ExternalEhcollMod,
  ExternalModSource,
  GameVersionPolicy,
  ModRuleType,
  NexusEhcollMod,
  NexusModSource,
  PackageMetadata,
  RequiredExtension,
  SchemaVersion,
  SupportedGameId,
  VerificationLevel,
  VortexDeploymentMethod,
} from "../../types/ehcoll";

const SCHEMA_VERSION: SchemaVersion = 1;

const SUPPORTED_GAME_IDS: ReadonlySet<SupportedGameId> = new Set([
  "skyrimse",
  "fallout3",
  "falloutnv",
  "fallout4",
  "starfield",
]);

/**
 * Vortex `gameId` → Nexus URL `gameDomain` mapping for supported games.
 * Vortex stores game domains separately from gameIds (different naming
 * conventions historically — "skyrimse" vs. "skyrimspecialedition"), and
 * `AuditorMod` doesn't capture the per-mod domain in the v1 snapshot.
 *
 * Hardcoded here because:
 *   1. The mapping is stable for our supported game set.
 *   2. The installer needs a real domain to download via the Nexus API.
 *   3. Curators on a single supported game don't need to know the value.
 *
 * Future work: capture `nexusGameId` per-mod (from `mod.attributes.downloadGame`)
 * and prefer that over this fallback table.
 */
const NEXUS_GAME_DOMAIN_BY_GAME_ID: Record<SupportedGameId, string> = {
  skyrimse: "skyrimspecialedition",
  fallout3: "fallout3",
  falloutnv: "newvegas",
  fallout4: "fallout4",
  starfield: "starfield",
};

const KNOWN_RULE_TYPES: ReadonlySet<ModRuleType> = new Set([
  "before",
  "after",
  "requires",
  "recommends",
  "conflicts",
  "provides",
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Optional curator-supplied metadata for an external (non-Nexus) mod.
 * Keyed by `AuditorMod.id` in {@link BuildManifestInput.externalMods}.
 *
 * Anything missing falls back to a documented default — see the prose spec.
 */
export type ExternalModSpec = {
  /**
   * Ship this mod as EXTERNAL even though Vortex knows its Nexus ids.
   *
   * For a mod whose Nexus file has been deleted. Its `nexus:modId:fileId`
   * identity is a promise the user cannot keep — the download simply fails —
   * so the curator downgrades it to identity-by-hash, which the user can
   * satisfy from a bundled copy or a file they fetch themselves.
   *
   * Explicit rather than inferred from availability: the build must not
   * silently change a mod's identity because a network check said something
   * on the day it ran.
   */
  treatAsExternal?: boolean;
  /** Filename hint shown in the user-side picker prompt. */
  expectedFilename?: string;
  /** Free-form text shown when the mod isn't bundled. Required when bundled=false. */
  instructions?: string;
  /**
   * Where to get it. Usually not typed by the curator at all — filled from
   * what Vortex already knows (see externalHints), which is the point.
   */
  url?: string;
  /** What kind of link `url` is. See ExternalModSource.downloadMode. */
  mode?: "direct" | "browse" | "manual";
  /** Include the archive in the `.ehcoll` package at `bundled/<sha256>.<ext>`. */
  bundled?: boolean;
};

export type BuildManifestInput = {
  snapshot: ExportedModsSnapshot;

  package: {
    /** UUIDv4. Generated once per collection by the action handler and persisted. */
    id: string;
    name: string;
    /** Semver. */
    version: string;
    author: string;
    description?: string;
    /** Defaults to current time at call. */
    createdAt?: string;
    /** Default false — skip+warn rather than abort. */
    strictMissingMods?: boolean;
    /**
     * Curator's chosen integrity-verification depth. Drives whether the
     * snapshot's mods carry `stagingFiles` (and whether each entry has
     * a sha256). Defaults to `"fast"` — full file lists with size, no
     * hashes — which catches Vortex's "lost file" bug without making
     * builds painful for large collections.
     *
     * The `"none"` value is reserved for backward-compat / explicit
     * opt-out by the curator; new builds should pick fast or thorough.
     */
    verificationLevel?: VerificationLevel;
  };

  game: {
    /** Curator's installed game version string. */
    version: string;
    /** Default `"exact"`. */
    versionPolicy?: GameVersionPolicy;
    /** Vortex's discovered store for this game, when it knows one. */
    store?: string;
  };

  vortex: {
    version: string;
    deploymentMethod: VortexDeploymentMethod;
    /** Defaults to []. */
    requiredExtensions?: RequiredExtension[];
  };

  /**
   * Verbatim contents of the curator's `plugins.txt` (already read from
   * `%LOCALAPPDATA%\<game>\plugins.txt`). When undefined, the manifest's
   * `plugins.order` is emitted as `[]`.
   */
  pluginsTxtContent?: string;
  /**
   * ESL/light flags per LOWERCASED plugin name, read from the deployed plugin
   * headers by `capturePluginFlags`.
   *
   * Passed in rather than read here so this stays synchronous and pure — the
   * flag is a property of a file on disk, and this function has no business
   * touching the filesystem. Omitted entirely when the game folder is unknown,
   * in which case no plugin records a flag and the installer changes none.
   */
  pluginLightFlags?: Record<string, boolean>;

  /** Per-AuditorMod.id overrides for external (non-Nexus) mods. */
  externalMods?: Record<string, ExternalModSpec>;
  /**
   * Mods whose archive this build REPACKED from the staging folder.
   *
   * Their identity is keyed on content rather than on the repacked archive's
   * hash, because that hash encodes file mtimes — see buildExternalMod. The
   * builder cannot infer this: repacking happens before it runs and only
   * replaces `archiveSha256`, which by then looks like any other archive hash.
   */
  repackedModIds?: ReadonlySet<string>;

  /** Pass-through. Defaults to []. */
  externalDependencies?: EhcollExternalDependency[];

  /**
   * The curator's game INI settings, already reduced to collection-owned keys
   * by `captureGameIni`. Omitted when the build could not read them.
   */
  gameIni?: EhcollGameIni;
};

export type BuildManifestResult = {
  manifest: EhcollManifest;
  /** Non-fatal issues. Empty when the snapshot is fully clean. */
  warnings: string[];
};

/**
 * Fatal validation errors. Every problem the packager could detect is
 * collected before throwing — curators get one report, not whack-a-mole.
 */
/**
 * `Mod "<id>" (<name>)` prints the same string twice whenever Vortex derived
 * the mod id from its install folder, which is the common case — every problem
 * line was twice as long as it needed to be for no information. Show the name
 * only when it differs.
 */
function label(mod: { id: string; name?: string }): string {
  const name = mod.name;
  return name !== undefined && name !== mod.id
    ? `"${mod.id}" (${name})`
    : `"${mod.id}"`;
}

export class BuildManifestError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(
      errors.length === 1
        ? errors[0]
        : `Cannot build manifest (${errors.length} problems):\n  - ${errors.join(
            "\n  - ",
          )}`,
    );
    this.name = "BuildManifestError";
    this.errors = errors;
  }
}

/** buildManifest's own, stricter notion: ids AND an explicit nexus source. */
/**
 * A STRICTER question than `isNexusSourced`, deliberately, and renamed to say
 * so rather than share a name with it.
 *
 * The manifest additionally requires `source === "nexus"`: an entry claiming a
 * Nexus origin is a promise that Nexus can serve it, and a mod carrying ids
 * from some other importer is not that. Unifying this with the bundling gates'
 * predicate was tried and reclassified every such mod — see
 * `shipsAsExternal.ts` and `shipsAsExternal.test.ts`.
 *
 * It also does NOT test `typeof`, so a string id passes here and fails there.
 * Left as-is: this branch is about provenance, and the ids are stringified
 * into the compareKey either way.
 */
function isNexusSourcedForManifest(mod: AuditorMod): boolean {
  return (
    mod.source === "nexus" &&
    mod.nexusModId !== undefined &&
    mod.nexusFileId !== undefined
  );
}

export function buildManifest(input: BuildManifestInput): BuildManifestResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const gameId = validateGameId(input.snapshot.gameId, errors);
  const compareKeyById = new Map<string, string>();
  const usedCompareKeys = new Map<string, string>();

  // Emit mods in the curator's install order.
  //
  // The snapshot arrives in `Object.entries(state.persistent.mods)` order —
  // Redux insertion order, which means nothing and is not guaranteed stable
  // across a Vortex restart. Two builds of an unchanged profile could then
  // differ in this array while being identical collections, which is noise in
  // exactly the artifact whose promise is determinism.
  //
  // `installOrder` is already computed as a deterministic ordinal (installTime,
  // ties broken by id) and was recorded and never used. Ordering by it costs
  // nothing, makes the array mean something, and makes the installer — which
  // walks this array — install in the sequence the curator did.
  //
  // Measured on a real 954-mod collection, that sequence decides almost
  // nothing: of 4,383 contested files, 4,380 have a mod rule between their
  // providers and are resolved by rules the installer already applies. The
  // remaining 3 were `fomod/info.xml`, `readme.txt` and an animation-offsets
  // file. So this is for determinism, not for conflict resolution — worth one
  // sort, and not worth a feature.
  const orderedMods = [...input.snapshot.mods].sort(
    (a, b) => a.installOrder - b.installOrder,
  );

  const mods: EhcollMod[] = [];
  for (const mod of orderedMods) {
    const built = buildModEntry(
      mod,
      gameId,
      input.externalMods?.[mod.id],
      errors,
      input.repackedModIds,
    );
    if (!built) continue;

    compareKeyById.set(mod.id, built.compareKey);

    const existingId = usedCompareKeys.get(built.compareKey);
    if (existingId !== undefined && existingId !== mod.id) {
      errors.push(
        `Duplicate compareKey "${built.compareKey}" for mods "${existingId}" and "${mod.id}". ` +
          `Two mods cannot share an identity in the same package.`,
      );
      continue;
    }
    usedCompareKeys.set(built.compareKey, mod.id);
    mods.push(built);
  }

  if (errors.length > 0) {
    throw new BuildManifestError(errors);
  }

  const rules = buildRules(input.snapshot.mods, compareKeyById, warnings);


  const pluginsOrder = buildPluginsOrder(
    input.pluginsTxtContent,
    input.pluginLightFlags,
  );

  const loadOrder = buildLoadOrder(
    input.snapshot.loadOrder ?? [],
    compareKeyById,
    warnings,
  );

  const userlist = buildUserlist(
    input.snapshot.userlist,
    pluginsOrder,
    warnings,
  );

  // The curator's FOMOD choices are recorded and replayed by nobody. On
  // install, each archive is handed to Vortex's `start-install`, which runs
  // the FOMOD UI and lets the USER pick — so a mod the curator configured one
  // way arrives configured another, and the collection ships selections that
  // reach no one.
  //
  // The manifest does assert the curator's staged file hashes, so the
  // divergence is DETECTED: verification fails for that mod after install.
  // Detecting a difference it cannot prevent is exactly the shape of failure
  // this project exists to remove, so the curator hears about it up front,
  // while they can still write an instruction for it.
  // The curator's FOMOD choices are recorded and replayed by nobody. On
  // install, each archive is handed to Vortex's `start-install`, which runs
  // the FOMOD UI and lets the USER pick — so a mod the curator configured one
  // way arrives configured another, and the collection ships selections that
  // reach no one.
  //
  // The manifest does assert the curator's staged file hashes, so the
  // divergence is DETECTED: verification fails for that mod after install.
  // Detecting a difference it cannot prevent is exactly the shape of failure
  // this project exists to remove, so the curator hears about it up front,
  // while they can still write an instruction for it.
  // Replay EXISTS now. This warning used to say "the installer cannot replay
  // them yet — whoever installs this collection gets the FOMOD dialog and
  // picks for themselves", and it went on saying it after `choicesFor` started
  // reading this exact field and `runInstall` started passing the result to
  // both install paths. Measured on the real 963-mod build: 112 of 115 replay
  // automatically, and the warning claimed none did.
  //
  // A stale warning is not harmless. This one sent the curator to write
  // instructions for 115 mods that need none, and set the wrong expectation
  // for what their tester would see.
  //
  // What is still worth saying is the residue: `choicesFor` returns undefined
  // when no group in any step has a selected option, because sending that
  // would claim a choice the curator never made. Those mods do fall back to
  // asking the user, and they are the only ones a curator can act on.
  const withChoices = mods.filter(
    (m) => (m.install?.fomodSelections ?? []).length > 0,
  );
  const unreplayable = withChoices.filter(
    (m) =>
      !(m.install?.fomodSelections ?? []).some((step) =>
        step.groups.some((group) => group.choices.length > 0),
      ),
  );
  if (unreplayable.length > 0) {
    const replayed = withChoices.length - unreplayable.length;
    warnings.push(
      `${unreplayable.length} mod(s) recorded FOMOD steps with no option ` +
        `selected (e.g. "${unreplayable[0]!.name}"), so there is nothing to ` +
        `replay for them — whoever installs this collection is asked to choose ` +
        `for those. If they only work with specific options, say so in their ` +
        `instructions. The other ${replayed} mod(s) with recorded options are ` +
        `replayed automatically.`,
    );
  }

  // No warning about per-mod INI tweaks, and that is a CORRECTION.
  //
  // This used to tell the curator that the installer did not apply INI
  // tweaks, that the .ini files shipped without their settings switched on,
  // and that whoever installed the collection would have to go and enable
  // each one manually. That stopped being true when `applyIniTweaks.ts` was
  // written: it reads
  // `state.enabledINITweaks` and dispatches `setINITweakEnabled(..., true)`
  // for each one, from `runInstallImpl`. The sentence survived the feature
  // that refuted it.
  //
  // The cost was not cosmetic. A curator read it and passed the instruction
  // on, so testers were told to go and tick by hand what the driver had
  // already ticked — and anyone who complied could not tell their manual
  // ticks from the collection's.
  //
  // `manifest.iniTweaks` (the TOP-LEVEL array) is still an unused v1
  // placeholder, and that is a different field from the per-mod ticks. It is
  // not warned about here because nothing is captured into it either: an empty
  // array cannot lose a setting.

  const manifest: EhcollManifest = {
    schemaVersion: SCHEMA_VERSION,
    package: buildPackageMetadata(input.package),
    game: {
      id: gameId,
      version: input.game.version,
      versionPolicy: input.game.versionPolicy ?? "exact",
      // Absent stays absent rather than becoming "": the install treats an
      // unknown store as "say nothing", and an empty string is not unknown.
      ...(input.game.store !== undefined && input.game.store.length > 0
        ? { store: input.game.store }
        : {}),
    },
    vortex: {
      version: input.vortex.version,
      deploymentMethod: input.vortex.deploymentMethod,
      requiredExtensions: input.vortex.requiredExtensions ?? [],
    },
    mods,
    rules,
    plugins: { order: pluginsOrder },
    loadOrder,
    userlist,
    iniTweaks: [],
    externalDependencies: input.externalDependencies ?? [],
    // Only written when there is something to write: an empty capture and an
    // absent one mean the same thing to a consumer, and the smaller manifest
    // is the honest one.
    ...(input.gameIni !== undefined && input.gameIni.files.length > 0
      ? { gameIni: input.gameIni }
      : {}),
  };

  return { manifest, warnings };
}

// ---------------------------------------------------------------------------
// Validators / mappers
// ---------------------------------------------------------------------------

function validateGameId(raw: string, errors: string[]): SupportedGameId {
  if (!SUPPORTED_GAME_IDS.has(raw as SupportedGameId)) {
    errors.push(
      `Unsupported gameId "${raw}". Event Horizon supports: ${Array.from(
        SUPPORTED_GAME_IDS,
      ).join(", ")}.`,
    );
    return raw as SupportedGameId;
  }
  return raw as SupportedGameId;
}

function buildPackageMetadata(
  pkg: BuildManifestInput["package"],
): PackageMetadata {
  return {
    id: pkg.id,
    name: pkg.name,
    version: pkg.version,
    author: pkg.author,
    createdAt: pkg.createdAt ?? new Date().toISOString(),
    description: pkg.description,
    strictMissingMods: pkg.strictMissingMods ?? false,
    // A default is what you get when nobody thought about it, so it must be
    // the strong option. "fast" records names and sizes and reads nothing —
    // wrong bytes at the right size verify as correct — and it withholds the
    // stagingSetHash that archive-less external mods need to be identifiable
    // at all. Nothing new is built with it any more.
    //
    // Reading it stays supported forever: packages already in the wild
    // recorded "fast" or "none", and that is a fact about them, not a setting
    // to migrate. See parseManifest, which still accepts all three.
    verificationLevel: pkg.verificationLevel ?? "thorough",
  };
}

/**
 * Decide nexus vs external from {@link AuditorMod} fields, build the
 * matching mod entry. Returns `undefined` when the mod is unbuildable
 * (in which case it pushed errors to the accumulator).
 *
 * Identity rules:
 *  - **Nexus mods** require `archiveSha256` (Nexus identity is
 *    `(modId, fileId, sha256)` per §5.5; absence is fatal).
 *  - **External mods** require either `archiveSha256` OR a
 *    thorough-level `stagingFiles` snapshot (which yields
 *    `stagingSetHash`). Absence of *both* is fatal — there is no
 *    way to identify the mod cross-machine.
 */
function buildModEntry(
  mod: AuditorMod,
  gameId: SupportedGameId,
  spec: ExternalModSpec | undefined,
  errors: string[],
  repackedModIds?: ReadonlySet<string>,
): EhcollMod | undefined {
  if (!shipsAsExternal(isNexusSourcedForManifest(mod), spec)) {
    if (!mod.archiveSha256) {
      errors.push(
        `Mod ${label(mod)} has no archiveSha256. ` +
          `A Nexus mod is identified by (modId, fileId, sha256), and the sha256 ` +
          `can only be computed from the source archive — which Vortex no longer ` +
          `has. Re-download it, or rescan Downloads if the file is still on disk.`,
      );
      return undefined;
    }
    return buildNexusMod(mod, gameId);
  }

  return buildExternalMod(mod, spec, errors, repackedModIds);
}



function buildNexusMod(
  mod: AuditorMod,
  gameId: SupportedGameId,
): NexusEhcollMod {
  const compareKey = nexusCompareKey(mod.nexusModId!, mod.nexusFileId!);

  const source: NexusModSource = {
    kind: "nexus",
    gameDomain: NEXUS_GAME_DOMAIN_BY_GAME_ID[gameId],
    modId: Number(mod.nexusModId),
    fileId: Number(mod.nexusFileId),
    archiveName: deriveArchiveName(mod),
    sha256: mod.archiveSha256!,
  };

  return {
    compareKey,
    name: mod.name,
    version: mod.version,
    source,
    install: buildModInstallSpec(mod),
    state: buildModInstallState(mod),
    attributes: buildUiAttributes(mod),
  };
}

function buildExternalMod(
  mod: AuditorMod,
  spec: ExternalModSpec | undefined,
  errors: string[],
  /** Mods whose archive is one we repacked from staging — see compareKey. */
  repackedModIds?: ReadonlySet<string>,
): ExternalEhcollMod | undefined {
  const archiveSha = mod.archiveSha256;
  const stagingSetHash = mod.stagingFiles
    ? computeStagingSetHash(mod.stagingFiles)
    : undefined;
  const wantsBundled = spec?.bundled ?? false;

  // Hard-block: external mods need at least one identity oracle.
  // (Q2.2: "yes it's a hard block" for curator mods with no archive
  // AND no staging snapshot.) The build refuses rather than shipping
  // a manifest that no user-side resolver could reason about.
  if (archiveSha === undefined && stagingSetHash === undefined) {
    errors.push(
      `Mod ${label(mod)} is an external mod but has neither ` +
        `an archive sha256 nor a thorough-level staging-file snapshot. ` +
        `Vortex's download cache does not retain this mod's archive, and ` +
        `no per-file hashes were captured at build time. The collection ` +
        `cannot identify this mod across machines. Either: ` +
        `(a) re-import the archive into Vortex so the cache picks it up, or ` +
        `(b) rebuild with verificationLevel = "thorough" so a stagingSetHash ` +
        `can be computed from the deployed file set.`,
    );
    return undefined;
  }

  // Bundling without an archive sha is a config error: the bundled-
  // archive path inside `.ehcoll` is keyed by archive sha256.
  if (wantsBundled && archiveSha === undefined) {
    errors.push(
      `Mod ${label(mod)} is marked bundled=true but has no ` +
        `archive sha256. Bundled archives are keyed by archive sha; ` +
        `re-import the archive or set bundled=false.`,
    );
    return undefined;
  }

  // CompareKey scheme:
  //  - Repacked from staging: "external:staging:<stagingSetHash>". See below.
  //  - With archive:          "external:<archiveSha>" (unchanged, back-compat).
  //  - Without archive:       "external:staging:<stagingSetHash>" (v1.1).
  //
  // ── Why a repacked mod does NOT use its archive hash ──
  // A bundled mod's `archiveSha` is the hash of an archive WE just built from
  // the curator's staging folder, and a ZIP stores each file's modification
  // time. So the hash encodes mtimes — metadata that says nothing about the
  // mod's contents. Verified: repacking the same folder after `touch`-ing one
  // file, with contents byte-identical, produces a different hash.
  //
  // Identity is what the user-side reconciler compares across releases. Key a
  // mod on that hash and any mtime change — reinstalling the same mod version,
  // a redeploy, a backup tool, copying the staging folder — re-keys it. On the
  // next update the old key is absent from the manifest, so the mod is
  // reported as an ORPHAN and the user is asked to uninstall something that is
  // still in the collection, while the new key installs a second copy of it.
  //
  // `stagingSetHash` is path + size + content sha over the same files, so it
  // is immune to all of that by construction, and it is already computed. The
  // archive hash stays on `source.sha256`, where it belongs: it LOCATES the
  // bundled archive inside the package. Locator and identity are different
  // jobs and this is the mod where they diverge.
  const wasRepacked = repackedModIds?.has(mod.id) === true;
  const compareKey =
    wasRepacked && stagingSetHash !== undefined
      ? externalStagingCompareKey(stagingSetHash)
      : archiveSha !== undefined
        ? externalArchiveCompareKey(archiveSha)
        : externalStagingCompareKey(stagingSetHash!);

  const source: ExternalModSource = {
    kind: "external",
    expectedFilename: spec?.expectedFilename ?? deriveArchiveName(mod),
    ...(archiveSha !== undefined ? { sha256: archiveSha } : {}),
    ...(stagingSetHash !== undefined ? { stagingSetHash } : {}),
    instructions: spec?.instructions,
    ...(spec?.url !== undefined ? { url: spec.url } : {}),
    ...(spec?.mode !== undefined ? { downloadMode: spec.mode } : {}),
    bundled: wantsBundled,
  };

  return {
    compareKey,
    name: mod.name,
    version: mod.version,
    source,
    install: buildModInstallSpec(mod),
    state: buildModInstallState(mod),
    attributes: buildUiAttributes(mod),
  };
}

/**
 * v1 has no captured archive filename in the snapshot — Vortex stores it
 * on `state.persistent.downloads.files[archiveId].localPath`, which the
 * pure converter can't read. We fall back to `mod.name`; the action
 * handler in slice 4 can override this per-mod with the real filename.
 */
function deriveArchiveName(mod: AuditorMod): string {
  return mod.name;
}

function buildModInstallSpec(
  mod: AuditorMod,
): EhcollMod["install"] {
  const fomodSelections: FomodSelectionStep[] = mod.fomodSelections ?? [];
  return {
    fomodSelections,
    installerType: mod.installerType,
    ...(mod.installerChoicesType !== undefined
      ? { installerChoicesType: mod.installerChoicesType }
      : {}),
    // Only meaningful alongside an EMPTY selection list, which is where the
    // ambiguity lives. Writing it for a mod that recorded real choices would
    // be noise at best and a contradiction at worst.
    ...(fomodSelections.length === 0 && mod.emptySelectionVerified === true
      ? { emptySelectionVerified: true }
      : {}),
  };
}

function buildModInstallState(
  mod: AuditorMod,
): EhcollMod["state"] {
  return {
    enabled: mod.enabled,
    installOrder: mod.installOrder,
    // Same number as installOrder, and named for an intention that was never
    // built — see ExternalModSource's sibling field. Not a capture bug: there
    // is no Vortex-computed priority to capture, and nothing reads it.
    deploymentPriority: mod.installOrder,
    modType: mod.modType,
    enabledINITweaks:
      mod.enabledINITweaks && mod.enabledINITweaks.length > 0
        ? mod.enabledINITweaks
        : undefined,
    stagingFiles:
      mod.stagingFiles && mod.stagingFiles.length > 0
        ? mod.stagingFiles
        : undefined,
    // Only when true. A `false` in every entry of a 950-mod manifest is 950
    // lines saying nothing.
    ...(mod.postProcessed === true ? { postProcessed: true } : {}),
    ...(mod.mirrored === true ? { mirrored: true } : {}),
  };
}

function buildUiAttributes(
  _mod: AuditorMod,
): EhcollMod["attributes"] {
  // No-op for now — AuditorMod doesn't currently carry category/description.
  // Schema field is optional; emit undefined and let future capture passes fill it in.
  return undefined;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function buildRules(
  mods: AuditorMod[],
  compareKeyById: Map<string, string>,
  warnings: string[],
): EhcollRule[] {
  const out: EhcollRule[] = [];
  // Collected rather than reported one by one. A profile that has been curated
  // for a while accumulates rules pointing at mods it no longer has — versions
  // upgraded past, mods removed — and on a real 955-mod profile that produced
  // 108 near-identical warnings, drowning the handful that meant something. The
  // count is what matters; the individual lines are noise about mods the
  // curator already got rid of.
  const unresolved: string[] = [];

  for (const mod of mods) {
    const sourceCompareKey = compareKeyById.get(mod.id);
    if (!sourceCompareKey) continue;

    for (const rule of mod.rules ?? []) {
      const built = buildRule(
        mod,
        sourceCompareKey,
        rule,
        compareKeyById,
        warnings,
        unresolved,
      );
      if (built) out.push(built);
    }
  }

  if (unresolved.length > 0) {
    const targets = [...new Set(unresolved)].sort();
    warnings.push(
      `${unresolved.length} mod rule(s) reference ${targets.length} mod(s) that are ` +
        `not in this collection, so those rules were dropped: ` +
        `${targets.slice(0, 6).map((t) => `"${t}"`).join(", ")}` +
        `${targets.length > 6 ? `, and ${targets.length - 6} more` : ""}. ` +
        `This is normal on a profile that has been curated for a while — a rule ` +
        `outlives the mod version it was written against. A rule about a mod that ` +
        `is not here cannot mean anything, so dropping it is correct.`,
    );
  }

  out.sort(canonicalRuleSortKey);
  return out;
}

function buildRule(
  ownerMod: AuditorMod,
  sourceCompareKey: string,
  rule: CapturedModRule,
  compareKeyById: Map<string, string>,
  warnings: string[],
  /** Collects unresolvable rule targets so they can be reported once. */
  unresolved: string[],
): EhcollRule | undefined {
  if (!KNOWN_RULE_TYPES.has(rule.type as ModRuleType)) {
    warnings.push(
      `Mod "${ownerMod.id}" has a rule with unknown type "${rule.type}". Skipping.`,
    );
    return undefined;
  }

  const reference = synthesizeRuleReference(
    ownerMod,
    rule.reference,
    compareKeyById,
    unresolved,
  );
  if (!reference) return undefined;

  return {
    source: sourceCompareKey,
    type: rule.type as ModRuleType,
    reference,
    comment: rule.comment,
    ignored: rule.ignored === true ? true : undefined,
  };
}

/**
 * Translate a {@link CapturedRuleReference} (Vortex's multi-pin object)
 * into a single manifest-style compareKey string.
 *
 * Priority — strongest first. We deliberately prefer fully-pinned forms
 * because the installer can downgrade them at resolve time but cannot
 * upgrade a partial pin without losing portability.
 */
function synthesizeRuleReference(
  _ownerMod: AuditorMod,
  ref: CapturedRuleReference,
  compareKeyById: Map<string, string>,
  unresolved: string[],
): string | undefined {
  if (ref.nexusModId && ref.nexusFileId) {
    return nexusFileReference(ref.nexusModId, ref.nexusFileId);
  }
  if (ref.nexusModId) {
    return nexusModReference(ref.nexusModId);
  }

  if (ref.id) {
    const mapped = compareKeyById.get(ref.id);
    if (mapped) return mapped;
  }

  if (ref.archiveId) {
    return archiveReference(ref.archiveId);
  }

  // Name the TARGET, not the owner: "which mod is missing" is the actionable
  // half, and the same absent mod is typically referenced by many owners.
  unresolved.push(ref.id ?? ref.archiveId ?? JSON.stringify(ref));
  return undefined;
}

function canonicalRuleSortKey(a: EhcollRule, b: EhcollRule): number {
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  if (a.reference !== b.reference) return a.reference < b.reference ? -1 : 1;
  return 0;
}

// ---------------------------------------------------------------------------
// File overrides (top-level — derived from deployment manifests)
// ---------------------------------------------------------------------------


function toPosixPath(p: string): string {
  return toPosix(p);
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

/**
 * @param lightByName ESL/light flags keyed by LOWERCASED plugin name, read
 * from the deployed plugin headers before the build ran. A name absent from
 * the map records no flag at all — absent means "unknown", and the installer
 * leaves an unknown plugin's flag alone rather than clearing it on a guess.
 */
function buildPluginsOrder(
  content: string | undefined,
  lightByName: Record<string, boolean> | undefined,
): EhcollPluginEntry[] {
  if (content === undefined) return [];

  const parsed = parsePluginsTxt(content);
  return parsed.map((entry) => {
    const light = lightByName?.[entry.name.toLowerCase()];
    return {
      name: entry.name,
      enabled: entry.enabled,
      ...(light !== undefined ? { light } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// LoadOrder (top-level — Vortex per-game load order, slice 6c)
// ---------------------------------------------------------------------------

/**
 * Translate the curator's `CapturedLoadOrderEntry[]` (keyed by Vortex
 * internal modId) into the manifest's `EhcollLoadOrderEntry[]` (keyed
 * by `compareKey`). Entries whose modId can't be mapped to a manifest
 * mod are dropped with a warning — they're typically:
 *   - external/synthesized entries Vortex generated from on-disk files
 *     outside its mod table (`external: true`),
 *   - mods we excluded from the package (e.g. unbuildable due to a
 *     missing archive sha256),
 *   - stale load-order entries left behind by a since-removed mod.
 *
 * Re-numbers `pos` 0..N-1 in original sort order so the manifest is
 * dense and portable. The user-side installer doesn't depend on the
 * exact integer values, only the relative order.
 */
function buildLoadOrder(
  entries: CapturedLoadOrderEntry[],
  compareKeyById: Map<string, string>,
  warnings: string[],
): EhcollLoadOrderEntry[] {
  if (entries.length === 0) return [];

  const sorted = [...entries].sort((a, b) => {
    if (a.pos !== b.pos) return a.pos - b.pos;
    return a.modId < b.modId ? -1 : a.modId > b.modId ? 1 : 0;
  });

  const out: EhcollLoadOrderEntry[] = [];
  let densePos = 0;
  for (const entry of sorted) {
    const compareKey = compareKeyById.get(entry.modId);
    if (compareKey === undefined) {
      if (entry.external !== true) {
        // External/synthesized entries are expected; only warn for
        // real mod-table entries we couldn't map (stale lo, snapshot
        // skew, etc.).
        warnings.push(
          `Load-order entry for modId "${entry.modId}" (pos=${entry.pos}) ` +
            `has no matching mod in the snapshot. Skipping.`,
        );
      }
      continue;
    }
    out.push({
      compareKey,
      pos: densePos++,
      enabled: entry.enabled,
      ...(entry.locked === true ? { locked: true } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Userlist (LOOT plugin rules + groups, slice 6d)
// ---------------------------------------------------------------------------

/**
 * Translate the curator's `CapturedUserlist` into the manifest's
 * `EhcollUserlist`, scoping plugin entries to those shipping with this
 * collection.
 *
 * Scoping policy:
 *   - **plugins**: kept only when the plugin name matches one of the
 *     manifest's `plugins.order` entries (case-insensitive). This drops
 *     curator's personal rules on plugins they didn't ship — those
 *     would never apply on a user machine that doesn't have them, and
 *     they'd waste audit-trail space in the receipt.
 *   - **groups**: ALL captured groups are kept. Group rules form a
 *     global namespace; trimming risks breaking transitive ordering
 *     (plugin A → group X, group X → group Y, group Y → plugin B).
 *     Groups are tiny (typically <30 entries) so the overhead is
 *     negligible.
 *
 * References (after / req / inc lists, group `after` lists) are kept
 * verbatim — they may point at vanilla masters (Skyrim.esm), at
 * plugins NOT in our collection but commonly present, or at user-
 * supplied plugins. The apply-side decides what to do with each.
 */
function buildUserlist(
  captured: CapturedUserlist | undefined,
  pluginsOrder: EhcollPluginEntry[],
  warnings: string[],
): EhcollUserlist {
  if (captured === undefined) return { plugins: [], groups: [] };

  // Build the lowercase lookup once. Plugins are matched case-
  // insensitively everywhere (LOOT, Vortex's reducer, plugins.txt).
  const pluginNamesLower = new Set(
    pluginsOrder.map((p) => p.name.toLowerCase()),
  );

  /**
   * ─── DROPPING EVERYTHING IS NOT THE SAME AS DROPPING SOME ────────────
   * The per-entry skip below is deliberately silent, and right: a curator
   * keeps LOOT rules on far more plugins than they ship, and warning about
   * each would be noise.
   *
   * But "no plugin order at all" is a different event. It means the build
   * could not read plugins.txt — which is what a store-relocated folder did
   * for real: a GOG Skyrim SE shipped `plugins.order: []`, and this loop then
   * discarded every LOOT rule the curator had, without a word, because each
   * individual drop looked like the ordinary case. One bug, three losses, all
   * invisible.
   */
  if (pluginNamesLower.size === 0 && captured.plugins.length > 0) {
    warnings.push(
      `None of the ${captured.plugins.length} LOOT plugin rule(s) could be ` +
        `shipped, because this build captured no plugin order to match them ` +
        `against. That usually means plugins.txt could not be read — check ` +
        `the log for plugins-txt.not-found.`,
    );
  }

  const plugins: EhcollUserlistPlugin[] = [];
  for (const entry of captured.plugins) {
    if (!pluginNamesLower.has(entry.name.toLowerCase())) {
      // Don't warn — this is curator's personal userlist on plugins
      // they don't ship. Common case (most modders maintain rules on
      // many more plugins than they collection-bundle).
      continue;
    }

    const built: EhcollUserlistPlugin = { name: entry.name };
    if (entry.group !== undefined) built.group = entry.group;
    if (entry.after !== undefined && entry.after.length > 0) {
      built.after = [...entry.after];
    }
    if (entry.req !== undefined && entry.req.length > 0) {
      built.req = [...entry.req];
    }
    if (entry.inc !== undefined && entry.inc.length > 0) {
      built.inc = [...entry.inc];
    }
    plugins.push(built);
  }

  // Stable sort for deterministic manifest output.
  plugins.sort((a, b) =>
    a.name.toLowerCase() < b.name.toLowerCase()
      ? -1
      : a.name.toLowerCase() > b.name.toLowerCase()
        ? 1
        : 0,
  );

  const groups: EhcollUserlistGroup[] = [];
  const seenGroupNames = new Set<string>();
  for (const group of captured.groups) {
    const lower = group.name.toLowerCase();
    if (seenGroupNames.has(lower)) {
      warnings.push(
        `Duplicate userlist group "${group.name}" in curator state. ` +
          `Keeping the first occurrence.`,
      );
      continue;
    }
    seenGroupNames.add(lower);

    const built: EhcollUserlistGroup = { name: group.name };
    if (group.after !== undefined && group.after.length > 0) {
      built.after = [...group.after];
    }
    groups.push(built);
  }

  groups.sort((a, b) =>
    a.name.toLowerCase() < b.name.toLowerCase()
      ? -1
      : a.name.toLowerCase() > b.name.toLowerCase()
        ? 1
        : 0,
  );

  return { plugins, groups };
}
