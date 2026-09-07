//! Extraction, behind one trait.
//!
//! ─── SCOPE ──────────────────────────────────────────────────────────────
//! List and extract ZIP / 7z / RAR. One trait, several backends, so the
//! choice of backend is a build-time or runtime decision and not a fact
//! smeared across the codebase.
//!
//! ─── UNREADABLE IS A RESULT, NOT AN ERROR ───────────────────────────────
//! Callers use this while explaining some other failure, so it reports why it
//! could not read rather than throwing into the middle of a diagnosis. Which
//! backend answered is itself diagnostic on a broken prefix — keep it in the
//! result.
//!
//! ─── OPEN DECISION: THE RAR BACKEND ─────────────────────────────────────
//! LoversLab ships a lot of `.rar`, so RAR is not optional for this domain.
//! The options are not equivalent and the choice has consequences past the
//! code:
//!
//!   * `unrar` crates bind libunrar under the UnRAR licence. Not copyleft —
//!     it will not relicense us — but non-free enough that distributions
//!     will not package the result. Flatpak is then the delivery story.
//!   * Shelling out to system `7z` / `unar` sidesteps the licence entirely
//!     and costs a runtime dependency we cannot guarantee is present.
//!
//! Decide deliberately before Stage 2 rather than discovering it at package
//! time. Whatever is chosen, it must not be GPL — see `deny.toml`.
//!
//! STATUS: skeleton. No behaviour yet.

#![forbid(unsafe_code)]
