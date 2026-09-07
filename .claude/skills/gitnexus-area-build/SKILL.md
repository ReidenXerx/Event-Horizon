---
name: gitnexus-area-build
description: "Skill for the Build area of Event-Horizon. 271 symbols across 47 files."
---

# Build

271 symbols | 47 files | Cohesion: 72%

## When to Use

- Working with code in `src/`
- Understanding how describeExternalDrift, mergeRepackedBundles, choiceFromEntry work
- Modifying build-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/pages/build/BuildPage.tsx` | handle, handleDiscardDraft, handleChange, handleDismissDraftBanner, session (+27) |
| `src/ui/pages/build/buildSession.ts` | queuePosition, isAbortError, _runBuild, begin, discardDraft (+26) |
| `src/ui/pages/build/engine.ts` | BuildRefusedError, BundleResolutionError, applyPostProcessedDeclarations, buildOutputFileName, declarationsFor (+24) |
| `src/ui/pages/build/BuildDashboard.tsx` | slugsInUse, BuildDashboard, handleDismissBuilt, handleOpenBuilt, handleOpenDraft (+17) |
| `src/ui/pages/build/buildSessionRegistry.ts` | BuildSessionRegistry, getBuildSessionRegistry, ensure, get, makeHooks (+13) |
| `src/ui/pages/build/buildDiff.test.ts` | findPackages, findPackages, findPackages, findPackages, findPackages (+9) |
| `src/core/manifest/collectionConfig.ts` | choiceFromEntry, decidedPostProcessing, modsNewlyBundled, modsNoLongerBundled, isUuid (+7) |
| `src/core/draftStorage.ts` | deleteDraft, getAppDataPath, getDraftPath, isPlainObject, loadDraft (+6) |
| `src/core/build/nexusAvailability.ts` | categoryOf, checkNexusAvailability, classifyFile, currentMainFile, fileIdOf (+6) |
| `src/core/archiveHashCache.ts` | archiveHashCacheKey, emptyArchiveHashCache, isHex64, loadArchiveHashCache, rememberArchiveHash (+4) |

## Entry Points

Start here when exploring this area:

- **`describeExternalDrift`** (Function) — `src/core/manifest/bundleFromStaging.ts:549`
- **`mergeRepackedBundles`** (Function) — `src/core/manifest/bundleFromStaging.ts:608`
- **`choiceFromEntry`** (Function) — `src/core/manifest/collectionConfig.ts:1128`
- **`decidedPostProcessing`** (Function) — `src/core/manifest/collectionConfig.ts:1137`
- **`modsNewlyBundled`** (Function) — `src/core/manifest/collectionConfig.ts:1195`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `BuildRefusedError` | Class | `src/ui/pages/build/engine.ts` | 1040 |
| `BundleResolutionError` | Class | `src/ui/pages/build/engine.ts` | 507 |
| `describeExternalDrift` | Function | `src/core/manifest/bundleFromStaging.ts` | 549 |
| `mergeRepackedBundles` | Function | `src/core/manifest/bundleFromStaging.ts` | 608 |
| `choiceFromEntry` | Function | `src/core/manifest/collectionConfig.ts` | 1128 |
| `decidedPostProcessing` | Function | `src/core/manifest/collectionConfig.ts` | 1137 |
| `modsNewlyBundled` | Function | `src/core/manifest/collectionConfig.ts` | 1195 |
| `modsNoLongerBundled` | Function | `src/core/manifest/collectionConfig.ts` | 1161 |
| `applyDependencyOverrides` | Function | `src/core/manifest/externalDependencies.ts` | 554 |
| `describeUndeclared` | Function | `src/core/manifest/externalHints.ts` | 407 |
| `describeMachineKept` | Function | `src/core/manifest/gameIni.ts` | 353 |
| `slugsInUse` | Function | `src/ui/pages/build/BuildDashboard.tsx` | 381 |
| `applyPostProcessedDeclarations` | Function | `src/ui/pages/build/engine.ts` | 466 |
| `runBuildPipeline` | Function | `src/ui/pages/build/engine.ts` | 1049 |
| `checkAbort` | Function | `src/ui/pages/build/engine.ts` | 1079 |
| `slugify` | Function | `src/ui/pages/build/engine.ts` | 2365 |
| `deleteDraft` | Function | `src/core/draftStorage.ts` | 509 |
| `getAppDataPath` | Function | `src/core/draftStorage.ts` | 543 |
| `getDraftPath` | Function | `src/core/draftStorage.ts` | 102 |
| `loadDraft` | Function | `src/core/draftStorage.ts` | 143 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `PublishedDetailsPanel → GetEventHorizonDir` | cross_community | 10 |
| `LoadPublishedDetails → GetEventHorizonRoot` | cross_community | 10 |
| `HandleDeletePublished → GetVortexUserDataPath` | cross_community | 10 |
| `PublishedDetailsPanel → GetVortexUserDataPath` | cross_community | 10 |
| `BuildPage → GetVortexUserDataPath` | cross_community | 10 |
| `BuildWizard → GetVortexUserDataPath` | cross_community | 10 |
| `OnRecovered → GetVortexUserDataPath` | cross_community | 10 |
| `HandleCleanupUnbuilt → GetVortexUserDataPath` | cross_community | 9 |
| `Handle → GetVortexUserDataPath` | cross_community | 9 |
| `HandleDiscardDraft → GetVortexUserDataPath` | cross_community | 9 |

## How to Explore

1. `context({name: "describeExternalDrift"})` — see callers and callees
2. `query({search_query: "build"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
