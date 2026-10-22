//! Part 1 of deployment: WHICH file goes WHERE, and which mod wins it.
//!
//! Pure: the manifest in, a plan out. Nothing here reads or writes the game.
//!
//! ─── VORTEX'S RULES, READ FROM ITS SOURCE (2.6.3) ───────────────────────
//! * Order (`sortMods`): a `before` rule on mod M naming R is an edge M → R;
//!   an `after` rule on M naming R is an edge R → M. The mods are then
//!   topologically sorted, and a cycle is an error — Vortex will not deploy.
//! * Winner (`deployMods` → `activate`): mods are walked in that order and
//!   each file is written into one map keyed by its normalised path, so the
//!   LATER mod wins a file both provide.
//! * Destination (`queryModPath`, `registerModType`): the default mod type
//!   goes to the game's mod path — `Data` for Skyrim SE, Fallout 3, New Vegas
//!   and Fallout 4, but `.` (the game root) for Starfield, whose mods carry
//!   `Data/` in their own paths. `dinput` and `enb` go to the game root.
//!
//! ─── WHAT DECIDES A TIE ─────────────────────────────────────────────────
//! Two mods with no rule between them: the one installed later wins
//! (`installOrder`). Measured on a real 954-mod collection, that decides 3 of
//! 4,383 contested files (a readme, a fomod/info.xml, one animation file);
//! rules decide the other 4,380. Vortex breaks the tie by its own mod order,
//! which is install order in practice.

use ehcoll::{parse_mod_reference, EhcollMod, EhcollRule, ModRuleType, ParsedModReference, SupportedGameId};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt;

/// Where in the game installation a file goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Target {
    /// The game's mod path (`Data`, or the root for Starfield).
    ModPath,
    /// The folder holding the game's executable.
    GameRoot,
}

impl Target {
    /// The target's folder, relative to the game installation.
    pub fn relative_dir(self, game: SupportedGameId) -> &'static str {
        match (self, game) {
            (Target::GameRoot, _) | (Target::ModPath, SupportedGameId::Starfield) => ".",
            (Target::ModPath, _) => "Data",
        }
    }
}

/// Where a mod type deploys, or `None` for a type this build does not know.
/// Unknown types are reported, never guessed: a wrong guess deploys files
/// into a place the game does not read, and verifies clean.
pub fn target_of(mod_type: &str) -> Option<Target> {
    match mod_type {
        "" => Some(Target::ModPath),
        "dinput" | "enb" => Some(Target::GameRoot),
        _ => None,
    }
}

/// One file to put in the game.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedFile {
    pub target: Target,
    /// Relative to the target, as the winning mod spells it.
    pub path: String,
    /// The mod that provides it.
    pub mod_key: String,
    /// Its path inside that mod's staging folder.
    pub staged_path: String,
}

/// A path more than one mod provides.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conflict {
    pub target: Target,
    pub path: String,
    pub winner: String,
    /// The others, earliest first.
    pub losers: Vec<String>,
    /// True when no rule orders the winner after every loser — install
    /// order decided it.
    pub by_install_order: bool,
}

/// A rule that could not be placed in the order, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnresolvedRule {
    pub source: String,
    pub reference: String,
    pub why: &'static str,
}

#[derive(Debug, Clone, Default)]
pub struct DeployPlan {
    /// Mods in deployment order (later wins), enabled and deployable only.
    pub order: Vec<String>,
    /// Every file to deploy, sorted by target then path.
    pub files: Vec<PlannedFile>,
    pub conflicts: Vec<Conflict>,
    pub unresolved_rules: Vec<UnresolvedRule>,
    /// Enabled mods of a type this build cannot place: (key, type).
    pub unsupported: Vec<(String, String)>,
    /// Disabled mods: staged, not deployed.
    pub disabled: Vec<String>,
    /// Enabled mods with no recorded file list.
    pub no_file_list: Vec<String>,
    /// Enabled mods every one of whose files another mod wins.
    pub fully_overridden: Vec<String>,
}

impl DeployPlan {
    /// Nothing stands in the way of deploying exactly what the curator had.
    pub fn is_deployable(&self) -> bool {
        self.unsupported.is_empty() && self.no_file_list.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanError {
    /// The rules contradict each other; Vortex refuses to deploy this too.
    Cycle(Vec<String>),
}

impl fmt::Display for PlanError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PlanError::Cycle(mods) => write!(
                f,
                "the collection's rules contradict each other (a cycle through {}), so no order satisfies them",
                mods.join(" → ")
            ),
        }
    }
}

impl std::error::Error for PlanError {}

