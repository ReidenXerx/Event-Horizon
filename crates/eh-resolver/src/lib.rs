//! The install plan: what to download, extract, reuse, or refuse.
//!
//! ─── SCOPE ──────────────────────────────────────────────────────────────
//! Manifest plus observed user state in; a plan out. Pure decision-making —
//! it computes what SHOULD happen and performs none of it, which is what
//! makes a plan reviewable before a single byte is written.
//!
//! ─── CONSERVATIVE BY CONTRACT ───────────────────────────────────────────
//! The worst-case outcome of a plan is "we did nothing", never "we removed
//! the user's stuff". Conflicts and orphans resolve to manual review; a
//! recommendation is a suggestion to a human, and the engine must act on
//! confirmed choices rather than on a recommendation field.
//!
//! STATUS: skeleton. No behaviour yet.

#![forbid(unsafe_code)]
