//! The deployment plan against Vortex's own rules (read from 2.6.3's source):
//! `after` puts the rule's owner later, later wins a file, the default mod
//! type goes to Data (Starfield: the root), dinput/enb to the game root.

use eh_deploy::{plan, DeployPlan, PlanError, Target};
use ehcoll::{parse_manifest, EhcollManifest, SupportedGameId};
use serde_json::{json, Value};

const FIXTURE: &str = include_str!("../../../spec/fixtures/manifests/valid/roundtrip.json");
const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/// A Nexus mod `nexus:<id>:<id>` with these staged paths.
fn m(id: u64, order: i64, mod_type: &str, enabled: bool, files: &[&str]) -> Value {
    json!({
        "compareKey": format!("nexus:{id}:{id}"), "name": format!("Mod {id}"), "version": "1",
        "source": { "kind": "nexus", "gameDomain": "skyrimspecialedition", "modId": id, "fileId": id,
                    "archiveName": "x.7z", "sha256": SHA },
        "install": { "fomodSelections": [] },
        "state": { "enabled": enabled, "installOrder": order, "deploymentPriority": order, "modType": mod_type,
                   "stagingFiles": files.iter().map(|p| json!({ "path": p, "size": 1, "sha256": SHA })).collect::<Vec<_>>() }
    })
}

fn rule(source: u64, kind: &str, reference: &str) -> Value {
    json!({ "source": format!("nexus:{source}:{source}"), "type": kind, "reference": reference })
}

fn manifest(mods: Vec<Value>, rules: Vec<Value>) -> EhcollManifest {
    let mut v: Value = serde_json::from_str(FIXTURE).unwrap();
    v["mods"] = json!(mods);
    v["rules"] = json!(rules);
    v["loadOrder"] = json!([]);
    parse_manifest(&v.to_string()).unwrap().manifest
}

fn planned(game: SupportedGameId, mods: Vec<Value>, rules: Vec<Value>) -> DeployPlan {
    let man = manifest(mods, rules);
    plan(game, &man.mods, &man.rules).unwrap()
}

fn winner(p: &DeployPlan, path: &str) -> String {
    p.files.iter().find(|f| f.path.eq_ignore_ascii_case(path)).map(|f| f.mod_key.clone()).unwrap_or_default()
}

const SSE: SupportedGameId = SupportedGameId::Skyrimse;

#[test]
fn an_after_rule_makes_its_owner_win_even_against_install_order() {
    // Mod 1 installed LAST but has "after 2" → 1 deploys after 2 → 1 wins.
    let p = planned(SSE, vec![m(1, 9, "", true, &["textures/a.dds"]), m(2, 0, "", true, &["textures/a.dds"])],
        vec![rule(1, "after", "nexus:2:2")]);
    assert_eq!(winner(&p, "textures/a.dds"), "nexus:1:1");
    // And the reverse, to prove the rule (not install order) decided it.
    let p = planned(SSE, vec![m(1, 0, "", true, &["textures/a.dds"]), m(2, 9, "", true, &["textures/a.dds"])],
        vec![rule(1, "after", "nexus:2:2")]);
    assert_eq!(winner(&p, "textures/a.dds"), "nexus:1:1");
    assert!(!p.conflicts[0].by_install_order);
}

#[test]
fn a_before_rule_makes_its_owner_lose() {
    let p = planned(SSE, vec![m(1, 9, "", true, &["a.esp"]), m(2, 0, "", true, &["a.esp"])],
        vec![rule(1, "before", "nexus:2:2")]);
    assert_eq!(winner(&p, "a.esp"), "nexus:2:2");
    assert_eq!(p.order, ["nexus:1:1", "nexus:2:2"]);
}

#[test]
fn with_no_rule_the_later_install_wins_and_says_so() {
    let p = planned(SSE, vec![m(1, 5, "", true, &["readme.txt"]), m(2, 3, "", true, &["readme.txt"])], vec![]);
    assert_eq!(winner(&p, "readme.txt"), "nexus:1:1");
    assert!(p.conflicts[0].by_install_order, "no rule decided it");
}

#[test]
fn order_carries_through_a_chain_even_across_a_disabled_mod() {
    // 3 after 2 (disabled), 2 after 1 ⇒ 3 after 1, whatever the install order.
    let p = planned(SSE,
        vec![m(1, 9, "", true, &["x.esp"]), m(2, 5, "", false, &["x.esp"]), m(3, 0, "", true, &["x.esp"])],
        vec![rule(3, "after", "nexus:2:2"), rule(2, "after", "nexus:1:1")]);
    assert_eq!(winner(&p, "x.esp"), "nexus:3:3");
    assert_eq!(p.disabled, ["nexus:2:2"]);
    assert!(!p.order.contains(&"nexus:2:2".to_owned()), "disabled mods are staged, not deployed");
    assert!(!p.conflicts[0].by_install_order, "a rule chain decided it");
}

