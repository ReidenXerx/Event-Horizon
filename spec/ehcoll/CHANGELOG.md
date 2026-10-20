# `.ehcoll` schemaVersion history

## v2 — current (2026-09-13)

Bundled mods ship as their loose files, `bundled/<sha256>/<path>`, instead of
as archives — Nexus quarantines an upload with an archive inside it. A bundled
mod's `source.sha256` is the sha256 of the canonical zip its files make
(`src/core/manifest/bundleZip.ts`), which the installer writes back and checks.

A v2 reader refuses v1 with "built by an older Event Horizon … download the
collection's current package", not with "update Event Horizon". There is no
toggle to emit or read v1.

Additive fields within v2 (no version bump; all optional, absent on older
packages):

| Field | Read |
| --- | --- |
| `package.changelog` | leniently — never refuses. *Not modelled in Rust yet.* |
| `package.presentation` | leniently — never refuses. *Not modelled in Rust yet.* |
| `vortex.deploymentMethodAssumed` | only a literal `true` counts; anything else is absent |
| `mods[].state.mirrorFromArchive` | strictly — safe relative paths that are entries of `stagingFiles` |
| `mods[].state.nativePlugins` | leniently — unreadable entries skipped, empty reads as absent |
| `plugins.lightFlagBit` | strictly — one header bit; absent means 0x200 |

## v1

Initial format. See `docs/business/MANIFEST_SCHEMA.md`.

Additive changes within a version do **not** bump it: consumers ignore
unknown top-level fields by contract. Renaming or removing a field, or
changing what one means, is breaking and requires a bump plus an explicit
refusal path in every consumer.
