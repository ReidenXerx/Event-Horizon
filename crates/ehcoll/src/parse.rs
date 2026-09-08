//! `manifest.json` validator — a port of `src/core/manifest/parseManifest.ts`.
//!
//! ─── NO WHACK-A-MOLE ────────────────────────────────────────────────────
//! Every detectable problem is collected and reported TOGETHER. A curator
//! fixing a bad manifest gets the full picture rather than a
//! half-fix-then-rerun loop, and that is a deliberate property worth
//! preserving in the port — it is why this validates a `serde_json::Value`
//! by hand instead of leaning on `serde`'s derive, which stops at the first
//! error.
//!
//! ─── TWO SEVERITY TIERS ─────────────────────────────────────────────────
//! * **Errors** abort. Missing required fields, wrong types, bad enum values,
//!   duplicate compareKeys, malformed SHA-256, unsupported gameId,
//!   `schemaVersion != 1`. The installer cannot start without these.
//! * **Warnings** survive. A rule whose reference resolves to nothing is
//!   structurally valid; the resolver skips it at install time.
//!
//! ─── schemaVersion IS A GATE, NOT A FIELD ───────────────────────────────
//! If it is wrong we do not know what the rest of the document MEANS, so it
//! is checked first and returns immediately. Reading a future manifest on a
//! best-effort basis produces a partially-understood install, which is the
//! exact failure this format exists to prevent.

use crate::reference::is_fully_pinned_reference;
use crate::types::*;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::fmt;

/// A manifest that parsed, plus anything non-fatal noticed on the way.
#[derive(Debug, Clone)]
pub struct ParseOutcome {
    pub manifest: EhcollManifest,
    /// Empty when the manifest is fully clean.
    pub warnings: Vec<String>,
}

/// Every problem found, not just the first.
#[derive(Debug, Clone)]
pub struct ParseError {
    pub errors: Vec<String>,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.errors.as_slice() {
            [only] => write!(f, "{only}"),
            many => {
                write!(f, "Manifest is invalid ({} problems):", many.len())?;
                for e in many {
                    write!(f, "\n  - {e}")?;
                }
                Ok(())
            }
        }
    }
}

impl std::error::Error for ParseError {}

impl ParseError {
    fn single(msg: impl Into<String>) -> Self {
        Self { errors: vec![msg.into()] }
    }
}

/// Parse and validate a `.ehcoll` `manifest.json` payload.
pub fn parse_manifest(raw: &str) -> Result<ParseOutcome, ParseError> {
    let parsed: Value = serde_json::from_str(raw)
        .map_err(|e| ParseError::single(format!("manifest.json is not valid JSON: {e}")))?;

    let Some(obj) = parsed.as_object() else {
        return Err(ParseError::single(format!(
            "Top-level value must be a JSON object, got {}.",
            describe(&parsed)
        )));
    };

    // The gate. Wrong here means the rest is uninterpretable.
    match obj.get("schemaVersion").and_then(Value::as_u64) {
        Some(SCHEMA_VERSION) => {}
        _ => {
            let got = obj.get("schemaVersion").unwrap_or(&Value::Null);
            return Err(ParseError::single(format!(
                "Unsupported schemaVersion {got}. This installer understands \
                 schemaVersion {SCHEMA_VERSION} only. Update Event Horizon to \
                 install newer manifests."
            )));
        }
    }

    let mut e: Vec<String> = Vec::new();

    let package = validate_package(obj.get("package"), &mut e);
    let game = validate_game(obj.get("game"), &mut e);
    let vortex = validate_vortex(obj.get("vortex"), &mut e);
    let mods = validate_mods(obj.get("mods"), &mut e);
    let rules = validate_rules(obj.get("rules"), &mut e);
    let plugins = validate_plugins(obj.get("plugins"), &mut e);
    // Back-filled: manifests written before these fields existed are valid v1.
    // The schema is additive, so absence is not an error.
    let load_order = validate_load_order(obj.get("loadOrder"), &mut e);
    let userlist = validate_userlist(obj.get("userlist"), &mut e);
    let ini_tweaks = validate_ini_tweaks(obj.get("iniTweaks"), &mut e);
    let game_ini = validate_game_ini(obj.get("gameIni"), &mut e);
    let external_dependencies =
        validate_external_dependencies(obj.get("externalDependencies"), &mut e);

    if !e.is_empty() {
        return Err(ParseError { errors: e });
    }

    let manifest = EhcollManifest {
        schema_version: SCHEMA_VERSION,
        package: package.expect("no errors implies package validated"),
        game: game.expect("no errors implies game validated"),
        vortex: vortex.expect("no errors implies vortex validated"),
        mods: mods.expect("no errors implies mods validated"),
        rules: rules.expect("no errors implies rules validated"),
        plugins: plugins.expect("no errors implies plugins validated"),
        load_order: load_order.expect("back-filled"),
        userlist: userlist.expect("back-filled"),
        ini_tweaks: ini_tweaks.expect("no errors implies iniTweaks validated"),
        game_ini,
        external_dependencies: external_dependencies.expect("no errors implies deps validated"),
    };

    // Post-pass, and warnings only: a manifest with an unresolvable rule is
    // structurally valid even though the resolver cannot honour every
    // directive.
    let warnings = cross_reference_validate(&manifest);
    Ok(ParseOutcome { manifest, warnings })
}

