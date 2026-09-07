//! The `.ehcoll` format: parse, validate, write.
//!
//! ─── SCOPE ──────────────────────────────────────────────────────────────
//! Bytes in, structs out. This crate does no filesystem I/O, no network, no
//! hashing and no archive work — hand it a `&[u8]` and it gives you a
//! manifest or an explanation. That constraint is what makes it fuzzable and
//! what makes the conformance corpus in `spec/fixtures/` cheap to run.
//!
//! ─── THIS IS THE SECOND IMPLEMENTATION ──────────────────────────────────
//! `src/core/manifest/` (TypeScript) is the first. Two implementations of one
//! format is exactly the drift this whole project exists to prevent, so they
//! are held together by `spec/` rather than by hope: both walk the same
//! fixture corpus and a disagreement fails CI. See `spec/conformance/`.
//!
//! The normative definition is `spec/ehcoll/SCHEMA.md`. When this crate and
//! the TypeScript one disagree, neither wins by default — read the spec.
//!
//! ─── UNKNOWN `schemaVersion` IS A REFUSAL, NOT A BEST EFFORT ────────────
//! A manifest from the future must fail loudly. Reading one on a best-effort
//! basis produces a partially-understood install, which is the failure this
//! format was designed to eliminate.
//!
//! STATUS: skeleton. No behaviour yet.

#![forbid(unsafe_code)]
