//! Nexus collections: the link a user pastes, and the revision it names.
//!
//! A collection's FILE is what Event Horizon installs — for an Event Horizon
//! collection it is the `.ehcoll` package. Getting it is three steps, the
//! same three Vortex takes (read from Vortex 2.6.3's bundled source):
//!
//!  1. GraphQL `collectionRevision(slug, revision?)` → the revision's
//!     `downloadLink`, an API path like `/v2/collections/…/download_link`.
//!  2. GET that path with the key → `{download_links: [mirrors]}`.
//!  3. Download from a mirror.
//!
//! ─── FREE ACCOUNTS CAN DO THIS ──────────────────────────────────────────
//! Vortex sends a free account to the website only for a MOD file
//! (`url.type === "mod"`); a collection's file always goes the direct way.
//! Mods inside the collection are a different matter — see the crate docs.

use serde::Deserialize;
use std::fmt;

/// What a pasted link names: a collection, and maybe one revision of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollectionLink {
    /// The Nexus game domain, when the link carries one.
    pub game_domain: Option<String>,
    pub slug: String,
    /// `None` means the latest published revision.
    pub revision: Option<u32>,
}

impl fmt::Display for CollectionLink {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "collection {}", self.slug)?;
        match self.revision {
            Some(r) => write!(f, " revision {r}"),
            None => write!(f, " (latest revision)"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkError(pub String);

impl fmt::Display for LinkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for LinkError {}

const HOSTS: [&str; 3] = ["www.nexusmods.com", "nexusmods.com", "next.nexusmods.com"];

/// Read a collection link. Accepted:
///
/// ```text
/// https://www.nexusmods.com/games/<game>/collections/<slug>[/revisions/<n|latest>][/…]
/// https://www.nexusmods.com/<game>/collections/<slug>[…]       (older pages)
/// https://next.nexusmods.com/<game>/collections/<slug>[…]
/// nxm://<game>/collections/<slug>/revisions/<n|latest>
/// <slug>                                                      (just the code)
/// ```
pub fn parse_collection_link(input: &str) -> Result<CollectionLink, LinkError> {
    let s = input.trim();
    if is_slug(s) {
        return Ok(CollectionLink { game_domain: None, slug: s.to_owned(), revision: None });
    }
    let bad = |why: &str| LinkError(format!("{input:?} is not a Nexus collection link: {why}"));

    let (scheme, rest) = s.split_once("://").ok_or_else(|| bad("expected a link or a collection code"))?;
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    let segments: Vec<&str> = match scheme.to_ascii_lowercase().as_str() {
        // nxm://<game>/collections/<slug>/revisions/<n>: the game is the "host".
        "nxm" => rest.split('/').filter(|p| !p.is_empty()).collect(),
        "https" | "http" => {
            let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
            if !HOSTS.contains(&host.to_ascii_lowercase().as_str()) {
                return Err(bad("that is not a nexusmods.com address"));
            }
            let mut p: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
            if p.first() == Some(&"games") {
                p.remove(0);
            }
            p
        }
        _ => return Err(bad("expected an https:// or nxm:// link")),
    };

    let at = segments.iter().position(|p| *p == "collections").ok_or_else(|| {
        if segments.contains(&"mods") {
            bad("that is a mod page, not a collection")
        } else {
            bad("it does not point at a collection")
        }
    })?;
    let game_domain = match at {
        0 => None,
        1 if is_domain(segments[0]) => Some(segments[0].to_ascii_lowercase()),
        _ => return Err(bad("unexpected path before /collections/")),
    };
    let slug = segments.get(at + 1).copied().filter(|s| is_slug(s)).ok_or_else(|| bad("no collection code after /collections/"))?;
    let revision = match (segments.get(at + 2), segments.get(at + 3)) {
        (Some(&"revisions"), Some(r)) if r.eq_ignore_ascii_case("latest") => None,
        (Some(&"revisions"), Some(r)) => Some(
            r.parse::<u32>()
                .ok()
                .filter(|n| *n >= 1)
                .ok_or_else(|| bad("the revision is not a number"))?,
        ),
        (Some(&"revisions"), None) => return Err(bad("the revision is missing")),
        // Anything else after the slug is a page tab (`/mods`, `/comments`).
        _ => None,
    };
    Ok(CollectionLink { game_domain, slug: slug.to_owned(), revision })
}

/// Collection codes are short and alphanumeric (`ecb76c`, `dmt85e`); Vortex
/// matches them with `\w+`. Anything else is not one.
fn is_slug(s: &str) -> bool {
    !s.is_empty() && s.len() <= 32 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn is_domain(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// One revision of a collection, as Nexus describes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollectionRevision {
    pub slug: String,
    pub collection_id: u64,
    pub collection_name: String,
    pub game_domain: String,
    pub revision_id: u64,
    pub revision_number: u32,
    /// An API path, `/v2/collections/<id>/revisions/<id>/download_link`.
    pub download_link: String,
    pub adult: bool,
    pub mod_count: Option<u64>,
    /// Sum of the mods' sizes in bytes — what installing it downloads, not
    /// the size of the collection's own file.
    pub mods_total_size: Option<u64>,
}

/// GraphQL's shape for the query in [`crate::Client::collection_revision`].
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GqlRevision {
    pub id: u64,
    pub revision_number: u32,
    pub download_link: String,
    #[serde(default)]
    pub adult_content: bool,
    pub mod_count: Option<u64>,
    /// A STRING in the API (`"74038709982"`): too big for GraphQL's Int.
    pub total_size: Option<String>,
    pub collection: GqlCollection,
}

#[derive(Deserialize)]
pub(crate) struct GqlCollection {
    pub id: u64,
    pub name: String,
    pub game: GqlGame,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GqlGame {
    pub domain_name: String,
}

pub(crate) const REVISION_QUERY: &str = "query R($slug: String!, $revision: Int, $viewAdultContent: Boolean) { \
    collectionRevision(slug: $slug, revision: $revision, viewAdultContent: $viewAdultContent) { \
    id revisionNumber downloadLink adultContent modCount totalSize \
    collection { id name game { domainName } } } }";

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(s: &str) -> CollectionLink {
        parse_collection_link(s).unwrap_or_else(|e| panic!("{s}: {e}"))
    }

    #[test]
    fn every_form_a_user_pastes() {
        let latest = |game: Option<&str>| CollectionLink {
            game_domain: game.map(str::to_owned),
            slug: "ecb76c".into(),
            revision: None,
        };
        let sse = Some("skyrimspecialedition");
        assert_eq!(ok("https://www.nexusmods.com/games/skyrimspecialedition/collections/ecb76c"), latest(sse));
        assert_eq!(ok("https://www.nexusmods.com/games/skyrimspecialedition/collections/ecb76c/mods"), latest(sse));
        assert_eq!(ok("https://www.nexusmods.com/skyrimspecialedition/collections/ecb76c?tab=about#x"), latest(sse));
        assert_eq!(ok("https://next.nexusmods.com/skyrimspecialedition/collections/ecb76c"), latest(sse));
        assert_eq!(ok("  ecb76c  "), latest(None));
        assert_eq!(ok("https://www.nexusmods.com/games/skyrimspecialedition/collections/ecb76c/revisions/latest"), latest(sse));

        let r15 = ok("https://www.nexusmods.com/games/skyrimspecialedition/collections/ecb76c/revisions/15");
        assert_eq!(r15.revision, Some(15));
        let nxm = ok("nxm://skyrimspecialedition/collections/ecb76c/revisions/15");
        assert_eq!((nxm.game_domain.as_deref(), nxm.revision), (sse, Some(15)));
    }

    #[test]
    fn what_is_not_a_collection_link_says_why() {
        for (s, why) in [
            ("https://www.nexusmods.com/skyrimspecialedition/mods/266", "mod page"),
            ("https://evil.example/skyrimspecialedition/collections/ecb76c", "not a nexusmods.com"),
            ("https://www.nexusmods.com.evil.example/x/collections/ecb76c", "not a nexusmods.com"),
            ("https://www.nexusmods.com/games/sse/collections/", "no collection code"),
            ("https://www.nexusmods.com/games/sse/collections/ecb76c/revisions/zero", "not a number"),
            ("https://www.nexusmods.com/games/sse/collections/ecb76c/revisions/0", "not a number"),
            ("ftp://www.nexusmods.com/sse/collections/ecb76c", "https:// or nxm://"),
            ("ecb 76c", "expected a link"),
        ] {
            let err = parse_collection_link(s).unwrap_err().0;
            assert!(err.contains(why), "{s}: {err}");
        }
    }
}
