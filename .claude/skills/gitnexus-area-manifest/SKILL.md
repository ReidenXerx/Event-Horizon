---
name: gitnexus-area-manifest
description: "Skill for the Manifest area of Event-Horizon. 461 symbols across 115 files."
---

# Manifest

461 symbols | 115 files | Cohesion: 75%

## When to Use

- Working with code in `src/`
- Understanding how createInstallCollectionAction, archiveFileCacheKey, enrichModsWithArchiveHashes work
- Modifying manifest-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/manifest/parseManifest.ts` | ParseManifestError, describe, expectArray, expectBoolean, expectEnum (+43) |
| `src/core/manifest/packageZip.ts` | describeBytes, isAbortLikeError, packageEhcoll, checkAbort, prepareStagingDir (+14) |
| `src/core/manifest/buildManifest.ts` | toPosixPath, BuildManifestError, buildLoadOrder, buildManifest, buildPackageMetadata (+12) |
| `src/core/manifest/readZip.ts` | ZipReadError, extractZipEntryToFile, findDataOffset, findEntry, findZip64Extra (+11) |
| `src/core/manifest/collectionConfig.ts` | mode, CollectionConfigError, createDefaultConfig, getCollectionConfigPath, loadOrCreateCollectionConfig (+8) |
| `src/core/manifest/externalHints.ts` | countBy, downloadsFromState, modsFromState, asMode, collectExternalHints (+8) |
| `src/core/resolver/userState.ts` | buildSuggestedProfileName, buildUserSideState, judgeResumeCandidate, pickInstallTarget, previousInstallFromReceipt (+7) |
| `src/core/manifest/readEhcoll.ts` | ReadEhcollError, assertReadableFile, crossCheckBundled, extractManifest, listZipEntries (+7) |
| `src/core/manifest/sevenZip.ts` | resolveSevenZip, assertOk, cancelOnAbort, sevenZipAdd, sevenZipExtractFull (+5) |
| `src/core/manifest/bundleFromStaging.ts` | readCachedBundle, repackBundledExternals, sweepStaleBundles, writeCachedBundle, directorySize (+3) |

## Entry Points

Start here when exploring this area:

- **`createInstallCollectionAction`** (Function) — `src/actions/installCollectionAction.ts:118`
- **`archiveFileCacheKey`** (Function) — `src/core/archiveHashCache.ts:84`
- **`enrichModsWithArchiveHashes`** (Function) — `src/core/archiveHashing.ts:184`
- **`hashFileSha256`** (Function) — `src/core/archiveHashing.ts:39`
- **`cleanup`** (Function) — `src/core/archiveHashing.ts:59`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `AbortError` | Class | `src/utils/abortError.ts` | 22 |
| `ReadEhcollError` | Class | `src/core/manifest/readEhcoll.ts` | 131 |
| `ZipReadError` | Class | `src/core/manifest/readZip.ts` | 59 |
| `ParseManifestError` | Class | `src/core/manifest/parseManifest.ts` | 123 |
| `BuildManifestError` | Class | `src/core/manifest/buildManifest.ts` | 255 |
| `CollectionConfigError` | Class | `src/core/manifest/collectionConfig.ts` | 290 |
| `PackageEhcollError` | Class | `src/core/manifest/packageZip.ts` | 171 |
| `createInstallCollectionAction` | Function | `src/actions/installCollectionAction.ts` | 118 |
| `archiveFileCacheKey` | Function | `src/core/archiveHashCache.ts` | 84 |
| `enrichModsWithArchiveHashes` | Function | `src/core/archiveHashing.ts` | 184 |
| `hashFileSha256` | Function | `src/core/archiveHashing.ts` | 39 |
| `cleanup` | Function | `src/core/archiveHashing.ts` | 59 |
| `onAbort` | Function | `src/core/archiveHashing.ts` | 51 |
| `recoverMissingArchives` | Function | `src/core/archiveRecovery.ts` | 248 |
| `discoveredStore` | Function | `src/core/comparePlugins.ts` | 160 |
| `liveStagingShapes` | Function | `src/core/curator/liveStagingShapes.ts` | 41 |
| `stagingShapeOf` | Function | `src/core/curator/stagingShape.ts` | 54 |
| `getModsForGame` | Function | `src/core/getModsListForProfile.ts` | 613 |
| `listInstallAttempts` | Function | `src/core/installer/attemptRecord.ts` | 147 |
| `checkArchiveIdentity` | Function | `src/core/installer/checkArchiveIdentity.ts` | 83 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `InstallNexusViaApi → GetEventHorizonRoot` | cross_community | 10 |
| `ExecutePromptUserChoice → GetEventHorizonDir` | cross_community | 10 |
| `ReadZipEntry → GetVortexUserDataPath` | cross_community | 10 |
| `RunInstallImpl → GetEventHorizonRoot` | cross_community | 10 |
| `PublishedDetailsPanel → GetEventHorizonDir` | cross_community | 10 |
| `RunSelfChecks → GetVortexUserDataPath` | cross_community | 10 |
| `Dashboard → GetEventHorizonRoot` | cross_community | 10 |
| `Act → GetEventHorizonDir` | cross_community | 10 |
| `HandleDeletePublished → GetVortexUserDataPath` | cross_community | 10 |
| `LoadPublishedDetails → GetEventHorizonRoot` | cross_community | 10 |

## How to Explore

1. `context({name: "createInstallCollectionAction"})` — see callers and callees
2. `query({search_query: "manifest"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