#[test]
fn contradicting_rules_are_a_cycle_named_by_mod() {
    let man = manifest(vec![m(1, 0, "", true, &["a"]), m(2, 1, "", true, &["a"])],
        vec![rule(1, "after", "nexus:2:2"), rule(2, "after", "nexus:1:1")]);
    match plan(SSE, &man.mods, &man.rules) {
        Err(PlanError::Cycle(names)) => assert_eq!(names, ["Mod 1", "Mod 2"]),
        other => panic!("{other:?}"),
    }
}

#[test]
fn mod_types_go_where_vortex_sends_them() {
    let p = planned(SSE, vec![m(1, 0, "", true, &["SKSE/Plugins/x.dll"]), m(2, 1, "dinput", true, &["dinput8.dll"]),
                             m(3, 2, "enb", true, &["enbseries.ini"])], vec![]);
    let target = |path: &str| p.files.iter().find(|f| f.path == path).unwrap().target;
    assert_eq!(target("SKSE/Plugins/x.dll"), Target::ModPath);
    assert_eq!(target("dinput8.dll"), Target::GameRoot);
    assert_eq!(target("enbseries.ini"), Target::GameRoot);
    assert_eq!(Target::ModPath.relative_dir(SSE), "Data");
    assert_eq!(Target::ModPath.relative_dir(SupportedGameId::Fallout4), "Data");
    assert_eq!(Target::ModPath.relative_dir(SupportedGameId::Starfield), ".", "Starfield's mod path is the root");
    assert_eq!(Target::GameRoot.relative_dir(SSE), ".");
}

#[test]
fn the_same_path_in_two_targets_is_two_files() {
    let p = planned(SSE, vec![m(1, 0, "", true, &["d3d11.dll"]), m(2, 1, "dinput", true, &["d3d11.dll"])], vec![]);
    assert_eq!(p.files.len(), 2);
    assert!(p.conflicts.is_empty());
}

#[test]
fn an_unknown_mod_type_is_reported_never_guessed() {
    let p = planned(SSE, vec![m(1, 0, "bepinex", true, &["x.dll"])], vec![]);
    assert_eq!(p.unsupported, [("nexus:1:1".to_owned(), "bepinex".to_owned())]);
    assert!(p.files.is_empty());
    assert!(!p.is_deployable());
}

#[test]
fn paths_differing_only_in_case_are_one_file_spelled_as_the_winner_spells_it() {
    let p = planned(SSE, vec![m(1, 0, "", true, &["Textures/A.dds"]), m(2, 1, "", true, &["textures/a.dds"])], vec![]);
    assert_eq!(p.files.len(), 1);
    assert_eq!(p.files[0].path, "textures/a.dds");
    assert_eq!(p.conflicts.len(), 1);
}

#[test]
fn a_page_reference_binds_every_file_of_that_mod_and_machine_local_ones_are_reported() {
    // nexus:20 (a mod page) names both 20:20 and 20:21.
    let mut v21 = m(20, 1, "", true, &["b.esp"]);
    v21["compareKey"] = json!("nexus:20:21");
    v21["source"]["fileId"] = json!(21);
    let p = planned(SSE,
        vec![m(1, 9, "", true, &["a.esp", "b.esp"]), m(20, 0, "", true, &["a.esp"]), v21],
        vec![rule(1, "after", "nexus:20"), rule(1, "after", "nexus:555"), rule(1, "after", "archive:177"), {
            let mut r = rule(1, "after", "nexus:999:999");
            r["ignored"] = json!(true);
            r
        }]);
    // Mod 1 was installed LAST anyway, so prove the page rule bound BOTH
    // files of mod 20: neither conflict was left to install order.
    assert_eq!(winner(&p, "a.esp"), "nexus:1:1");
    assert_eq!(winner(&p, "b.esp"), "nexus:1:1");
    assert!(p.conflicts.iter().all(|c| !c.by_install_order), "{:?}", p.conflicts);
    let why: Vec<&str> = p.unresolved_rules.iter().map(|u| u.why).collect();
    assert_eq!(why, ["the mod it names is not in the collection", "it names a download on the curator's machine"],
        "an ignored rule is not even reported");
}

#[test]
fn a_mod_that_loses_every_file_is_named() {
    let p = planned(SSE, vec![m(1, 0, "", true, &["a.esp"]), m(2, 1, "", true, &["a.esp", "b.esp"])], vec![]);
    assert_eq!(p.fully_overridden, ["nexus:1:1"]);
}

#[test]
fn the_plan_does_not_depend_on_the_order_mods_are_listed_in() {
    let mods = vec![m(1, 2, "", true, &["a", "b"]), m(2, 0, "", true, &["b", "c"]), m(3, 1, "", true, &["a", "c"])];
    let rules = vec![rule(2, "after", "nexus:3:3")];
    let p1 = planned(SSE, mods.clone(), rules.clone());
    let p2 = planned(SSE, mods.into_iter().rev().collect(), rules);
    assert_eq!(p1.order, p2.order);
    assert_eq!(p1.files, p2.files);
    assert_eq!(p1.conflicts, p2.conflicts);
}
