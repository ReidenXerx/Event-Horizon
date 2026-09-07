# `.ehcoll` schemaVersion history

## v1 — current

Initial format. See `docs/business/MANIFEST_SCHEMA.md`.

Additive changes within v1 do **not** bump the version: consumers ignore
unknown top-level fields by contract. Renaming or removing a field is
breaking and requires v2 plus an explicit refusal path in every consumer.
