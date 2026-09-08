//! The `.ehcoll` format: parse, validate, write.
//!
//! ─── SCOPE ──────────────────────────────────────────────────────────────
//! Bytes in, structs out. No filesystem I/O, no network, no hashing and no
//! archive work — hand it a `&str` and it gives you a manifest or an
//! explanation of everything wrong with it. That constraint is what makes it
//! fuzzable and what makes the conformance corpus in `spec/fixtures/` cheap
//! to run.
//!
//! ─── THIS IS THE SECOND IMPLEMENTATION ──────────────────────────────────
//! `src/core/manifest/` (TypeScript) is the first, and it is NORMATIVE —
//! settled 2026-09-07, see `spec/README.md`. This is a faithful port so that
//! one `.ehcoll` file works on both sides. When the two disagree, this side
//! is wrong until proven otherwise.
//!
//! ─── UNKNOWN `schemaVersion` IS A REFUSAL, NOT A BEST EFFORT ────────────
//! A manifest from the future fails loudly. Reading one on a best-effort
//! basis produces a partially-understood install, which is the failure this
//! format was designed to eliminate.

#![forbid(unsafe_code)]

pub mod parse;
pub mod reference;
pub mod types;

pub use parse::{parse_manifest, ParseError, ParseOutcome};
pub use reference::{is_fully_pinned_reference, parse_mod_reference, ParsedModReference};
pub use types::*;
