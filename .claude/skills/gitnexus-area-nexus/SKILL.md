---
name: gitnexus-area-nexus
description: "Skill for the Nexus area of Event-Horizon. 28 symbols across 10 files."
---

# Nexus

28 symbols | 10 files | Cohesion: 65%

## When to Use

- Working with code in `src/`
- Understanding how countNexusCollectionMods, nexusCollectionProblems, toNexusCollectionInfo work
- Modifying nexus-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/nexus/collectionUpload.ts` | canUploadCollections, isLoggedInToNexus, uploadToNexusCollection, listOwnNexusCollections, resolveNexusCollection (+3) |
| `src/core/nexus/collectionPayload.ts` | countNexusCollectionMods, nexusCollectionProblems, toNexusCollectionInfo, toNexusCollectionMod, describeNexusPointer |
| `src/ui/pages/build/NexusCollectionUpload.tsx` | NexusUploadModal, upload, defaultChoice, withPageName |
| `src/core/nexus/collectionRevision.ts` | comparable, nexusCollectionOfDownload, readNexusCollectionRevision |
| `src/core/nexus/collectionUpdates.ts` | findCollectionUpdates, latestPublishedRevision |
| `src/ui/runtime/collectionUpdates.ts` | downloadRevision, safeFileName |
| `src/core/nexus/collectionUpdates.test.ts` | emitAndAwait |
| `src/core/nexus/collectionUpload.test.ts` | emitAndAwait |
| `src/ui/pages/curator/useCuratorActions.ts` | refreshUpdates |
| `src/core/installer/runInstall.ts` | nexusRevisionOfPackageFile |

## Entry Points

Start here when exploring this area:

- **`countNexusCollectionMods`** (Function) — `src/core/nexus/collectionPayload.ts:126`
- **`nexusCollectionProblems`** (Function) — `src/core/nexus/collectionPayload.ts:141`
- **`toNexusCollectionInfo`** (Function) — `src/core/nexus/collectionPayload.ts:79`
- **`findCollectionUpdates`** (Function) — `src/core/nexus/collectionUpdates.ts:55`
- **`canUploadCollections`** (Function) — `src/core/nexus/collectionUpload.ts:85`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `countNexusCollectionMods` | Function | `src/core/nexus/collectionPayload.ts` | 126 |
| `nexusCollectionProblems` | Function | `src/core/nexus/collectionPayload.ts` | 141 |
| `toNexusCollectionInfo` | Function | `src/core/nexus/collectionPayload.ts` | 79 |
| `findCollectionUpdates` | Function | `src/core/nexus/collectionUpdates.ts` | 55 |
| `canUploadCollections` | Function | `src/core/nexus/collectionUpload.ts` | 85 |
| `isLoggedInToNexus` | Function | `src/core/nexus/collectionUpload.ts` | 79 |
| `uploadToNexusCollection` | Function | `src/core/nexus/collectionUpload.ts` | 167 |
| `NexusUploadModal` | Function | `src/ui/pages/build/NexusCollectionUpload.tsx` | 118 |
| `upload` | Function | `src/ui/pages/build/NexusCollectionUpload.tsx` | 186 |
| `defaultChoice` | Function | `src/ui/pages/build/NexusCollectionUpload.tsx` | 661 |
| `withPageName` | Function | `src/ui/pages/build/NexusCollectionUpload.tsx` | 648 |
| `latestPublishedRevision` | Function | `src/core/nexus/collectionUpdates.ts` | 39 |
| `listOwnNexusCollections` | Function | `src/core/nexus/collectionUpload.ts` | 105 |
| `resolveNexusCollection` | Function | `src/core/nexus/collectionUpload.ts` | 136 |
| `refreshUpdates` | Function | `src/ui/pages/curator/useCuratorActions.ts` | 698 |
| `downloadRevision` | Function | `src/ui/runtime/collectionUpdates.ts` | 249 |
| `nexusCollectionOfDownload` | Function | `src/core/nexus/collectionRevision.ts` | 56 |
| `readNexusCollectionRevision` | Function | `src/core/nexus/collectionRevision.ts` | 25 |
| `describeNexusPointer` | Function | `src/core/nexus/collectionPayload.ts` | 168 |
| `describeUploadError` | Function | `src/core/nexus/collectionUpload.ts` | 276 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `NexusUploadModal → GetEventHorizonRoot` | cross_community | 10 |
| `NexusUploadModal → GetVortexUserDataPath` | cross_community | 9 |
| `Upload → GetVortexUserDataPath` | cross_community | 9 |
| `NexusUploadModal → Truncate` | cross_community | 7 |
| `RefreshUpdates → GetVortexUserDataPath` | cross_community | 7 |
| `NexusUploadModal → ZipReadError` | cross_community | 6 |
| `Upload → Truncate` | cross_community | 5 |
| `NexusUploadModal → ReadEhcollError` | cross_community | 4 |
| `Upload → EmitAndAwait` | cross_community | 3 |
| `Upload → EmitAndAwait` | cross_community | 3 |

## How to Explore

1. `context({name: "countNexusCollectionMods"})` — see callers and callees
2. `query({search_query: "nexus"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
