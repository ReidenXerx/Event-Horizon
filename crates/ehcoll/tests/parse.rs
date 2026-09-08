//! Validation tests driven from a REAL manifest.
//!
//! `spec/fixtures/manifests/valid/roundtrip.json` was emitted by the
//! TypeScript `buildManifest` itself, not written by hand. Per
//! `spec/README.md`, compatibility fixtures are generated from the normative
//! implementation — hand-writing one would only test my transcription of the
//! schema against my transcription of the schema.
//!
//! Negative cases start from that manifest and break exactly one thing, so
//! every failure is attributable and no test accidentally passes because the
//! fixture was malformed in some other way.

use ehcoll::*;
use serde_json::{json, Value};

const FIXTURE: &str = include_str!("../../../spec/fixtures/manifests/valid/roundtrip.json");

fn valid() -> Value {
    serde_json::from_str(FIXTURE).expect("fixture is valid JSON")
}

fn parse(v: &Value) -> Result<ParseOutcome, ParseError> {
    parse_manifest(&v.to_string())
}

fn errors_of(v: &Value) -> Vec<String> {
    parse(v).err().map(|e| e.errors).unwrap_or_default()
}

fn assert_error_mentioning(v: &Value, needle: &str) {
    let errors = errors_of(v);
    assert!(
        errors.iter().any(|e| e.contains(needle)),
        "expected an error mentioning {needle:?}, got: {errors:#?}"
    );
}

// ── The real thing ─────────────────────────────────────────────────────────

#[test]
fn the_manifest_typescript_produced_parses_here() {
    let outcome = parse(&valid()).expect("a manifest buildManifest emitted must parse");
    let m = outcome.manifest;

    assert_eq!(m.schema_version, 1);
    assert_eq!(m.game.id, SupportedGameId::Fallout4);
    assert_eq!(m.game.version_policy, GameVersionPolicy::Exact);
    assert_eq!(m.mods.len(), 2);
    assert_eq!(m.plugins.order.len(), 3);
    assert_eq!(m.load_order.len(), 2);
    assert_eq!(m.userlist.plugins.len(), 2);
    assert_eq!(m.external_dependencies.len(), 1);
    assert!(m.game_ini.is_some());

    // Both arms of the discriminated union survived the port.
    let kinds: Vec<&str> = m
        .mods
        .iter()
        .map(|x| match x.source {
            ModSource::Nexus(_) => "nexus",
            ModSource::External(_) => "external",
        })
        .collect();
    assert!(kinds.contains(&"nexus") && kinds.contains(&"external"), "{kinds:?}");
}

#[test]
fn parsing_is_stable_across_a_serde_round_trip() {
    // Our own serialisation must be re-readable by our own parser: if it is
    // not, we cannot write a manifest the other side can read either.
    let first = parse(&valid()).unwrap().manifest;
    let reserialised = serde_json::to_string(&first).unwrap();
    let second = parse_manifest(&reserialised).unwrap().manifest;
    assert_eq!(first, second);
}

// ── The schemaVersion gate ─────────────────────────────────────────────────

#[test]
fn an_unknown_schema_version_is_refused_immediately_and_alone() {
    let mut v = valid();
    v["schemaVersion"] = json!(2);
    // Break something else too - it must NOT be reported, because with an
    // unknown version we do not know what the rest of the document means.
    v["package"] = json!("not an object");

    let errors = errors_of(&v);
    assert_eq!(errors.len(), 1, "the gate reports alone: {errors:#?}");
    assert!(errors[0].contains("schemaVersion"), "{}", errors[0]);
}

#[test]
fn a_missing_schema_version_is_refused() {
    let mut v = valid();
    v.as_object_mut().unwrap().remove("schemaVersion");
    assert_error_mentioning(&v, "schemaVersion");
}

#[test]
fn a_non_object_top_level_is_refused() {
    assert!(parse_manifest("[]").is_err());
    assert!(parse_manifest("\"hello\"").is_err());
    assert!(parse_manifest("null").is_err());
}

#[test]
fn invalid_json_is_one_clear_error_not_a_panic() {
    let err = parse_manifest("{ not json").unwrap_err();
    assert_eq!(err.errors.len(), 1);
    assert!(err.errors[0].contains("not valid JSON"), "{}", err.errors[0]);
}

// ── No whack-a-mole ────────────────────────────────────────────────────────

#[test]
fn every_problem_is_reported_together_not_one_at_a_time() {
    let mut v = valid();
    v["package"].as_object_mut().unwrap().remove("author");
    v["game"]["id"] = json!("morrowind");
    v["vortex"]["deploymentMethod"] = json!("teleport");
    v.as_object_mut().unwrap().remove("rules");

    let errors = errors_of(&v);
    assert!(errors.len() >= 4, "expected all four, got: {errors:#?}");
    assert!(errors.iter().any(|e| e.contains("author")));
    assert!(errors.iter().any(|e| e.contains("morrowind")));
    assert!(errors.iter().any(|e| e.contains("teleport")));
    assert!(errors.iter().any(|e| e.contains("rules")));
}

