---
name: gitnexus-area-resolver
description: "Skill for the Resolver area of Event-Horizon. 77 symbols across 14 files."
---

# Resolver

77 symbols | 14 files | Cohesion: 78%

## When to Use

- Working with code in `src/`
- Understanding how createInstallCollectionAction, getModsForGame, readReceipt work
- Modifying resolver-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/resolver/resolveInstallPlan.ts` | bundledZipPath, extractExtension, findDownloadBySha, findInstalledByNexusExact, findInstalledByNexusFileMismatch (+24) |
| `src/core/resolver/userState.ts` | buildSuggestedProfileName, buildUserSideState, pickInstallTarget, previousInstallFromReceipt, readDisabledExtensionsMap (+10) |
| `src/ui/pages/install/engine.ts` | checkSystemRuntimes, profileExistsInState, runLoadingPipeline, checkAbort, runLoadingPipelineWithReceipt (+2) |
| `src/actions/installCollectionAction.ts` | createInstallCollectionAction, formatError, isPlanInstallable, profileExistsInState, resolveStaleReceipt (+1) |
| `src/core/resolver/collectAvailableDownloads.test.ts` | action, engine, pipelines, read |
| `src/core/resolver/gameVersionGuidance.ts` | compareVersions, parse, describe, gameVersionGuidance |
| `src/core/resolver/logInstallPlan.ts` | countBy, describeInputs, logInstallPlan |
| `src/core/resolver/scanAvailableDownloads.ts` | downloadsDirFor, scanAvailableDownloads |
| `src/core/resolver/resumeIdentity.test.ts` | decide, manifest |
| `src/core/getModsListForProfile.ts` | getModsForGame |

## Entry Points

Start here when exploring this area:

- **`createInstallCollectionAction`** (Function) — `src/actions/installCollectionAction.ts:116`
- **`getModsForGame`** (Function) — `src/core/getModsListForProfile.ts:585`
- **`readReceipt`** (Function) — `src/core/installLedger.ts:351`
- **`listInstallAttempts`** (Function) — `src/core/installer/attemptRecord.ts:138`
- **`downloadsDirFor`** (Function) — `src/core/resolver/scanAvailableDownloads.ts:40`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `createInstallCollectionAction` | Function | `src/actions/installCollectionAction.ts` | 116 |
| `getModsForGame` | Function | `src/core/getModsListForProfile.ts` | 585 |
| `readReceipt` | Function | `src/core/installLedger.ts` | 351 |
| `listInstallAttempts` | Function | `src/core/installer/attemptRecord.ts` | 138 |
| `downloadsDirFor` | Function | `src/core/resolver/scanAvailableDownloads.ts` | 40 |
| `scanAvailableDownloads` | Function | `src/core/resolver/scanAvailableDownloads.ts` | 57 |
| `buildUserSideState` | Function | `src/core/resolver/userState.ts` | 120 |
| `pickInstallTarget` | Function | `src/core/resolver/userState.ts` | 150 |
| `previousInstallFromReceipt` | Function | `src/core/resolver/userState.ts` | 324 |
| `resolveDeploymentMethod` | Function | `src/core/resolver/userState.ts` | 376 |
| `resolveEnabledExtensions` | Function | `src/core/resolver/userState.ts` | 416 |
| `resolveGameVersion` | Function | `src/core/resolver/userState.ts` | 353 |
| `resolveProfileName` | Function | `src/core/resolver/userState.ts` | 446 |
| `resolveVortexVersion` | Function | `src/core/resolver/userState.ts` | 346 |
| `resumableProfileFromAttempts` | Function | `src/core/resolver/userState.ts` | 259 |
| `runLoadingPipeline` | Function | `src/ui/pages/install/engine.ts` | 131 |
| `checkAbort` | Function | `src/ui/pages/install/engine.ts` | 138 |
| `runLoadingPipelineWithReceipt` | Function | `src/ui/pages/install/engine.ts` | 361 |
| `checkAbort` | Function | `src/ui/pages/install/engine.ts` | 384 |
| `warnIfSevenZipBroken` | Function | `src/ui/pages/install/engine.ts` | 530 |

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
| `RunLoadingPipelineWithReceipt → NormalizeRuleReference` | cross_community | 5 |
| `RunLoadingPipelineWithReceipt → RulesSortKey` | cross_community | 5 |
| `RunLoadingPipeline → ReadEhcollError` | cross_community | 4 |

## How to Explore

1. `context({name: "createInstallCollectionAction"})` — see callers and callees
2. `query({search_query: "resolver"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