// ───────────────────────────────────────────────────────────────────────────
// Field helpers
//
// `null` is treated as absent throughout. A required field that is null is
// therefore reported as missing rather than as a type error - a different
// message from the TypeScript, the same accept/reject outcome.
// ───────────────────────────────────────────────────────────────────────────

fn describe(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(_) => "a boolean".into(),
        Value::Number(_) => "a number".into(),
        Value::String(_) => "a string".into(),
        Value::Array(_) => "an array".into(),
        Value::Object(_) => "an object".into(),
    }
}

fn present(v: Option<&Value>) -> Option<&Value> {
    match v {
        Some(Value::Null) | None => None,
        other => other,
    }
}

fn obj_at<'a>(v: Option<&'a Value>, path: &str, e: &mut Vec<String>) -> Option<&'a Map<String, Value>> {
    match present(v) {
        None => {
            e.push(format!("{path} is required."));
            None
        }
        Some(val) => match val.as_object() {
            Some(o) => Some(o),
            None => {
                e.push(format!("{path} must be an object, got {}.", describe(val)));
                None
            }
        },
    }
}

fn arr_at<'a>(v: Option<&'a Value>, path: &str, e: &mut Vec<String>) -> Option<&'a Vec<Value>> {
    match present(v) {
        None => {
            e.push(format!("{path} is required."));
            None
        }
        Some(val) => match val.as_array() {
            Some(a) => Some(a),
            None => {
                e.push(format!("{path} must be an array, got {}.", describe(val)));
                None
            }
        },
    }
}

fn req_string(o: &Map<String, Value>, key: &str, path: &str, e: &mut Vec<String>) -> Option<String> {
    match present(o.get(key)) {
        None => {
            e.push(format!("{path}.{key} is required."));
            None
        }
        Some(v) => match v.as_str() {
            Some(s) => Some(s.to_owned()),
            None => {
                e.push(format!("{path}.{key} must be a string, got {}.", describe(v)));
                None
            }
        },
    }
}

fn opt_string(o: &Map<String, Value>, key: &str, path: &str, e: &mut Vec<String>) -> Option<String> {
    let v = present(o.get(key))?;
    match v.as_str() {
        Some(s) => Some(s.to_owned()),
        None => {
            e.push(format!("{path}.{key} must be a string when present, got {}.", describe(v)));
            None
        }
    }
}

fn req_bool(o: &Map<String, Value>, key: &str, path: &str, e: &mut Vec<String>) -> Option<bool> {
    match present(o.get(key)) {
        None => {
            e.push(format!("{path}.{key} is required."));
            None
        }
        Some(v) => match v.as_bool() {
            Some(b) => Some(b),
            None => {
                e.push(format!("{path}.{key} must be a boolean, got {}.", describe(v)));
                None
            }
        },
    }
}

fn opt_bool(o: &Map<String, Value>, key: &str, path: &str, e: &mut Vec<String>) -> Option<bool> {
    let v = present(o.get(key))?;
    match v.as_bool() {
        Some(b) => Some(b),
        None => {
            e.push(format!("{path}.{key} must be a boolean when present, got {}.", describe(v)));
            None
        }
    }
}

fn req_int(o: &Map<String, Value>, key: &str, path: &str, e: &mut Vec<String>) -> Option<i64> {
    match present(o.get(key)) {
        None => {
            e.push(format!("{path}.{key} is required."));
            None
        }
        Some(v) => match v.as_i64() {
            Some(n) => Some(n),
            None => {
                e.push(format!("{path}.{key} must be an integer, got {}.", describe(v)));
                None
            }
        },
    }
}

fn req_uint(o: &Map<String, Value>, key: &str, path: &str, e: &mut Vec<String>) -> Option<u64> {
    match present(o.get(key)) {
        None => {
            e.push(format!("{path}.{key} is required."));
            None
        }
        Some(v) => match v.as_u64() {
            Some(n) => Some(n),
            None => {
                e.push(format!(
                    "{path}.{key} must be a non-negative integer, got {}.",
                    describe(v)
                ));
                None
            }
        },
    }
}

fn opt_uint(o: &Map<String, Value>, key: &str, path: &str, e: &mut Vec<String>) -> Option<u64> {
    let v = present(o.get(key))?;
    match v.as_u64() {
        Some(n) => Some(n),
        None => {
            e.push(format!(
                "{path}.{key} must be a non-negative integer when present, got {}.",
                describe(v)
            ));
            None
        }
    }
}