#[test]
fn the_error_message_lists_them_all() {
    let mut v = valid();
    v["package"].as_object_mut().unwrap().remove("author");
    v["package"].as_object_mut().unwrap().remove("name");
    let rendered = parse(&v).unwrap_err().to_string();
    assert!(rendered.contains("2 problems"), "{rendered}");
    assert!(rendered.contains("author") && rendered.contains("name"), "{rendered}");
}

// ── Additive schema ────────────────────────────────────────────────────────

#[test]
fn unknown_fields_are_ignored_so_a_v1_1_manifest_still_reads() {
    let mut v = valid();
    v["someFieldFromTheFuture"] = json!({ "nested": [1, 2, 3] });
    v["package"]["anotherOne"] = json!("hello");
    parse(&v).expect("additive fields must not break a v1 reader");
}

#[test]
fn load_order_and_userlist_are_backfilled_when_absent() {
    let mut v = valid();
    v.as_object_mut().unwrap().remove("loadOrder");
    v.as_object_mut().unwrap().remove("userlist");
    v.as_object_mut().unwrap().remove("gameIni");

    let m = parse(&v).expect("older v1 manifests must parse").manifest;
    assert!(m.load_order.is_empty());
    assert!(m.userlist.plugins.is_empty() && m.userlist.groups.is_empty());
    assert!(m.game_ini.is_none());
}

#[test]
fn an_absent_verification_level_is_not_an_error() {
    let mut v = valid();
    v["package"].as_object_mut().unwrap().remove("verificationLevel");
    let m = parse(&v).unwrap().manifest;
    assert_eq!(m.package.verification_level, None, "absent reads as None, not as an error");
}

// ── Identity invariants ────────────────────────────────────────────────────

fn external_index(v: &Value) -> usize {
    v["mods"]
        .as_array()
        .unwrap()
        .iter()
        .position(|m| m["source"]["kind"] == "external")
        .expect("fixture has an external mod")
}

#[test]
fn an_external_mod_with_no_identity_oracle_at_all_is_refused() {
    let mut v = valid();
    let i = external_index(&v);
    let src = v["mods"][i]["source"].as_object_mut().unwrap();
    src.remove("sha256");
    src.remove("stagingSetHash");
    src.insert("bundled".into(), json!(false));
    assert_error_mentioning(&v, "stagingSetHash");
}

#[test]
fn an_external_mod_identified_only_by_staging_set_is_accepted() {
    let mut v = valid();
    let i = external_index(&v);
    let src = v["mods"][i]["source"].as_object_mut().unwrap();
    src.remove("sha256");
    src.insert("bundled".into(), json!(false));
    src.insert("stagingSetHash".into(), json!("a".repeat(64)));
    parse(&v).expect("stagingSetHash alone is a valid identity");
}

#[test]
fn bundling_without_an_archive_hash_is_refused() {
    let mut v = valid();
    let i = external_index(&v);
    let src = v["mods"][i]["source"].as_object_mut().unwrap();
    src.remove("sha256");
    src.insert("stagingSetHash".into(), json!("b".repeat(64)));
    src.insert("bundled".into(), json!(true));
    // bundled/<sha256>.<ext> has no address without the hash.
    assert_error_mentioning(&v, "bundled is true");
}

#[test]
fn a_duplicate_compare_key_is_an_error_not_a_warning() {
    let mut v = valid();
    let first = v["mods"][0]["compareKey"].clone();
    v["mods"][1]["compareKey"] = first;
    assert_error_mentioning(&v, "Duplicate compareKey");
}

#[test]
fn an_uppercase_sha256_is_rejected_rather_than_normalised() {
    let mut v = valid();
    let i = external_index(&v);
    v["mods"][i]["source"]["sha256"] = json!("A".repeat(64));
    assert_error_mentioning(&v, "lowercase hex");
}

#[test]
fn a_short_sha256_is_rejected() {
    let mut v = valid();
    let i = external_index(&v);
    v["mods"][i]["source"]["sha256"] = json!("abc123");
    assert_error_mentioning(&v, "64 characters");
}

#[test]
fn an_unsupported_game_is_refused() {
    let mut v = valid();
    v["game"]["id"] = json!("oblivion");
    assert_error_mentioning(&v, "oblivion");
}

// ── Proportionality: dropped, not rejected ─────────────────────────────────

