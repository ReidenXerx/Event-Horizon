---
name: gitnexus-area-manifest
description: "Skill for the Manifest area of Event-Horizon. 520 symbols across 118 files."
---

# Manifest

520 symbols | 118 files | Cohesion: 73%

## When to Use

- Working with code in `src/`
- Understanding how parseManifest, put, buildGogHashdbTable work
- Modifying manifest-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/manifest/parseManifest.ts` | ParseManifestError, describe, describeUnsupportedVersion, expectArray, expectBoolean (+44) |
| `src/core/manifest/readZip.ts` | onAbort, crc32File, onAbort, ZipReadError, extractZipEntryToFile (+23) |
| `src/core/manifest/packageZip.ts` | PackageEhcollError, describeBytes, listBundles, packageBytesAtMost, packageEhcoll (+20) |
| `src/core/manifest/collectionConfig.ts` | reconcileExternalModsConfig, modsNewlyBundled, modsNoLongerBundled, toBuildManifestExternalMods, createDefaultConfig (+19) |
| `src/core/manifest/buildManifest.ts` | BuildManifestError, buildLoadOrder, buildManifest, buildPackageMetadata, buildUserlist (+12) |
| `src/ui/pages/build/engine.ts` | loadBuildContext, pickDefaultCollectionName, resolveGameVersion, BuildRefusedError, BundleResolutionError (+11) |
| `src/core/manifest/externalHints.ts` | countBy, downloadsFromState, modsFromState, applyHint, describeUndeclared (+10) |
| `src/core/manifest/bundleZip.ts` | writeChunk, bundleFilesFromListing, listBundleFolder, assertBundlePaths, isAborted (+8) |
| `src/core/manifest/runSelfChecks.ts` | findModsThatPromptTheUser, describeDivergedMods, makeReadEntry, runSelfChecks, recoverArchive (+6) |
| `src/core/manifest/readEhcoll.ts` | crossCheckBundled, prepareStagingDir, readEhcoll, safeRmDir, ReadEhcollError (+6) |

## Entry Points

Start here when exploring this area:

- **`parseManifest`** (Function) — `src/core/manifest/parseManifest.ts:169`
- **`put`** (Function) — `src/core/diagnostics/zipWriter.ts:67`
- **`buildGogHashdbTable`** (Function) — `src/core/environment/fixtures.testutil.ts:218`
- **`buildPe`** (Function) — `src/core/environment/fixtures.testutil.ts:24`
- **`alloc`** (Function) — `src/core/environment/fixtures.testutil.ts:30`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `ParseManifestError` | Class | `src/core/manifest/parseManifest.ts` | 147 |
| `PackageEhcollError` | Class | `src/core/manifest/packageZip.ts` | 201 |
| `BuildRefusedError` | Class | `src/ui/pages/build/engine.ts` | 1124 |
| `BundleResolutionError` | Class | `src/ui/pages/build/engine.ts` | 591 |
| `AbortError` | Class | `src/utils/abortError.ts` | 22 |
| `ZipReadError` | Class | `src/core/manifest/readZip.ts` | 81 |
| `BuildManifestError` | Class | `src/core/manifest/buildManifest.ts` | 262 |
| `CollectionConfigError` | Class | `src/core/manifest/collectionConfig.ts` | 290 |
| `ReadEhcollError` | Class | `src/core/manifest/readEhcoll.ts` | 131 |
| `parseManifest` | Function | `src/core/manifest/parseManifest.ts` | 169 |
| `put` | Function | `src/core/diagnostics/zipWriter.ts` | 67 |
| `buildGogHashdbTable` | Function | `src/core/environment/fixtures.testutil.ts` | 218 |
| `buildPe` | Function | `src/core/environment/fixtures.testutil.ts` | 24 |
| `alloc` | Function | `src/core/environment/fixtures.testutil.ts` | 30 |
| `cstr` | Function | `src/core/environment/fixtures.testutil.ts` | 36 |
| `rva` | Function | `src/core/environment/fixtures.testutil.ts` | 35 |
| `write` | Function | `src/core/environment/snapshot.ts` | 128 |
| `setPluginLightFlag` | Function | `src/core/manifest/pluginFlags.ts` | 154 |
| `flush` | Function | `src/ui/pages/build/persistOverrides.ts` | 80 |
| `save` | Function | `src/ui/pages/build/persistOverrides.ts` | 72 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `LaunchGame → GetVortexUserDataPath` | cross_community | 10 |
| `PublishedDetailsPanel → GetEventHorizonDir` | cross_community | 10 |
| `RunSelfChecks → GetVortexUserDataPath` | cross_community | 10 |
| `LoadPublishedDetails → GetEventHorizonRoot` | cross_community | 10 |
| `PublishedDetailsPanel → GetVortexUserDataPath` | cross_community | 10 |
| `RunLoadingPipeline → GetEventHorizonRoot` | cross_community | 10 |
| `RecordPostProcessingDecision → GetVortexUserDataPath` | cross_community | 9 |
| `RunLoadingPipeline → GetVortexUserDataPath` | cross_community | 9 |
| `ScanGameFolder → ToPosix` | cross_community | 8 |
| `PublishedDetailsPanel → Truncate` | cross_community | 8 |

## How to Explore

1. `context({name: "parseManifest"})` — see callers and callees
2. `query({search_query: "manifest"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