/// Plan the deployment of `mods` under `rules` for `game`.
pub fn plan(game: SupportedGameId, mods: &[EhcollMod], rules: &[EhcollRule]) -> Result<DeployPlan, PlanError> {
    let _ = game; // the destination folder is resolved per target at apply time
    let mut out = DeployPlan::default();

    // Which mods take part: enabled, of a known type, with a file list.
    let mut deployable: Vec<&EhcollMod> = Vec::new();
    for m in mods {
        let mod_type = m.state.mod_type.as_deref().unwrap_or("");
        if !m.state.enabled {
            out.disabled.push(m.compare_key.clone());
        } else if target_of(mod_type).is_none() {
            out.unsupported.push((m.compare_key.clone(), mod_type.to_owned()));
        } else if m.state.staging_files.is_none() {
            out.no_file_list.push(m.compare_key.clone());
        } else {
            deployable.push(m);
        }
    }

    let edges = rule_edges(mods, rules, &mut out.unresolved_rules);
    let order = sort(&deployable, mods, &edges)?;
    let mut graph = Reach::new(&edges);

    // Walk in order; a later mod's file replaces an earlier one's, keyed
    // case-insensitively — one file to Windows, and so to the game.
    struct Slot<'m> {
        winner: (&'m EhcollMod, &'m str),
        losers: Vec<&'m EhcollMod>,
    }
    let mut map: BTreeMap<(Target, String), Slot> = BTreeMap::new();
    for m in &order {
        let target = target_of(m.state.mod_type.as_deref().unwrap_or("")).expect("filtered above");
        for f in m.state.staging_files.as_deref().unwrap_or_default() {
            let key = (target, path_key(&f.path));
            match map.get_mut(&key) {
                // The same mod listing one file twice in different case:
                // still one file, and not a conflict with itself.
                Some(slot) if std::ptr::eq(slot.winner.0, *m) => slot.winner.1 = f.path.as_str(),
                Some(slot) => {
                    let previous = std::mem::replace(&mut slot.winner, (m, f.path.as_str()));
                    slot.losers.push(previous.0);
                }
                None => {
                    map.insert(key, Slot { winner: (m, f.path.as_str()), losers: Vec::new() });
                }
            }
        }
    }

    let mut won: BTreeSet<&str> = BTreeSet::new();
    for ((target, _), slot) in &map {
        let (winner, path) = slot.winner;
        won.insert(winner.compare_key.as_str());
        out.files.push(PlannedFile {
            target: *target,
            path: path.to_owned(),
            mod_key: winner.compare_key.clone(),
            staged_path: path.to_owned(),
        });
        if !slot.losers.is_empty() {
            let mut losers: Vec<&str> = slot.losers.iter().map(|m| m.compare_key.as_str()).collect();
            losers.dedup();
            let by_rule = losers.iter().all(|l| graph.reaches(l, &winner.compare_key));
            out.conflicts.push(Conflict {
                target: *target,
                path: path.to_owned(),
                winner: winner.compare_key.clone(),
                losers: losers.into_iter().map(str::to_owned).collect(),
                by_install_order: !by_rule,
            });
        }
    }
    out.fully_overridden = order
        .iter()
        .filter(|m| {
            !m.state.staging_files.as_deref().unwrap_or_default().is_empty() && !won.contains(m.compare_key.as_str())
        })
        .map(|m| m.compare_key.clone())
        .collect();
    out.order = order.iter().map(|m| m.compare_key.clone()).collect();
    Ok(out)
}

/// The key two paths share when Windows would treat them as one file.
fn path_key(p: &str) -> String {
    p.replace('\\', "/").to_lowercase()
}

/// `before`/`after` rules as edges `earlier → later`, between mods of the
/// collection. Rules naming a mod outside it, or a reference that only has
/// meaning on the curator's machine, are reported and left out.
fn rule_edges(mods: &[EhcollMod], rules: &[EhcollRule], unresolved: &mut Vec<UnresolvedRule>) -> Vec<(String, String)> {
    let keys: BTreeSet<&str> = mods.iter().map(|m| m.compare_key.as_str()).collect();
    let mut edges = Vec::new();
    for r in rules {
        if r.ignored == Some(true) || !matches!(r.rule_type, ModRuleType::Before | ModRuleType::After) {
            continue;
        }
        let mut miss = |why| unresolved.push(UnresolvedRule { source: r.source.clone(), reference: r.reference.clone(), why });
        if !keys.contains(r.source.as_str()) {
            miss("the mod that has the rule is not in the collection");
            continue;
        }
        let targets: Vec<&str> = if keys.contains(r.reference.as_str()) {
            vec![r.reference.as_str()]
        } else {
            match parse_mod_reference(&r.reference) {
                ParsedModReference::NexusFile { nexus_mod_id, nexus_file_id } => {
                    let k = format!("nexus:{nexus_mod_id}:{nexus_file_id}");
                    keys.iter().copied().filter(|x| *x == k).collect()
                }
                // A mod PAGE: every file of it in the collection. Vortex binds
                // to the first match it finds; binding to all is the
                // deterministic superset.
                ParsedModReference::NexusMod { nexus_mod_id } => {
                    let prefix = format!("nexus:{nexus_mod_id}:");
                    keys.iter().copied().filter(|x| x.starts_with(&prefix)).collect()
                }
                ParsedModReference::Archive { .. } | ParsedModReference::LegacyId { .. } => {
                    miss("it names a download on the curator's machine");
                    continue;
                }
                ParsedModReference::Unrecognised { .. } => {
                    miss("the reference is not one this build understands");
                    continue;
                }
            }
        };
        if targets.is_empty() {
            miss("the mod it names is not in the collection");
            continue;
        }
        for t in targets {
            if t == r.source {
                continue;
            }
            match r.rule_type {
                ModRuleType::Before => edges.push((r.source.clone(), t.to_owned())),
                ModRuleType::After => edges.push((t.to_owned(), r.source.clone())),
                _ => {}
            }
        }
    }
    edges
}

