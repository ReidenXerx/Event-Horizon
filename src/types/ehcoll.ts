/**
 * Event Horizon collection package — `.ehcoll` manifest types (schema v1).
 *
 * The `.ehcoll` package is a ZIP file with a `manifest.json` at its root that
 * conforms to {@link EhcollManifest} below. The packager (Phase 2) writes it,
 * the resolver/installer (Phases 3–4) reads it.
 *
 * Specs:
 *  - business behavior:  docs/business/MANIFEST_SCHEMA.md
 *  - design rationale:   docs/PROPOSAL_INSTALLER.md (§5–§6)
 *  - identity rule:      docs/PROPOSAL_INSTALLER.md §5.5 (LOAD-BEARING)
 *
 * INVARIANTS (enforced by the packager, expected by the installer):
 *  - This file is type-only. No runtime code, no enums-with-values, no consts.
 *    Adding runtime code here changes the dependency graph; keep it inert.
 *  - All SHA-256 strings are lowercase hex, exactly 64 characters.
 *  - All timestamps are ISO-8601 UTC strings (`...Z`) unless explicitly noted.
 *  - All `compareKey` strings follow the format documented in
 *    docs/business/AUDITOR_MOD.md ("Mod identity / compareKey").
 *  - Every array field is required and non-undefined. Empty arrays are valid;
 *    missing fields are not. (Optional sub-fields use `?` explicitly.)
 *  - Schema is additive: future v1.x revisions add fields, never rename or
 *    remove. A breaking change bumps {@link SchemaVersion}.
 */

import type {
  FomodSelectionStep,
} from "../core/getModsListForProfile";

/**
 * Manifest schema version. Bumped only on breaking changes — additive
 * field changes leave this at 1. The installer refuses unknown versions.
 */
export type SchemaVersion = 1;

/**
 * Top-level shape of `manifest.json` inside an `.ehcoll` package.
 */
export type EhcollManifest = {
  schemaVersion: SchemaVersion;
  package: PackageMetadata;
  game: GameMetadata;
  vortex: VortexMetadata;
  mods: EhcollMod[];
  rules: EhcollRule[];
  plugins: EhcollPlugins;
  /**
   * Curator's per-game LoadOrder snapshot — Vortex's
   * `state.persistent.loadOrder[gameId]` projection. Distinct from
   * {@link EhcollPlugins.order}: plugins.txt covers ESPs/ESMs/ESLs only,
   * this covers every Vortex-managed mod (including script extenders,
   * ENB binaries, and other non-plugin payloads) for games that use
   * Vortex's LoadOrder API. Empty array for games that drive load
   * order purely via plugins.txt.
   *
   * Required field — older v1 manifests written before slice 6c
   * landed will not have it; the parser back-fills with `[]` so the
   * type stays clean. `compareKey` references resolve to user-side
   * Vortex modIds at install time (mirrors `EhcollRule.source`).
   */
  loadOrder: EhcollLoadOrderEntry[];
  /**
   * Curator's LOOT userlist snapshot — `state.userlist` projection
   * scoped to plugins shipped by this collection. Drives plugin-to-
   * plugin load order via Vortex's `extension-plugin-management` +
   * LOOT auto-sort. Distinct from {@link EhcollPlugins.order} (a flat
   * `plugins.txt` snapshot) and from {@link loadOrder} (Vortex's
   * generic per-game LoadOrder for non-plugin payloads).
   *
   * Required field — older v1 manifests written before slice 6d
   * landed will not have it; the parser back-fills with an empty
   * userlist so the type stays clean. Empty for games without LOOT
   * support (pure LoadOrder-API games like Starfield).
   */
  userlist: EhcollUserlist;
  iniTweaks: EhcollIniTweak[];
  /**
   * The curator's GAME settings — `Fallout4.ini` and friends — carrying only
   * the keys that belong to the collection.
   *
   * Distinct from {@link iniTweaks}, which is Vortex's per-mod `INI Tweaks`
   * mechanism. This is the game's own configuration: `uGridsToLoad`, archive
   * invalidation, the Papyrus block, LOD distances — settings that change how
   * the game loads and that a curator tunes deliberately.
   *
   * Machine-owned keys (screen resolution, CPU threads, RAM, GPU model, audio
   * device, FOV) are excluded when the package is BUILT, so they are not in
   * here to be applied by accident. See `core/manifest/gameIni.ts`.
   *
   * Optional: manifests built before this existed have none, and the parser
   * back-fills an empty capture.
   */
  gameIni?: EhcollGameIni;
  externalDependencies: EhcollExternalDependency[];
};

