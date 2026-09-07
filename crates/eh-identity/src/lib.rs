//! Content-addressed identity: what a mod archive *is*, independent of its name.
//!
//! ─── SCOPE ──────────────────────────────────────────────────────────────
//! SHA-256 over archive bytes, ZIP central-directory reading, and the
//! comparison verdicts (`matches` / `differs` / `damaged` / `unknown`).
//!
//! ─── WHY THIS IS THE LOAD-BEARING CRATE ─────────────────────────────────
//! An external mod's identity is its `archiveSha256` and nothing else — no
//! name, no version, no filename fallback (NS-2). Every other mod manager
//! surveyed gets this wrong in the same direction: Limo's `struct Mod` has no
//! hash field at all, so a LoversLab or Google Drive mod is identified by a
//! string the user typed. Those links rot; the hash outlives the URL.
//!
//! The `differs` / `damaged` split is not cosmetic. Only a damaged archive is
//! fixed by downloading it again, and only that one is not the curator's
//! problem. Collapsing them sends users to re-download a file that was
//! already correct.
//!
//! ─── NATIVE ZIP FIRST, BY DESIGN ────────────────────────────────────────
//! A large share of mod archives are ZIPs and the central directory carries
//! the same CRCs a subprocess would report, so the native path is a cheaper
//! route to an identical answer rather than a weaker one. It also survives a
//! Wine prefix where a 7z subprocess will not start — the platform this whole
//! investigation began on. Detection is by CONTENT, never by extension: a mod
//! archive named `.zip` is sometimes a RAR.
//!
//! STATUS: skeleton. No behaviour yet.

#![forbid(unsafe_code)]
