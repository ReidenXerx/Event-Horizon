/**
 * `manifest.json` validator (Phase 3 slice 1).
 *
 * Pure mirror of {@link ../manifest/buildManifest.buildManifest}. Takes
 * the raw string contents of a `.ehcoll` package's `manifest.json` and
 * returns a fully-typed {@link EhcollManifest} or throws a single
 * `ParseManifestError` listing every problem detected.
 *
 * Spec: docs/business/PARSE_MANIFEST.md
 *
 * ─── DESIGN ────────────────────────────────────────────────────────────
 * No I/O, no state access, no side effects. The caller (slice 2's
 * `readEhcoll`) is responsible for reading the ZIP and pulling out the
 * `manifest.json` contents; this module only validates the resulting
 * string.
 *
 * Every detectable problem is collected into one list and reported
 * together — same "no whack-a-mole" pattern we use in `buildManifest`
 * and `packageEhcoll`. A curator/user fixing a bad manifest gets the
 * full picture, not a half-fix-then-rerun loop.
 *
 * Two severity tiers:
 *  - **Errors** abort the parse. Missing required fields, wrong types,
 *    bad enum values, duplicate compareKeys, malformed SHA-256s,
 *    unsupported gameId, schemaVersion ≠ 1. The resolver/installer
 *    cannot start without these.
 *  - **Warnings** survive the parse. Rule references that don't resolve
 *    to any mod in the manifest, file-override mods missing from the
 *    mods list, etc. The resolver may downgrade or skip these at
 *    install time but the manifest as a whole is structurally valid.
 *
 * Cross-reference validation (compareKey lookups, bundled-flag sanity)
 * runs AFTER all mods are validated so we have the full set of
 * compareKeys to check against.
 * ──────────────────────────────────────────────────────────────────────
 */

import type {
  EhcollExternalDependency,
  EhcollIniTweak,
  EhcollLoadOrderEntry,
  EhcollManifest,
  EhcollMod,
  EhcollPluginEntry,
  EhcollRule,
  EhcollStagingFile,
  EhcollUserlist,
  EhcollUserlistGroup,
  EhcollUserlistPlugin,
  ExternalDependencyDestination,
  ExternalDependencyFile,
  ExternalModSource,
  GameMetadata,
  GameVersionPolicy,
  ModInstallSpec,
  ModInstallState,
  ModRuleType,
  ModUiAttributes,
  NexusModSource,
  PackageMetadata,
  RequiredExtension,
  SchemaVersion,
  SupportedGameId,
  VerificationLevel,
  VortexDeploymentMethod,
  VortexMetadata,
  EhcollGameIni,
} from "../../types/ehcoll";
import type {
  FomodSelectedChoice,
  FomodSelectionGroup,
  FomodSelectionStep,
} from "../getModsListForProfile";
import { isFullyPinnedReference as isFullyPinnedModReference } from "../identity/compareKey";

import { isSafeRelativePath, unsafePathReason } from "../safeRelativePath";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const SCHEMA_VERSION: SchemaVersion = 1;

const SUPPORTED_GAME_IDS = new Set<SupportedGameId>([
  "skyrimse",
  "fallout3",
  "falloutnv",
  "fallout4",
  "starfield",
]);

const GAME_VERSION_POLICIES = new Set<GameVersionPolicy>(["exact", "minimum"]);

const VORTEX_DEPLOYMENT_METHODS = new Set<VortexDeploymentMethod>([
  "hardlink",
  "symlink",
  "copy",
]);

const RULE_TYPES = new Set<ModRuleType>([
  "before",
  "after",
  "requires",
  "recommends",
  "conflicts",
  "provides",
]);

const EXTERNAL_DEP_DESTINATIONS = new Set<ExternalDependencyDestination>([
  "<gameDir>",
  "<dataDir>",
  "<scripts>",
]);

export type ParseManifestResult = {
  manifest: EhcollManifest;
  /**
   * Non-fatal issues. Empty when the manifest is fully clean. The
   * caller may surface these in a UI for the user/curator to inspect.
   */
  warnings: string[];
};

export class ParseManifestError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(
      errors.length === 1
        ? errors[0]
        : `Manifest is invalid (${errors.length} problems):\n  - ${errors.join(
            "\n  - ",
          )}`,
    );
    this.name = "ParseManifestError";
    this.errors = errors;
  }
}

/**
 * Parse + validate a `.ehcoll` `manifest.json` payload.
 *
 * `raw` is the JSON text exactly as it appears inside the ZIP. JSON
 * parsing failures become a single `ParseManifestError`. Structural
 * problems are collected into one error list before throwing.
 */
export function parseManifest(raw: string): ParseManifestResult {
  const parsed = parseJson(raw);

  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isObject(parsed)) {
    throw new ParseManifestError([
      `Top-level value must be a JSON object, got ${describe(parsed)}.`,
    ]);
  }

  // schemaVersion is the gate: if it's wrong, we don't even know what
  // the rest of the document means. Report that and stop.
  if ((parsed as Record<string, unknown>).schemaVersion !== SCHEMA_VERSION) {
    throw new ParseManifestError([
      `Unsupported schemaVersion ${JSON.stringify(
        (parsed as Record<string, unknown>).schemaVersion,
      )}. ` +
        `This installer understands schemaVersion ${SCHEMA_VERSION} only. ` +
        `Update the Event Horizon extension to install newer manifests.`,
    ]);
  }

  const obj = parsed as Record<string, unknown>;

  const pkg = validatePackage(obj.package, errors);
  const game = validateGame(obj.game, errors);
  const vortex = validateVortex(obj.vortex, errors);
  const mods = validateMods(obj.mods, errors);
  const rules = validateRules(obj.rules, errors);
  const plugins = validatePlugins(obj.plugins, errors);
  // loadOrder is back-filled to [] when missing so older v1 manifests
  // (written before slice 6c added the field) parse cleanly. Schema
  // version stays at 1 because the field is additive.
  const loadOrder = validateLoadOrder(obj.loadOrder, errors);
  // userlist (slice 6d) is back-filled to {plugins:[], groups:[]} when
  // missing so older v1 manifests parse cleanly. Schema version stays at 1
  // because the field is additive.
  const userlist = validateUserlist(obj.userlist, errors);
  const iniTweaks = validateIniTweaks(obj.iniTweaks, errors);
  // gameIni is additive like loadOrder and userlist: manifests built before it
  // existed simply have none, and absence is not an error. Schema version
  // stays at 1.
  const gameIni = validateGameIni(obj.gameIni, errors);
  const externalDependencies = validateExternalDependencies(
    obj.externalDependencies,
    errors,
  );

  if (errors.length > 0) {
    throw new ParseManifestError(errors);
  }

  // Cross-reference checks are post-pass: they're warnings, not errors,
  // because a manifest with an unresolvable rule is structurally valid
  // even though the resolver can't honor every directive.
  crossReferenceValidate(
    {
      mods: mods!,
      rules: rules!,
      loadOrder: loadOrder!,
      userlist: userlist!,
      plugins: plugins!.order,
    },
    warnings,
  );

  const manifest: EhcollManifest = {
    schemaVersion: SCHEMA_VERSION,
    package: pkg!,
    game: game!,
    vortex: vortex!,
    mods: mods!,
    rules: rules!,
    plugins: plugins!,
    loadOrder: loadOrder!,
    userlist: userlist!,
    iniTweaks: iniTweaks!,
    ...(gameIni !== undefined ? { gameIni } : {}),
    externalDependencies: externalDependencies!,
  };

  return { manifest, warnings };
}

