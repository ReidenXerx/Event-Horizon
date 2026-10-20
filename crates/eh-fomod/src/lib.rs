//! FOMOD: parse `ModuleConfig.xml`, evaluate conditions, replay recorded choices.
//!
//! ─── SCOPE ──────────────────────────────────────────────────────────────
//! Given a script and a set of recorded answers, compute the file set a FOMOD
//! SHOULD install — derived from no one's disk. That is the point: the
//! curator's staging folder stops being an input to correctness and becomes
//! the thing being verified.
//!
//! ─── FIDELITY IS THE RISK, AND IT IS MEASURABLE ─────────────────────────
//! This is a partial reimplementation of an installer. If it disagrees with
//! the engine that actually ran, it manufactures false mismatches — the same
//! class of bug, relocated. The TypeScript `fomodReplay.ts` grades its own
//! confidence, which is the weakest possible evidence.
//!
//! Two independent oracles exist and should be used instead of self-grading:
//! Vortex's engine, and Limo's `src/core/fomod/` (GPL-3 — read it, never
//! copy it; write our own fixtures from the spec).
//!
//! ─── CHOICES ARE NAMED, NOT POSITIONAL ──────────────────────────────────
//! Vortex records `IChoices` as `{ name, idx }`. Limo's engine takes a
//! positional `vector<vector<bool>>`. Positional silently breaks when a mod
//! update reorders groups — the answer stays "valid" and installs the wrong
//! files. Carry the name. Do not "simplify" this to indices.
//!
//! ─── HOW A MOD IS INSTALLED TODAY: BY CONTENT, NOT BY SCRIPT ───────────
//! Decided 2026-10-21 ("option A"): the install REBUILDS the curator's
//! staging folder from the manifest's `stagingFiles` (path + SHA-256), taking
//! bytes from the archive by hash — see [`reconstruct`]. The script is not
//! evaluated to install anything. Replaying it is still worth building, as a
//! CROSS-CHECK that warns when the curator's own install looks short, and the
//! recorded `fomodSelections` are kept for exactly that.
//!
//! A mod whose manifest has no per-file hashes (`fast` / `none` builds)
//! cannot be installed this way, and is refused rather than guessed at.
//!
//! STATUS: reconstruction implemented. Script replay (the cross-check) not yet.

#![forbid(unsafe_code)]

pub mod reconstruct;

pub use reconstruct::{plan, plan_from_trees, Applied, ContentIndex, MissingFile, ReconstructError, StagingPlan};
