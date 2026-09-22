---
name: gitnexus-area-nexus
description: "Skill for the Nexus area of Event-Horizon. 31 symbols across 11 files."
---

# Nexus

31 symbols | 11 files | Cohesion: 76%

## When to Use

- Working with code in `src/`
- Understanding how countNexusCollectionMods, describeNexusPointer, canUploadCollections work
- Modifying nexus-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/nexus/collectionUpload.ts` | canUploadCollections, describeUploadError, toOutcome, uploadToNexusCollection, armQuiet (+6) |
| `src/core/nexus/collectionStats.ts` | first, collectionStats, num, readCollectionStats, str (+1) |
| `src/core/nexus/collectionRevision.ts` | comparable, nexusCollectionOfDownload, readNexusCollectionRevision |
| `src/core/nexus/collectionPayload.ts` | countNexusCollectionMods, describeNexusPointer |
| `src/ui/runtime/collectionUpdates.ts` | downloadRevision, safeFileName |
| `src/ui/pages/dashboard/DashboardPage.tsx` | loadStats, onRefreshCurator |
| `src/core/nexus/collectionUpdates.test.ts` | emitAndAwait |
| `src/core/nexus/collectionUpdates.ts` | latestPublishedRevision |
| `src/core/nexus/collectionUpload.test.ts` | emitAndAwait |
| `src/ui/pages/curator/useCuratorActions.ts` | refreshUpdates |

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
| `collectionStats` | Function | `src/core/nexus/collectionStats.ts` | 186 |
| `readCollectionStats` | Function | `src/core/nexus/collectionStats.ts` | 139 |
| `toCollectionStats` | Function | `src/core/nexus/collectionStats.ts` | 70 |
| `loadStats` | Function | `src/ui/pages/dashboard/DashboardPage.tsx` | 56 |
| `onRefreshCurator` | Function | `src/ui/pages/dashboard/DashboardPage.tsx` | 171 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `OnRefreshCurator → GetEventHorizonRoot` | cross_community | 10 |
| `Upload → GetVortexUserDataPath` | cross_community | 9 |
| `OnRefreshCurator → Truncate` | cross_community | 7 |
| `RefreshUpdates → GetVortexUserDataPath` | cross_community | 7 |
| `OnRefreshCurator → EmitAndAwait` | cross_community | 6 |
| `OnRefreshCurator → EmitAndAwait` | cross_community | 6 |
| `OnRefreshCurator → Num` | intra_community | 6 |
| `Upload → Truncate` | cross_community | 5 |
| `OnAbort → DescribeNexusPointer` | intra_community | 3 |
| `OnAbort → IsAbort` | cross_community | 3 |

## How to Explore

1. `context({name: "countNexusCollectionMods"})` — see callers and callees
2. `query({search_query: "nexus"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
