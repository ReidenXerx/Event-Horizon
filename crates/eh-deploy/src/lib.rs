//! Deployment: get staged mods into the game directory.
//!
//! ─── SCOPE ──────────────────────────────────────────────────────────────
//! Hard-link and symlink deployment, file-level conflict resolution by mod
//! order, purge and redeploy, and a manifest of what we deployed so that
//! removing it is exact rather than approximate.
//!
//! ─── THIS IS THE GENUINELY NEW CAPABILITY ───────────────────────────────
//! Everything else in this workspace has a TypeScript counterpart to check
//! against. This does not: the extension delegates deployment to Vortex.
//! There is no oracle here, so tests carry the whole burden.
//!
//! ─── PROTON IS WHERE THIS GETS HARD ─────────────────────────────────────
//! A Windows game under Proton wants case-insensitive lookups on a
//! case-sensitive filesystem. Limo solves it with a `CaseMatchingDeployer`
//! that renames SOURCE files to match the case of existing target files.
//!
//! That is worth understanding and worth thinking twice about before copying:
//! mutating the staging tree to suit one target makes staging non-reproducible,
//! and reproducibility is this project's entire thesis. Prefer resolving case
//! at the link, and keep staging a faithful record of what was installed.
//!
//! STATUS: skeleton. No behaviour yet.

#![forbid(unsafe_code)]
