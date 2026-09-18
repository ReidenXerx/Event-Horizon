---
name: gitnexus-area-nexus
description: "Skill for the Nexus area of Event-Horizon. 16 symbols across 9 files."
---

# Nexus

16 symbols | 9 files | Cohesion: 72%

## When to Use

- Working with code in `src/`
- Understanding how latestPublishedRevision, listOwnNexusCollections, resolveNexusCollection work
- Modifying nexus-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/nexus/collectionUpload.ts` | listOwnNexusCollections, resolveNexusCollection, describeUploadError, toOutcome, callback |
| `src/core/nexus/collectionRevision.ts` | comparable, nexusCollectionOfDownload, readNexusCollectionRevision |
| `src/ui/runtime/collectionUpdates.ts` | downloadRevision, safeFileName |
| `src/core/nexus/collectionUpdates.test.ts` | emitAndAwait |
| `src/core/nexus/collectionUpdates.ts` | latestPublishedRevision |
| `src/core/nexus/collectionUpload.test.ts` | emitAndAwait |
| `src/ui/pages/curator/useCuratorActions.ts` | refreshUpdates |
| `src/core/installer/runInstall.ts` | nexusRevisionOfPackageFile |
| `src/core/nexus/collectionPayload.ts` | describeNexusPointer |

## Entry Points

Start here when exploring this area:

- **`latestPublishedRevision`** (Function) — `src/core/nexus/collectionUpdates.ts:39`
- **`listOwnNexusCollections`** (Function) — `src/core/nexus/collectionUpload.ts:105`
- **`resolveNexusCollection`** (Function) — `src/core/nexus/collectionUpload.ts:136`
- **`refreshUpdates`** (Function) — `src/ui/pages/curator/useCuratorActions.ts:698`
- **`downloadRevision`** (Function) — `src/ui/runtime/collectionUpdates.ts:249`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `latestPublishedRevision` | Function | `src/core/nexus/collectionUpdates.ts` | 39 |
| `listOwnNexusCollections` | Function | `src/core/nexus/collectionUpload.ts` | 105 |
| `resolveNexusCollection` | Function | `src/core/nexus/collectionUpload.ts` | 136 |
| `refreshUpdates` | Function | `src/ui/pages/curator/useCuratorActions.ts` | 698 |
| `downloadRevision` | Function | `src/ui/runtime/collectionUpdates.ts` | 249 |
| `nexusCollectionOfDownload` | Function | `src/core/nexus/collectionRevision.ts` | 56 |
| `readNexusCollectionRevision` | Function | `src/core/nexus/collectionRevision.ts` | 25 |
| `describeNexusPointer` | Function | `src/core/nexus/collectionPayload.ts` | 168 |
| `describeUploadError` | Function | `src/core/nexus/collectionUpload.ts` | 276 |
| `callback` | Function | `src/core/nexus/collectionUpload.ts` | 207 |
| `emitAndAwait` | Function | `src/core/nexus/collectionUpdates.test.ts` | 32 |
| `emitAndAwait` | Function | `src/core/nexus/collectionUpload.test.ts` | 49 |
| `safeFileName` | Function | `src/ui/runtime/collectionUpdates.ts` | 328 |
| `nexusRevisionOfPackageFile` | Function | `src/core/installer/runInstall.ts` | 6238 |
| `comparable` | Function | `src/core/nexus/collectionRevision.ts` | 85 |
| `toOutcome` | Function | `src/core/nexus/collectionUpload.ts` | 235 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `RefreshUpdates → GetVortexUserDataPath` | cross_community | 7 |
| `Upload → EmitAndAwait` | cross_community | 3 |
| `Upload → EmitAndAwait` | cross_community | 3 |
| `RefreshUpdates → Truncate` | cross_community | 3 |

## How to Explore

1. `context({name: "latestPublishedRevision"})` — see callers and callees
2. `query({search_query: "nexus"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
