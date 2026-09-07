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

## SETTLED — TypeScript is normative for v1

`docs/business/MANIFEST_SCHEMA.md` says:

> The TypeScript source of truth is `src/types/ehcoll.ts`. When prose
> disagrees with the types: **the types are the spec**.

**That stands.** Decided 2026-09-07: `crates/ehcoll` is a faithful port of
`src/types/ehcoll.ts`, not an independent re-derivation from prose. The goal
is that the same `.ehcoll` file works on both sides, and the cheapest way to
guarantee that is to have one definition and one translation of it.

What this buys, and what it costs — both are real, and the trade was made
deliberately:

* **Buys:** a manifest written by the extension parses in Rust and back, with
  no class of disagreement that has to be argued about. Stage 1 gets much
  smaller: transliterate, do not redesign.
* **Costs:** Rust inherits TypeScript's v1 bugs by construction. That is
  acceptable *because* a bug both sides share is a compatibility property
  rather than a divergence — but it means fixing one is a coordinated change
  to `src/types/ehcoll.ts`, `crates/ehcoll` and the fixtures together, never
  to one side alone.

The job of conformance here is therefore to catch **drift over time**, not to
adjudicate today's behaviour. If the two ever disagree, the Rust side is wrong
until proven otherwise.

## Two kinds of fixture, and only one may be generated

Because TypeScript is normative, the rule about generated fixtures splits:

* **Compatibility fixtures** — "does Rust read what TypeScript writes, and
  vice versa?" These *should* be generated from the TypeScript implementation.
  It is the definition, so its output is by construction correct, and
  hand-writing them would only introduce transcription errors.
* **Behavioural fixtures** — what must be *rejected*: unknown `schemaVersion`,
  a missing mandatory top-level field, an external mod with no
  `archiveSha256`. These are **hand-authored**, because "TypeScript happens to
  reject this today" is not the same claim as "this must always be rejected",
  and only the second one is worth a test.

Every fixture in `manifests/invalid/` and `manifests/adversarial/` carries a
comment saying what it attacks. A fixture whose purpose is unrecorded gets
"fixed" by the next person who sees it fail.
