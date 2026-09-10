---
name: gitnexus-area-resolver
description: "Skill for the Resolver area of Event-Horizon. 96 symbols across 21 files."
---

# Resolver

96 symbols | 21 files | Cohesion: 78%

## When to Use

- Working with code in `src/`
- Understanding how createInstallCollectionAction, discoveredStore, getModsForGame work
- Modifying resolver-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/resolver/resolveInstallPlan.ts` | enforceInstallTargetInvariant, resolveExternalDependencies, resolveInstallPlan, resolveOrphanedMods, resolvePluginOrder (+24) |
| `src/core/resolver/userState.ts` | buildSuggestedProfileName, buildUserSideState, judgeResumeCandidate, lookupProfile, pickInstallTarget (+14) |
| `src/actions/installCollectionAction.ts` | createInstallCollectionAction, formatError, isPlanInstallable, profileExistsInState, resolveStaleReceipt (+1) |
| `src/ui/pages/install/engine.ts` | checkSystemRuntimes, profileExistsInState, runLoadingPipeline, runLoadingPipelineWithReceipt, warnIfSevenZipBroken |
| `src/core/resolver/collectAvailableDownloads.test.ts` | action, engine, pipelines, read |
| `src/core/resolver/enrichStagingSetHashes.ts` | bundledInstallName, collectExternalStagingSetHashTargets, collectStagingSetHashTargetsForTest, normalizeName |
| `src/core/resolver/gameVersionGuidance.ts` | compareVersions, parse, describe, gameVersionGuidance |
| `src/core/installer/installMarker.ts` | listInterruptedInstalls, parseMarker, str |
| `src/core/resolver/logInstallPlan.ts` | countBy, describeInputs, logInstallPlan |
| `src/core/installer/resumeSources.test.ts` | resolve, state |

## Entry Points

Start here when exploring this area:

- **`createInstallCollectionAction`** (Function) — `src/actions/installCollectionAction.ts:119`
- **`discoveredStore`** (Function) — `src/core/comparePlugins.ts:160`
- **`getModsForGame`** (Function) — `src/core/getModsListForProfile.ts:649`
- **`listInstallAttempts`** (Function) — `src/core/installer/attemptRecord.ts:147`
- **`listInterruptedInstalls`** (Function) — `src/core/installer/installMarker.ts:132`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `createInstallCollectionAction` | Function | `src/actions/installCollectionAction.ts` | 119 |
| `discoveredStore` | Function | `src/core/comparePlugins.ts` | 160 |
| `getModsForGame` | Function | `src/core/getModsListForProfile.ts` | 649 |
| `listInstallAttempts` | Function | `src/core/installer/attemptRecord.ts` | 147 |
| `listInterruptedInstalls` | Function | `src/core/installer/installMarker.ts` | 132 |
| `resumeCandidates` | Function | `src/core/installer/resumeSources.ts` | 48 |
| `downloadsDirFor` | Function | `src/core/resolver/scanAvailableDownloads.ts` | 40 |
| `scanAvailableDownloads` | Function | `src/core/resolver/scanAvailableDownloads.ts` | 57 |
| `buildUserSideState` | Function | `src/core/resolver/userState.ts` | 127 |
| `pickInstallTarget` | Function | `src/core/resolver/userState.ts` | 158 |
| `previousInstallFromReceipt` | Function | `src/core/resolver/userState.ts` | 468 |
| `receiptProfileStillExists` | Function | `src/core/resolver/userState.ts` | 453 |
| `resolveDeploymentMethod` | Function | `src/core/resolver/userState.ts` | 523 |
| `resolveEnabledExtensions` | Function | `src/core/resolver/userState.ts` | 563 |
| `resolveGameVersion` | Function | `src/core/resolver/userState.ts` | 500 |
| `resolveProfileName` | Function | `src/core/resolver/userState.ts` | 593 |
| `resolveVortexVersion` | Function | `src/core/resolver/userState.ts` | 493 |
| `resumableProfileFromAttempts` | Function | `src/core/resolver/userState.ts` | 304 |
| `runLoadingPipeline` | Function | `src/ui/pages/install/engine.ts` | 135 |
| `runLoadingPipelineWithReceipt` | Function | `src/ui/pages/install/engine.ts` | 381 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `RunLoadingPipeline → GetEventHorizonRoot` | cross_community | 10 |
| `RunLoadingPipeline → GetVortexUserDataPath` | cross_community | 9 |
| `RunLoadingPipelineWithReceipt → GetVortexUserDataPath` | cross_community | 8 |
| `RunLoadingPipeline → Truncate` | cross_community | 7 |
| `RouteOutlet → ResolveProfileName` | cross_community | 6 |
| `RouteOutlet → ResolveVortexVersion` | cross_community | 6 |
| `RunLoadingPipeline → ZipReadError` | cross_community | 6 |
| `EnrichInstalledModsWithStagingSetHashes → ArchiveExtensionOf` | cross_community | 5 |
| `RunLoadingPipelineWithReceipt → NormalizeRuleReference` | cross_community | 5 |
| `RunLoadingPipelineWithReceipt → RulesSortKey` | cross_community | 5 |

## How to Explore

1. `context({name: "createInstallCollectionAction"})` — see callers and callees
2. `query({search_query: "resolver"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
