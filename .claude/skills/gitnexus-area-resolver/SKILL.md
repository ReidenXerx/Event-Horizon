---
name: gitnexus-area-resolver
description: "Skill for the Resolver area of Event-Horizon. 155 symbols across 56 files."
---

# Resolver

155 symbols | 56 files | Cohesion: 66%

## When to Use

- Working with code in `src/`
- Understanding how createCompareModsAction, createComparePluginsAction, createExportModsAction work
- Modifying resolver-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/resolver/resolveInstallPlan.ts` | checkDeploymentMethod, checkExtensions, checkGameVersion, checkVortexVersion, compareSemverLike (+21) |
| `src/core/resolver/userState.ts` | buildSuggestedProfileName, buildUserSideState, judgeResumeCandidate, lookupProfile, pickInstallTarget (+14) |
| `src/actions/installCollectionAction.ts` | createInstallCollectionAction, formatError, isPlanInstallable, profileExistsInState, resolveStaleReceipt (+2) |
| `src/core/getModsListForProfile.ts` | getActiveGameId, getActiveProfileId, getActiveProfileIdFromState, belongsToGame, getModsForGame (+1) |
| `src/ui/pages/install/engine.ts` | checkEnvironment, checkSystemRuntimes, profileExistsInState, runLoadingPipeline, runLoadingPipelineWithReceipt (+1) |
| `src/core/resolver/enrichStagingSetHashes.ts` | collectExternalStagingSetHashTargets, collectStagingSetHashTargetsForTest, enrichInstalledModsWithStagingSetHashes, normalizeName |
| `src/core/stagingPath.ts` | installRootFor, installationPathFromState, stagingRootForModId, stagingRootFromFolder |
| `src/utils/utils.ts` | exportDiffReport, pickEhcollFile, pickJsonFile, pickTxtFile |
| `src/core/resolver/collectAvailableDownloads.test.ts` | action, engine, pipelines, read |
| `src/core/resolver/gameVersionGuidance.ts` | compareVersions, parse, describe, gameVersionGuidance |

## Entry Points

Start here when exploring this area:

- **`createCompareModsAction`** (Function) — `src/actions/compareModsAction.ts:21`
- **`createComparePluginsAction`** (Function) — `src/actions/comparePluginsAction.ts:16`
- **`createExportModsAction`** (Function) — `src/actions/exportModsAction.ts:17`
- **`createInstallCollectionAction`** (Function) — `src/actions/installCollectionAction.ts:119`
- **`archiveFileCacheKey`** (Function) — `src/core/archiveHashCache.ts:84`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `createCompareModsAction` | Function | `src/actions/compareModsAction.ts` | 21 |
| `createComparePluginsAction` | Function | `src/actions/comparePluginsAction.ts` | 16 |
| `createExportModsAction` | Function | `src/actions/exportModsAction.ts` | 17 |
| `createInstallCollectionAction` | Function | `src/actions/installCollectionAction.ts` | 119 |
| `archiveFileCacheKey` | Function | `src/core/archiveHashCache.ts` | 84 |
| `enrichModsWithArchiveHashes` | Function | `src/core/archiveHashing.ts` | 184 |
| `hashFileSha256` | Function | `src/core/archiveHashing.ts` | 39 |
| `cleanup` | Function | `src/core/archiveHashing.ts` | 59 |
| `recoverMissingArchives` | Function | `src/core/archiveRecovery.ts` | 248 |
| `discoveredStore` | Function | `src/core/comparePlugins.ts` | 160 |
| `exportPluginsDiffReport` | Function | `src/core/comparePlugins.ts` | 371 |
| `liveStagingShapes` | Function | `src/core/curator/liveStagingShapes.ts` | 41 |
| `lightFlagTargets` | Function | `src/core/curator/pluginView.ts` | 38 |
| `key` | Function | `src/core/curator/pluginView.ts` | 41 |
| `profileDriftSince` | Function | `src/core/curator/profileDrift.ts` | 51 |
| `logBundleDirs` | Function | `src/core/diagnostics/logBundle.ts` | 45 |
| `profileId` | Function | `src/core/environment/snapshot.ts` | 203 |
| `stagingRoot` | Function | `src/core/environment/snapshot.ts` | 326 |
| `exportModsToJsonFile` | Function | `src/core/exportMods.ts` | 8 |
| `getActiveGameId` | Function | `src/core/getModsListForProfile.ts` | 277 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `LaunchGame → GetVortexUserDataPath` | cross_community | 10 |
| `RunInstallImpl → GetEventHorizonRoot` | cross_community | 10 |
| `PublishedDetailsPanel → GetEventHorizonDir` | cross_community | 10 |
| `RunSelfChecks → GetVortexUserDataPath` | cross_community | 10 |
| `Dashboard → GetEventHorizonRoot` | cross_community | 10 |
| `InstallDownloads → GetEventHorizonDir` | cross_community | 10 |
| `HandleDeletePublished → GetVortexUserDataPath` | cross_community | 10 |
| `LoadPublishedDetails → GetEventHorizonRoot` | cross_community | 10 |
| `Act → GetEventHorizonDir` | cross_community | 10 |
| `PublishedDetailsPanel → GetVortexUserDataPath` | cross_community | 10 |

## How to Explore

1. `context({name: "createCompareModsAction"})` — see callers and callees
2. `query({search_query: "resolver"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
