---
name: gitnexus-area-build
description: "Skill for the Build area of Event-Horizon. 250 symbols across 40 files."
---

# Build

250 symbols | 40 files | Cohesion: 71%

## When to Use

- Working with code in `src/`
- Understanding how deleteDraft, getAppDataPath, getDraftsRoot work
- Modifying build-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/pages/build/BuildPage.tsx` | handle, handleDiscardDraft, handleChange, handleDismissDraftBanner, session (+26) |
| `src/ui/pages/build/buildSession.ts` | queuePosition, _runBuild, discardDraft, releaseBuild, onDecisions (+26) |
| `src/ui/pages/build/engine.ts` | BuildRefusedError, BundleResolutionError, applyPostProcessedDeclarations, buildOutputFileName, declarationsFor (+23) |
| `src/ui/pages/build/BuildDashboard.tsx` | BuildDashboard, handleCleanupUnbuilt, handleDeletePublished, handleDiscardDraft, handleDismissBuilt (+17) |
| `src/ui/pages/build/buildSessionRegistry.ts` | BuildSessionRegistry, getBuildSessionRegistry, ensure, get, makeHooks (+13) |
| `src/ui/pages/build/buildDiff.test.ts` | findPackages, findPackages, findPackages, findPackages, findPackages (+9) |
| `src/core/manifest/collectionConfig.ts` | deleteCollectionConfig, deletePublishedCollection, isUuid, listNeverBuiltConfigs, listPublishedCollections (+6) |
| `src/core/build/nexusAvailability.ts` | categoryOf, checkNexusAvailability, classifyFile, currentMainFile, fileIdOf (+6) |
| `src/core/archiveHashCache.ts` | archiveHashCacheKey, emptyArchiveHashCache, isHex64, loadArchiveHashCache, rememberArchiveHash (+4) |
| `src/core/build/nexusAvailability.test.ts` | entry, f, f, f, entries (+3) |

## Entry Points

Start here when exploring this area:

- **`deleteDraft`** (Function) — `src/core/draftStorage.ts:509`
- **`getAppDataPath`** (Function) — `src/core/draftStorage.ts:543`
- **`getDraftsRoot`** (Function) — `src/core/draftStorage.ts:122`
- **`listDrafts`** (Function) — `src/core/draftStorage.ts:163`
- **`saveDraft`** (Function) — `src/core/draftStorage.ts:473`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `BuildRefusedError` | Class | `src/ui/pages/build/engine.ts` | 1116 |
| `BundleResolutionError` | Class | `src/ui/pages/build/engine.ts` | 583 |
| `deleteDraft` | Function | `src/core/draftStorage.ts` | 509 |
| `getAppDataPath` | Function | `src/core/draftStorage.ts` | 543 |
| `getDraftsRoot` | Function | `src/core/draftStorage.ts` | 122 |
| `listDrafts` | Function | `src/core/draftStorage.ts` | 163 |
| `saveDraft` | Function | `src/core/draftStorage.ts` | 473 |
| `beginOp` | Function | `src/core/logging/ehLog.ts` | 153 |
| `deleteCollectionConfig` | Function | `src/core/manifest/collectionConfig.ts` | 1046 |
| `deletePublishedCollection` | Function | `src/core/manifest/collectionConfig.ts` | 1038 |
| `listNeverBuiltConfigs` | Function | `src/core/manifest/collectionConfig.ts` | 1082 |
| `listPublishedCollections` | Function | `src/core/manifest/collectionConfig.ts` | 565 |
| `BuildDashboard` | Function | `src/ui/pages/build/BuildDashboard.tsx` | 205 |
| `handleCleanupUnbuilt` | Function | `src/ui/pages/build/BuildDashboard.tsx` | 406 |
| `handleDeletePublished` | Function | `src/ui/pages/build/BuildDashboard.tsx` | 534 |
| `handleDiscardDraft` | Function | `src/ui/pages/build/BuildDashboard.tsx` | 488 |
| `handleDismissBuilt` | Function | `src/ui/pages/build/BuildDashboard.tsx` | 717 |
| `handleOpenBuilt` | Function | `src/ui/pages/build/BuildDashboard.tsx` | 712 |
| `handleOpenDraft` | Function | `src/ui/pages/build/BuildDashboard.tsx` | 472 |
| `handleUpdatePublished` | Function | `src/ui/pages/build/BuildDashboard.tsx` | 575 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `PublishedDetailsPanel → GetEventHorizonDir` | cross_community | 10 |
| `Dashboard → GetEventHorizonRoot` | cross_community | 10 |
| `LoadPublishedDetails → GetEventHorizonRoot` | cross_community | 10 |
| `HandleDeletePublished → GetVortexUserDataPath` | cross_community | 10 |
| `PublishedDetailsPanel → GetVortexUserDataPath` | cross_community | 10 |
| `BuildPage → GetVortexUserDataPath` | cross_community | 10 |
| `BuildWizard → GetVortexUserDataPath` | cross_community | 10 |
| `OnRecovered → GetVortexUserDataPath` | cross_community | 10 |
| `LoadDashboardData → GetVortexUserDataPath` | cross_community | 10 |
| `BuildDiffCard → ToPosix` | cross_community | 9 |

## How to Explore

1. `context({name: "deleteDraft"})` — see callers and callees
2. `query({search_query: "build"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
