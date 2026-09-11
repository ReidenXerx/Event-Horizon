---
name: gitnexus-area-build
description: "Skill for the Build area of Event-Horizon. 244 symbols across 40 files."
---

# Build

244 symbols | 40 files | Cohesion: 71%

## When to Use

- Working with code in `src/`
- Understanding how captureLoadOrder, take, describeExternalDrift work
- Modifying build-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/pages/build/buildSession.ts` | queuePosition, isAbortError, _runBuild, begin, discardDraft (+26) |
| `src/ui/pages/build/engine.ts` | BuildRefusedError, BundleResolutionError, applyPostProcessedDeclarations, buildOutputFileName, collectMirrorPayload (+24) |
| `src/ui/pages/build/BuildPage.tsx` | handle, handleDiscardDraft, handleChange, handleDismissDraftBanner, BuildRulesScopeSummary (+22) |
| `src/ui/pages/build/buildSessionRegistry.ts` | BuildSessionRegistry, getBuildSessionRegistry, ensure, get, makeHooks (+13) |
| `src/ui/pages/build/BuildDashboard.tsx` | slugsInUse, registry, DetailRow, PublishedDetailsPanel, formatBytes (+12) |
| `src/ui/pages/build/buildDiff.test.ts` | findPackages, findPackages, findPackages, findPackages, findPackages (+9) |
| `src/core/build/nexusAvailability.ts` | categoryOf, checkNexusAvailability, classifyFile, currentMainFile, fileIdOf (+6) |
| `src/core/draftStorage.ts` | deleteDraft, getAppDataPath, getDraftPath, isPlainObject, loadDraft (+4) |
| `src/core/archiveHashCache.ts` | archiveHashCacheKey, emptyArchiveHashCache, isHex64, loadArchiveHashCache, rememberArchiveHash (+4) |
| `src/core/build/nexusAvailability.test.ts` | entry, f, f, f, entries (+3) |

## Entry Points

Start here when exploring this area:

- **`captureLoadOrder`** (Function) — `src/core/loadOrder.ts:64`
- **`take`** (Function) — `src/core/loadOrder.ts:79`
- **`describeExternalDrift`** (Function) — `src/core/manifest/bundleFromStaging.ts:569`
- **`mergeRepackedBundles`** (Function) — `src/core/manifest/bundleFromStaging.ts:628`
- **`choiceFromEntry`** (Function) — `src/core/manifest/collectionConfig.ts:1171`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `BuildRefusedError` | Class | `src/ui/pages/build/engine.ts` | 1116 |
| `BundleResolutionError` | Class | `src/ui/pages/build/engine.ts` | 583 |
| `captureLoadOrder` | Function | `src/core/loadOrder.ts` | 64 |
| `take` | Function | `src/core/loadOrder.ts` | 79 |
| `describeExternalDrift` | Function | `src/core/manifest/bundleFromStaging.ts` | 569 |
| `mergeRepackedBundles` | Function | `src/core/manifest/bundleFromStaging.ts` | 628 |
| `choiceFromEntry` | Function | `src/core/manifest/collectionConfig.ts` | 1171 |
| `decidedPostProcessing` | Function | `src/core/manifest/collectionConfig.ts` | 1184 |
| `modsNewlyBundled` | Function | `src/core/manifest/collectionConfig.ts` | 1242 |
| `modsNoLongerBundled` | Function | `src/core/manifest/collectionConfig.ts` | 1208 |
| `toBuildManifestExternalMods` | Function | `src/core/manifest/collectionConfig.ts` | 438 |
| `applyDependencyOverrides` | Function | `src/core/manifest/externalDependencies.ts` | 599 |
| `applyHint` | Function | `src/core/manifest/externalHints.ts` | 229 |
| `describeUndeclared` | Function | `src/core/manifest/externalHints.ts` | 407 |
| `describeMachineKept` | Function | `src/core/manifest/gameIni.ts` | 392 |
| `findModsThatPromptTheUser` | Function | `src/core/manifest/runSelfChecks.ts` | 1070 |
| `slugsInUse` | Function | `src/ui/pages/build/BuildDashboard.tsx` | 370 |
| `applyPostProcessedDeclarations` | Function | `src/ui/pages/build/engine.ts` | 524 |
| `collectMirrorPayload` | Function | `src/ui/pages/build/engine.ts` | 472 |
| `runBuildPipeline` | Function | `src/ui/pages/build/engine.ts` | 1145 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `PublishedDetailsPanel → GetEventHorizonDir` | cross_community | 10 |
| `LoadPublishedDetails → GetEventHorizonRoot` | cross_community | 10 |
| `HandleDeletePublished → GetVortexUserDataPath` | cross_community | 10 |
| `PublishedDetailsPanel → GetVortexUserDataPath` | cross_community | 10 |
| `BuildWizard → GetVortexUserDataPath` | cross_community | 10 |
| `OnRecovered → GetVortexUserDataPath` | cross_community | 10 |
| `WriteEnvironmentSnapshot → GetVortexUserDataPath` | cross_community | 9 |
| `HandleCleanupUnbuilt → GetVortexUserDataPath` | cross_community | 9 |
| `RunEnvironmentGate → Notify` | cross_community | 8 |
| `PublishedDetailsPanel → Truncate` | cross_community | 8 |

## How to Explore

1. `context({name: "captureLoadOrder"})` — see callers and callees
2. `query({search_query: "build"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
