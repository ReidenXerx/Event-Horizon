# `.ehcoll` v2 — normative schema

**STATUS: STUB.** The content lives in
[`docs/business/MANIFEST_SCHEMA.md`](../../docs/business/MANIFEST_SCHEMA.md)
and is being promoted here rather than rewritten, so that the spec sits beside
the fixtures that enforce it and is not owned by either implementation's tree.

Do not fork the prose. This file is a pointer; `src/types/ehcoll.ts` is
**normative** and `docs/business/MANIFEST_SCHEMA.md` describes it. Settled
2026-09-07 — see [`../README.md`](../README.md). `crates/ehcoll` is a faithful
port of the TypeScript types, so that one `.ehcoll` file works on both sides.

## Invariants already established (do not re-litigate)

- `schemaVersion` is `2` (history: [`CHANGELOG.md`](CHANGELOG.md)). An **unknown** `schemaVersion` is a refusal, never a
  best-effort read. A partially-understood manifest produces a
  partially-understood install.
- Every top-level field is mandatory and non-null. Empty arrays and objects are
  valid; missing keys are not.
- An unknown **extra** top-level field is ignored, not rejected. This is what
  allows additive changes within a version without a bump. Only renaming or
  removing a field is breaking.
- An external mod's identity is `archiveSha256` and nothing else — no name,
  version or filename fallback on the install side.
