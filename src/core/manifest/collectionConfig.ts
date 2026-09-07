/**
 * Per-collection state file (Phase 2 slice 4b).
 *
 * Persists the bits of curator-supplied input that must survive across
 * rebuilds — most importantly, the `package.id` UUIDv4. The same file
 * also carries per-mod overrides (which external archives to bundle,
 * what instructions to ship for each), README/CHANGELOG bodies, and a
 * read-only `name` hint per external mod so the curator can hand-edit
 * the file without keeping a Vortex modId-to-name lookup table in
 * their head.
 *
 * One file per collection slug, located at:
 *   `<configDir>/<slug>.json`
 *
 * where `<configDir>` is conventionally
 *   `%APPDATA%\Vortex\event-horizon\collections\.config\`
 *
 * On the first build of a given slug, the action handler creates the
 * file with a fresh UUID and an empty externalMods record. Subsequent
 * builds read the file and reuse the same id, preserving release
 * lineage (= "the user's already-installed v1.2.0 of THIS collection
 * upgrades cleanly to v1.3.0 of THIS collection because the package.id
 * is stable").
 *
 * Renaming the collection (which changes the slug) deliberately starts
 * a new release lineage. This is the simplest possible identity model
 * and matches how curators tend to think about renames in practice
 * ("if I rename it, it's a new collection"). The Phase 5 React UI may
 * introduce explicit collection identity decoupled from name; for now,
 * slug = identity.
 *
 * Spec: docs/business/COLLECTION_CONFIG.md
 *
 * ─── DESIGN ────────────────────────────────────────────────────────────
 * No bespoke UI for slice 4b. The action handler:
 *   1. Loads (or creates) the file via `loadOrCreateCollectionConfig`.
 *   2. Calls `reconcileExternalModsConfig` to add stub entries for any
 *      external mods present in the current snapshot but missing from
 *      the file. Newly added stubs default to `bundled: false`,
 *      `instructions: ""`, and carry a `name` hint.
 *   3. If reconciliation changed anything, persists the updated config
 *      via `saveCollectionConfig` so the curator sees a fully populated
 *      file the next time they open it.
 *
 * The Phase 5 React page consumes the same `loadOrCreateCollectionConfig`
 * + `saveCollectionConfig` pair to power its build-panel form — no
 * separate code path.
 * ──────────────────────────────────────────────────────────────────────
 */

import { randomUUID } from "crypto";
import * as fsp from "fs/promises";
import * as path from "path";
import { applyHint } from "./externalHints";
import type { DownloadMode, ExternalHint } from "./externalHints";
import { beginOp, ehLog } from "../logging/ehLog";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const COLLECTION_CONFIG_SCHEMA_VERSION = 1 as const;
export type CollectionConfigSchemaVersion =
  typeof COLLECTION_CONFIG_SCHEMA_VERSION;

/**
 * Per-mod override carried in the collection config. Keyed by
 * `AuditorMod.id` to match what `BuildManifestInput.externalMods`
 * expects. The `name` field is a read-only hint for hand-editors — it's
 * populated automatically on reconciliation and ignored when the
 * action feeds the config into `buildManifest`.
 */
export type ExternalModConfigEntry = {
  /** Read-only hint set by the action handler. Curator-edits are preserved but never relied on. */
  name?: string;
  /**
   * Ship a NEXUS mod as external, because its file is gone from Nexus.
   *
   * Only meaningful on a mod that has Nexus ids — external mods are external
   * already. Persisted with the other per-mod overrides so the decision
   * survives a rebuild: a curator should not have to rediscover a dead mod
   * every release.
   */
  treatAsExternal?: boolean;
  /** When true, the source archive ships inside the `.ehcoll` at `bundled/<sha256>.<ext>`. Default false. */
  bundled?: boolean;
  /**
   * The diverged files this mod's post-processing answer was given about.
   *
   * An answer is about the files as they were. Without this, a curator who
   * later drops another patch into the same folder keeps the old verdict —
   * and for "users don't need them" that means the new file is withheld
   * silently. With it, the question reopens exactly when the files move.
   *
   * Absent on entries answered before this existed. Those are honoured rather
   * than re-asked: nagging about every past decision on upgrade would be a
   * worse trade than trusting an answer that was correct when it was given.
   */
  postProcessingDecidedFor?: string;
  /**
   * Reproduce this mod's staging folder on the user's machine, exactly.
   *
   * The third answer to "my staging differs from my archive", and the one that
   * costs the least: the mod still installs from its own Nexus archive, and
   * afterwards the differences are reconciled from bytes carried in the
   * package. `bundled` replaces the archive; this corrects what it produced.
   */
  mirrored?: boolean;
  /**
   * "I post-processed this mod's staging myself, and that is deliberate."
   *
   * Some mods are edited in place after install — xLODGen and DynDOLOD
   * outputs written into a mod folder, BA2 repacks, cleaned plugins. The
   * staging folder then holds files the mod's own archive cannot produce, and
   * a user installing from that archive can NEVER have them.
   *
   * Without this flag those files are recorded as required. Every client then
   * fails verification, gets reinstalled from the same archive, fails
   * identically, and the mod is recorded broken — a permanent false
   * failure that no amount of retrying can clear.
   *
   * Setting it says: hold users to the files my archive can produce, and treat
   * the rest as mine. It is DECLARED rather than inferred on purpose. A mod
   * with unreproducible files that you did NOT flag is a mod where something
   * happened you did not intend, and that deserves to fail loudly rather than
   * be quietly waved through.
   *
   * It does not weaken anything else: the archive still identifies the mod,
   * every file the archive DOES produce is still verified, and files differing
   * in content are already handled without this flag by `judgeReinstall`.
   *
   * Meaningless on a bundled mod, which ships its staging verbatim.
   */
  postProcessed?: boolean;
  /**
   * Leave this mod out of the collection entirely.
   *
   * The fourth answer, and the only one that is not about HOW to deliver the
   * mod. Some mods should not be delivered: one in a real 1,755-mod
   * collection staged a single 74-byte placeholder — the curator's own copy
   * was empty — so it contributed nothing to the game, and reproducing it
   * meant asking a stranger to complete a FOMOD that produces no files, which
   * Vortex fails outright.
   *
   * The build already detected that shape and rendered a paragraph saying the
   * useful answer was to remove the mod. Then it offered mirror, declare and
   * bundle — all three of which would faithfully ship the placeholder. This
   * is the answer that was missing.
   *
   * A dropped mod is excluded from the manifest, from bundling and from
   * mirroring. Nothing is deleted from the curator's own Vortex: they keep
   * the mod, the collection simply stops carrying it.
   */
  dropped?: boolean;
  /** Free-form text shown to the user when the mod isn't bundled. */
  instructions?: string;
  /**
   * Where to get it. Usually filled in from what Vortex already knows rather
   * than typed — see externalHints — but curator-editable, and a curator value
   * is never overwritten by a suggestion.
   */
  url?: string;
  /** What kind of link `url` is. See ExternalModSource.downloadMode. */
  mode?: DownloadMode;
};