// ---------------------------------------------------------------------------
// Package metadata
// ---------------------------------------------------------------------------

export type PackageMetadata = {
  /**
   * UUIDv4 string. Stable across re-exports of the *same* collection so a
   * user's "is this the same collection I installed before?" check works.
   * The version field, not this id, distinguishes releases.
   */
  id: string;
  name: string;
  /** Semver string. Used by the user-side store / cache logic. */
  version: string;
  author: string;
  /** ISO-8601 UTC. */
  createdAt: string;
  description?: string;
  /**
   * Policy for unresolvable mods at install time:
   *  - `true`  → abort install with a full report.
   *  - `false` → skip + warn, surface in the post-install drift report.
   */
  strictMissingMods: boolean;
  /**
   * How thoroughly the curator captured per-mod file integrity data at
   * build time. Drives what the user-side {@link verifyModInstall} check
   * can do post-install:
   *  - `"none"`     → no `stagingFiles` captured. Verification is skipped
   *                   for backward compat with manifests built before this
   *                   field existed.
   *  - `"fast"`     → `stagingFiles` populated with `{ path, size }` only.
   *                   Catches Vortex's "lost file" bug + truncations.
   *  - `"thorough"` → `stagingFiles` populated with `{ path, size, sha256 }`.
   *                   Additionally catches silent corruption (file present
   *                   with right size but wrong bytes).
   *
   * Optional for backward compatibility: parsers treat absence as
   * `"none"`. New manifests always set this explicitly.
   */
  verificationLevel?: VerificationLevel;
};

export type VerificationLevel = "none" | "fast" | "thorough";

// ---------------------------------------------------------------------------
// Game / Vortex environment metadata
// ---------------------------------------------------------------------------

export type GameMetadata = {
  /** Vortex `gameId`. Restricted at the packager to the supported set. */
  id: SupportedGameId;
  /** Exact game version string the curator built on. */
  version: string;
  versionPolicy: GameVersionPolicy;
  /**
   * Which store's copy of the game the curator built on — `steam`, `gog`, …
   *
   * A compatibility axis the VERSION cannot express. GOG and Steam ship
   * Skyrim Special Edition at identical version numbers and different
   * executables, and an SKSE plugin DLL is compiled against one runtime's
   * memory layout through Address Library. A tester on GOG installed a
   * Steam-built collection, passed a `versionPolicy: "exact"` check on
   * 1.6.1179.0, and got "HonedMetal.dll: disabled, incompatible with current
   * version of the game".
   *
   * Optional: absent on every package built before this existed, and absent
   * means UNKNOWN. The install warns only when both sides are known AND
   * differ AND the package actually ships extender plugins — warning on an
   * unknown would fire for every existing collection and teach people to
   * ignore the one case that matters.
   */
  store?: string;
};

/**
 * Games this installer knows how to deploy. The `manifest.game.id` field
 * is restricted to this union; older or newer manifests with a different
 * id are rejected at parse time.
 *
 * Source of truth: docs/PROPOSAL_INSTALLER.md §3.
 */
export type SupportedGameId =
  | "skyrimse"
  | "fallout3"
  | "falloutnv"
  | "fallout4"
  | "starfield";

/**
 * `"exact"` requires the user's installed game version to match
 * `game.version` byte-for-byte. `"minimum"` requires the user's version to
 * be `>=` the manifest version (semver compare).
 */
export type GameVersionPolicy = "exact" | "minimum";

