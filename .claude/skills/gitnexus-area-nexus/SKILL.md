---
name: gitnexus-area-nexus
description: "Skill for the Nexus area of Event-Horizon. 24 symbols across 10 files."
---

# Nexus

24 symbols | 10 files | Cohesion: 74%

## When to Use

- Working with code in `src/`
- Understanding how countNexusCollectionMods, describeNexusPointer, canUploadCollections work
- Modifying nexus-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/nexus/collectionUpload.ts` | canUploadCollections, describeUploadError, toOutcome, uploadToNexusCollection, armQuiet (+6) |
| `src/core/nexus/collectionRevision.ts` | comparable, nexusCollectionOfDownload, readNexusCollectionRevision |
| `src/core/nexus/collectionPayload.ts` | countNexusCollectionMods, describeNexusPointer |
| `src/ui/runtime/collectionUpdates.ts` | downloadRevision, safeFileName |
| `src/core/nexus/collectionUpdates.test.ts` | emitAndAwait |
| `src/core/nexus/collectionUpdates.ts` | latestPublishedRevision |
| `src/core/nexus/collectionUpload.test.ts` | emitAndAwait |
| `src/ui/pages/curator/useCuratorActions.ts` | refreshUpdates |
| `src/core/installer/runInstall.ts` | nexusRevisionOfPackageFile |
| `src/ui/pages/install/engine.ts` | incomingRevisionOf |

## Entry Points

Start here when exploring this area:

- **`countNexusCollectionMods`** (Function) — `src/core/nexus/collectionPayload.ts:126`
- **`describeNexusPointer`** (Function) — `src/core/nexus/collectionPayload.ts:168`
- **`canUploadCollections`** (Function) — `src/core/nexus/collectionUpload.ts:85`
- **`describeUploadError`** (Function) — `src/core/nexus/collectionUpload.ts:337`
- **`uploadToNexusCollection`** (Function) — `src/core/nexus/collectionUpload.ts:167`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `countNexusCollectionMods` | Function | `src/core/nexus/collectionPayload.ts` | 126 |
| `describeNexusPointer` | Function | `src/core/nexus/collectionPayload.ts` | 168 |
| `canUploadCollections` | Function | `src/core/nexus/collectionUpload.ts` | 85 |
| `describeUploadError` | Function | `src/core/nexus/collectionUpload.ts` | 337 |
| `uploadToNexusCollection` | Function | `src/core/nexus/collectionUpload.ts` | 167 |
| `armQuiet` | Function | `src/core/nexus/collectionUpload.ts` | 227 |
| `callback` | Function | `src/core/nexus/collectionUpload.ts` | 260 |
| `done` | Function | `src/core/nexus/collectionUpload.ts` | 223 |
| `onAbort` | Function | `src/core/nexus/collectionUpload.ts` | 248 |
| `onProgress` | Function | `src/core/nexus/collectionUpload.ts` | 284 |
| `latestPublishedRevision` | Function | `src/core/nexus/collectionUpdates.ts` | 39 |
| `listOwnNexusCollections` | Function | `src/core/nexus/collectionUpload.ts` | 105 |
| `resolveNexusCollection` | Function | `src/core/nexus/collectionUpload.ts` | 136 |
| `refreshUpdates` | Function | `src/ui/pages/curator/useCuratorActions.ts` | 698 |
| `downloadRevision` | Function | `src/ui/runtime/collectionUpdates.ts` | 354 |
| `nexusCollectionOfDownload` | Function | `src/core/nexus/collectionRevision.ts` | 56 |
| `readNexusCollectionRevision` | Function | `src/core/nexus/collectionRevision.ts` | 25 |
| `toOutcome` | Function | `src/core/nexus/collectionUpload.ts` | 296 |
| `emitAndAwait` | Function | `src/core/nexus/collectionUpdates.test.ts` | 32 |
| `emitAndAwait` | Function | `src/core/nexus/collectionUpload.test.ts` | 49 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Upload → GetVortexUserDataPath` | cross_community | 9 |
| `RefreshUpdates → GetVortexUserDataPath` | cross_community | 7 |
| `Upload → Truncate` | cross_community | 5 |
| `OnAbort → DescribeNexusPointer` | intra_community | 3 |
| `OnAbort → IsAbort` | cross_community | 3 |
| `Upload → EmitAndAwait` | cross_community | 3 |
| `Upload → EmitAndAwait` | cross_community | 3 |
| `Upload → CountNexusCollectionMods` | cross_community | 3 |
| `Upload → Fail` | cross_community | 3 |
| `RefreshUpdates → Truncate` | cross_community | 3 |

## How to Explore

1. `context({name: "countNexusCollectionMods"})` — see callers and callees
2. `query({search_query: "nexus"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