/** What the curator decided about one detected prerequisite. */
export type ExternalDependencyConfigEntry = {
  /** Default true. False removes it from the manifest entirely. */
  included?: boolean;
  /** Replaces the generic default when non-blank. */
  instructions?: string;
  instructionsUrl?: string;
  /** Overrides the version derived from the files on disk. */
  version?: string;
};

export type CollectionConfig = {
  schemaVersion: CollectionConfigSchemaVersion;
  /** UUIDv4. Stable across rebuilds of the same slug. */
  packageId: string;
  /** Per-AuditorMod.id overrides for external (non-Nexus) mods. */
  externalMods: Record<string, ExternalModConfigEntry>;
  /**
   * Curator decisions about detected prerequisites that are NOT Vortex mods —
   * a script extender, ENB, a plugin preloader. Keyed by dependency id.
   *
   * The dependencies themselves are DETECTED from the game folder on every
   * build, because their file hashes have to come from disk. Only the
   * judgement is persisted: whether to ship it, and the instructions the
   * curator wrote, which know which build to fetch in a way a generic default
   * cannot. Optional so every config written before this existed still loads.
   */
  externalDependencies?: Record<string, ExternalDependencyConfigEntry>;
  /** Optional README markdown body. Written as `README.md` in the package. */
  readme?: string;
  /** Optional CHANGELOG markdown body. Written as `CHANGELOG.md`. */
  changelog?: string;
  /**
   * Last successful build's version string ("1.2.0"). Written by the
   * build pipeline post-package; read by the curator dashboard to
   * answer "what version did I last ship for this collection?" and
   * to power update-tracing ("editing v1.2 → ..." badge on a draft
   * linked to this packageId).
   *
   * Optional because freshly-created configs haven't shipped yet —
   * the field appears only after the first successful build.
   */
  lastBuiltVersion?: string;
  /** ISO timestamp of the last successful build. Pairs with {@link lastBuiltVersion}. */
  lastBuiltAt?: string;
  /**
   * Curator-facing display name as of the last build. Useful when
   * the slug differs slightly from the human-readable name (e.g.
   * "My Big Build" → slug "my-big-build"). Optional for legacy
   * configs.
   */
  lastBuiltName?: string;
  /**
   * Author recorded by the last successful build.
   *
   * Kept because it is the only place it survives: the curator types it into
   * the build form, it goes into the manifest, and then the form is gone. An
   * update seeded without it silently blanks the author of every release
   * after the first, which reads as "the field does not save".
   */
  lastBuiltAuthor?: string;
  /**
   * Fingerprint of the enabled-mod set the last build shipped.
   *
   * Lets the dashboard answer "has anything changed since?" without touching
   * the disk. Membership only — see `profileFingerprint`.
   */
  lastBuiltProfileFingerprint?: string;
  /**
   * Vortex `gameId` this collection was built for (e.g. "skyrimse").
   * Recorded on every successful build so the curator dashboard can:
   *   • filter the "Published" list to the active game,
   *   • refuse to "Update" a published collection from the wrong
   *     game's profile (which would silently rewrite the manifest's
   *     `gameId` and produce a malformed package).
   * Optional for legacy configs that pre-date this field; the
   * dashboard treats missing `gameId` as "any game" (it will surface
   * the entry but cannot guarantee compatibility).
   */
  gameId?: string;
};

export type LoadCollectionConfigInput = {
  /** Directory holding `<slug>.json` files. Created if missing. */
  configDir: string;
  /** Slugified collection name. */
  slug: string;
};

export type LoadCollectionConfigResult = {
  config: CollectionConfig;
  /** True iff the config file did not exist and was just created with a fresh UUID. */
  created: boolean;
  /** Absolute path to the JSON file. */
  configPath: string;
};

export type SaveCollectionConfigInput = {
  configDir: string;
  slug: string;
  config: CollectionConfig;
};