// ---------------------------------------------------------------------------
// Section validators
// ---------------------------------------------------------------------------

function validatePackage(
  raw: unknown,
  errors: string[],
): PackageMetadata | undefined {
  if (!isObject(raw)) {
    errors.push(`package must be an object, got ${describe(raw)}.`);
    return undefined;
  }
  const obj = raw as Record<string, unknown>;

  const id = expectUuid(obj.id, "package.id", errors);
  const name = expectNonEmptyString(obj.name, "package.name", errors);
  const version = expectSemver(obj.version, "package.version", errors);
  const author = expectNonEmptyString(obj.author, "package.author", errors);
  const createdAt = expectIso8601(obj.createdAt, "package.createdAt", errors);
  const strictMissingMods = expectBoolean(
    obj.strictMissingMods,
    "package.strictMissingMods",
    errors,
  );

  const description =
    obj.description === undefined
      ? undefined
      : expectString(obj.description, "package.description", errors);

  // verificationLevel is back-filled to "none" when missing so manifests
  // built before file-integrity capture parse cleanly. Unknown values
  // become a hard error — silently coercing would mask schema drift.
  let verificationLevel: VerificationLevel | undefined;
  if (obj.verificationLevel !== undefined) {
    const raw2 = obj.verificationLevel;
    if (raw2 === "none" || raw2 === "fast" || raw2 === "thorough") {
      verificationLevel = raw2;
    } else {
      errors.push(
        `package.verificationLevel must be "none" | "fast" | "thorough", ` +
          `got ${describe(raw2)}.`,
      );
    }
  } else {
    verificationLevel = "none";
  }

  if (
    id === undefined ||
    name === undefined ||
    version === undefined ||
    author === undefined ||
    createdAt === undefined ||
    strictMissingMods === undefined
  ) {
    return undefined;
  }

  return {
    id,
    name,
    version,
    author,
    createdAt,
    strictMissingMods,
    ...(description !== undefined ? { description } : {}),
    ...(verificationLevel !== undefined ? { verificationLevel } : {}),
  };
}

function validateGame(
  raw: unknown,
  errors: string[],
): GameMetadata | undefined {
  if (!isObject(raw)) {
    errors.push(`game must be an object, got ${describe(raw)}.`);
    return undefined;
  }
  const obj = raw as Record<string, unknown>;

  const id = expectEnum(obj.id, SUPPORTED_GAME_IDS, "game.id", errors) as
    | SupportedGameId
    | undefined;
  const version = expectNonEmptyString(obj.version, "game.version", errors);
  const versionPolicy = expectEnum(
    obj.versionPolicy,
    GAME_VERSION_POLICIES,
    "game.versionPolicy",
    errors,
  ) as GameVersionPolicy | undefined;

  if (id === undefined || version === undefined || versionPolicy === undefined) {
    return undefined;
  }

  /**
   * Optional, and absence is preserved. A package built before the store was
   * recorded carries no opinion about it, which is not the same as "built on
   * an unnamed store".
   */
  const store =
    obj.store === undefined
      ? undefined
      : expectString(obj.store, "game.store", errors);

  return {
    id,
    version,
    versionPolicy,
    ...(store !== undefined && store.length > 0 ? { store } : {}),
  };
}

function validateVortex(
  raw: unknown,
  errors: string[],
): VortexMetadata | undefined {
  if (!isObject(raw)) {
    errors.push(`vortex must be an object, got ${describe(raw)}.`);
    return undefined;
  }
  const obj = raw as Record<string, unknown>;

  const version = expectNonEmptyString(obj.version, "vortex.version", errors);
  const deploymentMethod = expectEnum(
    obj.deploymentMethod,
    VORTEX_DEPLOYMENT_METHODS,
    "vortex.deploymentMethod",
    errors,
  ) as VortexDeploymentMethod | undefined;

  const requiredExtensions = expectArray(
    obj.requiredExtensions,
    "vortex.requiredExtensions",
    errors,
  );
  const parsedExtensions: RequiredExtension[] = [];
  if (requiredExtensions !== undefined) {
    requiredExtensions.forEach((ext, i) => {
      const parsed = validateRequiredExtension(
        ext,
        `vortex.requiredExtensions[${i}]`,
        errors,
      );
      if (parsed !== undefined) parsedExtensions.push(parsed);
    });
  }

  if (
    version === undefined ||
    deploymentMethod === undefined ||
    requiredExtensions === undefined
  ) {
    return undefined;
  }

  return { version, deploymentMethod, requiredExtensions: parsedExtensions };
}

