---
name: gitnexus-area-actions
description: "Skill for the Actions area of Event-Horizon. 72 symbols across 16 files."
---

# Actions

72 symbols | 16 files | Cohesion: 75%

## When to Use

- Working with code in `src/`
- Understanding how createBuildPackageAction, captureDeploymentManifests, collectDistinctModTypes work
- Modifying actions-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/actions/installCollectionAction.ts` | collectUserDecisions, formatDivergedConflictText, formatOrphanText, formatPromptUserText, pickConflictChoice (+23) |
| `src/actions/buildPackageAction.ts` | BundleResolutionError, createBuildPackageAction, formatBytes, formatError, promptCuratorMetadata (+8) |
| `src/core/comparePlugins.ts` | getCurrentPluginsTxtPath, getLocalAppDataPath, pluginsTxtFolderCandidates, discoveredStore, exportPluginsDiffReport |
| `src/utils/utils.ts` | pickModArchiveFile, openFile, openFolder, pickTxtFile |
| `src/core/deploymentManifest.ts` | captureDeploymentManifests, collectDistinctModTypes, normalizeManifest |
| `src/core/manifest/packageFileName.ts` | buildOutputFileName, safePackageVersion, slugifyPackageName |
| `src/actions/comparePluginsAction.ts` | action, action, createComparePluginsAction |
| `src/core/loadOrder.ts` | captureLoadOrder, take |
| `src/core/manifest/collectionConfig.ts` | reconcileExternalModsConfig, toBuildManifestExternalMods |
| `src/actions/compareModsAction.ts` | action, action |

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
| `reconcileExternalModsConfig` | Function | `src/core/manifest/collectionConfig.ts` | 371 |
| `toBuildManifestExternalMods` | Function | `src/core/manifest/collectionConfig.ts` | 418 |
| `applyHint` | Function | `src/core/manifest/externalHints.ts` | 229 |
| `locateCollectionPackage` | Function | `src/core/manifest/locatePackage.ts` | 28 |
| `buildOutputFileName` | Function | `src/core/manifest/packageFileName.ts` | 32 |
| `safePackageVersion` | Function | `src/core/manifest/packageFileName.ts` | 27 |
| `slugifyPackageName` | Function | `src/core/manifest/packageFileName.ts` | 15 |
| `pickModArchiveFile` | Function | `src/utils/utils.ts` | 113 |
| `action` | Function | `src/actions/buildPackageAction.ts` | 379 |
| `action` | Function | `src/actions/buildPackageAction.ts` | 387 |
| `action` | Function | `src/actions/compareModsAction.ts` | 104 |
| `action` | Function | `src/actions/comparePluginsAction.ts` | 68 |
| `action` | Function | `src/actions/exportModsAction.ts` | 124 |
| `openFile` | Function | `src/utils/utils.ts` | 39 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Init → GetVortexUserDataPath` | cross_community | 9 |
| `CreateBuildPackageAction → GetVortexUserDataPath` | cross_community | 8 |
| `Init → Truncate` | cross_community | 5 |
| `CreateBuildPackageAction → Truncate` | cross_community | 4 |
| `Init → GetActiveGameId` | cross_community | 3 |
| `Init → Fail` | cross_community | 3 |
| `Init → Ok` | cross_community | 3 |

## How to Explore

1. `context({name: "createBuildPackageAction"})` — see callers and callees
2. `query({search_query: "actions"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
