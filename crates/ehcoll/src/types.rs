//! A verbatim port of `src/types/ehcoll.ts`.
//!
//! ─── THIS FILE IS A TRANSLATION, NOT A DESIGN ───────────────────────────
//! `src/types/ehcoll.ts` is NORMATIVE (settled 2026-09-07, see
//! `spec/README.md`). The goal is that one `.ehcoll` file works on both
//! sides, so this mirrors the TypeScript shape field for field — including
//! choices a fresh design would make differently.
//!
//! When the two disagree, THIS side is wrong until proven otherwise. Fixing a
//! shared bug is a coordinated change to `ehcoll.ts`, this file, and the
//! fixtures — never to one side alone.
//!
//! ─── SERDE SETTINGS THAT ARE LOAD-BEARING ───────────────────────────────
//! * Unknown fields are IGNORED, never rejected. The schema is additive by
//!   contract: v1.x adds fields, and a v1.1 manifest must still parse in a
//!   v1.0 reader. `deny_unknown_fields` here would break that guarantee.
//! * `Option<T>` means the TypeScript `?`. Absent and `null` both read as
//!   `None`, matching `undefined` on the other side.
//! * Field names are camelCase to match the JSON exactly.

use serde::{Deserialize, Serialize};

/// Bumped only on breaking changes. The installer refuses unknown versions.
pub const SCHEMA_VERSION: u64 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EhcollManifest {
    pub schema_version: u64,
    pub package: PackageMetadata,
    pub game: GameMetadata,
    pub vortex: VortexMetadata,
    pub mods: Vec<EhcollMod>,
    pub rules: Vec<EhcollRule>,
    pub plugins: EhcollPlugins,
    /// Vortex's per-game LoadOrder. Distinct from `plugins.order`, which is
    /// plugins.txt only — this covers every Vortex-managed mod, including
    /// script extenders and ENB binaries.
    ///
    /// Back-filled to `[]`: manifests written before this field existed are
    /// valid v1 and must parse.
    pub load_order: Vec<EhcollLoadOrderEntry>,
    /// LOOT userlist snapshot. Back-filled to empty for the same reason.
    pub userlist: EhcollUserlist,
    pub ini_tweaks: Vec<EhcollIniTweak>,
    /// The game's OWN configuration (`Fallout4.ini` and friends), not
    /// Vortex's per-mod INI Tweaks mechanism. Machine-owned keys (resolution,
    /// threads, GPU) are excluded at BUILD time, so they cannot be applied by
    /// accident here.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game_ini: Option<EhcollGameIni>,
    pub external_dependencies: Vec<EhcollExternalDependency>,
}

// ── Package ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageMetadata {
    /// UUIDv4, stable across re-exports of the SAME collection. `version`,
    /// not this, distinguishes releases.
    pub id: String,
    pub name: String,
    /// Semver.
    pub version: String,
    pub author: String,
    /// ISO-8601 UTC.
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// `true` → abort the install on an unresolvable mod, with a full report.
    /// `false` → skip, warn, and surface it in the drift report.
    pub strict_missing_mods: bool,
    /// Absent reads as [`VerificationLevel::None`], never as an error.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_level: Option<VerificationLevel>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VerificationLevel {
    /// No `stagingFiles`. Verification is skipped.
    None,
    /// `{ path, size }` — catches lost files and truncation.
    Fast,
    /// `{ path, size, sha256 }` — additionally catches silent corruption.
    Thorough,
}

// ── Game / Vortex environment ──────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameMetadata {
    pub id: SupportedGameId,
    pub version: String,
    pub version_policy: GameVersionPolicy,
}

/// A CLOSED set. A manifest naming any other game is rejected at parse — this
/// installer would not know how to deploy it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SupportedGameId {
    Skyrimse,
    Fallout3,
    Falloutnv,
    Fallout4,
    Starfield,
}

