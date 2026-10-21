//! Nexus Mods: the API key, the account behind it, and downloading files.
//!
//! ─── SCOPE ──────────────────────────────────────────────────────────────
//! Validate a key, get a file's download mirrors, and download it — verified
//! against the SHA-256 the collection names before it is allowed to exist
//! under its final name. Mirrors are chosen automatically and tried in turn.
//!
//! ─── WHO CAN DOWNLOAD WHAT ──────────────────────────────────────────────
//! A COLLECTION's file: any logged-in account, free included — Vortex sends
//! only mod downloads through the website (read from Vortex 2.6.3's source).
//!
//! A MOD's file: Premium accounts get direct links. A free account must press
//! "Mod manager download" on the mod's page, which hands an `nxm://` link
//! (with `key` and `expires`) to whatever is registered for it — unless the
//! mod has `direct_download_enabled`, which Vortex treats as a direct link for
//! everyone. The `nxm` handler is not built yet.
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
mod collection;
mod key;

pub use client::{Account, CdnLink, Client, Fetched, NexusError, NexusFile, RateLimits, API_BASE};
pub use collection::{parse_collection_link, CollectionLink, CollectionRevision, LinkError};
pub use key::{load_api_key, load_from, ApiKey, KeyError, KeySource, KEY_PAGE, KEY_VAR};