export type ReconcileInput = {
  config: CollectionConfig;
  /**
   * The set of currently-external mods in the snapshot. Anything in
   * this list missing from `config.externalMods` gets a stub entry
   * appended; entries in `config.externalMods` whose modId is NOT in
   * this list are kept untouched (the curator may have removed a mod
   * from the profile temporarily and we don't want to lose their
   * instructions).
   */
  externalMods: Array<{ id: string; name: string }>;
};

export type ReconcileResult = {
  config: CollectionConfig;
  /** True iff reconciliation made any change (added stubs or refreshed names). */
  changed: boolean;
  /** Mod IDs added as fresh stubs (informational, for diagnostics). */
  added: string[];
};

export class CollectionConfigError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(
      errors.length === 1
        ? errors[0]
        : `Collection config invalid (${errors.length} problems):\n  - ${errors.join(
            "\n  - ",
          )}`,
    );
    this.name = "CollectionConfigError";
    this.errors = errors;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getCollectionConfigPath(
  configDir: string,
  slug: string,
): string {
  return path.join(configDir, `${slug}.json`);
}

/**
 * Read the per-collection JSON file. If absent, create one with a
 * fresh UUID and write it to disk before returning.
 *
 * The file is parsed defensively. Anything malformed (bad JSON,
 * unexpected `schemaVersion`, missing `packageId`, etc.) throws a
 * {@link CollectionConfigError} listing every problem — we never
 * silently overwrite a broken file, because doing so would discard
 * the curator's previously-saved instructions and bundling choices.
 */
export async function loadOrCreateCollectionConfig(
  input: LoadCollectionConfigInput,
): Promise<LoadCollectionConfigResult> {
  validateSlug(input.slug);

  const configPath = getCollectionConfigPath(input.configDir, input.slug);
  const op = beginOp("collection-config.load", { slug: input.slug });

  let raw: string;
  try {
    raw = await fsp.readFile(configPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      const fresh = createDefaultConfig();
      await writeConfigFile(configPath, fresh);
      op.ok({ created: true, packageId: fresh.packageId });
      return { config: fresh, created: true, configPath };
    }
    op.fail(err, { code });
    throw err;
  }

  try {
    const config = parseAndValidate(raw, configPath);
    op.ok({
      created: false,
      externalMods: Object.keys(config.externalMods).length,
      externalDependencies: Object.keys(config.externalDependencies ?? {}).length,
    });
    return { config, created: false, configPath };
  } catch (err) {
    op.fail(err, {
      errors: err instanceof CollectionConfigError ? err.errors : undefined,
    });
    throw err;
  }
}

export async function saveCollectionConfig(
  input: SaveCollectionConfigInput,
): Promise<string> {
  validateSlug(input.slug);
  const configPath = getCollectionConfigPath(input.configDir, input.slug);
  const op = beginOp("collection-config.save", {
    slug: input.slug,
    externalMods: Object.keys(input.config.externalMods ?? {}).length,
  });
  try {
    await writeConfigFile(configPath, input.config);
    op.ok();
    return configPath;
  } catch (err) {
    op.fail(err);
    throw err;
  }
}

/**
 * Pure function. Adds stub entries for mods missing from
 * `config.externalMods` and refreshes the `name` hint on existing
 * entries. Does NOT remove stale entries — the curator may have
 * temporarily removed a mod from the profile and we want their
 * preserved instructions to survive that.
 */
export function reconcileExternalModsConfig(
  input: ReconcileInput,
): ReconcileResult {
  const next: Record<string, ExternalModConfigEntry> = {
    ...input.config.externalMods,
  };

  let changed = false;
  const added: string[] = [];

  for (const mod of input.externalMods) {
    const existing = next[mod.id];
    if (existing === undefined) {
      next[mod.id] = {
        name: mod.name,
        bundled: false,
        instructions: "",
      };
      changed = true;
      added.push(mod.id);
      continue;
    }

    if (existing.name !== mod.name) {
      next[mod.id] = { ...existing, name: mod.name };
      changed = true;
    }
  }

  ehLog(added.length > 0 ? "info" : "debug", "collection-config.reconcile", {
    externalMods: input.externalMods.length,
    added: added.length,
    changed,
  });

  return {
    config: changed ? { ...input.config, externalMods: next } : input.config,
    changed,
    added,
  };
}

/**
 * Strip {@link ExternalModConfigEntry.name} hints — they're for
 * hand-editors only and have no place in `BuildManifestInput`. Returns
 * the shape `buildManifest` expects.
 */
export function toBuildManifestExternalMods(
  config: CollectionConfig,
  /**
   * What Vortex already knows about where each mod came from, by Vortex mod
   * id. Optional — without it this behaves exactly as it did, which is what
   * keeps the callers that have no api handle working.
   */
  hints?: ReadonlyMap<string, ExternalHint>,
): Record<string, ExternalModBuildSpec> {
  const out: Record<string, ExternalModBuildSpec> = {};
  for (const [modId, entry] of Object.entries(config.externalMods)) {
    // The curator's own words win field by field; a hint only fills a gap.
    const merged = applyHint(
      {
        ...(entry.instructions !== undefined
          ? { instructions: entry.instructions }
          : {}),
        ...(entry.url !== undefined ? { url: entry.url } : {}),
        ...(entry.mode !== undefined ? { mode: entry.mode } : {}),
      },
      hints?.get(modId),
    );
    out[modId] = {
      instructions: merged.instructions,
      bundled: entry.bundled,
      ...(entry.treatAsExternal === true ? { treatAsExternal: true } : {}),
      ...(merged.url !== undefined ? { url: merged.url } : {}),
      ...(merged.mode !== undefined ? { mode: merged.mode } : {}),
    };
  }
  ehLog("debug", "collection-config.to-build-spec", {
    mods: Object.keys(out).length,
    bundled: Object.values(out).filter((m) => m.bundled === true).length,
  });
  return out;
}