/// Topological sort; among mods free to go next, the earliest installed.
/// `edges` join ALL mods, so a disabled mod in the middle of a chain still
/// carries the order across it (A after X, X after B ⇒ A after B).
fn sort<'m>(
    deployable: &[&'m EhcollMod],
    all: &[EhcollMod],
    edges: &[(String, String)],
) -> Result<Vec<&'m EhcollMod>, PlanError> {
    let by_key: HashMap<&str, &EhcollMod> = all.iter().map(|m| (m.compare_key.as_str(), m)).collect();
    let mut indegree: HashMap<&str, usize> = all.iter().map(|m| (m.compare_key.as_str(), 0)).collect();
    let mut next: HashMap<&str, Vec<&str>> = HashMap::new();
    for (a, b) in edges {
        next.entry(a.as_str()).or_default().push(b.as_str());
        *indegree.get_mut(b.as_str()).expect("edges join collection mods") += 1;
    }
    let rank = |k: &str| (by_key[k].state.install_order, k.to_owned());
    let mut ready: BTreeSet<(i64, String)> = indegree.iter().filter(|(_, d)| **d == 0).map(|(k, _)| rank(k)).collect();
    let mut sorted: Vec<&str> = Vec::with_capacity(all.len());
    while let Some(first) = ready.iter().next().cloned() {
        ready.remove(&first);
        let k = by_key[first.1.as_str()].compare_key.as_str();
        sorted.push(k);
        for n in next.get(k).cloned().unwrap_or_default() {
            let d = indegree.get_mut(n).expect("known");
            *d -= 1;
            if *d == 0 {
                ready.insert(rank(n));
            }
        }
    }
    if sorted.len() < all.len() {
        let stuck: BTreeSet<&str> = indegree.iter().filter(|(_, d)| **d > 0).map(|(k, _)| *k).collect();
        let mut names: Vec<String> = all.iter().filter(|m| stuck.contains(m.compare_key.as_str())).map(|m| m.name.clone()).collect();
        names.sort();
        return Err(PlanError::Cycle(names));
    }
    let wanted: BTreeSet<&str> = deployable.iter().map(|m| m.compare_key.as_str()).collect();
    let pick: HashMap<&str, &'m EhcollMod> = deployable.iter().map(|m| (m.compare_key.as_str(), *m)).collect();
    Ok(sorted.into_iter().filter(|k| wanted.contains(k)).map(|k| pick[k]).collect())
}

/// "Do the rules alone put A before B?", answered from an adjacency map and
/// remembered: a collection has thousands of conflicts, mostly between the
/// same few pairs of mods.
struct Reach<'e> {
    next: HashMap<&'e str, Vec<&'e str>>,
    known: HashMap<(String, String), bool>,
}

impl<'e> Reach<'e> {
    fn new(edges: &'e [(String, String)]) -> Self {
        let mut next: HashMap<&str, Vec<&str>> = HashMap::new();
        for (a, b) in edges {
            next.entry(a.as_str()).or_default().push(b.as_str());
        }
        Self { next, known: HashMap::new() }
    }

    fn reaches(&mut self, from: &str, to: &str) -> bool {
        let key = (from.to_owned(), to.to_owned());
        if let Some(&r) = self.known.get(&key) {
            return r;
        }
        let mut stack = vec![from];
        let mut seen: BTreeSet<&str> = BTreeSet::new();
        let mut found = false;
        while let Some(k) = stack.pop() {
            if k == to {
                found = true;
                break;
            }
            if seen.insert(k) {
                if let Some(n) = self.next.get(k) {
                    stack.extend(n.iter().copied());
                }
            }
        }
        self.known.insert(key, found);
        found
    }
}
