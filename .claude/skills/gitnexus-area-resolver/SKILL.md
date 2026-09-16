---
name: gitnexus-area-resolver
description: "Skill for the Resolver area of Event-Horizon. 115 symbols across 36 files."
---

# Resolver

115 symbols | 36 files | Cohesion: 67%

## When to Use

- Working with code in `src/`
- Understanding how createCompareModsAction, createComparePluginsAction, createExportModsAction work
- Modifying resolver-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/resolver/resolveInstallPlan.ts` | checkDeploymentMethod, checkExtensions, checkGameVersion, checkVortexVersion, compareSemverLike (+21) |
| `src/core/resolver/userState.ts` | buildSuggestedProfileName, buildUserSideState, judgeResumeCandidate, lookupProfile, pickInstallTarget (+14) |
| `src/ui/pages/install/engine.ts` | checkEnvironment, checkSystemRuntimes, profileExistsInState, runLoadingPipeline, runLoadingPipelineWithReceipt (+2) |
| `src/core/getModsListForProfile.ts` | getActiveGameId, getActiveProfileId, getActiveProfileIdFromState, belongsToGame, getModsForGame (+1) |
| `src/core/resolver/gameVersionGuidance.ts` | compareVersions, parse, describe, gameVersionGuidance |
| `src/core/installer/installMarker.ts` | listInterruptedInstalls, parseMarker, str |
| `src/core/paths/appDataPaths.ts` | getEventHorizonDir, getEventHorizonRoot, getVortexUserDataPath |
| `src/ui/pages/doctor/EnvironmentTools.tsx` | onGame, runCheck, activeGame |
| `src/utils/utils.ts` | exportDiffReport, pickJsonFile, pickTxtFile |
| `src/core/resolver/collectAvailableDownloads.ts` | belongsToGame, collectAvailableDownloads, readDownloadFiles |

## Entry Points

Start here when exploring this area:

- **`createCompareModsAction`** (Function) — `src/actions/compareModsAction.ts:21`
- **`createComparePluginsAction`** (Function) — `src/actions/comparePluginsAction.ts:16`
- **`createExportModsAction`** (Function) — `src/actions/exportModsAction.ts:17`
- **`enrichModsWithArchiveHashes`** (Function) — `src/core/archiveHashing.ts:184`
- **`discoveredStore`** (Function) — `src/core/comparePlugins.ts:160`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `createCompareModsAction` | Function | `src/actions/compareModsAction.ts` | 21 |
| `createComparePluginsAction` | Function | `src/actions/comparePluginsAction.ts` | 16 |
| `createExportModsAction` | Function | `src/actions/exportModsAction.ts` | 17 |
| `enrichModsWithArchiveHashes` | Function | `src/core/archiveHashing.ts` | 184 |
| `discoveredStore` | Function | `src/core/comparePlugins.ts` | 160 |
| `exportPluginsDiffReport` | Function | `src/core/comparePlugins.ts` | 371 |
| `profileDriftSince` | Function | `src/core/curator/profileDrift.ts` | 51 |
| `logBundleDirs` | Function | `src/core/diagnostics/logBundle.ts` | 45 |
| `profileId` | Function | `src/core/environment/snapshot.ts` | 203 |
| `exportModsToJsonFile` | Function | `src/core/exportMods.ts` | 8 |
| `getActiveGameId` | Function | `src/core/getModsListForProfile.ts` | 283 |
| `getActiveProfileId` | Function | `src/core/getModsListForProfile.ts` | 288 |
| `getActiveProfileIdFromState` | Function | `src/core/getModsListForProfile.ts` | 320 |
| `belongsToGame` | Function | `src/core/getModsListForProfile.ts` | 325 |
| `getModsForGame` | Function | `src/core/getModsListForProfile.ts` | 660 |
| `getModsForProfile` | Function | `src/core/getModsListForProfile.ts` | 625 |
| `listInstallAttempts` | Function | `src/core/installer/attemptRecord.ts` | 147 |
| `listInterruptedInstalls` | Function | `src/core/installer/installMarker.ts` | 132 |
| `deploymentInProgress` | Function | `src/core/installer/profileCleanup.ts` | 151 |
| `removeSupersededProfiles` | Function | `src/core/installer/profileCleanup.ts` | 182 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `LaunchGame → GetVortexUserDataPath` | cross_community | 10 |
| `RunInstallImpl → GetEventHorizonRoot` | cross_community | 10 |
| `LoadPublishedDetails → GetEventHorizonDir` | cross_community | 10 |
| `RunSelfChecks → GetVortexUserDataPath` | cross_community | 10 |
| `Dashboard → GetEventHorizonRoot` | cross_community | 10 |
| `InstallDownloads → GetEventHorizonDir` | cross_community | 10 |
| `HandleDeletePublished → GetVortexUserDataPath` | cross_community | 10 |
| `RunLoadingPipeline → GetEventHorizonRoot` | cross_community | 10 |
| `Act → GetEventHorizonDir` | cross_community | 10 |
| `BuildPage → GetVortexUserDataPath` | cross_community | 10 |

## How to Explore

1. `context({name: "createCompareModsAction"})` — see callers and callees
2. `query({search_query: "resolver"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
