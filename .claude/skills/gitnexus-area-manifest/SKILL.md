---
name: gitnexus-area-manifest
description: "Skill for the Manifest area of Event-Horizon. 533 symbols across 122 files."
---

# Manifest

533 symbols | 122 files | Cohesion: 73%

## When to Use

- Working with code in `src/`
- Understanding how parseManifest, bundleEntryOf, bundleFolderInPackage work
- Modifying manifest-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/manifest/parseManifest.ts` | ParseManifestError, describe, describeUnsupportedVersion, expectArray, expectBoolean (+45) |
| `src/core/manifest/collectionConfig.ts` | choiceFromEntry, decidedPostProcessing, modsNewlyBundled, modsNoLongerBundled, toBuildManifestExternalMods (+21) |
| `src/core/manifest/packageZip.ts` | PackageEhcollError, describeBytes, listBundles, packageBytesAtMost, packageEhcoll (+20) |
| `src/core/manifest/readZip.ts` | ZipReadError, extractZipEntryToFile, findDataOffset, findEntry, findZip64Extra (+20) |
| `src/ui/pages/build/engine.ts` | BuildRefusedError, BundleResolutionError, applyPostProcessedDeclarations, declarationsFor, resolveDeploymentMethod (+12) |
| `src/core/manifest/buildManifest.ts` | BuildManifestError, buildLoadOrder, buildManifest, buildPackageMetadata, buildUserlist (+12) |
| `src/core/manifest/externalHints.ts` | applyHint, describeUndeclared, countBy, downloadsFromState, modsFromState (+10) |
| `src/core/manifest/bundleZip.ts` | listBundleFolder, writeChunk, assertBundlePaths, isAborted, sortForBundle (+8) |
| `src/core/manifest/runSelfChecks.ts` | findModsThatPromptTheUser, describeDivergedMods, runSelfChecks, recoverArchive, makeReadEntry (+7) |
| `src/core/manifest/readEhcoll.ts` | ReadEhcollError, assertReadableFile, classifyEntries, crossCheckBundled, extractManifest (+7) |

## Entry Points

Start here when exploring this area:

- **`parseManifest`** (Function) — `src/core/manifest/parseManifest.ts:172`
- **`bundleEntryOf`** (Function) — `src/core/manifest/bundleLayout.ts:25`
- **`bundleFolderInPackage`** (Function) — `src/core/manifest/bundleLayout.ts:10`
- **`listBundleFolder`** (Function) — `src/core/manifest/bundleZip.ts:87`
- **`packageEhcoll`** (Function) — `src/core/manifest/packageZip.ts:238`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `ParseManifestError` | Class | `src/core/manifest/parseManifest.ts` | 150 |
| `PackageEhcollError` | Class | `src/core/manifest/packageZip.ts` | 209 |
| `BuildRefusedError` | Class | `src/ui/pages/build/engine.ts` | 1358 |
| `BundleResolutionError` | Class | `src/ui/pages/build/engine.ts` | 757 |
| `ZipReadError` | Class | `src/core/manifest/readZip.ts` | 81 |
| `BuildManifestError` | Class | `src/core/manifest/buildManifest.ts` | 270 |
| `ReadEhcollError` | Class | `src/core/manifest/readEhcoll.ts` | 133 |
| `CollectionConfigError` | Class | `src/core/manifest/collectionConfig.ts` | 315 |
| `parseManifest` | Function | `src/core/manifest/parseManifest.ts` | 172 |
| `bundleEntryOf` | Function | `src/core/manifest/bundleLayout.ts` | 25 |
| `bundleFolderInPackage` | Function | `src/core/manifest/bundleLayout.ts` | 10 |
| `listBundleFolder` | Function | `src/core/manifest/bundleZip.ts` | 87 |
| `packageEhcoll` | Function | `src/core/manifest/packageZip.ts` | 238 |
| `repairDecisionFor` | Function | `src/core/resolver/resolveInstallPlan.ts` | 1259 |
| `isAbort` | Function | `src/utils/abortError.ts` | 54 |
| `put` | Function | `src/core/diagnostics/zipWriter.ts` | 67 |
| `buildGogHashdbTable` | Function | `src/core/environment/fixtures.testutil.ts` | 260 |
| `buildPe` | Function | `src/core/environment/fixtures.testutil.ts` | 30 |
| `alloc` | Function | `src/core/environment/fixtures.testutil.ts` | 62 |
| `cstr` | Function | `src/core/environment/fixtures.testutil.ts` | 68 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `LaunchGame → GetVortexUserDataPath` | cross_community | 10 |
| `PublishedDetailsPanel → ResolveLogFile` | cross_community | 10 |
| `PublishedDetailsPanel → Truncate` | cross_community | 10 |
| `LoadPublishedDetails → GetEventHorizonDir` | cross_community | 10 |
| `RunSelfChecks → GetVortexUserDataPath` | cross_community | 10 |
| `NexusUploadModal → GetEventHorizonRoot` | cross_community | 10 |
| `LoadPublishedDetails → ResolveLogFile` | cross_community | 10 |
| `RunLoadingPipeline → GetEventHorizonRoot` | cross_community | 10 |
| `PrepareChangelog → ToPosix` | cross_community | 9 |
| `WriteEnvironmentSnapshot → GetVortexUserDataPath` | cross_community | 9 |

## How to Explore

1. `context({name: "parseManifest"})` — see callers and callees
2. `query({search_query: "manifest"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