export type ExternalModBuildSpec = {
  instructions?: string;
  bundled?: boolean;
  /** Ship a Nexus mod as external — its file is gone. */
  treatAsExternal?: boolean;
  url?: string;
  mode?: DownloadMode;
};

// ---------------------------------------------------------------------------
// Curator-side index ("My published collections")
// ---------------------------------------------------------------------------

/**
 * Compact summary of a published collection, derived from a config
 * file on disk. Powers the curator dashboard's "Published" tab.
 *
 * Treat fields like `lastBuiltVersion` as *advisory*: a curator may
 * have hand-edited their config or imported a config from another
 * machine before ever building locally. The dashboard shows what's
 * known and gracefully skips fields that are missing.
 */
export type PublishedCollectionSummary = {
  /** Filename slug (without `.json`). Acts as the on-disk identity. */
  slug: string;
  /** Stable UUIDv4 — release-lineage identity carried in manifests. */
  packageId: string;
  /** Last-built version (e.g. `"1.2.0"`), if the config records one. */
  lastBuiltVersion?: string;
  /** ISO timestamp of the last successful build, if recorded. */
  lastBuiltAt?: string;
  /** Last-built display name, if recorded. Falls back to `slug` in UI. */
  lastBuiltName?: string;
  /** Author of the last successful build, so an update can carry it forward. */
  lastBuiltAuthor?: string;
  /** Enabled-mod fingerprint at the last build; compare to spot a no-op update. */
  lastBuiltProfileFingerprint?: string;
  /**
   * Vortex `gameId` this collection was last built for, if recorded.
   * Drives the dashboard's per-game filter and the wizard's
   * "Update" gate (refuses cross-game updates).
   */
  gameId?: string;
  /** Absolute path to the config file. Useful for "Open in editor" actions. */
  configPath: string;
};

export type ListPublishedCollectionsOptions = {
  /**
   * If provided, called once per file that fails to parse so the UI
   * can surface "n collections couldn't be read" without losing
   * the rest of the list. Errors are otherwise silent.
   */
  onError?: (filename: string, err: unknown) => void;
};

/**
 * Enumerate the collections that have actually been BUILT at least once.
 *
 * ─── WHY THE lastBuiltAt FILTER ───────────────────────────────────────
 * A config file is NOT evidence of a published collection.
 * `loadOrCreateCollectionConfig` writes one the moment the curator opens the
 * Build page — it has to, so the form can carry a stable `packageId` and the
 * external-mod overrides before anything is built.
 *
 * This function used to report every `*.json` it found, so merely visiting the
 * Build page conjured a "1 published" collection the curator had never made.
 * The dashboard then rendered it as PUBLISHED with a footer reading "never
 * built" — a card contradicting itself — and offered an Update button for a
 * package that did not exist.
 *
 * `lastBuiltAt` is written only by `runBuildPipeline` after a build succeeds
 * (ui/pages/build/engine.ts), so its presence is the honest test for "this was
 * really published". Configs without it are skipped: they are scratch state for
 * a build that has not happened.
 * ──────────────────────────────────────────────────────────────────────
 *
 * Returns an empty array when:
 *   - the configDir doesn't exist (curator never built anything),
 *   - the directory is empty / contains no JSON files,
 *   - every config present belongs to a collection that was never built.
 *
 * Files with malformed JSON or invalid schema are skipped (and
 * surfaced via `onError` if provided). Unlike {@link
 * loadOrCreateCollectionConfig}, this function NEVER writes to disk —
 * the dashboard is read-only with respect to config files.
 *
 * Sorted by `lastBuiltAt` descending (most recently built first),
 * with never-built collections at the end in slug order.
 */
