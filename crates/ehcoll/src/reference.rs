//! A port of `src/core/identity/compareKey.ts`'s reference parsing.
//!
//! Only the part `parseManifest` needs: deciding whether a rule's `reference`
//! names exactly one mod, which decides whether a dangling reference is worth
//! warning about.

/// The shapes a mod reference can take.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedModReference {
    /// A specific file. Resolves to at most one installed mod.
    NexusFile { nexus_mod_id: String, nexus_file_id: String },
    /// A mod PAGE. May match several installed variants.
    NexusMod { nexus_mod_id: String },
    Archive { archive_id: String },
    /// Produced only by the deprecated `getModCompareKey`. Machine-local.
    LegacyId { mod_id: String },
    Unrecognised { raw: String },
}

pub fn parse_mod_reference(reference: &str) -> ParsedModReference {
    let parts: Vec<&str> = reference.split(':').collect();
    match parts.as_slice() {
        ["nexus", m, f] => ParsedModReference::NexusFile {
            nexus_mod_id: (*m).to_owned(),
            nexus_file_id: (*f).to_owned(),
        },
        ["nexus", m] => ParsedModReference::NexusMod { nexus_mod_id: (*m).to_owned() },
        ["archive", a] => ParsedModReference::Archive { archive_id: (*a).to_owned() },
        ["id", m] => ParsedModReference::LegacyId { mod_id: (*m).to_owned() },
        _ => ParsedModReference::Unrecognised { raw: reference.to_owned() },
    }
}

/// Does this reference name exactly one mod?
///
/// `nexus:<modId>` alone does not: it is a page, and several of its files may
/// be installed.
///
/// ─── NOTE FOR ANYONE COMPARING THIS TO THE TYPESCRIPT DOC COMMENT ───────
/// `parseManifest.ts` documents "`external:<sha256>` is fully pinned". The
/// code it delegates to does not agree: `parseModReference` has no `external`
/// branch, so every `external:` reference falls through to `Unrecognised` and
/// is NOT fully pinned. The behaviour is what is ported here; the comment
/// there is stale. Raised rather than silently reconciled.
pub fn is_fully_pinned_reference(reference: &str) -> bool {
    matches!(
        parse_mod_reference(reference),
        ParsedModReference::NexusFile { .. }
            | ParsedModReference::Archive { .. }
            | ParsedModReference::LegacyId { .. }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_nexus_file_is_pinned_but_a_nexus_page_is_not() {
        assert!(is_fully_pinned_reference("nexus:1234:567890"));
        assert!(!is_fully_pinned_reference("nexus:1234"));
    }

    #[test]
    fn archive_and_legacy_ids_are_pinned() {
        assert!(is_fully_pinned_reference("archive:abc-123"));
        assert!(is_fully_pinned_reference("id:MyMod-1234"));
    }

    #[test]
    fn external_references_are_not_pinned_whatever_the_doc_says() {
        // Both shapes buildExternalMod emits. Neither is recognised by
        // parseModReference, so neither is pinned - see the note above.
        assert!(!is_fully_pinned_reference(
            "external:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ));
        assert!(!is_fully_pinned_reference("external:staging:deadbeef"));
    }

    #[test]
    fn anything_with_the_wrong_arity_is_unrecognised() {
        assert!(!is_fully_pinned_reference("archive:a:b"));
        assert!(!is_fully_pinned_reference("nexus"));
        assert!(!is_fully_pinned_reference(""));
    }
}
