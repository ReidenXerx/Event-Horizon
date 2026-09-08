---
name: gitnexus-area-actions
description: "Skill for the Actions area of Event-Horizon. 88 symbols across 22 files."
---

# Actions

88 symbols | 22 files | Cohesion: 68%

## When to Use

- Working with code in `src/`
- Understanding how createBuildPackageAction, captureDeploymentManifests, collectDistinctModTypes work
- Modifying actions-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/actions/installCollectionAction.ts` | collectUserDecisions, formatDivergedConflictText, formatOrphanText, formatPromptUserText, pickConflictChoice (+24) |
| `src/actions/buildPackageAction.ts` | BundleResolutionError, createBuildPackageAction, formatBytes, formatError, promptCuratorMetadata (+8) |
| `src/utils/utils.ts` | exportDiffReport, pickJsonFile, pickModArchiveFile, openFile, openFolder (+1) |
| `src/core/comparePlugins.ts` | getCurrentPluginsTxtPath, getLocalAppDataPath, pluginsTxtFolderCandidates, discoveredStore, exportPluginsDiffReport |
| `src/core/getModsListForProfile.ts` | getActiveGameId, getActiveProfileId, getActiveProfileIdFromState, belongsToGame |
| `src/core/deploymentManifest.ts` | captureDeploymentManifests, collectDistinctModTypes, normalizeManifest |
| `src/core/manifest/packageFileName.ts` | buildOutputFileName, safePackageVersion, slugifyPackageName |
| `src/actions/compareModsAction.ts` | createCompareModsAction, action, action |
| `src/actions/exportModsAction.ts` | createExportModsAction, action, action |
| `src/actions/comparePluginsAction.ts` | action, action, createComparePluginsAction |

## Entry Points

Start here when exploring this area:

- **`createBuildPackageAction`** (Function) — `src/actions/buildPackageAction.ts:120`
- **`captureDeploymentManifests`** (Function) — `src/core/deploymentManifest.ts:133`
- **`collectDistinctModTypes`** (Function) — `src/core/deploymentManifest.ts:53`
- **`matchEhcollFile`** (Function) — `src/core/doctor/heal.ts:202`
- **`captureLoadOrder`** (Function) — `src/core/loadOrder.ts:64`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `createBuildPackageAction` | Function | `src/actions/buildPackageAction.ts` | 120 |
| `captureDeploymentManifests` | Function | `src/core/deploymentManifest.ts` | 133 |
| `collectDistinctModTypes` | Function | `src/core/deploymentManifest.ts` | 53 |
| `matchEhcollFile` | Function | `src/core/doctor/heal.ts` | 202 |
| `captureLoadOrder` | Function | `src/core/loadOrder.ts` | 64 |
| `take` | Function | `src/core/loadOrder.ts` | 79 |
| `reconcileExternalModsConfig` | Function | `src/core/manifest/collectionConfig.ts` | 391 |
| `toBuildManifestExternalMods` | Function | `src/core/manifest/collectionConfig.ts` | 438 |
| `applyHint` | Function | `src/core/manifest/externalHints.ts` | 229 |
| `locateCollectionPackage` | Function | `src/core/manifest/locatePackage.ts` | 28 |
| `buildOutputFileName` | Function | `src/core/manifest/packageFileName.ts` | 32 |
| `safePackageVersion` | Function | `src/core/manifest/packageFileName.ts` | 27 |
| `slugifyPackageName` | Function | `src/core/manifest/packageFileName.ts` | 15 |
| `createCompareModsAction` | Function | `src/actions/compareModsAction.ts` | 21 |
| `createExportModsAction` | Function | `src/actions/exportModsAction.ts` | 17 |
| `exportModsToJsonFile` | Function | `src/core/exportMods.ts` | 7 |
| `getActiveGameId` | Function | `src/core/getModsListForProfile.ts` | 258 |
| `getActiveProfileId` | Function | `src/core/getModsListForProfile.ts` | 263 |
| `getActiveProfileIdFromState` | Function | `src/core/getModsListForProfile.ts` | 295 |
| `belongsToGame` | Function | `src/core/getModsListForProfile.ts` | 300 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `ReadZipEntry → GetVortexUserDataPath` | cross_community | 10 |
| `RunSelfChecks → GetVortexUserDataPath` | cross_community | 10 |
| `HandleDeletePublished → GetVortexUserDataPath` | cross_community | 10 |
| `PublishedDetailsPanel → GetVortexUserDataPath` | cross_community | 10 |
| `BuildPage → GetVortexUserDataPath` | cross_community | 10 |
| `BuildWizard → GetVortexUserDataPath` | cross_community | 10 |
| `OnRecovered → GetVortexUserDataPath` | cross_community | 10 |
| `ListArchive → GetVortexUserDataPath` | cross_community | 10 |
| `LoadDashboardData → GetVortexUserDataPath` | cross_community | 10 |
| `Take → GetVortexUserDataPath` | cross_community | 10 |

## How to Explore

1. `context({name: "createBuildPackageAction"})` — see callers and callees
2. `query({search_query: "actions"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