export async function listPublishedCollections(
  configDir: string,
  opts?: ListPublishedCollectionsOptions,
): Promise<PublishedCollectionSummary[]> {
  const op = beginOp("collection-config.list-published");
  let entries: string[];
  try {
    entries = await fsp.readdir(configDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      op.ok({ scanned: 0, published: 0 });
      return [];
    }
    // Surface real I/O errors via onError; the dashboard prefers a
    // partial result over a thrown promise it has to handle.
    opts?.onError?.(configDir, err);
    op.fail(err);
    return [];
  }
  const out: PublishedCollectionSummary[] = [];
  let skipped = 0;
  for (const filename of entries) {
    if (!filename.endsWith(".json")) continue;
    if (filename.startsWith(".")) continue;
    const slug = filename.slice(0, -".json".length);
    if (slug.length === 0) continue;
    const configPath = path.join(configDir, filename);
    let raw: string;
    try {
      raw = await fsp.readFile(configPath, "utf8");
    } catch (err) {
      ehLog("warn", "collection-config.list-published.unreadable", {
        file: filename,
      });
      opts?.onError?.(filename, err);
      skipped += 1;
      continue;
    }
    let config: CollectionConfig;
    try {
      config = parseAndValidate(raw, configPath);
    } catch (err) {
      ehLog("warn", "collection-config.list-published.invalid", {
        file: filename,
        errorCount:
          err instanceof CollectionConfigError ? err.errors.length : undefined,
      });
      opts?.onError?.(filename, err);
      skipped += 1;
      continue;
    }
    if (config.lastBuiltAt === undefined) {
      // Never built — scratch config from opening the Build page, not a
      // published collection. See the note above.
      continue;
    }
    out.push({
      slug,
      packageId: config.packageId,
      lastBuiltVersion: config.lastBuiltVersion,
      lastBuiltAt: config.lastBuiltAt,
      lastBuiltName: config.lastBuiltName,
      lastBuiltAuthor: config.lastBuiltAuthor,
      lastBuiltProfileFingerprint: config.lastBuiltProfileFingerprint,
      gameId: config.gameId,
      configPath,
    });
  }
  out.sort((a, b) => {
    // Most recently built first; never-built collections sort to the
    // end in slug order so the curator's freshest work surfaces on top.
    if (a.lastBuiltAt !== undefined && b.lastBuiltAt !== undefined) {
      return a.lastBuiltAt < b.lastBuiltAt ? 1 : a.lastBuiltAt > b.lastBuiltAt ? -1 : 0;
    }
    if (a.lastBuiltAt !== undefined) return -1;
    if (b.lastBuiltAt !== undefined) return 1;
    return a.slug.localeCompare(b.slug);
  });
  op.ok({ scanned: entries.length, published: out.length, skipped });
  return out;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function createDefaultConfig(): CollectionConfig {
  return {
    schemaVersion: COLLECTION_CONFIG_SCHEMA_VERSION,
    packageId: randomUUID(),
    externalMods: {},
  };
}

async function writeConfigFile(
  configPath: string,
  config: CollectionConfig,
): Promise<void> {
  const dir = path.dirname(configPath);
  await fsp.mkdir(dir, { recursive: true });
  // Pretty-print so curators can hand-edit comfortably.
  const json = JSON.stringify(config, null, 2);
  await fsp.writeFile(configPath, json, "utf8");
}

function validateSlug(slug: string): void {
  if (typeof slug !== "string" || slug.length === 0) {
    ehLog("warn", "collection-config.field.invalid", {
      field: "slug",
      reason: "empty",
    });
    throw new CollectionConfigError(["Slug cannot be empty."]);
  }
  // The slug becomes a filename component; refuse path traversal and
  // characters that confuse Windows. The action handler's `slugify`
  // already produces a clean string, but we belt-and-braces here so
  // direct callers (Phase 5 UI, tests) can't accidentally smuggle in
  // a `..\..\evil.json`.
  if (/[\\/:*?"<>|]/.test(slug) || slug.includes("..")) {
    ehLog("warn", "collection-config.field.invalid", {
      field: "slug",
      reason: "illegal-characters",
      value: slug,
    });
    throw new CollectionConfigError([
      `Slug "${slug}" contains characters that are not allowed in a config filename.`,
    ]);
  }
}

function parseAndValidate(raw: string, configPath: string): CollectionConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    ehLog("error", "collection-config.validate.invalid-json", {
      file: path.basename(configPath),
      err,
    });
    throw new CollectionConfigError([
      `Config file "${configPath}" is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    ]);
  }

  const errors: string[] = [];

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    ehLog("error", "collection-config.validate.not-object", {
      file: path.basename(configPath),
    });
    throw new CollectionConfigError([
      `Config file "${configPath}" must be a JSON object.`,
    ]);
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.schemaVersion !== COLLECTION_CONFIG_SCHEMA_VERSION) {
    errors.push(
      `Unsupported schemaVersion ${JSON.stringify(obj.schemaVersion)}. ` +
        `Expected ${COLLECTION_CONFIG_SCHEMA_VERSION}.`,
    );
  }

  if (typeof obj.packageId !== "string" || !isUuid(obj.packageId)) {
    errors.push(
      `packageId must be a UUIDv4 string. Got ${JSON.stringify(obj.packageId)}.`,
    );
  }

  let externalMods: Record<string, ExternalModConfigEntry> = {};
  if (obj.externalMods === undefined) {
    // Tolerate legacy/missing field.
  } else if (
    obj.externalMods === null ||
    typeof obj.externalMods !== "object" ||
    Array.isArray(obj.externalMods)
  ) {
    errors.push("externalMods, when present, must be a JSON object.");
  } else {
    externalMods = validateExternalMods(
      obj.externalMods as Record<string, unknown>,
      errors,
    );
  }

  let externalDependencies:
    | Record<string, ExternalDependencyConfigEntry>
    | undefined;
  if (obj.externalDependencies === undefined) {
    // Absent on every config written before prerequisites existed.
  } else if (
    obj.externalDependencies === null ||
    typeof obj.externalDependencies !== "object" ||
    Array.isArray(obj.externalDependencies)
  ) {
    errors.push("externalDependencies, when present, must be a JSON object.");
  } else {
    externalDependencies = validateExternalDependencyEntries(
      obj.externalDependencies as Record<string, unknown>,
      errors,
    );
  }

  if (obj.readme !== undefined && typeof obj.readme !== "string") {
    errors.push("readme, when present, must be a string.");
  }
  if (obj.changelog !== undefined && typeof obj.changelog !== "string") {
    errors.push("changelog, when present, must be a string.");
  }
  if (
    obj.lastBuiltVersion !== undefined &&
    typeof obj.lastBuiltVersion !== "string"
  ) {
    errors.push("lastBuiltVersion, when present, must be a string.");
  }
  if (obj.lastBuiltAt !== undefined && typeof obj.lastBuiltAt !== "string") {
    errors.push("lastBuiltAt, when present, must be a string.");
  }
  if (obj.lastBuiltAuthor !== undefined && typeof obj.lastBuiltAuthor !== "string") {
    errors.push("lastBuiltAuthor, when present, must be a string.");
  }
  if (
    obj.lastBuiltProfileFingerprint !== undefined &&
    typeof obj.lastBuiltProfileFingerprint !== "string"
  ) {
    errors.push("lastBuiltProfileFingerprint, when present, must be a string.");
  }
  if (obj.lastBuiltName !== undefined && typeof obj.lastBuiltName !== "string") {
    errors.push("lastBuiltName, when present, must be a string.");
  }
  if (obj.gameId !== undefined && typeof obj.gameId !== "string") {
    errors.push("gameId, when present, must be a string.");
  }

  if (errors.length > 0) {
    ehLog("warn", "collection-config.validate.rejected", {
      file: path.basename(configPath),
      errors,
    });
    throw new CollectionConfigError(errors);
  }

  const config: CollectionConfig = {
    schemaVersion: COLLECTION_CONFIG_SCHEMA_VERSION,
    packageId: obj.packageId as string,
    externalMods,
    ...(externalDependencies !== undefined ? { externalDependencies } : {}),
  };
  if (typeof obj.readme === "string") config.readme = obj.readme;
  if (typeof obj.changelog === "string") config.changelog = obj.changelog;
  if (typeof obj.lastBuiltVersion === "string") {
    config.lastBuiltVersion = obj.lastBuiltVersion;
  }
  if (typeof obj.lastBuiltAt === "string") {
    config.lastBuiltAt = obj.lastBuiltAt;
  }
  if (typeof obj.lastBuiltAuthor === "string") {
    config.lastBuiltAuthor = obj.lastBuiltAuthor;
  }
  if (typeof obj.lastBuiltProfileFingerprint === "string") {
    config.lastBuiltProfileFingerprint = obj.lastBuiltProfileFingerprint;
  }
  if (typeof obj.lastBuiltName === "string") {
    config.lastBuiltName = obj.lastBuiltName;
  }
  if (typeof obj.gameId === "string") {
    config.gameId = obj.gameId;
  }
  return config;
}

/**
 * Validate the curator's per-prerequisite decisions.
 *
 * Tolerant on purpose: this file is hand-editable and a malformed entry should
 * cost that entry, not the collection. Unknown keys are dropped silently — the
 * detected data (files, hashes) is never stored here, so there is nothing a
 * stale key could contradict.
 */
function validateExternalDependencyEntries(
  raw: Record<string, unknown>,
  errors: string[],
): Record<string, ExternalDependencyConfigEntry> {
  const out: Record<string, ExternalDependencyConfigEntry> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`externalDependencies["${id}"] must be an object.`);
      continue;
    }
    const entry = value as Record<string, unknown>;
    const sanitized: ExternalDependencyConfigEntry = {};

    if (entry.included !== undefined) {
      if (typeof entry.included !== "boolean") {
        errors.push(`externalDependencies["${id}"].included must be a boolean.`);
      } else {
        sanitized.included = entry.included;
      }
    }
    for (const key of ["instructions", "instructionsUrl", "version"] as const) {
      const v = entry[key];
      if (v === undefined) continue;
      if (typeof v !== "string") {
        errors.push(`externalDependencies["${id}"].${key} must be a string.`);
      } else {
        sanitized[key] = v;
      }
    }
    out[id] = sanitized;
  }
  return out;
}

/**
 * Per-field readers for an external-mod entry.
 *
 * ── Why a TABLE and not a run of if-blocks ──
 * This validator is a WHITELIST: it copies known fields onto a fresh object
 * and silently discards the rest. Whitelisting untrusted input is right — a
 * config can be hand-edited and a manifest arrives from a stranger, so copying
 * unknown keys through invites prototype pollution and unbounded junk. The
 * defect was never the whitelist. It was that NOTHING CONNECTED THE WHITELIST
 * TO THE TYPE: a field could be added to `ExternalModConfigEntry`, written
 * correctly, saved to disk, and still be discarded on the next read, with the
 * compiler perfectly happy and no test failing.
 *
 * That is what happened to `url` and `mode`, and the loss cascaded — a dropped
 * `mode` reset the Source control to Manual, which hides the link input, so the
 * curator could not even re-enter what had been eaten.
 *
 * The mapped type below is the fix. `Required<ExternalModConfigEntry>` forces
 * an entry for EVERY field, so adding one to the type without adding a reader
 * here is a compile error at this line rather than data loss on a user's
 * machine. It is the cheapest possible link, and it points the right way: the
 * type is the source of truth and the validator has to keep up.
 */
const EXTERNAL_MOD_FIELDS: {
  [K in keyof Required<ExternalModConfigEntry>]: (
    raw: unknown,
    path: string,
    errors: string[],
  ) => Required<ExternalModConfigEntry>[K] | undefined;
} = {
  name: (raw, path, errors) => expectStringField(raw, path, errors),
  instructions: (raw, path, errors) => expectStringField(raw, path, errors),
  // A sha256 of the diverged files an answer was given about. Read as a plain
  // string: an unrecognisable value simply fails to match the current
  // fingerprint, which reopens the question — the safe direction.
  postProcessingDecidedFor: (raw, path, errors) =>
    expectStringField(raw, path, errors),
  url: (raw, path, errors) => expectStringField(raw, path, errors),
  bundled: (raw, path, errors) => {
    if (typeof raw !== "boolean") {
      errors.push(`${path} must be a boolean.`);
      return undefined;
    }
    return raw;
  },
  mirrored: (raw, path, errors) => {
    if (typeof raw !== "boolean") {
      errors.push(`${path} must be a boolean.`);
      return undefined;
    }
    return raw;
  },
  treatAsExternal: (raw, path, errors) => {
    if (typeof raw !== "boolean") {
      errors.push(`${path} must be a boolean.`);
      return undefined;
    }
    return raw;
  },
  postProcessed: (raw, path, errors) => {
    if (typeof raw !== "boolean") {
      errors.push(`${path} must be a boolean.`);
      return undefined;
    }
    return raw;
  },
  dropped: (raw, path, errors) => {
    if (typeof raw !== "boolean") {
      errors.push(`${path} must be a boolean.`);
      return undefined;
    }
    return raw;
  },
  mode: (raw, path, errors) => {
    if (typeof raw !== "string") {
      // Not a string is corruption, and worth refusing.
      errors.push(`${path} must be a string.`);
      return undefined;
    }
    if (raw === "direct" || raw === "browse" || raw === "manual") return raw;
    // An unrecognised mode is DROPPED, not rejected.
    //
    // Refusing the file would make the whole config unloadable, and it carries
    // the packageId that ties every release together — losing it ends the
    // lineage, and a rebuild starts a new one installers will not recognise as
    // an update. Ending a collection's history over one unknown enum member is
    // out of proportion, and it is exactly what a future version writing a
    // fourth mode would hand to every older build.
    ehLog("warn", "collection-config.field.discarded", {
      field: path,
      value: raw,
    });
    return undefined;
  },
};

function expectStringField(
  raw: unknown,
  path: string,
  errors: string[],
): string | undefined {
  if (typeof raw !== "string") {
    errors.push(`${path} must be a string.`);
    return undefined;
  }
  return raw;
}

function validateExternalMods(
  raw: Record<string, unknown>,
  errors: string[],
): Record<string, ExternalModConfigEntry> {
  const out: Record<string, ExternalModConfigEntry> = {};
  for (const [modId, value] of Object.entries(raw)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`externalMods["${modId}"] must be an object.`);
      continue;
    }
    const entry = value as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};

    for (const [key, read] of Object.entries(EXTERNAL_MOD_FIELDS)) {
      const present = entry[key];
      if (present === undefined) continue;
      const parsed = (read as (r: unknown, p: string, e: string[]) => unknown)(
        present,
        `externalMods["${modId}"].${key}`,
        errors,
      );
      if (parsed !== undefined) sanitized[key] = parsed;
    }

    out[modId] = sanitized as ExternalModConfigEntry;
  }
  return out;
}

function isUuid(value: string): boolean {
  // Accept any RFC 4122 UUID, not just v4 — curators may legitimately
  // paste a v1/v5 they generated elsewhere. The exact version is not
  // load-bearing for our identity model.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

/**
 * Remove a published collection's config.
 *
 * This is the collection's IDENTITY, not its output: the config carries the
 * packageId that ties every release together, so deleting it ends the lineage —
 * a future build under the same name starts a new one, and installers will not
 * recognise it as an update of what came before. Built `.ehcoll` files are left
 * alone; they are the curator's artifacts and deleting them is a separate
 * decision. Callers must confirm before calling this.
 */
export async function deletePublishedCollection(configPath: string): Promise<void> {
  ehLog("info", "collection-config.delete-published", {
    file: path.basename(configPath),
  });
  await deleteCollectionConfig(configPath);
}

/** Remove a config file. The primitive behind every deletion here. */
export async function deleteCollectionConfig(configPath: string): Promise<void> {
  const op = beginOp("collection-config.delete", {
    file: path.basename(configPath),
  });
  try {
    await fsp.rm(configPath, { force: true });
    op.ok();
  } catch (err) {
    op.fail(err);
    throw err;
  }
}

/** A config that exists but has never produced a package. */
export type UnbuiltCollectionConfig = {
  slug: string;
  packageId: string;
  configPath: string;
};

/**
 * Configs that were never built — the complement of
 * {@link listPublishedCollections}.
 *
 * These are created the moment the Build page opens, because the form needs a
 * stable packageId and somewhere to keep external-mod overrides before
 * anything is built. Most become collections. The rest linger, invisible on
 * the dashboard, and they are not inert: a slug is an identity here, so
 * building under an abandoned config's name years later silently resurrects
 * ITS packageId and release lineage rather than starting fresh.
 *
 * Listing them is separate from deleting them on purpose. One of these is
 * usually the config of the draft the curator has open right now, holding
 * bundle ticks and instructions they have not shipped yet — so the caller has
 * to decide what is safe to remove, and this function will not guess.
 */
export async function listNeverBuiltConfigs(
  configDir: string,
  opts?: ListPublishedCollectionsOptions,
): Promise<UnbuiltCollectionConfig[]> {
  const op = beginOp("collection-config.list-never-built");
  let entries: string[];
  try {
    entries = await fsp.readdir(configDir);
  } catch (err) {
    /**
     * ─── A DIRECTORY NOBODY HAS WRITTEN TO IS NOT A FAILURE ─────────────
     * The config directory is created on the first save, so on a machine
     * that has only ever INSTALLED collections it never exists. That is the
     * normal state for every user who is not a curator, and it was logged
     * three times per session as `error` with a stack — in a file testers
     * are asked to send when something goes wrong. Noise at error level
     * teaches people to skip the errors.
     *
     * Anything else — a permission problem, a path that is a file — is a
     * real failure and still says so.
     */
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      op.ok({ scanned: 0, unbuilt: 0, skipped: 0, reason: "no-config-dir" });
      return [];
    }
    op.fail(err);
    return [];
  }
  const out: UnbuiltCollectionConfig[] = [];
  let skipped = 0;
  for (const filename of entries) {
    if (!filename.endsWith(".json") || filename.startsWith(".")) continue;
    const slug = filename.slice(0, -".json".length);
    if (slug.length === 0) continue;
    const configPath = path.join(configDir, filename);
    try {
      const config = parseAndValidate(await fsp.readFile(configPath, "utf8"), configPath);
      if (config.lastBuiltAt !== undefined) continue;
      out.push({ slug, packageId: config.packageId, configPath });
    } catch (err) {
      ehLog("warn", "collection-config.list-never-built.invalid", {
        file: filename,
        errorCount:
          err instanceof CollectionConfigError ? err.errors.length : undefined,
      });
      opts?.onError?.(filename, err);
      skipped += 1;
    }
  }
  const sorted = out.sort((a, b) => a.slug.localeCompare(b.slug));
  op.ok({ scanned: entries.length, unbuilt: sorted.length, skipped });
  return sorted;
}


/**
 * ──────────────────────────────────────────────────────────────────────
 * Mods whose post-processing question has been ANSWERED, and what about.
 *
 * All three answers count. Only `postProcessed` used to, which meant the two
 * other buttons wrote a config entry, said "saved", and asked the same
 * question again on the next build — the answer stuck everywhere except in
 * the one place that decides whether to ask.
 *
 * The value is the fingerprint the answer was given against, or `undefined`
 * for entries written before fingerprints existed. Those are honoured: asking
 * a curator to re-answer every past decision because we started recording
 * more is a worse trade than trusting an answer that was right when given.
 * ──────────────────────────────────────────────────────────────────────
 */
export type DecidedChoice = "mirror" | "declare" | "bundle" | "drop";

export type PostProcessingAnswer = {
  choice: DecidedChoice;
  /** The diverged files this was answered about. Absent on older entries. */
  fingerprint?: string;
};

/**
 * Which of the three answers an entry carries.
 *
 * The flags are not mutually exclusive in the config — the build form can set
 * `bundled` independently of anything decided here — so a precedence is
 * needed, and it follows what the BUILD actually does rather than which flag
 * was written last. Bundling ships the staging folder verbatim, which makes
 * both other flags moot; mirroring reconciles the files, which makes
 * `postProcessed` moot. So the strongest statement about the bytes wins, and
 * the verdict shown always matches the outcome.
 */
export function choiceFromEntry(
  entry: ExternalModConfigEntry | undefined,
): DecidedChoice | undefined {
  // First, because it is not a way of shipping the mod — it is the answer
  // that there is nothing worth shipping. Everything below describes HOW to
  // deliver a mod that is staying.
  if (entry?.dropped === true) return "drop";
  if (entry?.bundled === true) return "bundle";
  if (entry?.mirrored === true) return "mirror";
  if (entry?.postProcessed === true) return "declare";
  return undefined;
}

export function decidedPostProcessing(
  config: CollectionConfig,
): Map<string, PostProcessingAnswer> {
  const out = new Map<string, PostProcessingAnswer>();
  for (const [modId, entry] of Object.entries(config.externalMods ?? {})) {
    const choice = choiceFromEntry(entry);
    if (choice === undefined) continue;
    out.set(modId, {
      choice,
      ...(entry?.postProcessingDecidedFor !== undefined
        ? { fingerprint: entry.postProcessingDecidedFor }
        : {}),
    });
  }
  return out;
}

/**
 * Mods that STOPPED being bundled while the build was paused.
 *
 * Only reachable now that a curator can change a verdict mid-build. The mod
 * was repacked on the first pass; leaving that bundle in the package would
 * ship an archive for a mod that is no longer supposed to have one.
 */
export function modsNoLongerBundled(
  before: CollectionConfig,
  after: CollectionConfig,
): string[] {
  const was = before.externalMods ?? {};
  const now = after.externalMods ?? {};
  const result = Object.keys(was)
    .filter((id) => was[id]?.bundled === true && now[id]?.bundled !== true)
    .sort();
  if (result.length > 0) {
    ehLog("info", "collection-config.mods-unbundled", { modIds: result });
  }
  return result;
}


/**
 * ──────────────────────────────────────────────────────────────────────
 * Mods that became `bundled` while the build was paused for a decision.
 *
 * The build's order is load-bearing and cannot simply be rearranged:
 * bundling repacks a staging folder into an archive, and the self-check that
 * FINDS diverged files must run after that, because a bundled mod's archive
 * IS its staging and comparing the two is meaningless.
 *
 * So the question is asked after bundling has already happened, and "ship my
 * copy" — now the right answer for LOD output — arrives too late for its own
 * repack. This names the mods that need a second pass, so the answer takes
 * effect in the build the curator is standing in rather than the next one.
 *
 * Only ADDITIONS count. A mod that was already bundled was packed on the
 * first pass, and un-bundling mid-build is not something the screen offers.
 * ──────────────────────────────────────────────────────────────────────
 */
export function modsNewlyBundled(
  before: CollectionConfig,
  after: CollectionConfig,
): string[] {
  const was = before.externalMods ?? {};
  const now = after.externalMods ?? {};
  const result = Object.keys(now)
    .filter((id) => now[id]?.bundled === true && was[id]?.bundled !== true)
    .sort();
  if (result.length > 0) {
    ehLog("info", "collection-config.mods-newly-bundled", { modIds: result });
  }
  return result;
}