/// Lowercase hex, exactly 64 characters. An uppercase hash is REJECTED rather
/// than normalised: identity comparisons happen in a dozen places and a
/// silently-normalised value is one of them forgetting.
fn is_sha256(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn req_sha256(o: &Map<String, Value>, key: &str, path: &str, e: &mut Vec<String>) -> Option<String> {
    let s = req_string(o, key, path, e)?;
    if is_sha256(&s) {
        Some(s)
    } else {
        e.push(format!(
            "{path}.{key} must be a lowercase hex SHA-256 of exactly 64 characters, got {s:?}."
        ));
        None
    }
}

fn opt_sha256(o: &Map<String, Value>, key: &str, path: &str, e: &mut Vec<String>) -> Option<String> {
    let s = opt_string(o, key, path, e)?;
    if is_sha256(&s) {
        Some(s)
    } else {
        e.push(format!(
            "{path}.{key} must be a lowercase hex SHA-256 of exactly 64 characters, got {s:?}."
        ));
        None
    }
}

fn req_enum<T: Copy>(
    o: &Map<String, Value>,
    key: &str,
    path: &str,
    allowed: &[(&str, T)],
    e: &mut Vec<String>,
) -> Option<T> {
    let s = req_string(o, key, path, e)?;
    match allowed.iter().find(|(name, _)| *name == s) {
        Some((_, v)) => Some(*v),
        None => {
            let names: Vec<&str> = allowed.iter().map(|(n, _)| *n).collect();
            e.push(format!(
                "{path}.{key} must be one of {}, got {s:?}.",
                names.join(", ")
            ));
            None
        }
    }
}

fn opt_enum<T: Copy>(
    o: &Map<String, Value>,
    key: &str,
    path: &str,
    allowed: &[(&str, T)],
    e: &mut Vec<String>,
) -> Option<T> {
    let s = opt_string(o, key, path, e)?;
    match allowed.iter().find(|(name, _)| *name == s) {
        Some((_, v)) => Some(*v),
        None => {
            let names: Vec<&str> = allowed.iter().map(|(n, _)| *n).collect();
            e.push(format!(
                "{path}.{key} must be one of {} when present, got {s:?}.",
                names.join(", ")
            ));
            None
        }
    }
}

fn opt_string_array(
    o: &Map<String, Value>,
    key: &str,
    path: &str,
    e: &mut Vec<String>,
) -> Option<Vec<String>> {
    let v = present(o.get(key))?;
    let Some(items) = v.as_array() else {
        e.push(format!("{path}.{key} must be an array when present, got {}.", describe(v)));
        return None;
    };
    let mut out = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        match item.as_str() {
            Some(s) => out.push(s.to_owned()),
            None => e.push(format!(
                "{path}.{key}[{i}] must be a string, got {}.",
                describe(item)
            )),
        }
    }
    Some(out)
}

// ───────────────────────────────────────────────────────────────────────────
// Section validators
// ───────────────────────────────────────────────────────────────────────────

fn validate_package(v: Option<&Value>, e: &mut Vec<String>) -> Option<PackageMetadata> {
    let o = obj_at(v, "package", e)?;
    let p = "package";
    let id = req_string(o, "id", p, e);
    let name = req_string(o, "name", p, e);
    let version = req_string(o, "version", p, e);
    let author = req_string(o, "author", p, e);
    let created_at = req_string(o, "createdAt", p, e);
    let strict = req_bool(o, "strictMissingMods", p, e);
    let description = opt_string(o, "description", p, e);
    let verification_level = opt_enum(
        o,
        "verificationLevel",
        p,
        &[
            ("none", VerificationLevel::None),
            ("fast", VerificationLevel::Fast),
            ("thorough", VerificationLevel::Thorough),
        ],
        e,
    );
    Some(PackageMetadata {
        id: id?,
        name: name?,
        version: version?,
        author: author?,
        created_at: created_at?,
        description,
        strict_missing_mods: strict?,
        verification_level,
    })
}

fn validate_game(v: Option<&Value>, e: &mut Vec<String>) -> Option<GameMetadata> {
    let o = obj_at(v, "game", e)?;
    let p = "game";
    let id = req_enum(
        o,
        "id",
        p,
        &[
            ("skyrimse", SupportedGameId::Skyrimse),
            ("fallout3", SupportedGameId::Fallout3),
            ("falloutnv", SupportedGameId::Falloutnv),
            ("fallout4", SupportedGameId::Fallout4),
            ("starfield", SupportedGameId::Starfield),
        ],
        e,
    );
    let version = req_string(o, "version", p, e);
    let policy = req_enum(
        o,
        "versionPolicy",
        p,
        &[("exact", GameVersionPolicy::Exact), ("minimum", GameVersionPolicy::Minimum)],
        e,
    );
    Some(GameMetadata { id: id?, version: version?, version_policy: policy? })
}

fn validate_vortex(v: Option<&Value>, e: &mut Vec<String>) -> Option<VortexMetadata> {
    let o = obj_at(v, "vortex", e)?;
    let p = "vortex";
    let version = req_string(o, "version", p, e);
    let method = req_enum(
        o,
        "deploymentMethod",
        p,
        &[
            ("hardlink", VortexDeploymentMethod::Hardlink),
            ("symlink", VortexDeploymentMethod::Symlink),
            ("copy", VortexDeploymentMethod::Copy),
        ],
        e,
    );
    let items = arr_at(o.get("requiredExtensions"), "vortex.requiredExtensions", e)?;
    let mut exts = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        let path = format!("vortex.requiredExtensions[{i}]");
        let Some(eo) = obj_at(Some(item), &path, e) else { continue };
        let id = req_string(eo, "id", &path, e);
        let min_version = opt_string(eo, "minVersion", &path, e);
        if let Some(id) = id {
            exts.push(RequiredExtension { id, min_version });
        }
    }
    Some(VortexMetadata { version: version?, deployment_method: method?, required_extensions: exts })
}