impl SupportedGameId {
    pub fn as_str(self) -> &'static str {
        match self {
            SupportedGameId::Skyrimse => "skyrimse",
            SupportedGameId::Fallout3 => "fallout3",
            SupportedGameId::Falloutnv => "falloutnv",
            SupportedGameId::Fallout4 => "fallout4",
            SupportedGameId::Starfield => "starfield",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GameVersionPolicy {
    /// Byte-for-byte match required.
    Exact,
    /// User's version must be `>=` (semver compare).
    Minimum,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VortexMetadata {
    /// Warn-only on mismatch.
    pub version: String,
    /// Informational. The user's own Vortex setting wins.
    pub deployment_method: VortexDeploymentMethod,
    /// Extensions the install REQUIRES. Missing one is refuse-to-install.
    pub required_extensions: Vec<RequiredExtension>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VortexDeploymentMethod {
    Hardlink,
    Symlink,
    Copy,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequiredExtension {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_version: Option<String>,
}

// ── Mods ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EhcollMod {
    /// Stable identity for diff/reconcile, e.g. `"nexus:1234:567890"`,
    /// `"external:<sha256>"`.
    pub compare_key: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub install: ModInstallSpec,
    pub state: ModInstallState,
    /// UI only. NEVER used for identity or install behaviour.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attributes: Option<ModUiAttributes>,
    /// Discriminated by `kind`.
    pub source: ModSource,
}

/// The discriminator is `source.kind`, matching the TypeScript union.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ModSource {
    /// Retrieved by `(gameDomain, modId, fileId)`, then VERIFIED by sha256.
    /// A hash mismatch is a hard fail: Nexus served different bytes.
    Nexus(NexusModSource),
    /// Identity is the hash alone. See [`ExternalModSource`].
    External(ExternalModSource),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NexusModSource {
    pub game_domain: String,
    pub mod_id: u64,
    pub file_id: u64,
    pub archive_name: String,
    /// Mandatory. Lowercase hex, exactly 64 characters.
    pub sha256: String,
}

/// NS-2 lives here. An external mod is identified by its BYTES, with no name,
/// version or filename fallback — because a Google Drive link rots and a
/// LoversLab file gets silently reuploaded, and the hash outlives both.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalModSource {
    /// A hint for the user prompt. NOT identity.
    pub expected_filename: String,
    /// Optional since v1.1: Vortex does not always retain the original
    /// archive. When absent, identity falls back to `stagingSetHash`.
    ///
    /// PARSER-ENFORCED: at least one of `sha256` or `stagingSetHash` must be
    /// present, or the mod cannot be identified across machines at all.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    /// `http(s)` ONLY, enforced at parse. Vortex also records `nxm://` links
    /// and bare local paths; a local path is the CURATOR's disk, so shipping
    /// one sends the user hunting a folder they do not have and publishes the
    /// curator's directory layout on the way.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// "Open this page and find the file" and "this link starts a download"
    /// are different actions, and inferring which from the URL is exactly the
    /// guess that produces confidently wrong guidance.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_mode: Option<DownloadMode>,
    /// `true` ⇒ the archive rides in the package at `bundled/<sha256>.<ext>`.
    ///
    /// PARSER-ENFORCED: `true` requires `sha256`, because the bundled path is
    /// keyed by it.
    pub bundled: bool,
    /// Deterministic hash over the curator's deployed staging folder. The
    /// fallback rung of the identity ladder when no archive bytes exist.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub staging_set_hash: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadMode {
    Direct,
    Browse,
    Manual,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModInstallSpec {
    /// The curator's saved FOMOD answers. ORDER IS SIGNIFICANT — it mirrors
    /// the installer's step sequence.
    pub fomod_selections: Vec<FomodSelectionStep>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installer_type: Option<String>,
    /// Which installer's answer format `fomodSelections` is written in.
    /// Replay has to hand back both halves of `IChoiceType`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installer_choices_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FomodSelectionStep {
    pub name: String,
    pub groups: Vec<FomodSelectionGroup>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FomodSelectionGroup {
    pub name: String,
    pub choices: Vec<FomodSelectedChoice>,
}

/// Carries BOTH the name and the index. Do not "simplify" to the index:
/// positional answers silently install the wrong files when a mod update
/// reorders groups, and the answer still looks valid.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FomodSelectedChoice {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idx: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModInstallState {
    pub enabled: bool,
    /// Curator's install ordinal, 0-indexed.
    pub install_order: i64,
    /// RECORDED AND DELIBERATELY NOT APPLIED. Measured on the real 954-mod
    /// collection: deployment order decides 3 of 4,383 contested files — the
    /// other 4,380 are settled by rules, which the installer does apply.
    /// Applying it would be machinery with its own failure modes guarding
    /// almost nothing.
    pub deployment_priority: i64,
    /// Empty string is the default modtype.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mod_type: Option<String>,
    /// Reproduce this mod's staging exactly after installing its archive —
    /// for a cleaned plugin or repacked BA2 the archive cannot reproduce.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mirrored: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled_ini_tweaks: Option<Vec<String>>,
    /// The curator declared this staging deliberately post-processed, so
    /// files they recorded that are absent on the user's side stop being a
    /// hard failure. Absent means NOT DECLARED, never "false from an old
    /// build" — both read the same, and both mean the strict check applies.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_processed: Option<bool>,
    /// NOT the complete set the user must have: different FOMOD answers
    /// legitimately produce different file sets. Extra files on the user side
    /// are informational; only MISSING files are a hard failure.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub staging_files: Option<Vec<EhcollStagingFile>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EhcollStagingFile {
    /// POSIX-style, relative to the mod's staging root.
    pub path: String,
    pub size: u64,
    /// Present iff built with `verificationLevel = "thorough"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModUiAttributes {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

// ── Rules ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EhcollRule {
    /// `compareKey` of the mod that owns the rule.
    pub source: String,
    #[serde(rename = "type")]
    pub rule_type: ModRuleType,
    /// Fully pinned (`"nexus:1234:567890"`) or partially pinned
    /// (`"nexus:1234"` matches any file id of mod 1234).
    pub reference: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    /// Disabled but preserved.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ignored: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModRuleType {
    Before,
    After,
    Requires,
    Recommends,
    Conflicts,
    Provides,
}

// ── Plugins ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EhcollPlugins {
    pub order: Vec<EhcollPluginEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EhcollPluginEntry {
    /// Original casing preserved.
    pub name: String,
    pub enabled: bool,
    /// The ESL / "light" header flag.
    ///
    /// Not cosmetic: regular plugins are addressed with one byte, so only 254
    /// can load, while light plugins share the `FE` index and consume none.
    /// Measured on the profile this was built for: 817 plugins, 573 light,
    /// leaving 244 regular against a limit of 254. Eleven lost flags and the
    /// game will not start.
    ///
    /// `None` means UNKNOWN, never "not light" — treating it as false would
    /// clear flags the user legitimately has.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub light: Option<bool>,
}

// ── LoadOrder ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EhcollLoadOrderEntry {
    pub compare_key: String,
    /// 0-indexed position.
    pub pos: i64,
    pub enabled: bool,
    /// Informational. The installer does not enforce locking.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locked: Option<bool>,
}

// ── Userlist ───────────────────────────────────────────────────────────────

/// Mirrors Vortex's `state.userlist`, which mirrors LOOT's `userlist.yaml`.
/// References are plain names; the on-disk object form
/// (`{ name, display?, condition? }`) is collapsed at capture, so conditional
/// refs lose their condition metadata — a known v1 limitation.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EhcollUserlist {
    pub plugins: Vec<EhcollUserlistPlugin>,
    /// Captured in FULL: group rules form a global namespace and trimming
    /// risks breaking transitive ordering.
    pub groups: Vec<EhcollUserlistGroup>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EhcollUserlistPlugin {
    /// Curator's casing preserved; matched case-insensitively.
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub req: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inc: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EhcollUserlistGroup {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<Vec<String>>,
}

// ── INI ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EhcollIniTweak {
    pub ini: String,
    pub section: String,
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EhcollGameIni {
    pub files: Vec<EhcollGameIniFile>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EhcollGameIniFile {
    /// File NAME only — never a path from the curator's disk.
    pub file_name: String,
    pub settings: Vec<EhcollGameIniSetting>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EhcollGameIniSetting {
    pub section: String,
    pub key: String,
    pub value: String,
}

// ── External dependencies ──────────────────────────────────────────────────

/// NOT mods Vortex installs — script extenders, ENB binaries, loaders. The
/// user installs these by hand; we verify by hashing the listed files.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EhcollExternalDependency {
    pub id: String,
    pub name: String,
    pub category: String,
    pub version: String,
    pub destination: ExternalDependencyDestination,
    pub files: Vec<ExternalDependencyFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions_url: Option<String>,
    /// Mandatory: the user has to do work, so they must be told what.
    pub instructions: String,
}

/// Tokens resolved on the user side.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExternalDependencyDestination {
    #[serde(rename = "<gameDir>")]
    GameDir,
    #[serde(rename = "<dataDir>")]
    DataDir,
    #[serde(rename = "<scripts>")]
    Scripts,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalDependencyFile {
    /// Relative to the dependency's `destination`.
    pub rel_path: String,
    pub sha256: String,
}
