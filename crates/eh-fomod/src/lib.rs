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
//! STATUS: skeleton. No behaviour yet.

#![forbid(unsafe_code)]