fn validate_mods(v: Option<&Value>, e: &mut Vec<String>) -> Option<Vec<EhcollMod>> {
    let items = arr_at(v, "mods", e)?;
    let mut out = Vec::with_capacity(items.len());
    // Duplicate compareKeys are an ERROR: two mods with one identity means
    // every downstream lookup silently picks one of them.
    let mut seen: HashMap<String, usize> = HashMap::new();

    for (i, item) in items.iter().enumerate() {
        let path = format!("mods[{i}]");
        let Some(mo) = obj_at(Some(item), &path, e) else { continue };
        let compare_key = req_string(mo, "compareKey", &path, e);
        let name = req_string(mo, "name", &path, e);
        let version = opt_string(mo, "version", &path, e);
        let install = validate_install_spec(mo.get("install"), &format!("{path}.install"), e);
        let state = validate_install_state(mo.get("state"), &format!("{path}.state"), e);
        let attributes = validate_ui_attributes(mo.get("attributes"), &path, e);
        let source = validate_source(mo.get("source"), &format!("{path}.source"), e);

        if let Some(key) = compare_key.as_ref() {
            if let Some(prev) = seen.insert(key.clone(), i) {
                e.push(format!(
                    "Duplicate compareKey {key:?} at mods[{i}] and mods[{prev}]. \
                     Every mod must have a distinct identity."
                ));
            }
        }

        let (Some(compare_key), Some(name), Some(install), Some(state), Some(source)) =
            (compare_key, name, install, state, source)
        else {
            continue;
        };
        out.push(EhcollMod { compare_key, name, version, install, state, attributes, source });
    }
    Some(out)
}

fn validate_source(v: Option<&Value>, path: &str, e: &mut Vec<String>) -> Option<ModSource> {
    let o = obj_at(v, path, e)?;
    let kind = req_string(o, "kind", path, e)?;
    match kind.as_str() {
        "nexus" => {
            let game_domain = req_string(o, "gameDomain", path, e);
            let mod_id = req_uint(o, "modId", path, e);
            let file_id = req_uint(o, "fileId", path, e);
            let archive_name = req_string(o, "archiveName", path, e);
            // Mandatory here: Nexus is fetched by id, then VERIFIED by hash.
            let sha256 = req_sha256(o, "sha256", path, e);
            Some(ModSource::Nexus(NexusModSource {
                game_domain: game_domain?,
                mod_id: mod_id?,
                file_id: file_id?,
                archive_name: archive_name?,
                sha256: sha256?,
            }))
        }
        "external" => {
            let expected_filename = req_string(o, "expectedFilename", path, e);
            let sha256 = opt_sha256(o, "sha256", path, e);
            let staging_set_hash = opt_sha256(o, "stagingSetHash", path, e);
            let instructions = opt_string(o, "instructions", path, e);
            let url = validate_external_url(o.get("url"), &format!("{path}.url"), e);
            // An unknown mode is DROPPED, not rejected - same proportionality
            // argument as the url.
            let download_mode = match present(o.get("downloadMode")).and_then(Value::as_str) {
                Some("direct") => Some(DownloadMode::Direct),
                Some("browse") => Some(DownloadMode::Browse),
                Some("manual") => Some(DownloadMode::Manual),
                _ => None,
            };
            let bundled = req_bool(o, "bundled", path, e);

            // Identity-oracle invariant. Presence is judged on the RAW field,
            // not on the validated value: a malformed sha256 has already been
            // reported, and reporting "no identity" as well would be a second
            // complaint about one mistake.
            let sha_present = present(o.get("sha256")).is_some();
            let staging_present = present(o.get("stagingSetHash")).is_some();
            if !sha_present && !staging_present {
                e.push(format!(
                    "{path} must define either \"sha256\" (archive identity) or \
                     \"stagingSetHash\" (deployed-files identity). Both absent means \
                     the mod cannot be identified on another machine."
                ));
            }
            // Bundled archives live at bundled/<sha256>.<ext>, so bundling
            // without the hash has no address to write to.
            if bundled == Some(true) && !sha_present {
                e.push(format!(
                    "{path}.bundled is true but {path}.sha256 is missing. \
                     Bundled archives are addressed by archive sha256."
                ));
            }

            Some(ModSource::External(ExternalModSource {
                expected_filename: expected_filename?,
                sha256,
                instructions,
                url,
                download_mode,
                bundled: bundled?,
                staging_set_hash,
            }))
        }
        other => {
            e.push(format!("{path}.kind must be \"nexus\" or \"external\", got {other:?}."));
            None
        }
    }
}