#[test]
fn a_url_we_cannot_present_is_dropped_not_treated_as_invalid() {
    for bad in ["nxm://fallout4/mods/1/files/2", "C:\\Users\\curator\\Downloads\\x.7z", "ftp://x/y"] {
        let mut v = valid();
        let i = external_index(&v);
        v["mods"][i]["source"]["url"] = json!(bad);
        let m = parse(&v)
            .unwrap_or_else(|e| panic!("{bad:?} must not invalidate the manifest: {e}"))
            .manifest;
        let ModSource::External(src) = &m.mods[i].source else { panic!("expected external") };
        assert_eq!(src.url, None, "{bad:?} should have been dropped");
    }
}

#[test]
fn an_http_url_survives_and_is_trimmed() {
    let mut v = valid();
    let i = external_index(&v);
    v["mods"][i]["source"]["url"] = json!("  https://www.loverslab.com/files/file/14263-x/  ");
    let m = parse(&v).unwrap().manifest;
    let ModSource::External(src) = &m.mods[i].source else { panic!("expected external") };
    assert_eq!(src.url.as_deref(), Some("https://www.loverslab.com/files/file/14263-x/"));
}

#[test]
fn an_unknown_download_mode_is_dropped_not_rejected() {
    let mut v = valid();
    let i = external_index(&v);
    v["mods"][i]["source"]["downloadMode"] = json!("carrier-pigeon");
    let m = parse(&v).expect("an unknown mode must not invalidate the manifest").manifest;
    let ModSource::External(src) = &m.mods[i].source else { panic!("expected external") };
    assert_eq!(src.download_mode, None);
}

// ── Cross-reference warnings ───────────────────────────────────────────────

#[test]
fn a_dangling_rule_source_warns_but_still_parses() {
    let mut v = valid();
    v["rules"][0]["source"] = json!("nexus:999999:888888");
    let outcome = parse(&v).expect("structurally valid despite the dangling rule");
    assert!(
        outcome.warnings.iter().any(|w| w.contains("rules[0].source")),
        "{:#?}",
        outcome.warnings
    );
}

#[test]
fn a_partially_pinned_reference_does_not_warn() {
    let mut v = valid();
    // "nexus:1234" names a PAGE, not a file - it legitimately resolves on the
    // user side, so warning about it here would be noise.
    v["rules"][0]["reference"] = json!("nexus:1234");
    let outcome = parse(&v).unwrap();
    assert!(
        !outcome.warnings.iter().any(|w| w.contains("rules[0].reference")),
        "a partial pin must not warn: {:#?}",
        outcome.warnings
    );
}

#[test]
fn a_fully_pinned_dangling_reference_does_warn() {
    let mut v = valid();
    v["rules"][0]["reference"] = json!("nexus:1234:5678");
    let outcome = parse(&v).unwrap();
    assert!(
        outcome.warnings.iter().any(|w| w.contains("rules[0].reference")),
        "{:#?}",
        outcome.warnings
    );
}

#[test]
fn two_external_mods_sharing_an_archive_hash_warn_about_the_dedupe() {
    let mut v = valid();
    let i = external_index(&v);
    let sha = v["mods"][i]["source"]["sha256"].clone();
    let mut clone = v["mods"][i].clone();
    clone["compareKey"] = json!("external:a-different-key");
    clone["source"]["sha256"] = sha;
    v["mods"].as_array_mut().unwrap().push(clone);

    let outcome = parse(&v).expect("a dedupe oversight is not fatal");
    assert!(
        outcome.warnings.iter().any(|w| w.contains("archiveSha256")),
        "{:#?}",
        outcome.warnings
    );
}

#[test]
fn a_userlist_plugin_outside_the_collection_warns() {
    let mut v = valid();
    v["userlist"]["plugins"][0]["name"] = json!("SomeoneElsesMod.esp");
    let outcome = parse(&v).unwrap();
    assert!(
        outcome.warnings.iter().any(|w| w.contains("userlist.plugins[0].name")),
        "{:#?}",
        outcome.warnings
    );
}

/// CONFORMANCE. The warning list below is not what I think is correct - it is
/// what the normative TypeScript `parseManifest` emitted for this exact
/// fixture, captured on 2026-09-08 and pasted here verbatim. If the two ever
/// diverge, this fails, and per `spec/README.md` the Rust side is wrong until
/// proven otherwise.
///
/// Note what it says: `"default"` is LOOT's BUILT-IN group, so a scoped
/// userlist capture never defines it and this warning fires on essentially
/// every real manifest. Both implementations do it, so it is shared
/// behaviour rather than a port bug - but it is permanent noise in the
/// warning channel and worth fixing on the TypeScript side first.
#[test]
fn warnings_match_the_normative_typescript_implementation_exactly() {
    let outcome = parse(&valid()).unwrap();
    let expected = [
        "userlist.groups[0].after[0] \"default\" does not match any group defined in \
         userlist.groups. Vortex will tolerate the dangling reference but the rule may \
         not behave as intended.",
    ];
    assert_eq!(outcome.warnings, expected, "diverged from the TypeScript side");
}
