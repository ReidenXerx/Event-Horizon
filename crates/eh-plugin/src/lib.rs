//! Bethesda plugin headers — masters and flags, and nothing more.
//!
//! ─── SCOPE, AND WHY IT IS THIS NARROW ───────────────────────────────────
//! Read (and write) the `TES3`/`TES4` header record of an `.esp`/`.esm`/`.esl`:
//! the master list, and the record flags that carry the light/ESL bit.
//!
//! That is a deliberately small surface. `esplugin` does far more — record
//! counts, FormID analysis, overlap detection — and it is **GPL-3**, so it
//! cannot live in this workspace (`deny.toml`). The good news is that the
//! common path does not need it: pinning a recorded order and restoring ESL
//! flags needs the header and nothing else, and the header is a documented,
//! stable, few-hundred-line format.
//!
//! ─── WHAT DOES NOT BELONG HERE ──────────────────────────────────────────
//! Anything that needs the masterlist, LOOT metadata, or condition strings.
//! That is sorting, it is GPL, and it lives in a separate binary. See
//! `eh-loadorder`.
//!
//! ─── VERIFY THE FLAG BIT AGAINST THE FORMAT DOCS ────────────────────────
//! The light-master flag is a bit in the header record's flags field, and the
//! exact value differs by game generation. Confirm it against UESP / the
//! format documentation before trusting it — an ESL flag written to the wrong
//! bit corrupts the plugin's load behaviour silently, which is the worst
//! shape of bug this project has.
//!
//! STATUS: skeleton. No behaviour yet.

#![forbid(unsafe_code)]