/// A link the user can actually open.
///
/// Anything that is not `http(s)` is DROPPED rather than rejected: a manifest
/// is not invalid because it carries an origin we cannot present, and refusing
/// a whole collection over one unusable link would be wildly out of
/// proportion. The mod still has its instructions.
fn validate_external_url(v: Option<&Value>, path: &str, e: &mut Vec<String>) -> Option<String> {
    let raw = present(v)?;
    let Some(s) = raw.as_str() else {
        e.push(format!("{path} must be a string when present, got {}.", describe(raw)));
        return None;
    };
    let trimmed = s.trim();
    let lower = trimmed.to_ascii_lowercase();
    let looks_http = (lower.starts_with("http://") || lower.starts_with("https://"))
        && trimmed.len() > lower.find("//").map_or(0, |i| i + 2)
        && !trimmed.chars().any(char::is_whitespace);
    if looks_http {
        Some(trimmed.to_owned())
    } else {
        None
    }
}

fn validate_install_spec(v: Option<&Value>, path: &str, e: &mut Vec<String>) -> Option<ModInstallSpec> {
    let o = obj_at(v, path, e)?;
    let steps = arr_at(o.get("fomodSelections"), &format!("{path}.fomodSelections"), e)?;
    let mut fomod_selections = Vec::with_capacity(steps.len());
    for (i, step) in steps.iter().enumerate() {
        let sp = format!("{path}.fomodSelections[{i}]");
        let Some(so) = obj_at(Some(step), &sp, e) else { continue };
        let name = req_string(so, "name", &sp, e);
        let Some(groups_raw) = arr_at(so.get("groups"), &format!("{sp}.groups"), e) else {
            continue;
        };
        let mut groups = Vec::with_capacity(groups_raw.len());
        for (gi, g) in groups_raw.iter().enumerate() {
            let gp = format!("{sp}.groups[{gi}]");
            let Some(go) = obj_at(Some(g), &gp, e) else { continue };
            let gname = req_string(go, "name", &gp, e);
            let Some(choices_raw) = arr_at(go.get("choices"), &format!("{gp}.choices"), e) else {
                continue;
            };
            let mut choices = Vec::with_capacity(choices_raw.len());
            for (ci, c) in choices_raw.iter().enumerate() {
                let cp = format!("{gp}.choices[{ci}]");
                let Some(co) = obj_at(Some(c), &cp, e) else { continue };
                let cname = req_string(co, "name", &cp, e);
                let idx = opt_uint(co, "idx", &cp, e);
                if let Some(name) = cname {
                    choices.push(FomodSelectedChoice { name, idx });
                }
            }
            if let Some(name) = gname {
                groups.push(FomodSelectionGroup { name, choices });
            }
        }
        if let Some(name) = name {
            fomod_selections.push(FomodSelectionStep { name, groups });
        }
    }
    Some(ModInstallSpec {
        fomod_selections,
        installer_type: opt_string(o, "installerType", path, e),
        installer_choices_type: opt_string(o, "installerChoicesType", path, e),
    })
}

fn validate_install_state(v: Option<&Value>, path: &str, e: &mut Vec<String>) -> Option<ModInstallState> {
    let o = obj_at(v, path, e)?;
    let enabled = req_bool(o, "enabled", path, e);
    let install_order = req_int(o, "installOrder", path, e);
    let deployment_priority = req_int(o, "deploymentPriority", path, e);

    let staging_files = match present(o.get("stagingFiles")) {
        None => None,
        Some(val) => match val.as_array() {
            None => {
                e.push(format!(
                    "{path}.stagingFiles must be an array when present, got {}.",
                    describe(val)
                ));
                None
            }
            Some(items) => {
                let mut files = Vec::with_capacity(items.len());
                for (i, item) in items.iter().enumerate() {
                    let fp = format!("{path}.stagingFiles[{i}]");
                    let Some(fo) = obj_at(Some(item), &fp, e) else { continue };
                    let fpath = req_string(fo, "path", &fp, e);
                    let size = req_uint(fo, "size", &fp, e);
                    let sha256 = opt_sha256(fo, "sha256", &fp, e);
                    if let (Some(p), Some(s)) = (fpath, size) {
                        files.push(EhcollStagingFile { path: p, size: s, sha256 });
                    }
                }
                Some(files)
            }
        },
    };

    Some(ModInstallState {
        enabled: enabled?,
        install_order: install_order?,
        deployment_priority: deployment_priority?,
        mod_type: opt_string(o, "modType", path, e),
        mirrored: opt_bool(o, "mirrored", path, e),
        enabled_ini_tweaks: opt_string_array(o, "enabledINITweaks", path, e),
        post_processed: opt_bool(o, "postProcessed", path, e),
        staging_files,
    })
}

fn validate_ui_attributes(v: Option<&Value>, path: &str, e: &mut Vec<String>) -> Option<ModUiAttributes> {
    let raw = present(v)?;
    let Some(o) = raw.as_object() else {
        e.push(format!("{path}.attributes must be an object when present, got {}.", describe(raw)));
        return None;
    };
    let ap = format!("{path}.attributes");
    Some(ModUiAttributes {
        category: opt_string(o, "category", &ap, e),
        description: opt_string(o, "description", &ap, e),
    })
}