export type VortexMetadata = {
  /** Vortex client version the curator used. Warn-only mismatch. */
  version: string;
  /**
   * Curator's deployment method. Informational only — the user's Vortex
   * may use a different method; the installer respects whichever is set
   * on the user side.
   */
  deploymentMethod: VortexDeploymentMethod;
  /**
   * Other Vortex extensions the install REQUIRES to be present and enabled
   * on the user side (e.g. LOOT). Refuse-to-install on missing.
   */
  requiredExtensions: RequiredExtension[];
};

export type VortexDeploymentMethod = "hardlink" | "symlink" | "copy";

export type RequiredExtension = {
  id: string;
  /** Optional minimum semver, when known. */
  minVersion?: string;
};

// ---------------------------------------------------------------------------
// Mods (discriminated union by source.kind)
// ---------------------------------------------------------------------------

/**
 * A mod entry in the manifest. The discriminator lives on `source.kind`:
 *  - `"nexus"`   → identity is `(gameDomain, modId, fileId)`, verified by sha256
 *  - `"external"` → identity is `sha256` alone (sole identity, see §5.5)
 *
 * Vortex's vanilla collections do not have a true second case — Event Horizon
 * does because every external mod the curator ships carries the SHA-256 of
 * the exact bytes they built against, and the user-side resolver refuses
 * anything else.
 */
export type EhcollMod = NexusEhcollMod | ExternalEhcollMod;

export type NexusEhcollMod = EhcollModBase & {
  source: NexusModSource;
};

export type ExternalEhcollMod = EhcollModBase & {
  source: ExternalModSource;
};

type EhcollModBase = {
  /**
   * Stable identity for diff/reconcile. See `getModCompareKey` and
   * docs/business/AUDITOR_MOD.md for the full ladder. Examples:
   *   "nexus:1234:567890"
   *   "archive:abc-123-def"
   *   "id:MyMod-1234-5-0-0"
   *   "external:<sha256>"  (manifest-only synthetic key for external mods)
   */
  compareKey: string;
  name: string;
  version?: string;
  install: ModInstallSpec;
  state: ModInstallState;
  /** UI-only metadata. Never used by the installer for identity or behavior. */
  attributes?: ModUiAttributes;
};

export type NexusModSource = {
  kind: "nexus";
  /** Nexus game domain, e.g. `"skyrimspecialedition"`. */
  gameDomain: string;
  modId: number;
  fileId: number;
  /** Original archive filename on Nexus, useful for the download UI. */
  archiveName: string;
  /**
   * Mandatory. SHA-256 of the bytes Nexus served when the curator built
   * this manifest. The installer downloads via Nexus IDs, then verifies
   * against this hash. Mismatch ⇒ HARD FAIL (Nexus served different bytes).
   */
  sha256: string;
};

