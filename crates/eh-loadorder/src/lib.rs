//! Load order: pin what the curator recorded. Do not sort.
//!
//! ─── SCOPE ──────────────────────────────────────────────────────────────
//! Write `plugins.txt` in a recorded order, restore ESL flags, and check that
//! every plugin's masters are present and precede it. All of that is MIT and
//! all of it is small, because a recorded order needs no decisions made.
//!
//! ─── SORTING IS NOT HERE, AND NOT BECAUSE IT IS HARD ────────────────────
//! Sorting means the masterlist (thousands of community-maintained entries
//! per game), the group DAG, LOOT's condition-string language, plugin record
//! analysis, cycle detection with errors a human can act on, and per-game
//! quirks. libloot is a substantial library, and `esplugin`,
//! `libloadorder` and `loot-condition-interpreter` exist as separate crates
//! because each piece is substantial on its own.
//!
//! All of it is **GPL-3-or-later**. Linking it here would relicense the
//! product (NS-3). So the sorter is a separate GPL-3 binary talking JSON over
//! stdio, and this crate holds only the seam for it.
//!
//! ─── THE SEAM, AND ITS HONEST DEFAULT ───────────────────────────────────
//! A `Sorter` is something the engine is HANDED, never something it links.
//! When no sorter is available the default must report unknown plugins rather
//! than place them: guessing a position for a plugin nobody described is how
//! you get an install that verifies clean and loads something else. Reproducing
//! a recorded order works fully without a sorter; only integrating plugins the
//! collection has never heard of needs one.
//!
//! STATUS: skeleton. No behaviour yet.

#![forbid(unsafe_code)]
