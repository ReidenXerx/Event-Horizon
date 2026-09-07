/**
 * Toolbar action: "Build Collection Package" (Phase 2 slice 4a + 4b).
 *
 * Wires the existing snapshot pipeline (state read → mods enrichment →
 * deployment manifests → load order → plugins.txt) into the new packager
 * (`buildManifest` → `packageEhcoll`) and produces one `.ehcoll` file
 * inside `%APPDATA%\Vortex\event-horizon\collections\`.
 *
 * Spec: docs/business/BUILD_PACKAGE.md
 *
 * ─── TRANSITIONAL UI WARNING ──────────────────────────────────────────
 * Everything in this file that touches `showDialog`, `sendNotification`,
 * or "the toolbar button" is scaffolding. Phase 5 introduces a dedicated
 * Event Horizon `mainPage` (custom React UI) that replaces this entire
 * dialog flow. The *business logic* (the call sequence below — state
 * read, pipeline run, buildManifest, packageEhcoll) is permanent.
 *
 * Design rule when extending this file: any new piece of curator input
 * must be a JSON-serializable record on the `BuildManifestInput` /
 * config-file side. Phase 5's React forms produce exactly that shape
 * and feed the same functions, so the core stays UI-agnostic.
 * See docs/PROPOSAL_INSTALLER.md §10 "Transitional UI vs Phase 5 UI".
 * ──────────────────────────────────────────────────────────────────────
 *
 * Slice 4a (done): one dialog asks for name/version/author/description.
 *
 * Slice 4b (this file's current shape):
 *   - Per-collection state file at
 *     `<appData>\Vortex\event-horizon\collections\.config\<slug>.json`
 *     persists package.id (UUIDv4, stable across rebuilds), per-mod
 *     overrides (`bundled`, `instructions`, `name` hint), and optional
 *     README / CHANGELOG markdown bodies.
 *   - Action loads-or-creates the file every build. Renaming the
 *     collection produces a new slug ⇒ new file ⇒ new release lineage.
 *   - Reconciliation auto-populates stub entries for any external mod
 *     present in the current snapshot but missing from the config, so
 *     the curator sees a fully-populated file the next time they
 *     hand-edit it.
 *   - For each external mod the curator flags `bundled: true`, the
 *     action resolves the source archive on disk via
 *     `resolveModArchivePath` — which also finds an archive that was
 *     re-downloaded after its own record died — and feeds it to
 *     `packageEhcoll` as a `BundledArchiveSpec`.
 *
 * Phase 5 (future React page) replaces:
 *   - The curator metadata `showDialog` → form on the build panel.
 *   - "Hand-edit the JSON file" → a per-mod table with checkboxes /
 *     textareas writing the same JSON shape via `saveCollectionConfig`.
 *   - README / CHANGELOG markdown → rich editors writing the same fields.
 */

import { isNexusSourced } from "../core/identity/nexusSourced";
import { mayBundle } from "../core/manifest/shipsAsExternal";
import * as fsp from "fs/promises";
import * as path from "path";
import { util } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";

import {
  enrichModsWithArchiveHashes,
  resolveModArchivePath,
} from "../core/archiveHashing";
import { captureDeploymentManifests } from "../core/deploymentManifest";
import type { AuditorMod } from "../core/getModsListForProfile";
import {
  getActiveGameId,
  getActiveProfileIdFromState,
  getModsForProfile,
} from "../core/getModsListForProfile";
import { captureLoadOrder } from "../core/loadOrder";
import { captureUserlist } from "../core/userlist";
import {
  discoveredStore,
  getCurrentPluginsTxtPath,
} from "../core/comparePlugins";
import {
  buildManifest,
  BuildManifestError,
} from "../core/manifest/buildManifest";
import { captureStagingFiles } from "../core/manifest/captureStagingFiles";
import {
  packageEhcoll,
  PackageEhcollError,
  type BundledArchiveSpec,
} from "../core/manifest/packageZip";
import {
  buildOutputFileName,
  slugifyPackageName,
} from "../core/manifest/packageFileName";
import {
  CollectionConfigError,
  loadOrCreateCollectionConfig,
  reconcileExternalModsConfig,
  saveCollectionConfig,
  toBuildManifestExternalMods,
  type CollectionConfig,
} from "../core/manifest/collectionConfig";
import type {
  SupportedGameId,
  VortexDeploymentMethod,
} from "../types/ehcoll";
import { openFile, openFolder } from "../utils/utils";
import { getCollectionsDir, getVortexUserDataPath } from "../core/paths";
import { beginOp, ehLog } from "../core/logging/ehLog";