export type ExternalModSource = {
  kind: "external";
  /** Filename hint for the user prompt. Not used for identity. */
  expectedFilename: string;
  /**
   * SHA-256 of the source archive bytes when the curator has them.
   *
   * v1.0 schema treated this as mandatory. v1.1+ made it optional
   * because Vortex doesn't always retain the original archive for
   * externally-installed mods (manual installs, sideloaded mods,
   * archives the user purged from the cache). When archive bytes are
   * unavailable, identity falls back to {@link stagingSetHash}.
   *
   * INVARIANT (parser-enforced): at least one of `sha256` or
   * `stagingSetHash` MUST be present. A manifest with neither has no
   * way to identify the mod across machines and is rejected.
   *
   * INVARIANT (parser-enforced): if `bundled === true`, then `sha256`
   * MUST be present (the bundled-archive path on disk is keyed by
   * archive sha256, so we cannot bundle without it).
   *
   * When present: lowercase hex, exactly 64 characters.
   */
  sha256?: string;
  /** Free-form text shown to the user when the file isn't in `bundled/`. */
  instructions?: string;
  /**
   * Where to get this mod. Shown as an openable link when the file is not
   * bundled.
   *
   * `http(s)` only, enforced at parse: Vortex also records `nxm://` links and
   * bare local paths for a mod's origin, and neither is something the person
   * installing can act on — a local path is the CURATOR's disk, so shipping
   * one would send the user hunting a folder they do not have and would
   * publish the curator's directory layout along the way.
   *
   * Optional, and instructions remain the load-bearing field: a link alone
   * does not say which of eleven files on the page to take.
   */
  url?: string;
  /**
   * What kind of link {@link url} is, from Vortex's own `downloadHint.mode`.
   *
   * Changes the instruction the user gets, which is the whole reason to carry
   * it: "open this page and find the file" and "this link starts a download"
   * are different actions, and guessing which one from the URL is exactly the
   * kind of inference that produces confidently wrong guidance.
   */
  downloadMode?: "direct" | "browse" | "manual";
  /**
   * `true` ⇒ archive is included in the package at `bundled/<sha256>.<ext>`.
   * `false` ⇒ the user must supply a local copy.
   *
   * Requires {@link sha256} to be set when `true` (see invariant above).
   */
  bundled: boolean;
  /**
   * Deterministic SHA-256 over the curator's deployed staging folder for
   * this mod (file list aggregated by relative path + size + sha256).
   * Populated iff this mod was captured with
   * `verificationLevel = "thorough"`.
   *
   * Why we need it: Vortex doesn't always retain the original archive
   * for externally-installed mods (manual installs, sideloads, archives
   * the user purged). When the curator has no archive bytes to hash,
   * the manifest still has identity via the curator's deployed file
   * set. The user-side resolver mirrors this by hashing matching mods'
   * staging folders and comparing.
   *
   * Identity ladder for external mods (LOAD-BEARING):
   *   1. archive `sha256` match (preferred — cheap, archive-authoritative)
   *   2. `stagingSetHash` match (fallback — works when archive absent)
   *   3. fall through to install-from-bundle / prompt-user
   *
   * Optional for backward compatibility: parsers treat absence as
   * "no staging-set identity available." Manifests built with
   * `verificationLevel = "thorough"` always populate it. Manifests
   * without `sha256` (archive-less mods) MUST populate it (otherwise
   * the mod has no identity at all and the build is rejected).
   *
   * Format: lowercase hex, exactly 64 characters. Computed by
   * `computeStagingSetHash`.
   */
  stagingSetHash?: string;
};

/** A game INI file, reduced to the settings this collection owns. */
export type EhcollGameIniFile = {
  /** File name only — never a path from the curator's disk. */
  fileName: string;
  settings: Array<{ section: string; key: string; value: string }>;
};

/** The curator's game configuration, as shipped. */
export type EhcollGameIni = {
  files: EhcollGameIniFile[];
};

