---
name: gitnexus-area-resolver
description: "Skill for the Resolver area of Event-Horizon. 85 symbols across 19 files."
---

# Resolver

85 symbols | 19 files | Cohesion: 75%

## When to Use

- Working with code in `src/`
- Understanding how createCompareModsAction, createExportModsAction, createInstallCollectionAction work
- Modifying resolver-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/resolver/resolveInstallPlan.ts` | bundledZipPath, extractExtension, findDownloadBySha, findInstalledByNexusExact, findInstalledByNexusFileMismatch (+23) |
| `src/core/resolver/userState.ts` | buildSuggestedProfileName, buildUserSideState, pickInstallTarget, previousInstallFromReceipt, readDisabledExtensionsMap (+9) |
| `src/actions/installCollectionAction.ts` | createInstallCollectionAction, formatError, isPlanInstallable, logPlanSummary, profileExistsInState (+2) |
| `src/ui/pages/install/engine.ts` | checkSystemRuntimes, profileExistsInState, runLoadingPipeline, runLoadingPipelineWithReceipt, warnIfSevenZipBroken |
| `src/core/getModsListForProfile.ts` | getActiveGameId, getActiveProfileId, getActiveProfileIdFromState, belongsToGame |
| `src/core/resolver/collectAvailableDownloads.test.ts` | action, engine, pipelines, read |
| `src/core/resolver/gameVersionGuidance.ts` | compareVersions, parse, describe, gameVersionGuidance |
| `src/core/paths.ts` | getEventHorizonDir, getEventHorizonRoot, getVortexUserDataPath |
| `src/utils/utils.ts` | exportDiffReport, pickEhcollFile, pickJsonFile |
| `src/core/resolver/scanAvailableDownloads.ts` | downloadsDirFor, scanAvailableDownloads |

## Entry Points

Start here when exploring this area:

- **`createCompareModsAction`** (Function) — `src/actions/compareModsAction.ts:21`
- **`createExportModsAction`** (Function) — `src/actions/exportModsAction.ts:17`
- **`createInstallCollectionAction`** (Function) — `src/actions/installCollectionAction.ts:112`
- **`exportModsToJsonFile`** (Function) — `src/core/exportMods.ts:7`
- **`getActiveGameId`** (Function) — `src/core/getModsListForProfile.ts:249`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `createCompareModsAction` | Function | `src/actions/compareModsAction.ts` | 21 |
| `createExportModsAction` | Function | `src/actions/exportModsAction.ts` | 17 |
| `createInstallCollectionAction` | Function | `src/actions/installCollectionAction.ts` | 112 |
| `exportModsToJsonFile` | Function | `src/core/exportMods.ts` | 7 |
| `getActiveGameId` | Function | `src/core/getModsListForProfile.ts` | 249 |
| `getActiveProfileId` | Function | `src/core/getModsListForProfile.ts` | 254 |
| `getActiveProfileIdFromState` | Function | `src/core/getModsListForProfile.ts` | 286 |
| `belongsToGame` | Function | `src/core/getModsListForProfile.ts` | 291 |
| `deleteReceipt` | Function | `src/core/installLedger.ts` | 422 |
| `beginOp` | Function | `src/core/logging/ehLog.ts` | 153 |
| `getEventHorizonDir` | Function | `src/core/paths.ts` | 53 |
| `getEventHorizonRoot` | Function | `src/core/paths.ts` | 43 |
| `getVortexUserDataPath` | Function | `src/core/paths.ts` | 38 |
| `downloadsDirFor` | Function | `src/core/resolver/scanAvailableDownloads.ts` | 40 |
| `scanAvailableDownloads` | Function | `src/core/resolver/scanAvailableDownloads.ts` | 57 |
| `buildUserSideState` | Function | `src/core/resolver/userState.ts` | 120 |
| `pickInstallTarget` | Function | `src/core/resolver/userState.ts` | 150 |
| `previousInstallFromReceipt` | Function | `src/core/resolver/userState.ts` | 175 |
| `resolveDeploymentMethod` | Function | `src/core/resolver/userState.ts` | 227 |
| `resolveEnabledExtensions` | Function | `src/core/resolver/userState.ts` | 267 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `ExecutePromptUserChoice → GetEventHorizonDir` | cross_community | 10 |
| `RunInstallImpl → GetEventHorizonRoot` | cross_community | 10 |
| `ReadZipEntry → GetVortexUserDataPath` | cross_community | 10 |
| `PublishedDetailsPanel → GetEventHorizonDir` | cross_community | 10 |
| `Dashboard → GetEventHorizonRoot` | cross_community | 10 |
| `RunSelfChecks → GetVortexUserDataPath` | cross_community | 10 |
| `Act → GetEventHorizonDir` | cross_community | 10 |
| `LoadPublishedDetails → GetEventHorizonRoot` | cross_community | 10 |
| `SelfCheckMod → GetVortexUserDataPath` | cross_community | 10 |
| `RunLoadingPipeline → GetEventHorizonRoot` | cross_community | 10 |

## How to Explore

1. `context({name: "createCompareModsAction"})` — see callers and callees
2. `query({search_query: "resolver"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