fn validate_rules(v: Option<&Value>, e: &mut Vec<String>) -> Option<Vec<EhcollRule>> {
    let items = arr_at(v, "rules", e)?;
    let mut out = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        let path = format!("rules[{i}]");
        let Some(o) = obj_at(Some(item), &path, e) else { continue };
        let source = req_string(o, "source", &path, e);
        let rule_type = req_enum(
            o,
            "type",
            &path,
            &[
                ("before", ModRuleType::Before),
                ("after", ModRuleType::After),
                ("requires", ModRuleType::Requires),
                ("recommends", ModRuleType::Recommends),
                ("conflicts", ModRuleType::Conflicts),
                ("provides", ModRuleType::Provides),
            ],
            e,
        );
        let reference = req_string(o, "reference", &path, e);
        let comment = opt_string(o, "comment", &path, e);
        let ignored = opt_bool(o, "ignored", &path, e);
        if let (Some(source), Some(rule_type), Some(reference)) = (source, rule_type, reference) {
            out.push(EhcollRule { source, rule_type, reference, comment, ignored });
        }
    }
    Some(out)
}

fn validate_plugins(v: Option<&Value>, e: &mut Vec<String>) -> Option<EhcollPlugins> {
    let o = obj_at(v, "plugins", e)?;
    let items = arr_at(o.get("order"), "plugins.order", e)?;
    let mut order = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        let path = format!("plugins.order[{i}]");
        let Some(po) = obj_at(Some(item), &path, e) else { continue };
        let name = req_string(po, "name", &path, e);
        let enabled = req_bool(po, "enabled", &path, e);
        // Absent means UNKNOWN, never "not light" - treating it as false
        // would clear ESL flags the user legitimately has.
        let light = opt_bool(po, "light", &path, e);
        if let (Some(name), Some(enabled)) = (name, enabled) {
            order.push(EhcollPluginEntry { name, enabled, light });
        }
    }
    Some(EhcollPlugins { order })
}

fn validate_load_order(v: Option<&Value>, e: &mut Vec<String>) -> Option<Vec<EhcollLoadOrderEntry>> {
    // Back-filled: absent is valid v1.
    let Some(raw) = present(v) else { return Some(Vec::new()) };
    let Some(items) = raw.as_array() else {
        e.push(format!("loadOrder must be an array, got {}.", describe(raw)));
        return None;
    };
    let mut out = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        let path = format!("loadOrder[{i}]");
        let Some(o) = obj_at(Some(item), &path, e) else { continue };
        let compare_key = req_string(o, "compareKey", &path, e);
        let pos = req_int(o, "pos", &path, e);
        let enabled = req_bool(o, "enabled", &path, e);
        let locked = opt_bool(o, "locked", &path, e);
        if let (Some(compare_key), Some(pos), Some(enabled)) = (compare_key, pos, enabled) {
            out.push(EhcollLoadOrderEntry { compare_key, pos, enabled, locked });
        }
    }
    Some(out)
}

fn validate_userlist(v: Option<&Value>, e: &mut Vec<String>) -> Option<EhcollUserlist> {
    let Some(raw) = present(v) else { return Some(EhcollUserlist::default()) };
    let Some(o) = raw.as_object() else {
        e.push(format!("userlist must be an object, got {}.", describe(raw)));
        return None;
    };

    let mut plugins = Vec::new();
    let mut seen_plugins: HashMap<String, usize> = HashMap::new();
    if let Some(items) = arr_at(o.get("plugins"), "userlist.plugins", e) {
        for (i, item) in items.iter().enumerate() {
            let path = format!("userlist.plugins[{i}]");
            let Some(po) = obj_at(Some(item), &path, e) else { continue };
            let Some(name) = req_string(po, "name", &path, e) else { continue };
            // Matched case-insensitively, so duplicates are too.
            if let Some(prev) = seen_plugins.insert(name.to_lowercase(), i) {
                e.push(format!(
                    "Duplicate userlist plugin {name:?} at userlist.plugins[{i}] and \
                     userlist.plugins[{prev}]."
                ));
            }
            plugins.push(EhcollUserlistPlugin {
                name,
                group: opt_string(po, "group", &path, e),
                after: opt_string_array(po, "after", &path, e),
                req: opt_string_array(po, "req", &path, e),
                inc: opt_string_array(po, "inc", &path, e),
            });
        }
    }

    let mut groups = Vec::new();
    let mut seen_groups: HashMap<String, usize> = HashMap::new();
    if let Some(items) = arr_at(o.get("groups"), "userlist.groups", e) {
        for (i, item) in items.iter().enumerate() {
            let path = format!("userlist.groups[{i}]");
            let Some(go) = obj_at(Some(item), &path, e) else { continue };
            let Some(name) = req_string(go, "name", &path, e) else { continue };
            if let Some(prev) = seen_groups.insert(name.to_lowercase(), i) {
                e.push(format!(
                    "Duplicate userlist group {name:?} at userlist.groups[{i}] and \
                     userlist.groups[{prev}]."
                ));
            }
            groups.push(EhcollUserlistGroup { name, after: opt_string_array(go, "after", &path, e) });
        }
    }

    Some(EhcollUserlist { plugins, groups })
}