export type ModInstallSpec = {
  /**
   * The curator's saved FOMOD wizard answers. Empty when the mod isn't FOMOD
   * or had no choices. Order is significant — it mirrors the installer's step
   * sequence.
   *
   * NOT yet replayed on install: every archive is handed to Vortex's
   * `start-install`, which runs the FOMOD UI and lets the user pick. This
   * docstring used to claim they were replayed "in unattended mode", which
   * described an intention rather than the code.
   */
  fomodSelections: FomodSelectionStep[];
  /** Vortex installer type, e.g. `"fomod"` or `"raw"`. */
  installerType?: string;
  /**
   * `installerChoices.type` — which installer's answer format
   * `fomodSelections` is written in. Vortex's `IChoiceType` is
   * `{ type, options }`, and replay has to hand back both halves.
   */
  installerChoicesType?: string;
  /**
   * The curator installed this mod WITHOUT selecting anything, and the build
   * proved it by replaying the installer with no choices and comparing the
   * result against their staging folder.
   *
   * Only meaningful when `fomodSelections` is empty, where that emptiness is
   * otherwise ambiguous: Vortex records nothing both when a user picks nothing
   * AND when a mod's answers were lost (creating a variant without
   * "Pre-populate installer options" discards them). Guessing costs either a
   * mod installed with less than the curator has, or a dialog a stranger
   * cannot answer.
   *
   * When set, the user side hands the installer an empty answer unattended
   * instead of letting it ask.
   */
  emptySelectionVerified?: boolean;
  /**
   * ─── PLUGINS THIS MOD'S INSTALLER ASKS THE GAME ABOUT ──────────────────
   * Lowercased plugin filenames named by a `<fileDependency>` anywhere in the
   * mod's FOMOD script — its `<moduleDependencies>`, an install step's
   * `<visible>`, a `<conditionalFileInstalls>` pattern, or a plugin's
   * `<typeDescriptor>`. Absent for the overwhelming majority, which ask the
   * game nothing.
   *
   * ─── WHY IT IS IN THE PACKAGE ──────────────────────────────────────────
   * Vortex's FOMOD engine evaluates these against LIVE game state when the
   * mod installs, through a delegate that reads `loadOrder[name].enabled`.
   * Pre-filling the curator's `installerChoices` does not suppress that —
   * proven by reading Vortex's shipped bundle, where `getAllPlugins` is
   * registered unconditionally and `choices` is one argument among six with
   * no flag that turns condition evaluation off.
   *
   * So a mod naming a plugin the COLLECTION ITSELF provides behaves
   * differently depending on its position in the install order, which is a
   * coin toss nobody chose. One real mod, 801 of 979, refused eleven times
   * across the tester logs: "Prerequisits not fulfilled: File 'aaf.esm' is
   * Active OR File 'aaf.esp' is Active" — with AAF sitting in the same
   * collection, uninstalled at that moment.
   *
   * The refusing case is loud and the retry pass rescues it. The same
   * dependency in a `<visible>` or a conditional pattern does NOT refuse: it
   * takes a different branch, installs a different file set, and nothing
   * fails — so no retry, and verification later reports the mod as
   * unreproducible while blaming its archive. That is the case this field
   * exists for, and the build is the only place it can be seen.
   *
   * Recorded as evidence, not as an instruction: the installer decides what
   * to do with it, because only the installer knows which of these plugins
   * this collection provides and which the user already has.
   */
  readsPluginState?: string[];
  /**
   * ─── WHY AN ABSENT `readsPluginState` NEEDED A SECOND FIELD ──────────
   * Absent means TWO things, and they call for opposite handling:
   *
   *   1. the installer was read and asks the game nothing — 845 of 963 mods
   *      on the real collection have no FOMOD script at all;
   *   2. the archive could not be opened, so nothing is known.
   *
   * The epoch planner reads absent as (1), which is right 845 times and wrong
   * for the handful in (2) — and (2) is exactly the population most likely to
   * matter, because a mod whose download record Vortex lost is usually one
   * that has been updated in place and re-patched.
   *
   * `true` says the second thing out loud. It does NOT defer the mod: a mod
   * that could not be examined is not evidence that it needs deferring, and
   * deferring on a guess costs it its curated position. It is reported, and
   * the remedy is the curator's — rescan Downloads, rebuild.
   */
  installerUnexamined?: boolean;
};