function validateRequiredExtension(
  raw: unknown,
  path: string,
  errors: string[],
): RequiredExtension | undefined {
  if (!isObject(raw)) {
    errors.push(`${path} must be an object, got ${describe(raw)}.`);
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const id = expectNonEmptyString(obj.id, `${path}.id`, errors);
  const minVersion =
    obj.minVersion === undefined
      ? undefined
      : expectString(obj.minVersion, `${path}.minVersion`, errors);
  if (id === undefined) return undefined;
  return minVersion === undefined ? { id } : { id, minVersion };
}

// ---------------------------------------------------------------------------
// Mods
// ---------------------------------------------------------------------------

function validateMods(
  raw: unknown,
  errors: string[],
): EhcollMod[] | undefined {
  const arr = expectArray(raw, "mods", errors);
  if (arr === undefined) return undefined;

  const mods: EhcollMod[] = [];
  const seenCompareKeys = new Map<string, number>();

  arr.forEach((entry, i) => {
    const mod = validateModEntry(entry, `mods[${i}]`, errors);
    if (mod === undefined) return;

    const previousIndex = seenCompareKeys.get(mod.compareKey);
    if (previousIndex !== undefined) {
      errors.push(
        `Duplicate compareKey "${mod.compareKey}" at mods[${i}] and mods[${previousIndex}]. ` +
          `Two mods cannot share the same identity in one manifest.`,
      );
      return;
    }
    seenCompareKeys.set(mod.compareKey, i);
    mods.push(mod);
  });

  return mods;
}

function validateModEntry(
  raw: unknown,
  path: string,
  errors: string[],
): EhcollMod | undefined {
  if (!isObject(raw)) {
    errors.push(`${path} must be an object, got ${describe(raw)}.`);
    return undefined;
  }
  const obj = raw as Record<string, unknown>;

  const compareKey = expectNonEmptyString(
    obj.compareKey,
    `${path}.compareKey`,
    errors,
  );
  const name = expectNonEmptyString(obj.name, `${path}.name`, errors);
  const version =
    obj.version === undefined
      ? undefined
      : expectString(obj.version, `${path}.version`, errors);

  const source = validateModSource(obj.source, `${path}.source`, errors);
  const install = validateInstallSpec(
    obj.install,
    `${path}.install`,
    errors,
  );
  const state = validateInstallState(obj.state, `${path}.state`, errors);
  const attributes =
    obj.attributes === undefined
      ? undefined
      : validateUiAttributes(obj.attributes, `${path}.attributes`, errors);

  if (
    compareKey === undefined ||
    name === undefined ||
    source === undefined ||
    install === undefined ||
    state === undefined
  ) {
    return undefined;
  }

  // Discriminate after all sub-validators ran so we get every error in
  // one pass.
  if (source.kind === "nexus") {
    return {
      compareKey,
      name,
      ...(version !== undefined ? { version } : {}),
      install,
      state,
      ...(attributes !== undefined ? { attributes } : {}),
      source,
    };
  }
  return {
    compareKey,
    name,
    ...(version !== undefined ? { version } : {}),
    install,
    state,
    ...(attributes !== undefined ? { attributes } : {}),
    source,
  };
}

function validateModSource(
  raw: unknown,
  path: string,
  errors: string[],
): NexusModSource | ExternalModSource | undefined {
  if (!isObject(raw)) {
    errors.push(`${path} must be an object, got ${describe(raw)}.`);
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const kind = obj.kind;

  if (kind === "nexus") return validateNexusSource(obj, path, errors);
  if (kind === "external") return validateExternalSource(obj, path, errors);

  errors.push(
    `${path}.kind must be "nexus" or "external", got ${describe(kind)}.`,
  );
  return undefined;
}

function validateNexusSource(
  obj: Record<string, unknown>,
  path: string,
  errors: string[],
): NexusModSource | undefined {
  const gameDomain = expectNonEmptyString(
    obj.gameDomain,
    `${path}.gameDomain`,
    errors,
  );
  const modId = expectPositiveInt(obj.modId, `${path}.modId`, errors);
  const fileId = expectPositiveInt(obj.fileId, `${path}.fileId`, errors);
  const archiveName = expectNonEmptyString(
    obj.archiveName,
    `${path}.archiveName`,
    errors,
  );
  const sha256 = expectSha256Hex(obj.sha256, `${path}.sha256`, errors);

  if (
    gameDomain === undefined ||
    modId === undefined ||
    fileId === undefined ||
    archiveName === undefined ||
    sha256 === undefined
  ) {
    return undefined;
  }

  return {
    kind: "nexus",
    gameDomain,
    modId,
    fileId,
    archiveName,
    sha256,
  };
}

function validateExternalSource(
  obj: Record<string, unknown>,
  path: string,
  errors: string[],
): ExternalModSource | undefined {
  const expectedFilename = expectNonEmptyString(
    obj.expectedFilename,
    `${path}.expectedFilename`,
    errors,
  );
  // sha256 is optional in v1.1+ when stagingSetHash is set. Validate
  // format only when the field is present; absence is checked by the
  // identity-oracle invariant below.
  const sha256 =
    obj.sha256 === undefined
      ? undefined
      : expectSha256Hex(obj.sha256, `${path}.sha256`, errors);
  const stagingSetHash =
    obj.stagingSetHash === undefined
      ? undefined
      : expectSha256Hex(
          obj.stagingSetHash,
          `${path}.stagingSetHash`,
          errors,
        );
  const bundled = expectBoolean(obj.bundled, `${path}.bundled`, errors);
  const url = validateExternalUrl(obj.url, `${path}.url`, errors);
  const downloadMode = validateDownloadMode(obj.downloadMode);
  const instructions =
    obj.instructions === undefined
      ? undefined
      : expectString(obj.instructions, `${path}.instructions`, errors);

  if (expectedFilename === undefined || bundled === undefined) {
    return undefined;
  }

  // Identity-oracle invariant: at least one of sha256/stagingSetHash.
  // A field validation error above (e.g. malformed hex) leaves the
  // value undefined; we only emit this extra error when both fields
  // were genuinely absent — otherwise the format error already
  // explains the rejection.
  const sha256Present = obj.sha256 !== undefined;
  const stagingSetHashPresent = obj.stagingSetHash !== undefined;
  if (!sha256Present && !stagingSetHashPresent) {
    errors.push(
      `${path} must define either "sha256" (archive identity) or ` +
        `"stagingSetHash" (deployed-files identity). Both absent ⇒ ` +
        `the mod has no cross-machine identity.`,
    );
    return undefined;
  }

  // Bundled-archive invariant: the on-disk path inside .ehcoll is
  // keyed by archive sha256, so bundling requires sha256 to be set.
  if (bundled && sha256 === undefined) {
    errors.push(
      `${path}.bundled is true but ${path}.sha256 is missing. ` +
        `Bundled archives are addressed by archive sha256; cannot ` +
        `locate the archive inside the package without it.`,
    );
    return undefined;
  }

  return {
    kind: "external",
    expectedFilename,
    bundled,
    ...(sha256 !== undefined ? { sha256 } : {}),
    ...(stagingSetHash !== undefined ? { stagingSetHash } : {}),
    ...(instructions !== undefined ? { instructions } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(downloadMode !== undefined ? { downloadMode } : {}),
  };
}

/**
 * Vortex's own three download modes. An unrecognised value is DROPPED rather
 * than rejected — the mod still installs, it just gets the generic wording
 * instead of the mode-specific one, and refusing a whole collection over an
 * unknown enum member would be badly out of proportion.
 */
function validateDownloadMode(
  raw: unknown,
): "direct" | "browse" | "manual" | undefined {
  return raw === "direct" || raw === "browse" || raw === "manual"
    ? raw
    : undefined;
}

/**
 * A download link the user can actually open.
 *
 * Anything that is not http(s) is DROPPED rather than rejected: a manifest is
 * not invalid because it carries an origin we cannot present, and refusing to
 * install a whole collection over one unusable link would be wildly out of
 * proportion. The mod still has its instructions.
 */
function validateExternalUrl(
  raw: unknown,
  path: string,
  errors: string[],
): string | undefined {
  if (raw === undefined) return undefined;
  const value = expectString(raw, path, errors);
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return undefined;
  return trimmed;
}

function validateInstallSpec(
  raw: unknown,
  path: string,
  errors: string[],
): ModInstallSpec | undefined {
  if (!isObject(raw)) {
    errors.push(`${path} must be an object, got ${describe(raw)}.`);
    return undefined;
  }
  const obj = raw as Record<string, unknown>;

  const fomodSelections = validateFomodSelections(
    obj.fomodSelections,
    `${path}.fomodSelections`,
    errors,
  );
  const installerType =
    obj.installerType === undefined
      ? undefined
      : expectString(obj.installerType, `${path}.installerType`, errors);
  // Which installer's answer format the selections are written in. Dropping
  // it on parse would make the manifest carry a replayable structure and hand
  // the installer half of it.
  const installerChoicesType =
    obj.installerChoicesType === undefined
      ? undefined
      : expectString(
          obj.installerChoicesType,
          `${path}.installerChoicesType`,
          errors,
        );

  // Proof that an EMPTY selection list means "nothing was picked" rather than
  // "nothing was remembered". Dropping it here would put the ambiguity back.
  const emptySelectionVerified = obj.emptySelectionVerified === true;

  /**
   * ─── PLUGINS THE INSTALLER ASKS THE GAME ABOUT ────────────────────────
   * Registered HERE, beside the writer, because this parser is a whitelist:
   * a field with no branch is not merely unread, it is DROPPED, and the
   * package then ships a field the user side can never see. `light` lived
   * that way for the whole life of the feature.
   *
   * Filtered rather than trusted. It reaches `runInstall` and decides which
   * epoch a mod installs in, so a non-string or an empty entry must not get
   * that far — and an entry that is not a plugin name would defer a mod for
   * a dependency ordering cannot satisfy.
   */
  const readsPluginState = Array.isArray(obj.readsPluginState)
    ? (obj.readsPluginState as unknown[]).filter(
        (x): x is string =>
          typeof x === "string" && /\.(esp|esm|esl)$/i.test(x),
      )
    : undefined;

  if (fomodSelections === undefined) return undefined;
  return {
    fomodSelections,
    ...(installerType !== undefined ? { installerType } : {}),
    ...(installerChoicesType !== undefined ? { installerChoicesType } : {}),
    ...(emptySelectionVerified ? { emptySelectionVerified: true } : {}),
    ...(readsPluginState !== undefined && readsPluginState.length > 0
      ? { readsPluginState }
      : {}),
    // Only `true` survives. Anything else is the absence it already was, and
    // a truthy non-boolean must not become a claim about the archive.
    ...(obj.installerUnexamined === true
      ? { installerUnexamined: true as const }
      : {}),
  };
}

function validateFomodSelections(
  raw: unknown,
  path: string,
  errors: string[],
): FomodSelectionStep[] | undefined {
  const arr = expectArray(raw, path, errors);
  if (arr === undefined) return undefined;

  const steps: FomodSelectionStep[] = [];
  arr.forEach((entry, i) => {
    if (!isObject(entry)) {
      errors.push(`${path}[${i}] must be an object, got ${describe(entry)}.`);
      return;
    }
    const step = entry as Record<string, unknown>;
    const name = expectString(step.name, `${path}[${i}].name`, errors);
    const groupsRaw = expectArray(step.groups, `${path}[${i}].groups`, errors);
    if (name === undefined || groupsRaw === undefined) return;

    const groups: FomodSelectionGroup[] = [];
    groupsRaw.forEach((groupEntry, j) => {
      const group = validateFomodGroup(
        groupEntry,
        `${path}[${i}].groups[${j}]`,
        errors,
      );
      if (group !== undefined) groups.push(group);
    });
    steps.push({ name, groups });
  });
  return steps;
}

function validateFomodGroup(
  raw: unknown,
  path: string,
  errors: string[],
): FomodSelectionGroup | undefined {
  if (!isObject(raw)) {
    errors.push(`${path} must be an object, got ${describe(raw)}.`);
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const name = expectString(obj.name, `${path}.name`, errors);
  const choicesRaw = expectArray(obj.choices, `${path}.choices`, errors);
  if (name === undefined || choicesRaw === undefined) return undefined;

  const choices: FomodSelectedChoice[] = [];
  choicesRaw.forEach((choiceEntry, k) => {
    if (!isObject(choiceEntry)) {
      errors.push(
        `${path}.choices[${k}] must be an object, got ${describe(choiceEntry)}.`,
      );
      return;
    }
    const choiceObj = choiceEntry as Record<string, unknown>;
    const choiceName = expectString(
      choiceObj.name,
      `${path}.choices[${k}].name`,
      errors,
    );
    if (choiceName === undefined) return;
    const idx =
      choiceObj.idx === undefined
        ? undefined
        : expectInteger(choiceObj.idx, `${path}.choices[${k}].idx`, errors);
    choices.push({ name: choiceName, ...(idx !== undefined ? { idx } : {}) });
  });
  return { name, choices };
}

function validateInstallState(
  raw: unknown,
  path: string,
  errors: string[],
): ModInstallState | undefined {
  if (!isObject(raw)) {
    errors.push(`${path} must be an object, got ${describe(raw)}.`);
    return undefined;
  }
  const obj = raw as Record<string, unknown>;

  const enabled = expectBoolean(obj.enabled, `${path}.enabled`, errors);
  const installOrder = expectNonNegativeInt(
    obj.installOrder,
    `${path}.installOrder`,
    errors,
  );
  const deploymentPriority = expectNonNegativeInt(
    obj.deploymentPriority,
    `${path}.deploymentPriority`,
    errors,
  );
  const modType =
    obj.modType === undefined
      ? undefined
      : expectString(obj.modType, `${path}.modType`, errors);
  /**
   * Written by the build, and until now silently DROPPED here — so every mod
   * the curator answered "declare" for arrived on the user's machine without
   * its flag. `judgeReinstall` then applied the strict missing-file rule to
   * the one mod that had opted out of it, ordered a reinstall that provably
   * cannot produce those files, and did it again on every machine, forever.
   *
   * The same shape as the `light` flag before it: written, shipped, dropped.
   */
  const postProcessed =
    obj.postProcessed === undefined
      ? undefined
      : expectBoolean(obj.postProcessed, `${path}.postProcessed`, errors);

  const mirrored =
    obj.mirrored === undefined
      ? undefined
      : expectBoolean(obj.mirrored, `${path}.mirrored`, errors);
  const enabledINITweaks =
    obj.enabledINITweaks === undefined
      ? undefined
      : expectStringArray(
          obj.enabledINITweaks,
          `${path}.enabledINITweaks`,
          errors,
        );
  const stagingFiles =
    obj.stagingFiles === undefined
      ? undefined
      : validateStagingFiles(
          obj.stagingFiles,
          `${path}.stagingFiles`,
          errors,
        );

  if (
    enabled === undefined ||
    installOrder === undefined ||
    deploymentPriority === undefined
  ) {
    return undefined;
  }

  return {
    enabled,
    installOrder,
    deploymentPriority,
    ...(modType !== undefined ? { modType } : {}),
    ...(postProcessed !== undefined ? { postProcessed } : {}),
    ...(mirrored !== undefined ? { mirrored } : {}),
    ...(enabledINITweaks !== undefined ? { enabledINITweaks } : {}),
    ...(stagingFiles !== undefined ? { stagingFiles } : {}),
  };
}

/**
 * Validate per-mod `stagingFiles` array. Each entry must be an object
 * with `path: string`, `size: number >= 0`, optional `sha256: string`.
 *
 * Hash format check: when present, `sha256` must be 64 lowercase hex
 * chars. Mismatched hash format becomes an error rather than silently
 * dropping the field — the integrity check is the whole point.
 */
function validateStagingFiles(
  raw: unknown,
  path: string,
  errors: string[],
): EhcollStagingFile[] | undefined {
  const arr = expectArray(raw, path, errors);
  if (arr === undefined) return undefined;

  const out: EhcollStagingFile[] = [];
  arr.forEach((entry, i) => {
    if (!isObject(entry)) {
      errors.push(
        `${path}[${i}] must be an object, got ${describe(entry)}.`,
      );
      return;
    }
    const obj = entry as Record<string, unknown>;
    const filePath = expectString(obj.path, `${path}[${i}].path`, errors);
    const size = expectNonNegativeInt(
      obj.size,
      `${path}[${i}].size`,
      errors,
    );
    const sha256Raw =
      obj.sha256 === undefined
        ? undefined
        : expectString(obj.sha256, `${path}[${i}].sha256`, errors);
    if (filePath === undefined || size === undefined) return;
    /**
     * A `.ehcoll` comes from a stranger, and this path is joined onto a
     * folder we own so the mirror pass can write bytes into it. An entry
     * spelled `../../../../plugins/evil/index.js` lands in Vortex's own
     * extension directory, which Vortex loads on the next start.
     *
     * An ERROR, not a warning: no staging folder contains an entry above
     * itself, so a package claiming one is not a degraded package — it is
     * not describing a staging folder at all.
     */
    if (!isSafeRelativePath(filePath)) {
      errors.push(
        `${path}[${i}].path must be a relative path inside the mod's ` +
          `staging folder — "${filePath}" was rejected because ` +
          `${unsafePathReason(filePath)}.`,
      );
      return;
    }
    if (sha256Raw !== undefined && !/^[0-9a-f]{64}$/.test(sha256Raw)) {
      errors.push(
        `${path}[${i}].sha256 must be 64 lowercase hex chars, got "${sha256Raw}".`,
      );
      return;
    }
    out.push({
      path: filePath,
      size,
      ...(sha256Raw !== undefined ? { sha256: sha256Raw } : {}),
    });
  });
  return out;
}

function validateUiAttributes(
  raw: unknown,
  path: string,
  errors: string[],
): ModUiAttributes | undefined {
  if (!isObject(raw)) {
    errors.push(`${path} must be an object, got ${describe(raw)}.`);
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const category =
    obj.category === undefined
      ? undefined
      : expectString(obj.category, `${path}.category`, errors);
  const description =
    obj.description === undefined
      ? undefined
      : expectString(obj.description, `${path}.description`, errors);

  const out: ModUiAttributes = {};
  if (category !== undefined) out.category = category;
  if (description !== undefined) out.description = description;
  return out;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function validateRules(
  raw: unknown,
  errors: string[],
): EhcollRule[] | undefined {
  const arr = expectArray(raw, "rules", errors);
  if (arr === undefined) return undefined;
  const rules: EhcollRule[] = [];
  arr.forEach((entry, i) => {
    const rule = validateRuleEntry(entry, `rules[${i}]`, errors);
    if (rule !== undefined) rules.push(rule);
  });
  return rules;
}

function validateRuleEntry(
  raw: unknown,
  path: string,
  errors: string[],
): EhcollRule | undefined {
  if (!isObject(raw)) {
    errors.push(`${path} must be an object, got ${describe(raw)}.`);
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const source = expectNonEmptyString(obj.source, `${path}.source`, errors);
  const type = expectEnum(
    obj.type,
    RULE_TYPES,
    `${path}.type`,
    errors,
  ) as ModRuleType | undefined;
  const reference = expectNonEmptyString(
    obj.reference,
    `${path}.reference`,
    errors,
  );
  const comment =
    obj.comment === undefined
      ? undefined
      : expectString(obj.comment, `${path}.comment`, errors);
  const ignored =
    obj.ignored === undefined
      ? undefined
      : expectBoolean(obj.ignored, `${path}.ignored`, errors);

  if (source === undefined || type === undefined || reference === undefined) {
    return undefined;
  }
  return {
    source,
    type,
    reference,
    ...(comment !== undefined ? { comment } : {}),
    ...(ignored !== undefined ? { ignored } : {}),
  };
}


// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

function validatePlugins(
  raw: unknown,
  errors: string[],
): { order: EhcollPluginEntry[] } | undefined {
  if (!isObject(raw)) {
    errors.push(`plugins must be an object, got ${describe(raw)}.`);
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const orderRaw = expectArray(obj.order, "plugins.order", errors);
  if (orderRaw === undefined) return undefined;

  const order: EhcollPluginEntry[] = [];
  orderRaw.forEach((entry, i) => {
    if (!isObject(entry)) {
      errors.push(
        `plugins.order[${i}] must be an object, got ${describe(entry)}.`,
      );
      return;
    }
    const e = entry as Record<string, unknown>;
    const name = expectNonEmptyString(e.name, `plugins.order[${i}].name`, errors);
    const enabled = expectBoolean(
      e.enabled,
      `plugins.order[${i}].enabled`,
      errors,
    );
    /**
     * ─── ABSENT IS A THIRD STATE, AND IT HAS TO SURVIVE THE PARSER ──────
     * This was not read at all, so every `light` the curator captured was
     * dropped here and the ESL feature was a no-op on every user's machine —
     * `applyPluginLightFlags` saw `undefined` for all 817 plugins, counted
     * them "unknown", wrote nothing, and said nothing, because its notice is
     * suppressed when `corrected === 0` and its over-limit alarm counts only
     * plugins it compared. A 573-light profile installed with every plugin
     * against a 254 limit and reported success.
     *
     * The field is optional on `EhcollPluginEntry`, so dropping it was not a
     * type error — which is exactly why it survived. Absent must stay absent
     * and never be coerced to `false`: `false` means "the curator's copy is
     * NOT light, clear the flag", while absent means "we could not read it,
     * leave the user's file alone".
     */
    const light =
      e.light === undefined
        ? undefined
        : expectBoolean(e.light, `plugins.order[${i}].light`, errors);
    if (name === undefined || enabled === undefined) return;
    order.push({ name, enabled, ...(light !== undefined ? { light } : {}) });
  });
  return { order };
}

// ---------------------------------------------------------------------------
// LoadOrder (top-level — Vortex per-game load order, slice 6c)
// ---------------------------------------------------------------------------

/**
 * Back-compat note: pre-slice-6c manifests don't carry `loadOrder`.
 * `undefined` is treated as `[]` so older `.ehcoll` files parse cleanly
 * (schema version stays at 1; the field is additive).
 */
function validateLoadOrder(
  raw: unknown,
  errors: string[],
): EhcollLoadOrderEntry[] | undefined {
  if (raw === undefined) return [];
  const arr = expectArray(raw, "loadOrder", errors);
  if (arr === undefined) return undefined;
  const out: EhcollLoadOrderEntry[] = [];
  const seenCompareKeys = new Set<string>();
  arr.forEach((entry, i) => {
    if (!isObject(entry)) {
      errors.push(`loadOrder[${i}] must be an object, got ${describe(entry)}.`);
      return;
    }
    const obj = entry as Record<string, unknown>;
    const compareKey = expectNonEmptyString(
      obj.compareKey,
      `loadOrder[${i}].compareKey`,
      errors,
    );
    const pos = expectNonNegativeInt(obj.pos, `loadOrder[${i}].pos`, errors);
    const enabled = expectBoolean(
      obj.enabled,
      `loadOrder[${i}].enabled`,
      errors,
    );
    const locked =
      obj.locked === undefined
        ? undefined
        : expectBoolean(obj.locked, `loadOrder[${i}].locked`, errors);
    if (compareKey === undefined || pos === undefined || enabled === undefined) {
      return;
    }
    if (seenCompareKeys.has(compareKey)) {
      errors.push(
        `loadOrder[${i}].compareKey "${compareKey}" appears more than once. ` +
          `Each mod can occupy only one load-order position.`,
      );
      return;
    }
    seenCompareKeys.add(compareKey);
    out.push({
      compareKey,
      pos,
      enabled,
      ...(locked !== undefined ? { locked } : {}),
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Userlist (LOOT plugin rules + groups, slice 6d)
// ---------------------------------------------------------------------------

/**
 * Back-compat note: pre-slice-6d manifests don't carry `userlist`.
 * `undefined` is treated as an empty userlist so older `.ehcoll` files
 * parse cleanly (schema version stays at 1; the field is additive).
 *
 * The validator is permissive about reference shape: each
 * `after` / `req` / `inc` / group `after` entry can be either a plain
 * string OR a LOOT object reference `{ name, display?, condition? }`.
 * Object refs are collapsed to their `name`, mirroring what the
 * curator-side capture does. Conditional refs lose their condition
 * metadata in the collapse — same v1 limitation as capture.
 */
function validateUserlist(
  raw: unknown,
  errors: string[],
): EhcollUserlist | undefined {
  if (raw === undefined) return { plugins: [], groups: [] };

  if (!isObject(raw)) {
    errors.push(`userlist must be an object, got ${describe(raw)}.`);
    return undefined;
  }
  const obj = raw as Record<string, unknown>;

  const plugins = validateUserlistPlugins(obj.plugins, errors);
  const groups = validateUserlistGroups(obj.groups, errors);
  if (plugins === undefined || groups === undefined) return undefined;

  return { plugins, groups };
}

function validateUserlistPlugins(
  raw: unknown,
  errors: string[],
): EhcollUserlistPlugin[] | undefined {
  // Back-fill missing/undefined to [] for forward-compat — same policy
  // we apply to the entire userlist when the manifest predates 6d.
  if (raw === undefined) return [];
  const arr = expectArray(raw, "userlist.plugins", errors);
  if (arr === undefined) return undefined;

  const out: EhcollUserlistPlugin[] = [];
  const seen = new Map<string, number>();

  arr.forEach((entry, i) => {
    const path = `userlist.plugins[${i}]`;
    if (!isObject(entry)) {
      errors.push(`${path} must be an object, got ${describe(entry)}.`);
      return;
    }
    const e = entry as Record<string, unknown>;

    const name = expectNonEmptyString(e.name, `${path}.name`, errors);
    if (name === undefined) return;

    const lower = name.toLowerCase();
    const previousIndex = seen.get(lower);
    if (previousIndex !== undefined) {
      errors.push(
        `Duplicate userlist plugin "${name}" at ${path} and ` +
          `userlist.plugins[${previousIndex}] (case-insensitive). ` +
          `Each plugin can have at most one userlist entry.`,
      );
      return;
    }
    seen.set(lower, i);

    const group =
      e.group === undefined
        ? undefined
        : expectNonEmptyString(e.group, `${path}.group`, errors);
    const after = readUserlistRefList(e.after, `${path}.after`, errors);
    const req = readUserlistRefList(e.req, `${path}.req`, errors);
    const inc = readUserlistRefList(e.inc, `${path}.inc`, errors);

    // If any sub-validator pushed an error for this plugin, we still
    // collect the rest of its fields — `errors` accumulates everything
    // so the curator gets the full picture in one pass.
    const built: EhcollUserlistPlugin = { name };
    if (group !== undefined) built.group = group;
    if (after !== undefined && after.length > 0) built.after = after;
    if (req !== undefined && req.length > 0) built.req = req;
    if (inc !== undefined && inc.length > 0) built.inc = inc;
    out.push(built);
  });

  return out;
}

function validateUserlistGroups(
  raw: unknown,
  errors: string[],
): EhcollUserlistGroup[] | undefined {
  if (raw === undefined) return [];
  const arr = expectArray(raw, "userlist.groups", errors);
  if (arr === undefined) return undefined;

  const out: EhcollUserlistGroup[] = [];
  const seen = new Map<string, number>();

  arr.forEach((entry, i) => {
    const path = `userlist.groups[${i}]`;
    if (!isObject(entry)) {
      errors.push(`${path} must be an object, got ${describe(entry)}.`);
      return;
    }
    const e = entry as Record<string, unknown>;
    const name = expectNonEmptyString(e.name, `${path}.name`, errors);
    if (name === undefined) return;

    const lower = name.toLowerCase();
    const previousIndex = seen.get(lower);
    if (previousIndex !== undefined) {
      errors.push(
        `Duplicate userlist group "${name}" at ${path} and ` +
          `userlist.groups[${previousIndex}] (case-insensitive). ` +
          `Each group can be defined at most once.`,
      );
      return;
    }
    seen.set(lower, i);

    const after = readUserlistRefList(e.after, `${path}.after`, errors);
    const built: EhcollUserlistGroup = { name };
    if (after !== undefined && after.length > 0) built.after = after;
    out.push(built);
  });

  return out;
}

/**
 * Permissive reference-list reader: accepts plain strings (Vortex's
 * Redux storage shape) and LOOT object refs (`{ name, display?,
 * condition? }`, the on-disk YAML shape). Object refs are collapsed
 * to their `name` field. Mixed lists are tolerated.
 */
function readUserlistRefList(
  raw: unknown,
  path: string,
  errors: string[],
): string[] | undefined {
  if (raw === undefined) return [];
  const arr = expectArray(raw, path, errors);
  if (arr === undefined) return undefined;
  const out: string[] = [];
  arr.forEach((item, i) => {
    if (typeof item === "string") {
      if (item.length === 0) {
        errors.push(`${path}[${i}] cannot be an empty string.`);
        return;
      }
      out.push(item);
      return;
    }
    if (isObject(item)) {
      const obj = item as Record<string, unknown>;
      if (typeof obj.name !== "string" || obj.name.length === 0) {
        errors.push(
          `${path}[${i}] must be a string or have a non-empty "name" field, ` +
            `got ${describe(item)}.`,
        );
        return;
      }
      out.push(obj.name);
      return;
    }
    errors.push(
      `${path}[${i}] must be a string or LOOT reference object, got ${describe(item)}.`,
    );
  });
  return out;
}

// ---------------------------------------------------------------------------
// INI tweaks (placeholder until Phase 5)
// ---------------------------------------------------------------------------

function validateIniTweaks(
  raw: unknown,
  errors: string[],
): EhcollIniTweak[] | undefined {
  const arr = expectArray(raw, "iniTweaks", errors);
  if (arr === undefined) return undefined;
  const tweaks: EhcollIniTweak[] = [];
  arr.forEach((entry, i) => {
    if (!isObject(entry)) {
      errors.push(`iniTweaks[${i}] must be an object, got ${describe(entry)}.`);
      return;
    }
    const obj = entry as Record<string, unknown>;
    const ini = expectNonEmptyString(obj.ini, `iniTweaks[${i}].ini`, errors);
    const section = expectString(
      obj.section,
      `iniTweaks[${i}].section`,
      errors,
    );
    const key = expectNonEmptyString(obj.key, `iniTweaks[${i}].key`, errors);
    const value = expectString(obj.value, `iniTweaks[${i}].value`, errors);
    if (
      ini === undefined ||
      section === undefined ||
      key === undefined ||
      value === undefined
    ) {
      return;
    }
    tweaks.push({ ini, section, key, value });
  });
  return tweaks;
}

// ---------------------------------------------------------------------------
// External dependencies
// ---------------------------------------------------------------------------

function validateExternalDependencies(
  raw: unknown,
  errors: string[],
): EhcollExternalDependency[] | undefined {
  const arr = expectArray(raw, "externalDependencies", errors);
  if (arr === undefined) return undefined;
  const deps: EhcollExternalDependency[] = [];
  arr.forEach((entry, i) => {
    const dep = validateExternalDependency(
      entry,
      `externalDependencies[${i}]`,
      errors,
    );
    if (dep !== undefined) deps.push(dep);
  });
  return deps;
}

function validateExternalDependency(
  raw: unknown,
  path: string,
  errors: string[],
): EhcollExternalDependency | undefined {
  if (!isObject(raw)) {
    errors.push(`${path} must be an object, got ${describe(raw)}.`);
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const id = expectNonEmptyString(obj.id, `${path}.id`, errors);
  const name = expectNonEmptyString(obj.name, `${path}.name`, errors);
  const category = expectNonEmptyString(
    obj.category,
    `${path}.category`,
    errors,
  );
  const version = expectString(obj.version, `${path}.version`, errors);
  const destination = expectEnum(
    obj.destination,
    EXTERNAL_DEP_DESTINATIONS,
    `${path}.destination`,
    errors,
  ) as ExternalDependencyDestination | undefined;
  const filesRaw = expectArray(obj.files, `${path}.files`, errors);
  const instructions = expectNonEmptyString(
    obj.instructions,
    `${path}.instructions`,
    errors,
  );
  const instructionsUrl =
    obj.instructionsUrl === undefined
      ? undefined
      : expectString(obj.instructionsUrl, `${path}.instructionsUrl`, errors);

  let files: ExternalDependencyFile[] | undefined;
  if (filesRaw !== undefined) {
    files = [];
    filesRaw.forEach((fileEntry, i) => {
      const file = validateExternalDependencyFile(
        fileEntry,
        `${path}.files[${i}]`,
        errors,
      );
      if (file !== undefined) files!.push(file);
    });
  }

  if (
    id === undefined ||
    name === undefined ||
    category === undefined ||
    version === undefined ||
    destination === undefined ||
    files === undefined ||
    instructions === undefined
  ) {
    return undefined;
  }

  return {
    id,
    name,
    category,
    version,
    destination,
    files,
    instructions,
    ...(instructionsUrl !== undefined ? { instructionsUrl } : {}),
  };
}

function validateExternalDependencyFile(
  raw: unknown,
  path: string,
  errors: string[],
): ExternalDependencyFile | undefined {
  if (!isObject(raw)) {
    errors.push(`${path} must be an object, got ${describe(raw)}.`);
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const relPath = expectNonEmptyString(obj.relPath, `${path}.relPath`, errors);
  const sha256 = expectSha256Hex(obj.sha256, `${path}.sha256`, errors);
  if (relPath === undefined || sha256 === undefined) return undefined;
  return { relPath, sha256 };
}

// ---------------------------------------------------------------------------
// Cross-reference validation (warnings only)
// ---------------------------------------------------------------------------

function crossReferenceValidate(
  parts: {
    mods: EhcollMod[];
    rules: EhcollRule[];
      loadOrder: EhcollLoadOrderEntry[];
    userlist: EhcollUserlist;
    plugins: EhcollPluginEntry[];
  },
  warnings: string[],
): void {
  const compareKeys = new Set(parts.mods.map((m) => m.compareKey));
  const externalSha256Counts = new Map<string, string[]>();
  const externalStagingHashCounts = new Map<string, string[]>();

  // External-mod identity collision detection. We bucket on whichever
  // identity oracle the mod carries (archiveSha256 first, then
  // stagingSetHash) and warn on collisions in either bucket. Mods
  // without `sha256` (archive-less, identity by stagingSetHash) can
  // legitimately collide with sha-based mods only if the curator
  // deduped poorly — we don't bother cross-bucket-checking those.
  for (const mod of parts.mods) {
    if (mod.source.kind === "external") {
      if (mod.source.sha256 !== undefined) {
        const list = externalSha256Counts.get(mod.source.sha256) ?? [];
        list.push(mod.compareKey);
        externalSha256Counts.set(mod.source.sha256, list);
      } else if (mod.source.stagingSetHash !== undefined) {
        const list =
          externalStagingHashCounts.get(mod.source.stagingSetHash) ?? [];
        list.push(mod.compareKey);
        externalStagingHashCounts.set(mod.source.stagingSetHash, list);
      }
    }
  }
  for (const [sha, keys] of externalSha256Counts) {
    if (keys.length > 1) {
      warnings.push(
        `External mods ${keys.map((k) => `"${k}"`).join(", ")} share the ` +
          `same archiveSha256 (${sha.slice(0, 12)}…). The package can only ` +
          `bundle the archive once; the resolver will install both pointing ` +
          `at the same bytes. Likely a curator dedupe oversight.`,
      );
    }
  }
  for (const [setHash, keys] of externalStagingHashCounts) {
    if (keys.length > 1) {
      warnings.push(
        `External mods ${keys.map((k) => `"${k}"`).join(", ")} share the ` +
          `same stagingSetHash (${setHash.slice(0, 12)}…). Their deployed ` +
          `file sets are byte-identical. Likely a curator dedupe oversight.`,
      );
    }
  }

  // Rule references — both source and reference may resolve to a mod.
  for (let i = 0; i < parts.rules.length; i++) {
    const rule = parts.rules[i]!;
    if (!compareKeys.has(rule.source)) {
      warnings.push(
        `rules[${i}].source "${rule.source}" does not match any mod's ` +
          `compareKey. The rule will be skipped at install time.`,
      );
    }
    // `reference` may be a partially-pinned key like "nexus:1234". We
    // only warn when the reference is fully-pinned AND not present.
    if (
      isFullyPinnedReference(rule.reference) &&
      !compareKeys.has(rule.reference)
    ) {
      warnings.push(
        `rules[${i}].reference "${rule.reference}" does not match any mod's ` +
          `compareKey. The rule's target may resolve via partial pin at ` +
          `install time, or be unenforceable.`,
      );
    }
  }

  // LoadOrder references — every entry must match a manifest mod.
  // Loose entries (capturing a mod the curator had locally but didn't
  // pack) are warned-only because the install driver will skip them
  // gracefully; we don't refuse the whole install over them.
  for (let i = 0; i < parts.loadOrder.length; i++) {
    const entry = parts.loadOrder[i]!;
    if (!compareKeys.has(entry.compareKey)) {
      warnings.push(
        `loadOrder[${i}].compareKey "${entry.compareKey}" does not match ` +
          `any mod's compareKey. The entry will be skipped at install time.`,
      );
    }
  }

  // Userlist plugin entries — every plugin entry should match a plugin
  // in `plugins.order` (the curator-side scoping pass enforces this,
  // so a mismatch implies a hand-edited manifest). References (after /
  // req / inc) are NOT validated against the manifest's plugin list:
  // they intentionally reach outside the collection (to vanilla
  // masters, common community plugins, etc.) — that's the only way
  // LOOT rules work in practice.
  const collectionPluginsLower = new Set(
    parts.plugins.map((p) => p.name.toLowerCase()),
  );
  for (let i = 0; i < parts.userlist.plugins.length; i++) {
    const entry = parts.userlist.plugins[i]!;
    if (!collectionPluginsLower.has(entry.name.toLowerCase())) {
      warnings.push(
        `userlist.plugins[${i}].name "${entry.name}" does not match any ` +
          `plugin in plugins.order. The entry will be skipped at install ` +
          `time. (Likely a hand-edited manifest — the curator-side scoping ` +
          `pass drops these.)`,
      );
    }
  }

  // Userlist groups — group `after` references should point at other
  // groups defined in this userlist. Inter-group rules pointing at a
  // group not present here are warned but not fatal: the user's local
  // userlist may carry the missing group definition.
  const groupNamesLower = new Set(
    parts.userlist.groups.map((g) => g.name.toLowerCase()),
  );
  for (let i = 0; i < parts.userlist.groups.length; i++) {
    const group = parts.userlist.groups[i]!;
    if (group.after === undefined) continue;
    group.after.forEach((ref, j) => {
      if (!groupNamesLower.has(ref.toLowerCase())) {
        warnings.push(
          `userlist.groups[${i}].after[${j}] "${ref}" does not match any ` +
            `group defined in userlist.groups. Vortex will tolerate the ` +
            `dangling reference but the rule may not behave as intended.`,
        );
      }
    });
  }

}

/**
 * A reference is "fully pinned" when it specifies enough information
 * to match exactly one mod. Heuristic: `nexus:<modId>:<fileId>` is fully
 * pinned (3 colon-separated segments); `nexus:<modId>` is partial.
 * `external:<sha256>` is fully pinned. `archive:<id>` is fully pinned.
 *
 * `external:` carries TWO shapes, which the comment here used to deny.
 * `buildExternalMod` emits `external:<sha256>` for a mod identified by its
 * archive and `external:staging:<stagingSetHash>` for one repacked from its
 * staging folder — two lines apart in the same ternary. This function said
 * "external: / archive: / id: are all single-segment-after-prefix" and passed
 * the three-segment form anyway, because the regex only tests the prefix. The
 * behaviour was right by accident and the stated rule was wrong, which is the
 * worse of the two to leave in place: the next person to add an arity check
 * would have written it from the comment.
 */
const isFullyPinnedReference = isFullyPinnedModReference;

// ---------------------------------------------------------------------------
// JSON parsing helper
// ---------------------------------------------------------------------------

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ParseManifestError([
      `manifest.json is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    ]);
  }
}

// ---------------------------------------------------------------------------
// Type-narrowing helpers (return value or undefined; push errors)
// ---------------------------------------------------------------------------

function expectString(
  raw: unknown,
  path: string,
  errors: string[],
): string | undefined {
  if (typeof raw === "string") return raw;
  errors.push(`${path} must be a string, got ${describe(raw)}.`);
  return undefined;
}

function expectNonEmptyString(
  raw: unknown,
  path: string,
  errors: string[],
): string | undefined {
  const s = expectString(raw, path, errors);
  if (s === undefined) return undefined;
  if (s.length === 0) {
    errors.push(`${path} cannot be empty.`);
    return undefined;
  }
  return s;
}

function expectBoolean(
  raw: unknown,
  path: string,
  errors: string[],
): boolean | undefined {
  if (typeof raw === "boolean") return raw;
  errors.push(`${path} must be a boolean, got ${describe(raw)}.`);
  return undefined;
}

function expectInteger(
  raw: unknown,
  path: string,
  errors: string[],
): number | undefined {
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  errors.push(`${path} must be an integer, got ${describe(raw)}.`);
  return undefined;
}

function expectNonNegativeInt(
  raw: unknown,
  path: string,
  errors: string[],
): number | undefined {
  const n = expectInteger(raw, path, errors);
  if (n === undefined) return undefined;
  if (n < 0) {
    errors.push(`${path} must be ≥ 0, got ${n}.`);
    return undefined;
  }
  return n;
}

function expectPositiveInt(
  raw: unknown,
  path: string,
  errors: string[],
): number | undefined {
  const n = expectInteger(raw, path, errors);
  if (n === undefined) return undefined;
  if (n <= 0) {
    errors.push(`${path} must be > 0, got ${n}.`);
    return undefined;
  }
  return n;
}

function expectArray(
  raw: unknown,
  path: string,
  errors: string[],
): unknown[] | undefined {
  if (Array.isArray(raw)) return raw;
  errors.push(`${path} must be an array, got ${describe(raw)}.`);
  return undefined;
}

function expectStringArray(
  raw: unknown,
  path: string,
  errors: string[],
): string[] | undefined {
  const arr = expectArray(raw, path, errors);
  if (arr === undefined) return undefined;
  const out: string[] = [];
  let ok = true;
  arr.forEach((v, i) => {
    if (typeof v !== "string") {
      errors.push(`${path}[${i}] must be a string, got ${describe(v)}.`);
      ok = false;
      return;
    }
    out.push(v);
  });
  return ok ? out : undefined;
}

function expectEnum<T extends string>(
  raw: unknown,
  allowed: ReadonlySet<T>,
  path: string,
  errors: string[],
): T | undefined {
  if (typeof raw === "string" && allowed.has(raw as T)) return raw as T;
  errors.push(
    `${path} must be one of ${Array.from(allowed)
      .map((v) => `"${v}"`)
      .join(", ")}; got ${describe(raw)}.`,
  );
  return undefined;
}

function expectUuid(
  raw: unknown,
  path: string,
  errors: string[],
): string | undefined {
  const s = expectString(raw, path, errors);
  if (s === undefined) return undefined;
  // Accept any RFC 4122 UUID (v1/v4/v5 — version digit not enforced).
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
  ) {
    errors.push(`${path} must be a UUID string, got ${JSON.stringify(s)}.`);
    return undefined;
  }
  return s;
}

function expectSha256Hex(
  raw: unknown,
  path: string,
  errors: string[],
): string | undefined {
  const s = expectString(raw, path, errors);
  if (s === undefined) return undefined;
  if (!/^[0-9a-f]{64}$/.test(s)) {
    errors.push(
      `${path} must be a lowercase 64-character hex SHA-256, got ${JSON.stringify(
        s,
      )}.`,
    );
    return undefined;
  }
  return s;
}

function expectIso8601(
  raw: unknown,
  path: string,
  errors: string[],
): string | undefined {
  const s = expectString(raw, path, errors);
  if (s === undefined) return undefined;
  // We accept anything Date can parse to a finite number — the spec
  // says ISO-8601 UTC but we don't want to be stricter than the
  // builtin parser, since `Date.toISOString()` (what the producer
  // emits) round-trips cleanly.
  const t = Date.parse(s);
  if (!Number.isFinite(t)) {
    errors.push(
      `${path} must be an ISO-8601 timestamp, got ${JSON.stringify(s)}.`,
    );
    return undefined;
  }
  return s;
}

function expectSemver(
  raw: unknown,
  path: string,
  errors: string[],
): string | undefined {
  const s = expectString(raw, path, errors);
  if (s === undefined) return undefined;
  // Lightweight check, same shape the action handler enforces. Strict
  // semver compatibility checking is the resolver's job.
  if (!/^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$/.test(s)) {
    errors.push(
      `${path} must be a semver string (e.g. "1.0.0" or "1.0.0-beta.1"), ` +
        `got ${JSON.stringify(s)}.`,
    );
    return undefined;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value === undefined) return "undefined";
  return typeof value;
}

/**
 * The curator's game INI settings.
 *
 * Absent is valid and common — manifests built before this field existed, and
 * builds that could not read the files. A malformed entry is dropped with an
 * error rather than half-parsed: a settings block that silently loses keys
 * would apply a configuration nobody wrote.
 */
function validateGameIni(
  raw: unknown,
  errors: string[],
): EhcollGameIni | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    errors.push(`gameIni must be an object, got ${describe(raw)}.`);
    return undefined;
  }
  const files = expectArray((raw as Record<string, unknown>).files, "gameIni.files", errors);
  if (files === undefined) return undefined;

  const out: EhcollGameIni["files"] = [];
  files.forEach((entry, i) => {
    const path = `gameIni.files[${i}]`;
    if (!isObject(entry)) {
      errors.push(`${path} must be an object, got ${describe(entry)}.`);
      return;
    }
    const e = entry as Record<string, unknown>;
    const fileName = expectString(e.fileName, `${path}.fileName`, errors);
    const settings = expectArray(e.settings, `${path}.settings`, errors);
    if (fileName === undefined || settings === undefined) return;

    const parsedSettings: EhcollGameIni["files"][number]["settings"] = [];
    settings.forEach((s, j) => {
      const sp = `${path}.settings[${j}]`;
      if (!isObject(s)) {
        errors.push(`${sp} must be an object, got ${describe(s)}.`);
        return;
      }
      const so = s as Record<string, unknown>;
      const section = expectString(so.section, `${sp}.section`, errors);
      const key = expectString(so.key, `${sp}.key`, errors);
      const value = expectString(so.value, `${sp}.value`, errors);
      if (section === undefined || key === undefined || value === undefined) return;
      parsedSettings.push({ section, key, value });
    });

    out.push({ fileName, settings: parsedSettings });
  });

  return { files: out };
}
