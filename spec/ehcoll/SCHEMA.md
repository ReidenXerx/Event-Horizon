# `.ehcoll` v1 — normative schema

**STATUS: STUB.** The content lives in
[`docs/business/MANIFEST_SCHEMA.md`](../../docs/business/MANIFEST_SCHEMA.md)
and is being promoted here rather than rewritten, so that the spec sits beside
the fixtures that enforce it and is not owned by either implementation's tree.

Do not fork the prose. Until the promotion is done this file is a pointer, and
`docs/business/MANIFEST_SCHEMA.md` plus `src/types/ehcoll.ts` remain the
definition. See [`../README.md`](../README.md) for the unresolved question of
which of those two is normative.

## Invariants already established (do not re-litigate)

- `schemaVersion` is `1`. An **unknown** `schemaVersion` is a refusal, never a
  best-effort read. A partially-understood manifest produces a
  partially-understood install.
- Every top-level field is mandatory and non-null. Empty arrays and objects are
  valid; missing keys are not.
- An unknown **extra** top-level field is ignored, not rejected. This is what
  allows additive v1.x changes without a version bump. Only renaming or
  removing a field is breaking.
- An external mod's identity is `archiveSha256` and nothing else — no name,
  version or filename fallback on the install side.
