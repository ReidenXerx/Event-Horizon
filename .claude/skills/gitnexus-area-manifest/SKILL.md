---
name: gitnexus-area-manifest
description: "Skill for the Manifest area of Event-Horizon. 392 symbols across 89 files."
---

# Manifest

392 symbols | 89 files | Cohesion: 77%

## When to Use

- Working with code in `src/`
- Understanding how archiveFileCacheKey, enrichModsWithArchiveHashes, hashFileSha256 work
- Modifying manifest-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/manifest/parseManifest.ts` | ParseManifestError, describe, expectArray, expectBoolean, expectEnum (+43) |
| `src/core/manifest/packageZip.ts` | describeBytes, isAbortLikeError, packageEhcoll, checkAbort, prepareStagingDir (+14) |
| `src/core/manifest/readZip.ts` | ZipReadError, extractZipEntryToFile, findDataOffset, findEntry, findZip64Extra (+11) |
| `src/core/manifest/buildManifest.ts` | BuildManifestError, buildLoadOrder, buildManifest, buildPackageMetadata, buildUserlist (+11) |
| `src/core/manifest/collectionConfig.ts` | mode, CollectionConfigError, createDefaultConfig, getCollectionConfigPath, loadOrCreateCollectionConfig (+8) |
| `src/core/manifest/externalHints.ts` | countBy, downloadsFromState, modsFromState, asMode, collectExternalHints (+8) |
| `src/core/manifest/readEhcoll.ts` | ReadEhcollError, assertReadableFile, crossCheckBundled, extractManifest, listZipEntries (+7) |
| `src/core/manifest/sevenZip.ts` | resolveSevenZip, assertOk, cancelOnAbort, sevenZipAdd, sevenZipExtractFull (+5) |
| `src/core/manifest/bundleFromStaging.ts` | directorySize, walk, readCachedBundle, repackBundledExternals, sweepStaleBundles (+3) |
| `src/core/logging/ehLog.ts` | fail, ok, step, ehLog, enqueue (+3) |

## Entry Points

Start here when exploring this area:

- **`archiveFileCacheKey`** (Function) — `src/core/archiveHashCache.ts:84`
- **`enrichModsWithArchiveHashes`** (Function) — `src/core/archiveHashing.ts:184`
- **`hashFileSha256`** (Function) — `src/core/archiveHashing.ts:39`
- **`cleanup`** (Function) — `src/core/archiveHashing.ts:59`
- **`onAbort`** (Function) — `src/core/archiveHashing.ts:51`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `AbortError` | Class | `src/utils/abortError.ts` | 22 |
| `ReadEhcollError` | Class | `src/core/manifest/readEhcoll.ts` | 129 |
| `ZipReadError` | Class | `src/core/manifest/readZip.ts` | 58 |
| `ParseManifestError` | Class | `src/core/manifest/parseManifest.ts` | 121 |
| `BuildManifestError` | Class | `src/core/manifest/buildManifest.ts` | 251 |
| `CollectionConfigError` | Class | `src/core/manifest/collectionConfig.ts` | 290 |
| `PackageEhcollError` | Class | `src/core/manifest/packageZip.ts` | 171 |
| `archiveFileCacheKey` | Function | `src/core/archiveHashCache.ts` | 84 |
| `enrichModsWithArchiveHashes` | Function | `src/core/archiveHashing.ts` | 184 |
| `hashFileSha256` | Function | `src/core/archiveHashing.ts` | 39 |
| `cleanup` | Function | `src/core/archiveHashing.ts` | 59 |
| `onAbort` | Function | `src/core/archiveHashing.ts` | 51 |
| `recoverMissingArchives` | Function | `src/core/archiveRecovery.ts` | 248 |
| `checkArchiveIdentity` | Function | `src/core/installer/checkArchiveIdentity.ts` | 83 |
| `verifyModInstall` | Function | `src/core/installer/verifyModInstall.ts` | 165 |
| `bundleFileName` | Function | `src/core/manifest/bundleCache.ts` | 50 |
| `bundleSidecarPath` | Function | `src/core/manifest/bundleCache.ts` | 55 |
| `isBundleOfMod` | Function | `src/core/manifest/bundleCache.ts` | 66 |
| `sanitizeModId` | Function | `src/core/manifest/bundleCache.ts` | 40 |
| `sidecarMatches` | Function | `src/core/manifest/bundleCache.ts` | 103 |

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
| `HandleDeletePublished → GetVortexUserDataPath` | cross_community | 10 |
| `RunLoadingPipeline → GetEventHorizonRoot` | cross_community | 10 |

## How to Explore

1. `context({name: "archiveFileCacheKey"})` — see callers and callees
2. `query({search_query: "manifest"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