const SUPPORTED_GAME_IDS: ReadonlySet<string> = new Set<SupportedGameId>([
  "skyrimse",
  "fallout3",
  "falloutnv",
  "fallout4",
  "starfield",
]);

type CuratorInput = {
  name: string;
  version: string;
  author: string;
  description: string;
};

export default function createBuildPackageAction(
  context: types.IExtensionContext,
): () => Promise<void> {
  return async () => {
    const hashingNotificationId = "vortex-event-horizon:hashing";
    let hashingNotificationShown = false;
    const op = beginOp("build");

    try {
      const state = context.api.getState();

      const gameId = getActiveGameId(state);
      if (!gameId) throw new Error("No active game found");

      if (!SUPPORTED_GAME_IDS.has(gameId)) {
        throw new Error(
          `Game "${gameId}" is not supported by Event Horizon. Supported: ${Array.from(
            SUPPORTED_GAME_IDS,
          ).join(", ")}.`,
        );
      }

      const profileId = getActiveProfileIdFromState(state, gameId);
      if (!profileId) throw new Error(`No profile found for game ${gameId}`);

      const curator = await promptCuratorMetadata(context.api);
      if (curator === undefined) {
        // Curator hit Cancel. Silent to the UI, NOT to the log: an op that
        // ends without ok/fail leaves a `build.start` with no end, and from
        // the log alone that is indistinguishable from a build that hung on
        // the metadata prompt. Say which one it was.
        ehLog("info", "build.cancelled", { where: "curator-metadata-prompt" });
        op.ok({ outcome: "cancelled", where: "curator-metadata-prompt" });
        return;
      }

      const rawMods = getModsForProfile(state, gameId, profileId);

      context.api.sendNotification?.({
        id: hashingNotificationId,
        type: "activity",
        message: `Hashing ${rawMods.length} mod archives...`,
      });
      hashingNotificationShown = true;

      let mods = await enrichModsWithArchiveHashes(
        state,
        gameId,
        rawMods,
        { concurrency: 4 },
      );

      context.api.dismissNotification?.(hashingNotificationId);
      hashingNotificationShown = false;

      // "thorough" — per-file sha256, not just names and sizes.
      //
      // This used to be "fast", which records a file list with sizes and reads
      // nothing. Under it a file with the right name and the right size but
      // DIFFERENT BYTES verifies as correct, which is the shape of failure
      // that looks like success. For a format whose promise is reproducing a
      // curator's exact state, that is the wrong default at any price.
      //
      // It also cascades: without per-file hashes there is no stagingSetHash,
      // and for an external mod whose archive Vortex did not retain that is
      // the ONLY identity oracle — buildManifest hard-blocks such a mod
      // outright and tells the curator to rebuild thorough. Defaulting to it
      // removes a wall curators were being walked into.
      //
      // The cost is the curator's, once per build, and it is CPU.
      mods = await captureStagingFiles(state, gameId, mods, {
        level: "thorough",
        onWarn: (mod, message) => {
          // A capture warning means THIS mod's staging inspection degraded, so
          // the package it lands in verifies that mod more weakly than the rest.
          // The curator has no other way to learn that, and devtools output is
          // gone by the time anyone asks — so it goes in the file.
          ehLog("warn", "build.capture.warn", {
            mod: mod.name,
            message,
            consequence:
              "this mod ships with a weaker staging record than the others",
          });
        },
      });

      const deploymentManifests = await captureDeploymentManifests(
        context.api,
        state,
        gameId,
      );

      // Keyed by PROFILE — see captureLoadOrder's note.
      const loadOrder = captureLoadOrder(state, profileId);

      const userlist = captureUserlist(state);

      // Store-aware: see readPluginsTxtIfPresent.
      const pluginsTxtContent = await readPluginsTxtIfPresent(
        gameId,
        discoveredStore(state, gameId),
      );

      // ── Slice 4b: load/create per-collection state file ────────────────
      // Lives at <appData>\Vortex\event-horizon\collections\.config\<slug>.json
      // and persists package.id, per-mod overrides, README, CHANGELOG.
      // First build of a slug = fresh UUID + empty externalMods. Subsequent
      // builds reuse the same id, preserving release lineage.
      const slug = slugifyPackageName(curator.name);
      const appDataPath = getVortexUserDataPath();
      const outputDir = getCollectionsDir();
      const configDir = path.join(outputDir, ".config");

      const loaded = await loadOrCreateCollectionConfig({ configDir, slug });
      let collectionConfig = loaded.config;

      // Auto-populate stub entries for any external mods present in the
      // current snapshot but missing from the config. Curators see a
      // pre-filled file the next time they hand-edit it.
      const externalAuditorMods = collectExternalMods(mods);
      const reconciled = reconcileExternalModsConfig({
        config: collectionConfig,
        externalMods: externalAuditorMods,
      });
      if (reconciled.changed) {
        collectionConfig = reconciled.config;
        await saveCollectionConfig({
          configDir,
          slug,
          config: collectionConfig,
        });
      }

      const snapshot = {
        exportedAt: new Date().toISOString(),
        gameId,
        profileId,
        count: mods.length,
        mods,
        deploymentManifests,
        loadOrder,
        userlist,
      };

      const { manifest, warnings } = buildManifest({
        snapshot,
        package: {
          id: collectionConfig.packageId,
          name: curator.name,
          version: curator.version,
          author: curator.author,
          description:
            curator.description.length > 0 ? curator.description : undefined,
          strictMissingMods: false,
          // Must match the capture level above. Recording a level the capture
          // did not actually perform would make the manifest lie about its own
          // evidence, and every consumer downstream trusts this field to know
          // what it is allowed to check.
          verificationLevel: "thorough",
        },
        game: {
          version: resolveGameVersion(state, gameId),
        },
        vortex: {
          version: resolveVortexVersion(state),
          deploymentMethod: resolveDeploymentMethod(state, gameId),
        },
        pluginsTxtContent,
        externalMods: toBuildManifestExternalMods(collectionConfig),
        /**
         * ─── STILL EMPTY, BUT NO LONGER SILENTLY ────────────────────────
         * Detection lives in the build page's pipeline, above the manifest
         * layer, so this second entry point never gets it. The resulting
         * `.ehcoll` declares zero prerequisites while also declaring
         * `verificationLevel: "thorough"`, and is byte-indistinguishable from
         * a good package — every user of one is silently never told about
         * SKSE or Engine Fixes.
         *
         * Wiring detection in here is the real fix and belongs with the
         * detection move; until then this at least stops the omission being
         * invisible, which is the property that let it survive.
         */
        externalDependencies: [],
      });

      ehLog("warn", "legacy-build.no-external-deps", {
        gameId,
        why:
          "The legacy dialog does not run prerequisite detection, so this " +
          "package declares none. Build from the Event Horizon page if the " +
          "collection needs SKSE, ENB or an engine injector.",
      });
      context.api.sendNotification?.({
        type: "warning",
        title: "Built without prerequisites",
        message:
          "This dialog does not detect script extenders or engine injectors. " +
          "The package declares none — build from the Event Horizon page if " +
          "this collection needs them.",
      });

      const outputFileName = buildOutputFileName(curator.name, curator.version);
      const outputPath = path.join(outputDir, outputFileName);

      // Resolve source paths for any externals the curator flagged as
      // bundled. Mismatches (mod not in snapshot, missing archive,
      // missing hash) are accumulated as fatal errors and reported as
      // one error notification — the curator gets the full list.
      const { bundledArchives, errors: bundleErrors } =
        resolveBundledArchives(state, gameId, collectionConfig, mods);
      if (bundleErrors.length > 0) {
        throw new BundleResolutionError(bundleErrors);
      }

      const result = await packageEhcoll({
        manifest,
        bundledArchives,
        readme:
          collectionConfig.readme && collectionConfig.readme.length > 0
            ? collectionConfig.readme
            : undefined,
        changelog:
          collectionConfig.changelog && collectionConfig.changelog.length > 0
            ? collectionConfig.changelog
            : undefined,
        outputPath,
      });

      op.ok({
        name: curator.name,
        version: curator.version,
        mods: manifest.mods.length,
        rules: manifest.rules.length,
          plugins: manifest.plugins.order.length,
        loadOrder: manifest.loadOrder.length,
        userlistPlugins: manifest.userlist.plugins.length,
        userlistGroups: manifest.userlist.groups.length,
        bundled: result.bundledCount,
        bytes: result.outputBytes,
        outputPath,
      });

      // The one line that says what shipped. Structured rather than a formatted
      // string, because the question asked of it later is always "how many X"
      // for some X, and a grep for a number inside prose is not an answer.
      ehLog("info", "build.package.built", {
        collection: curator.name,
        version: curator.version,
        mods: manifest.mods.length,
        rules: manifest.rules.length,
        plugins: manifest.plugins.order.length,
        loadOrder: manifest.loadOrder.length,
        userlistPlugins: manifest.userlist.plugins.length,
        userlistGroups: manifest.userlist.groups.length,
        bundled: result.bundledCount,
        bytes: result.outputBytes,
        warnings: warnings.length + result.warnings.length,
        configPath: loaded.configPath,
        configCreated: loaded.created,
      });

      for (const warning of [...warnings, ...result.warnings]) {
        // Every warning here is a way the package is less than it claims. The
        // notification shows a COUNT; only the log shows which ones.
        ehLog("warn", "build.package.warning", { warning });
      }

      const bundledLabel =
        result.bundledCount > 0
          ? `, ${result.bundledCount} bundled`
          : "";
      context.api.sendNotification?.({
        type: "success",
        message:
          `Built ${curator.name} v${curator.version} ` +
          `(${manifest.mods.length} mods${bundledLabel}, ${formatBytes(
            result.outputBytes,
          )})`,
        actions: [
          {
            title: "Open Package",
            action: () => openFile(outputPath),
          },
          {
            title: "Open Folder",
            action: () => openFolder(outputDir),
          },
          {
            title: "Open Config",
            action: () => openFile(loaded.configPath),
          },
        ],
      });
    } catch (error) {
      const message = formatError(error);

      context.api.sendNotification?.({
        type: "error",
        message: `Build failed: ${message}`,
      });

      op.fail(error);
      console.error("[Vortex Event Horizon] Build failed:", error);
    } finally {
      if (hashingNotificationShown) {
        context.api.dismissNotification?.(hashingNotificationId);
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Curator metadata dialog
// ---------------------------------------------------------------------------

async function promptCuratorMetadata(
  api: types.IExtensionApi,
): Promise<CuratorInput | undefined> {
  // Vortex's IDialogResult.input is `any` in the typings; in practice
  // it's a record keyed by IInput.id.
  type DialogInputRecord = Record<string, string | undefined>;

  // Collect everything in one shot. The dialog renders one input per
  // entry; the curator hits Build, we validate. Validation failures
  // re-prompt with the previous values pre-filled so the curator
  // doesn't lose typing.
  let preset: CuratorInput = {
    name: "",
    version: "1.0.0",
    author: "",
    description: "",
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await api.showDialog?.(
      "question",
      "Build Event Horizon Collection",
      {
        text:
          "Fill in the metadata that ships in the .ehcoll manifest. " +
          "Per-mod settings (bundling external archives, instructions) " +
          "and README/CHANGELOG inputs come in a later release; for now, " +
          "external mods will default to instructions-only.",
        input: [
          {
            id: "name",
            type: "text",
            label: "Collection name",
            value: preset.name,
            placeholder: "My Awesome Skyrim Build",
          },
          {
            id: "version",
            type: "text",
            label: "Version (semver)",
            value: preset.version,
            placeholder: "1.0.0",
          },
          {
            id: "author",
            type: "text",
            label: "Author",
            value: preset.author,
            placeholder: "Your Nexus username",
          },
          {
            id: "description",
            type: "multiline",
            label: "Description (optional)",
            value: preset.description,
            placeholder: "What this collection ships, who it's for, ...",
          },
        ],
      },
      [
        { label: "Cancel" },
        { label: "Build", default: true },
      ],
    );

    if (!result || result.action !== "Build") {
      return undefined;
    }

    const inputs = (result.input ?? {}) as DialogInputRecord;
    const candidate: CuratorInput = {
      name: (inputs.name ?? "").trim(),
      version: (inputs.version ?? "").trim(),
      author: (inputs.author ?? "").trim(),
      description: (inputs.description ?? "").trim(),
    };

    const validationError = validateCuratorInput(candidate);
    if (validationError === undefined) {
      return candidate;
    }

    preset = candidate;

    await api.showDialog?.(
      "error",
      "Invalid input",
      { text: validationError },
      [{ label: "Back", default: true }],
    );
  }
}

function validateCuratorInput(input: CuratorInput): string | undefined {
  if (input.name.length === 0) return "Collection name cannot be empty.";
  if (input.author.length === 0) return "Author cannot be empty.";

  // Lightweight semver check — three numeric segments separated by dots,
  // optionally followed by `-prerelease`. Strict semver validation lives
  // in the manifest consumer; we just want to catch obvious typos here.
  if (!/^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/.test(input.version)) {
    return `Version "${input.version}" doesn't look like semver. Try e.g. "1.0.0" or "0.2.1-beta.1".`;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

function resolveVortexVersion(state: types.IState): string {
  const app = (state as unknown as { app?: { appVersion?: string; version?: string } }).app;
  return app?.appVersion ?? app?.version ?? "unknown";
}

/**
 * Best-effort game version. Vortex doesn't always populate this — the
 * value lives under different state keys depending on how the game was
 * discovered. Slice 4b will plumb a real per-game version resolver;
 * for now "unknown" is a valid (per-schema) fallback string.
 */
function resolveGameVersion(state: types.IState, gameId: string): string {
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

  return "unknown";
}

/**
 * Look up the per-game deployment method from settings. Defaults to
 * `"hardlink"` — it's the Vortex default on supported games and the
 * value is informational (the user-side installer respects whatever
 * the user has configured locally).
 */
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
      // Closest match in our enum — `move` is a deploy strategy that
      // physically moves files into the game dir. The schema only
      // distinguishes hardlink/symlink/copy; "copy" is the safest read.
      return "copy";
    default:
      return "hardlink";
  }
}

// ---------------------------------------------------------------------------
// plugins.txt
// ---------------------------------------------------------------------------

async function readPluginsTxtIfPresent(
  gameId: string,
  store?: string,
): Promise<string | undefined> {
  let pluginsPath: string;
  try {
    pluginsPath = getCurrentPluginsTxtPath(gameId, store);
  } catch {
    // Game doesn't have a plugins.txt path mapping (e.g. starfield handled
    // via LoadOrder API). buildManifest will emit plugins.order: [].
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

// ---------------------------------------------------------------------------
// Output filename
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// External-mod bundling (slice 4b)
// ---------------------------------------------------------------------------

class BundleResolutionError extends Error {
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

/**
 * Filter the snapshot's mods down to those buildManifest will treat
 * as external — i.e. mods without `nexusModId` + `nexusFileId`. Used
 * to reconcile the per-collection config file with what's actually
 * in the active profile right now.
 */
function collectExternalMods(
  mods: AuditorMod[],
): Array<{ id: string; name: string }> {
  return mods
    .filter((mod) => !isNexusMod(mod))
    .map((mod) => ({ id: mod.id, name: mod.name }));
}

/**
 * Was a private, byte-identical copy of the predicate in
 * `core/identity/nexusSourced.ts`. Two bundling gates decided "is this from
 * Nexus" from two separate function bodies that nothing kept in step.
 */
const isNexusMod = isNexusSourced;

/**
 * Walk the curator's per-mod overrides; for each entry flagged
 * `bundled: true`, resolve the source archive on disk so 7z can pick
 * it up. Per-mod failures are accumulated rather than throwing
 * eagerly — curators get one report covering every problem.
 */
function resolveBundledArchives(
  state: types.IState,
  gameId: string,
  config: CollectionConfig,
  mods: AuditorMod[],
): { bundledArchives: BundledArchiveSpec[]; errors: string[] } {
  const errors: string[] = [];
  const bundledArchives: BundledArchiveSpec[] = [];
  const modById = new Map(mods.map((m) => [m.id, m]));

  for (const [modId, entry] of Object.entries(config.externalMods)) {
    if (entry.bundled !== true) continue;

    const mod = modById.get(modId);
    if (mod === undefined) {
      errors.push(
        `Config flags modId "${modId}" as bundled, but no such mod is in the active profile right now. ` +
          `Either install the mod, remove the entry from the config, or set bundled=false.`,
      );
      continue;
    }

    // See engine.resolveBundledArchives — the same rule, and it must stay the
    // same rule. This copy is why marking a mod external fixed the manifest
    // and not the build.
    if (!mayBundle(isNexusMod(mod), entry)) {
      errors.push(
        `Config flags Nexus mod "${mod.name}" (id="${modId}") as bundled, ` +
          `but it is not marked as an external dependency. Nexus mods are ` +
          `downloaded with the user's own API key, so bundling one only ` +
          `makes sense once its file is gone from Nexus.`,
      );
      continue;
    }

    if (
      typeof mod.archiveSha256 !== "string" ||
      mod.archiveSha256.length === 0
    ) {
      errors.push(
        `External mod "${mod.name}" (id="${modId}") is flagged for bundling but has no archiveSha256. ` +
          `Re-export the snapshot or check the archive is on disk; the export pipeline should have hashed it.`,
      );
      continue;
    }

    const sourcePath = resolveModArchivePath(state, mod, gameId);
    if (sourcePath === undefined) {
      errors.push(
        `External mod "${mod.name}" (id="${modId}") is flagged for bundling but its source archive ` +
          `cannot be located on disk (archiveId="${mod.archiveId ?? "<unset>"}"). ` +
          `The archive may have been deleted from the Vortex downloads folder.`,
      );
      continue;
    }

    bundledArchives.push({
      sourcePath,
      sha256: mod.archiveSha256,
    });
  }

  return { bundledArchives, errors };
}

function formatError(err: unknown): string {
  if (err instanceof BuildManifestError) {
    return `Manifest build failed (${err.errors.length} problem${
      err.errors.length === 1 ? "" : "s"
    }):\n${err.errors.map((e) => `  - ${e}`).join("\n")}`;
  }
  if (err instanceof PackageEhcollError) {
    return `Package build failed (${err.errors.length} problem${
      err.errors.length === 1 ? "" : "s"
    }):\n${err.errors.map((e) => `  - ${e}`).join("\n")}`;
  }
  if (err instanceof BundleResolutionError) {
    return `Bundled-archive resolution failed (${err.errors.length} problem${
      err.errors.length === 1 ? "" : "s"
    }):\n${err.errors.map((e) => `  - ${e}`).join("\n")}`;
  }
  if (err instanceof CollectionConfigError) {
    return `Collection config invalid (${err.errors.length} problem${
      err.errors.length === 1 ? "" : "s"
    }):\n${err.errors.map((e) => `  - ${e}`).join("\n")}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