export type ModInstallState = {
  enabled: boolean;
  /**
   * Curator's install ordinal (0-indexed). Sequenced rule application
   * walks mods in this order to mimic the curator's machine.
   */
  installOrder: number;
  /**
   * Recorded, and deliberately NOT applied. Read this before using it.
   *
   * The comment here used to say Vortex computes this from rules and age, that
   * we capture the resulting number, and that the installer feeds it back so
   * the user-side deploy resolves overrides identically. None of that was
   * true: `buildModInstallState` assigns `mod.installOrder`, Vortex exposes no
   * action to set a deployment priority, and nothing on the install side ever
   * read the field. It was a description of an intention that was never built.
   *
   * It stays unapplied on purpose. Deployment order only decides a file
   * conflict that no RULE decides, and measured on the real 954-mod collection
   * that is 3 of 4,383 contested files — the other 4,380 are settled by the
   * curator's rules, which the installer does apply. Building an ordering
   * replay for three files would be machinery with its own failure modes
   * guarding almost nothing.
   *
   * So: it is the curator's install ordinal, kept because it is cheap to carry
   * and useful when diagnosing an ordering question by hand. If it ever does
   * get applied, that is a new decision with a new measurement behind it, not
   * the fulfilment of a promise this field was making.
   */
  deploymentPriority: number;
  /** Vortex modtype. Empty string is the default modtype. */
  modType?: string;
  /**
   * Reproduce this mod's staging folder exactly, after installing its archive.
   *
   * Set when the curator answered "mirror" for a mod whose staging their
   * archive cannot reproduce — a cleaned plugin, a repacked BA2, a patch
   * dropped in by hand. The target is `stagingFiles` on this same state; the
   * bytes the archive cannot supply ride in the package at `mirror/<sha256>`.
   *
   * Only meaningful alongside a `thorough` capture: without per-file hashes
   * there is nothing to reconcile against, and `planMirror` says so rather
   * than guessing.
   */
  mirrored?: boolean;
  /** INI tweak filenames the curator enabled on this mod. */
  enabledINITweaks?: string[];
  /**
   * The curator declared this mod's staging as deliberately post-processed.
   *
   * Set from `ExternalModConfigEntry.postProcessed` at build time. Read by the
   * user-side verifier: files the curator recorded that are ABSENT on the
   * user's side stop being a hard failure for this mod, because the archive
   * the user installed from provably cannot produce them.
   *
   * Absent means not declared, never "false by default from an older build":
   * both read the same here, and both mean the ordinary strict check applies.
   */
  postProcessed?: boolean;
  /**
   * Snapshot of the curator's staging folder for this mod, captured at
   * build time. Used by the user-side {@link verifyModInstall} check to
   * detect Vortex's "lost file" / truncation / corruption bugs after a
   * mod install completes.
   *
   * Source: walking `<curator install path>/<mod.installationPath>` on
   * the curator's machine after Vortex finished extracting the archive
   * (post-FOMOD-resolution, so the file set reflects the curator's
   * answers to the wizard, not the raw archive contents).
   *
   * Optional because:
   *  - Older manifests (pre-Tier-1) don't have it.
   *  - Curators may opt out via `package.verificationLevel = "none"`
   *    for very large collections where build time matters more than
   *    integrity catching.
   *
   * The list is **not** the complete set the user MUST have — if the
   * user picks different FOMOD answers, file sets legitimately differ.
   * The verifier treats "extra files on user side" as informational and
   * "missing files on user side" as the only hard failure (with retry).
   */
  stagingFiles?: EhcollStagingFile[];
};

/**
 * One file from the curator's staging folder for a mod, recorded at
 * build time. `sha256` is only set when the curator built with
 * `verificationLevel = "thorough"`.
 */
export type EhcollStagingFile = {
  /** POSIX-style path, relative to the mod's staging root. */
  path: string;
  /** File size in bytes. */
  size: number;
  /**
   * SHA-256 of the file contents, lowercase hex. Present iff the
   * curator's manifest was built with `verificationLevel = "thorough"`.
   */
  sha256?: string;
};

export type ModUiAttributes = {
  category?: string;
  description?: string;
  /**
   * What the curator wanted the installer to know about this mod: why it is
   * here, what to check after an update. Only notes the curator marked for
   * users are shipped; shown on the install plan.
   */
  curatorNote?: string;
};

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export type EhcollRule = {
  /** `compareKey` of the mod that owns the rule. */
  source: string;
  type: ModRuleType;
  /**
   * Either a fully-pinned `compareKey` (`"nexus:1234:567890"`) or a
   * partially-pinned reference (`"nexus:1234"` matches any file id of
   * Nexus mod 1234). The installer resolves to the strongest available
   * pin on the user side.
   */
  reference: string;
  comment?: string;
  /** Curator's note that the rule is disabled but preserved. */
  ignored?: boolean;
};

