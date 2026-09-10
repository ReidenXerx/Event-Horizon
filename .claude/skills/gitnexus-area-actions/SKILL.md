---
name: gitnexus-area-actions
description: "Skill for the Actions area of Event-Horizon. 60 symbols across 15 files."
---

# Actions

60 symbols | 15 files | Cohesion: 73%

## When to Use

- Working with code in `src/`
- Understanding how createCompareModsAction, createComparePluginsAction, createExportModsAction work
- Modifying actions-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/actions/installCollectionAction.ts` | collectUserDecisions, formatDivergedConflictText, formatOrphanText, formatPromptUserText, pickConflictChoice (+24) |
| `src/utils/utils.ts` | exportDiffReport, pickJsonFile, pickTxtFile, pickModArchiveFile, openFile (+1) |
| `src/core/getModsListForProfile.ts` | getActiveGameId, getActiveProfileId, getActiveProfileIdFromState, belongsToGame, getModsForProfile |
| `src/actions/compareModsAction.ts` | createCompareModsAction, action, action |
| `src/actions/comparePluginsAction.ts` | createComparePluginsAction, action, action |
| `src/actions/exportModsAction.ts` | createExportModsAction, action, action |
| `src/ui/pages/build/BuildDashboard.tsx` | recentlyBuilt, diff |
| `src/ui/pages/dashboard/data.ts` | formatGameLabel, readSystemStatus |
| `src/core/comparePlugins.ts` | exportPluginsDiffReport |
| `src/core/curator/profileDrift.ts` | profileDriftSince |

## Entry Points

Start here when exploring this area:

- **`createCompareModsAction`** (Function) — `src/actions/compareModsAction.ts:21`
- **`createComparePluginsAction`** (Function) — `src/actions/comparePluginsAction.ts:16`
- **`createExportModsAction`** (Function) — `src/actions/exportModsAction.ts:17`
- **`exportPluginsDiffReport`** (Function) — `src/core/comparePlugins.ts:371`
- **`profileDriftSince`** (Function) — `src/core/curator/profileDrift.ts:51`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `createCompareModsAction` | Function | `src/actions/compareModsAction.ts` | 21 |
| `createComparePluginsAction` | Function | `src/actions/comparePluginsAction.ts` | 16 |
| `createExportModsAction` | Function | `src/actions/exportModsAction.ts` | 17 |
| `exportPluginsDiffReport` | Function | `src/core/comparePlugins.ts` | 371 |
| `profileDriftSince` | Function | `src/core/curator/profileDrift.ts` | 51 |
| `exportModsToJsonFile` | Function | `src/core/exportMods.ts` | 7 |
| `getActiveGameId` | Function | `src/core/getModsListForProfile.ts` | 272 |
| `getActiveProfileId` | Function | `src/core/getModsListForProfile.ts` | 277 |
| `getActiveProfileIdFromState` | Function | `src/core/getModsListForProfile.ts` | 309 |
| `belongsToGame` | Function | `src/core/getModsListForProfile.ts` | 314 |
| `getModsForProfile` | Function | `src/core/getModsListForProfile.ts` | 614 |
| `getVortexUserDataPath` | Function | `src/core/paths/appDataPaths.ts` | 38 |
| `recentlyBuilt` | Function | `src/ui/pages/build/BuildDashboard.tsx` | 668 |
| `readSystemStatus` | Function | `src/ui/pages/dashboard/data.ts` | 133 |
| `exportDiffReport` | Function | `src/utils/utils.ts` | 454 |
| `pickJsonFile` | Function | `src/utils/utils.ts` | 70 |
| `pickTxtFile` | Function | `src/utils/utils.ts` | 473 |
| `pickModArchiveFile` | Function | `src/utils/utils.ts` | 113 |
| `action` | Function | `src/actions/compareModsAction.ts` | 104 |
| `action` | Function | `src/actions/comparePluginsAction.ts` | 71 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `ReadZipEntry → GetVortexUserDataPath` | cross_community | 10 |
| `RunSelfChecks → GetVortexUserDataPath` | cross_community | 10 |
| `SelfCheckMod → GetVortexUserDataPath` | cross_community | 10 |
| `HandleDeletePublished → GetVortexUserDataPath` | cross_community | 10 |
| `PublishedDetailsPanel → GetVortexUserDataPath` | cross_community | 10 |
| `BuildPage → GetVortexUserDataPath` | cross_community | 10 |
| `BuildWizard → GetVortexUserDataPath` | cross_community | 10 |
| `OnRecovered → GetVortexUserDataPath` | cross_community | 10 |
| `ListArchive → GetVortexUserDataPath` | cross_community | 10 |
| `LoadDashboardData → GetVortexUserDataPath` | cross_community | 10 |

## How to Explore

1. `context({name: "createCompareModsAction"})` — see callers and callees
2. `query({search_query: "actions"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