fn validate_ini_tweaks(v: Option<&Value>, e: &mut Vec<String>) -> Option<Vec<EhcollIniTweak>> {
    let items = arr_at(v, "iniTweaks", e)?;
    let mut out = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        let path = format!("iniTweaks[{i}]");
        let Some(o) = obj_at(Some(item), &path, e) else { continue };
        let ini = req_string(o, "ini", &path, e);
        let section = req_string(o, "section", &path, e);
        let key = req_string(o, "key", &path, e);
        let value = req_string(o, "value", &path, e);
        if let (Some(ini), Some(section), Some(key), Some(value)) = (ini, section, key, value) {
            out.push(EhcollIniTweak { ini, section, key, value });
        }
    }
    Some(out)
}

fn validate_game_ini(v: Option<&Value>, e: &mut Vec<String>) -> Option<EhcollGameIni> {
    // Additive like loadOrder and userlist: absence is not an error.
    let raw = present(v)?;
    let Some(o) = raw.as_object() else {
        e.push(format!("gameIni must be an object when present, got {}.", describe(raw)));
        return None;
    };
    let items = arr_at(o.get("files"), "gameIni.files", e)?;
    let mut files = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        let path = format!("gameIni.files[{i}]");
        let Some(fo) = obj_at(Some(item), &path, e) else { continue };
        let file_name = req_string(fo, "fileName", &path, e);
        let Some(settings_raw) = arr_at(fo.get("settings"), &format!("{path}.settings"), e) else {
            continue;
        };
        let mut settings = Vec::with_capacity(settings_raw.len());
        for (si, s) in settings_raw.iter().enumerate() {
            let sp = format!("{path}.settings[{si}]");
            let Some(so) = obj_at(Some(s), &sp, e) else { continue };
            let section = req_string(so, "section", &sp, e);
            let key = req_string(so, "key", &sp, e);
            let value = req_string(so, "value", &sp, e);
            if let (Some(section), Some(key), Some(value)) = (section, key, value) {
                settings.push(EhcollGameIniSetting { section, key, value });
            }
        }
        if let Some(file_name) = file_name {
            files.push(EhcollGameIniFile { file_name, settings });
        }
    }
    Some(EhcollGameIni { files })
}

fn validate_external_dependencies(
    v: Option<&Value>,
    e: &mut Vec<String>,
) -> Option<Vec<EhcollExternalDependency>> {
    let items = arr_at(v, "externalDependencies", e)?;
    let mut out = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        let path = format!("externalDependencies[{i}]");
        let Some(o) = obj_at(Some(item), &path, e) else { continue };
        let id = req_string(o, "id", &path, e);
        let name = req_string(o, "name", &path, e);
        let category = req_string(o, "category", &path, e);
        let version = req_string(o, "version", &path, e);
        let destination = req_enum(
            o,
            "destination",
            &path,
            &[
                ("<gameDir>", ExternalDependencyDestination::GameDir),
                ("<dataDir>", ExternalDependencyDestination::DataDir),
                ("<scripts>", ExternalDependencyDestination::Scripts),
            ],
            e,
        );
        // Mandatory: the user has to do work by hand, so they must be told what.
        let instructions = req_string(o, "instructions", &path, e);
        let instructions_url = opt_string(o, "instructionsUrl", &path, e);

        let Some(files_raw) = arr_at(o.get("files"), &format!("{path}.files"), e) else { continue };
        let mut files = Vec::with_capacity(files_raw.len());
        for (fi, f) in files_raw.iter().enumerate() {
            let fp = format!("{path}.files[{fi}]");
            let Some(fo) = obj_at(Some(f), &fp, e) else { continue };
            let rel_path = req_string(fo, "relPath", &fp, e);
            let sha256 = req_sha256(fo, "sha256", &fp, e);
            if let (Some(rel_path), Some(sha256)) = (rel_path, sha256) {
                files.push(ExternalDependencyFile { rel_path, sha256 });
            }
        }

        if let (Some(id), Some(name), Some(category), Some(version), Some(destination), Some(instructions)) =
            (id, name, category, version, destination, instructions)
        {
            out.push(EhcollExternalDependency {
                id,
                name,
                category,
                version,
                destination,
                files,
                instructions_url,
                instructions,
            });
        }
    }
    Some(out)
}

// ───────────────────────────────────────────────────────────────────────────
// Cross-reference pass — WARNINGS ONLY
//
// A manifest with an unresolvable rule is structurally valid; the resolver
// skips it at install time. Refusing the whole collection over one dangling
// reference would be out of proportion.
// ───────────────────────────────────────────────────────────────────────────

/// Groups values by key while preserving first-seen order, so warning output
/// is deterministic. (A `HashMap` would emit them in a different order every
/// run, which makes both tests and bug reports harder to compare.)
fn group_in_order(pairs: Vec<(String, String)>) -> Vec<(String, Vec<String>)> {
    let mut order: Vec<String> = Vec::new();
    let mut buckets: HashMap<String, Vec<String>> = HashMap::new();
    for (key, value) in pairs {
        if !buckets.contains_key(&key) {
            order.push(key.clone());
        }
        buckets.entry(key).or_default().push(value);
    }
    order
        .into_iter()
        .map(|k| {
            let v = buckets.remove(&k).unwrap_or_default();
            (k, v)
        })
        .collect()
}