export type ModRuleType =
  | "before"
  | "after"
  | "requires"
  | "recommends"
  | "conflicts"
  | "provides";

// ---------------------------------------------------------------------------
// Plugins (Bethesda plugins.txt content)
// ---------------------------------------------------------------------------

export type EhcollPlugins = {
  /**
   * Plugin entries in the curator's `plugins.txt` order.
   *
   * This IS an instruction now, and reaches the user's plugins.txt.
   *
   * It was a baseline for a long time, under the rules-only strategy: the old
   * `pluginsTxt.ts` writer had been removed because Vortex and LOOT regenerate
   * that file, so the order was applied indirectly through LOOT rules and only
   * compared afterwards. The premise was half right — the FILE is Vortex's to
   * own, but the STATE is not. `PluginPersistor.syncFromState` exists to flush
   * the load-order hive to plugins.txt after a collection install.
   *
   * So `applyPluginOrder` now pins this order, asks LOOT to sort the user's own
   * plugins into it, and has Vortex write the result. It is still copied into
   * the receipt as `baselinePluginOrder`, and the drift check still runs — but
   * a difference there now means LOOT actively disagreed with the curator,
   * rather than nobody having tried.
   */
  order: EhcollPluginEntry[];
  /**
   * The TES4 header bit every `order[].light` was read from — 0x200, or 0x100
   * on Starfield.
   *
   * Starfield marks light with 0x100, and 0x200 there is a different flag.
   * Builds before this field existed read 0x200 for every game, so their
   * Starfield `light` values say nothing about light. Absent therefore means
   * 0x200, and the installer applies the values only where that bit IS the
   * game's light bit (`judgeRecordedLightFlags`).
   */
  lightFlagBit?: number;
};

export type EhcollPluginEntry = {
  /** Plugin filename, e.g. `"Skyrim.esm"`. Original casing preserved. */
  name: string;
  enabled: boolean;
  /**
   * Whether the curator's copy carries the ESL / "light" header flag.
   *
   * Not cosmetic. Regular plugins are addressed with one byte, so only 254 can
   * load; light plugins share the `FE` index and do not consume one. Measured
   * on the profile this was built for: 817 plugins, 573 of them light, leaving
   * 244 regular against a limit of 254. Eleven lost flags and the game will
   * not start.
   *
   * Recorded explicitly because the flag lives INSIDE the plugin file, so a
   * curator who marks a plugin light after installing it has a staged file the
   * archive does not contain — and the user, who installs from that archive,
   * silently gets the unflagged version. File comparison cannot rescue this:
   * it correctly concludes the user's bytes match the archive and accepts them.
   *
   * `undefined` on packages built before this was captured, and for a plugin
   * whose header could not be read. Absent means "unknown", never "not light":
   * treating it as false would clear flags the user legitimately has.
   */
  light?: boolean;
};

// ---------------------------------------------------------------------------
// LoadOrder (top-level — Vortex's per-game load order)
// ---------------------------------------------------------------------------

/**
 * One entry in the curator's per-game LoadOrder, normalized for
 * cross-machine portability. Mirrors the on-disk shape of
 * `state.persistent.loadOrder[gameId]` after `captureLoadOrder`.
 *
 * INVARIANT: `compareKey` is mandatory and always resolvable against
 * `EhcollManifest.mods`. Curator-side capture skips load-order entries
 * whose Vortex modId can't be mapped to a manifest compareKey (a
 * loose archive on disk, an external Vortex mod we didn't pack, etc.).
 */
export type EhcollLoadOrderEntry = {
  /** Mirrors `EhcollMod.compareKey`. */
  compareKey: string;
  /** 0-indexed position in the curator's load order. */
  pos: number;
  /** Whether the curator had this entry enabled in the load-order view. */
  enabled: boolean;
  /**
   * Curator marked this entry as locked (cannot be moved by the user).
   * Informational — the installer does not enforce locking on the user
   * side; Vortex's UI uses this for display + drag-disable hints only.
   */
  locked?: boolean;
};

