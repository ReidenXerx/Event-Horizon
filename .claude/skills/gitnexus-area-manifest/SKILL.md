---
name: gitnexus-area-manifest
description: "Skill for the Manifest area of Event-Horizon. 529 symbols across 139 files."
---

# Manifest

529 symbols | 139 files | Cohesion: 74%

## When to Use

- Working with code in `src/`
- Understanding how createCompareModsAction, createComparePluginsAction, createExportModsAction work
- Modifying manifest-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/manifest/parseManifest.ts` | ParseManifestError, describe, expectArray, expectBoolean, expectEnum (+43) |
| `src/core/manifest/packageZip.ts` | isAbortLikeError, describeBytes, packageEhcoll, checkAbort, prepareStagingDir (+14) |
| `src/core/manifest/collectionConfig.ts` | reconcileExternalModsConfig, createDefaultConfig, getCollectionConfigPath, loadOrCreateCollectionConfig, saveCollectionConfig (+14) |
| `src/core/manifest/buildManifest.ts` | buildExternalMod, buildModEntry, buildModInstallSpec, buildModInstallState, buildNexusMod (+12) |
| `src/core/manifest/readZip.ts` | ZipReadError, extractZipEntryToFile, findDataOffset, findEntry, findZip64Extra (+11) |
| `src/core/resolver/userState.ts` | buildSuggestedProfileName, buildUserSideState, judgeResumeCandidate, lookupProfile, pickInstallTarget (+10) |
| `src/core/manifest/externalHints.ts` | countBy, downloadsFromState, modsFromState, asMode, collectExternalHints (+8) |
| `src/core/manifest/readEhcoll.ts` | crossCheckBundled, prepareStagingDir, readEhcoll, safeRmDir, ReadEhcollError (+7) |
| `src/core/manifest/runSelfChecks.ts` | recoverArchive, describeDivergedMods, makeReadEntry, runSelfChecks, divergenceFingerprint (+5) |
| `src/core/manifest/parseModuleConfig.ts` | collectPluginStateDependencies, walk, decodeModuleConfig, parseConditionals, parseFiles (+5) |

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
| `ParseManifestError` | Class | `src/core/manifest/parseManifest.ts` | 123 |
| `ZipReadError` | Class | `src/core/manifest/readZip.ts` | 77 |
| `BuildManifestError` | Class | `src/core/manifest/buildManifest.ts` | 262 |
| `CollectionConfigError` | Class | `src/core/manifest/collectionConfig.ts` | 290 |
| `PackageEhcollError` | Class | `src/core/manifest/packageZip.ts` | 172 |
| `ReadEhcollError` | Class | `src/core/manifest/readEhcoll.ts` | 131 |
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

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `LaunchGame → GetVortexUserDataPath` | cross_community | 10 |
| `ExecutePromptUserChoice → GetEventHorizonDir` | cross_community | 10 |
| `RunInstallImpl → GetEventHorizonRoot` | cross_community | 10 |
| `ReadZipEntry → GetVortexUserDataPath` | cross_community | 10 |
| `PublishedDetailsPanel → GetEventHorizonDir` | cross_community | 10 |
| `Dashboard → GetEventHorizonRoot` | cross_community | 10 |
| `RunSelfChecks → GetVortexUserDataPath` | cross_community | 10 |
| `InstallDownloads → GetEventHorizonDir` | cross_community | 10 |
| `LoadPublishedDetails → GetEventHorizonRoot` | cross_community | 10 |
| `HandleDeletePublished → GetVortexUserDataPath` | cross_community | 10 |

## How to Explore

1. `context({name: "createCompareModsAction"})` — see callers and callees
2. `query({search_query: "manifest"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
