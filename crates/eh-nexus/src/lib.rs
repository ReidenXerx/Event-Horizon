//! Nexus Mods: the API key, the account behind it, and downloading files.
//!
//! ─── SCOPE ──────────────────────────────────────────────────────────────
//! Validate a key, get a file's download mirrors, and download it — verified
//! against the SHA-256 the collection names before it is allowed to exist
//! under its final name. Mirrors are chosen automatically and tried in turn.
//!
//! ─── PREMIUM ONLY, FOR NOW ──────────────────────────────────────────────
//! Nexus gives direct download links to Premium accounts. A free account has
//! to press "Mod manager download" on the website, which hands an `nxm://`
//! link (with `key` and `expires`) to whatever is registered for it. That
//! path needs this program registered as the `nxm` handler, and is not built.
//!
//! ─── THE KEY STAYS WITH NEXUS ───────────────────────────────────────────
//! It is sent only to the API host, on an agent that follows no redirects,
//! and never to a CDN. It is never printed: [`ApiKey`] redacts itself.
//!
//! ─── FOR OTHER PEOPLE'S MACHINES ────────────────────────────────────────
//! A personal API key is the developer path. An application distributed to
//! users is expected to log them in through Nexus's own flow as a registered
//! application. Settle that with Nexus before shipping.

#![forbid(unsafe_code)]

mod client;
mod key;

pub use client::{Account, CdnLink, Client, Fetched, NexusError, NexusFile, RateLimits, API_BASE};
pub use key::{load_api_key, load_from, ApiKey, KeyError, KeySource, KEY_PAGE, KEY_VAR};