fn quoted_list(keys: &[String]) -> String {
    keys.iter().map(|k| format!("\"{k}\"")).collect::<Vec<_>>().join(", ")
}

fn short(hash: &str) -> String {
    hash.chars().take(12).collect()
}

fn cross_reference_validate(m: &EhcollManifest) -> Vec<String> {
    let mut warnings = Vec::new();
    let compare_keys: std::collections::HashSet<&str> =
        m.mods.iter().map(|x| x.compare_key.as_str()).collect();

    // External-mod identity collisions. Bucket on whichever oracle the mod
    // carries - archive sha256 first, then stagingSetHash. Mods identified by
    // staging set are only checked against each other; cross-bucket collisions
    // are not meaningful.
    let mut by_sha: Vec<(String, String)> = Vec::new();
    let mut by_staging: Vec<(String, String)> = Vec::new();
    for mod_entry in &m.mods {
        if let ModSource::External(src) = &mod_entry.source {
            if let Some(sha) = &src.sha256 {
                by_sha.push((sha.clone(), mod_entry.compare_key.clone()));
            } else if let Some(set_hash) = &src.staging_set_hash {
                by_staging.push((set_hash.clone(), mod_entry.compare_key.clone()));
            }
        }
    }
    for (sha, keys) in group_in_order(by_sha) {
        if keys.len() > 1 {
            warnings.push(format!(
                "External mods {} share the same archiveSha256 ({}…). The package can \
                 only bundle the archive once; the resolver will install both pointing \
                 at the same bytes. Likely a curator dedupe oversight.",
                quoted_list(&keys),
                short(&sha)
            ));
        }
    }
    for (set_hash, keys) in group_in_order(by_staging) {
        if keys.len() > 1 {
            warnings.push(format!(
                "External mods {} share the same stagingSetHash ({}…). Their deployed \
                 file sets are byte-identical. Likely a curator dedupe oversight.",
                quoted_list(&keys),
                short(&set_hash)
            ));
        }
    }

    for (i, rule) in m.rules.iter().enumerate() {
        if !compare_keys.contains(rule.source.as_str()) {
            warnings.push(format!(
                "rules[{i}].source \"{}\" does not match any mod's compareKey. The rule \
                 will be skipped at install time.",
                rule.source
            ));
        }
        // A partially-pinned reference like "nexus:1234" legitimately matches
        // nothing here and resolves on the user side, so only fully-pinned
        // references are worth warning about.
        if is_fully_pinned_reference(&rule.reference)
            && !compare_keys.contains(rule.reference.as_str())
        {
            warnings.push(format!(
                "rules[{i}].reference \"{}\" does not match any mod's compareKey. The \
                 rule's target may resolve via partial pin at install time, or be \
                 unenforceable.",
                rule.reference
            ));
        }
    }

    // Loose load-order entries (a mod the curator had locally but did not
    // pack) are warned only - the driver skips them gracefully.
    for (i, entry) in m.load_order.iter().enumerate() {
        if !compare_keys.contains(entry.compare_key.as_str()) {
            warnings.push(format!(
                "loadOrder[{i}].compareKey \"{}\" does not match any mod's compareKey. \
                 The entry will be skipped at install time.",
                entry.compare_key
            ));
        }
    }

    // Userlist plugin entries should match a plugin in plugins.order, because
    // the curator-side scoping pass enforces that - a mismatch implies a
    // hand-edited manifest. The after/req/inc REFERENCES are deliberately not
    // validated: they intentionally reach outside the collection to vanilla
    // masters and common community plugins, which is the only way LOOT rules
    // work in practice.
    let collection_plugins: std::collections::HashSet<String> =
        m.plugins.order.iter().map(|p| p.name.to_lowercase()).collect();
    for (i, entry) in m.userlist.plugins.iter().enumerate() {
        if !collection_plugins.contains(&entry.name.to_lowercase()) {
            warnings.push(format!(
                "userlist.plugins[{i}].name \"{}\" does not match any plugin in \
                 plugins.order. The entry will be skipped at install time. (Likely a \
                 hand-edited manifest - the curator-side scoping pass drops these.)",
                entry.name
            ));
        }
    }

    // Group rules pointing at a group not defined here are tolerated: the
    // user's local userlist may carry the missing definition.
    let group_names: std::collections::HashSet<String> =
        m.userlist.groups.iter().map(|g| g.name.to_lowercase()).collect();
    for (i, group) in m.userlist.groups.iter().enumerate() {
        let Some(after) = &group.after else { continue };
        for (j, reference) in after.iter().enumerate() {
            if !group_names.contains(&reference.to_lowercase()) {
                warnings.push(format!(
                    "userlist.groups[{i}].after[{j}] \"{reference}\" does not match any \
                     group defined in userlist.groups. Vortex will tolerate the dangling \
                     reference but the rule may not behave as intended."
                ));
            }
        }
    }

    warnings
}
