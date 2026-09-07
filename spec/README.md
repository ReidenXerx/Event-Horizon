# `spec/` — the contract between implementations

`.ehcoll` now has more than one implementation:

| Implementation | Location | Language |
| --- | --- | --- |
| Vortex extension | `src/core/manifest/`, `src/types/ehcoll.ts` | TypeScript |
| Standalone engine | `crates/ehcoll/` | Rust |

This project exists because state drifts silently between implementations of a
format. Two implementations of `.ehcoll` is therefore a risk we are taking
deliberately, and this directory is the thing that makes the risk *visible*
instead of latent: both walk the same fixture corpus, and a disagreement fails
CI rather than surfacing on a user's machine six months later.

## Layout

```
ehcoll/SCHEMA.md            normative prose
ehcoll/manifest.v1.schema.json   machine-checkable shape
ehcoll/CHANGELOG.md         schemaVersion history
fixtures/manifests/         valid / invalid / adversarial manifests
fixtures/fomod/             ModuleConfig.xml + choices + expected file set
fixtures/archives/          tiny SYNTHETIC archives — never real mods
conformance/                how each implementation consumes the corpus
```

## UNRESOLVED — what is normative?

`docs/business/MANIFEST_SCHEMA.md` currently says:

> The TypeScript source of truth is `src/types/ehcoll.ts`. When prose
> disagrees with the types: **the types are the spec**.

That was the right call with one implementation. With two it is a trap: it
makes every TypeScript bug normative by definition, so the Rust implementation
would be obliged to reproduce them and the conformance suite would become an
expensive way to agree with ourselves.

**This has not been changed unilaterally.** It is a decision for the project
owner, and until it is made, treat `src/types/ehcoll.ts` as normative and
treat any Rust/TypeScript disagreement as unresolved rather than as a Rust bug.

The proposed replacement is NS-5 in `.bearing/northstars.md`.

## Golden files are authored, not generated

Whatever is normative, expected outputs in `fixtures/` are written **from the
spec**, by hand, for the cases that matter. Generating them by running one
implementation teaches the other that implementation's bugs and produces a
green suite that proves nothing.

Where hand-authoring is impractical, run the case **differentially**: both
implementations must agree, and a disagreement is a ticket resolved by reading
the spec — not by picking whichever side is more convenient.