// ---------------------------------------------------------------------------
// Userlist (LOOT plugin rules + groups, slice 6d)
// ---------------------------------------------------------------------------

/**
 * Portable LOOT userlist — mirrors Vortex's `state.userlist` Redux
 * slice (which mirrors LOOT's `userlist.yaml`).
 *
 * INVARIANTS:
 *  - References inside `plugins[i].after / req / inc` and
 *    `groups[i].after` are plain plugin/group **names** (strings),
 *    matching Vortex's reducer storage. The on-disk LOOT object form
 *    (`{ name, display?, condition? }`) is collapsed at capture time;
 *    conditional refs lose their condition metadata (v1 limitation).
 *  - `plugins` is scoped to entries whose `name` matches a plugin in
 *    the manifest's `plugins.order`. Plugin entries that only carried
 *    LOOT noise (msg / tag / dirty / url) are dropped at capture time.
 *  - `groups` is captured in full — group rules form a global
 *    namespace; trimming risks breaking transitive ordering.
 *  - Both arrays may be empty — that's the steady state for non-LOOT
 *    games.
 */
export type EhcollUserlist = {
  plugins: EhcollUserlistPlugin[];
  groups: EhcollUserlistGroup[];
};

export type EhcollUserlistPlugin = {
  /** Plugin filename. Curator's casing preserved; matched case-insensitively. */
  name: string;
  /** LOOT group assignment. Omitted when the plugin has no explicit group. */
  group?: string;
  /** Plain plugin names this plugin loads after. */
  after?: string[];
  /** Plain plugin names required by this one (LOOT requirement metadata). */
  req?: string[];
  /** Plain plugin names incompatible with this one. */
  inc?: string[];
};

export type EhcollUserlistGroup = {
  /** Group name. Curator's casing preserved; matched case-insensitively. */
  name: string;
  /** Plain group names this group loads after (group → group ordering). */
  after?: string[];
};

// ---------------------------------------------------------------------------
// INI tweaks (Phase 5 stretch goal — schema placeholder)
// ---------------------------------------------------------------------------

/**
 * Single INI key/value override. Phase 5 deliverable; v1 packagers emit
 * `iniTweaks: []`. Placed in the v1 schema so future packagers can
 * populate it without bumping {@link SchemaVersion}.
 *
 * See docs/PROPOSAL_INSTALLER.md §7.4 — the Vortex Redux key for tweaks
 * still has to be confirmed at runtime.
 */
export type EhcollIniTweak = {
  /** Logical id (e.g. `"Skyrim.ini"`); per-game mapping lives in installer. */
  ini: string;
  section: string;
  key: string;
  value: string;
};

// ---------------------------------------------------------------------------
// External (non-mod) dependencies
// ---------------------------------------------------------------------------

/**
 * Dependencies that are NOT mods Vortex installs — script extenders,
 * ENB binaries, fixed loaders. The user installs these by hand following
 * `instructions`; the installer verifies by hashing the listed files at
 * `destination`.
 */
export type EhcollExternalDependency = {
  id: string;
  name: string;
  /** Free-form bucket, e.g. `"script-extender"`, `"enb"`, `"loader"`. */
  category: string;
  version: string;
  /**
   * Token resolved on the user side. `"<gameDir>"` is the Vortex-tracked
   * game install root; `"<dataDir>"` is its `Data` subdirectory; `"<scripts>"`
   * is the per-game scripts location (e.g. `Data\Scripts` for Skyrim).
   */
  destination: ExternalDependencyDestination;
  /** Files to verify after the user reports installation done. */
  files: ExternalDependencyFile[];
  /** Where to download — surfaced as a clickable link in the UI. */
  instructionsUrl?: string;
  /** Free-form prose. Mandatory because the user has to do work. */
  instructions: string;
};

export type ExternalDependencyDestination = "<gameDir>" | "<dataDir>" | "<scripts>";

export type ExternalDependencyFile = {
  /** Path relative to {@link EhcollExternalDependency.destination}. */
  relPath: string;
  sha256: string;
};
