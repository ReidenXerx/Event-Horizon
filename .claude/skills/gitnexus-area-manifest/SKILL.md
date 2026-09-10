---
name: gitnexus-area-manifest
description: "Skill for the Manifest area of Event-Horizon. 422 symbols across 100 files."
---

# Manifest

422 symbols | 100 files | Cohesion: 76%

## When to Use

- Working with code in `src/`
- Understanding how parseManifest, probeNexusAccount, selectDriftCandidates work
- Modifying manifest-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/manifest/parseManifest.ts` | ParseManifestError, describe, expectArray, expectBoolean, expectEnum (+43) |
| `src/core/manifest/packageZip.ts` | describeBytes, packageEhcoll, checkAbort, prepareStagingDir, runSevenZipAdd (+13) |
| `src/core/manifest/buildManifest.ts` | BuildManifestError, buildLoadOrder, buildManifest, buildPackageMetadata, buildUserlist (+12) |
| `src/core/manifest/readZip.ts` | ZipReadError, extractZipEntryToFile, findDataOffset, findEntry, findZip64Extra (+11) |
| `src/core/manifest/collectionConfig.ts` | mode, reconcileExternalModsConfig, choiceFromEntry, decidedPostProcessing, CollectionConfigError (+11) |
| `src/core/manifest/externalHints.ts` | countBy, downloadsFromState, modsFromState, asMode, collectExternalHints (+8) |
| `src/core/manifest/readEhcoll.ts` | ReadEhcollError, assertReadableFile, crossCheckBundled, extractManifest, listZipEntries (+7) |
| `src/core/manifest/parseModuleConfig.ts` | collectPluginStateDependencies, walk, decodeModuleConfig, parseConditionals, parseFiles (+5) |
| `src/core/manifest/sevenZip.ts` | assertOk, cancelOnAbort, sevenZipAdd, sevenZipExtractFull, sevenZipList (+5) |
| `src/core/manifest/selfCheckMod.ts` | findModuleConfigEntry, selfCheckMod, withDeps, verifyEmptySelection, no (+4) |

## Entry Points

Start here when exploring this area:

- **`parseManifest`** (Function) — `src/core/manifest/parseManifest.ts:145`
- **`probeNexusAccount`** (Function) — `src/core/installer/checkNexusAccount.ts:243`
- **`selectDriftCandidates`** (Function) — `src/core/installer/detectStagingDrift.ts:67`
- **`probeInstallerApi`** (Function) — `src/core/installer/probeInstallerApi.ts:124`
- **`watchInstallCalls`** (Function) — `src/core/installer/probeInstallerApi.ts:58`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `ParseManifestError` | Class | `src/core/manifest/parseManifest.ts` | 123 |
| `ReadEhcollError` | Class | `src/core/manifest/readEhcoll.ts` | 131 |
| `ZipReadError` | Class | `src/core/manifest/readZip.ts` | 77 |
| `BuildManifestError` | Class | `src/core/manifest/buildManifest.ts` | 255 |
| `CollectionConfigError` | Class | `src/core/manifest/collectionConfig.ts` | 290 |
| `PackageEhcollError` | Class | `src/core/manifest/packageZip.ts` | 172 |
| `parseManifest` | Function | `src/core/manifest/parseManifest.ts` | 145 |
| `probeNexusAccount` | Function | `src/core/installer/checkNexusAccount.ts` | 243 |
| `selectDriftCandidates` | Function | `src/core/installer/detectStagingDrift.ts` | 67 |
| `probeInstallerApi` | Function | `src/core/installer/probeInstallerApi.ts` | 124 |
| `watchInstallCalls` | Function | `src/core/installer/probeInstallerApi.ts` | 58 |
| `finalize` | Function | `src/core/installer/profile.ts` | 153 |
| `onChange` | Function | `src/core/installer/profile.ts` | 218 |
| `timeout` | Function | `src/core/installer/profile.ts` | 161 |
| `fail` | Function | `src/core/logging/ehLog.ts` | 164 |
| `ok` | Function | `src/core/logging/ehLog.ts` | 159 |
| `step` | Function | `src/core/logging/ehLog.ts` | 158 |
| `ehLog` | Function | `src/core/logging/ehLog.ts` | 115 |
| `getLogFilePath` | Function | `src/core/logging/ehLog.ts` | 69 |
| `filesProvidedByMods` | Function | `src/core/manifest/externalDependencies.ts` | 346 |

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
| `SelfCheckMod → GetVortexUserDataPath` | cross_community | 10 |
| `LoadPublishedDetails → GetEventHorizonRoot` | cross_community | 10 |

## How to Explore

1. `context({name: "parseManifest"})` — see callers and callees
2. `query({search_query: "manifest"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
