---
name: gitnexus-area-resolver
description: "Skill for the Resolver area of Event-Horizon. 78 symbols across 20 files."
---

# Resolver

78 symbols | 20 files | Cohesion: 70%

## When to Use

- Working with code in `src/`
- Understanding how resolveInstallPlan, describeStoreMismatch, scriptExtenderMods work
- Modifying resolver-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/resolver/resolveInstallPlan.ts` | enforceInstallTargetInvariant, resolveExternalDependencies, resolveInstallPlan, resolveOrphanedMods, resolvePluginOrder (+21) |
| `src/core/resolver/userState.ts` | readDisabledExtensionsMap, resolveEnabledExtensions, judgeResumeCandidate, lookupProfile, profileForGame (+10) |
| `src/core/resolver/gameVersionGuidance.ts` | compareVersions, parse, describe, gameVersionGuidance |
| `src/core/resolver/enrichStagingSetHashes.ts` | collectExternalStagingSetHashTargets, collectStagingSetHashTargetsForTest, enrichInstalledModsWithStagingSetHashes, normalizeName |
| `src/ui/pages/install/engine.ts` | runLoadingPipelineWithReceipt, checkAbort, warnIfSevenZipBroken |
| `src/core/resolver/logInstallPlan.ts` | countBy, describeInputs, logInstallPlan |
| `src/core/resolver/collectAvailableDownloads.test.ts` | engine, pipelines, read |
| `src/core/resolver/resumeIdentity.test.ts` | decide, manifest |
| `test/e2e/installDriver.e2e.test.ts` | install, userState |
| `test/e2e/verification.e2e.test.ts` | install, userState |

## Entry Points

Start here when exploring this area:

- **`resolveInstallPlan`** (Function) — `src/core/resolver/resolveInstallPlan.ts:95`
- **`describeStoreMismatch`** (Function) — `src/core/manifest/storeCompatibility.ts:122`
- **`scriptExtenderMods`** (Function) — `src/core/manifest/storeCompatibility.ts:98`
- **`resolveCompatibility`** (Function) — `src/core/resolver/resolveInstallPlan.ts:184`
- **`resumeCandidates`** (Function) — `src/core/installer/resumeSources.ts:48`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `resolveInstallPlan` | Function | `src/core/resolver/resolveInstallPlan.ts` | 95 |
| `describeStoreMismatch` | Function | `src/core/manifest/storeCompatibility.ts` | 122 |
| `scriptExtenderMods` | Function | `src/core/manifest/storeCompatibility.ts` | 98 |
| `resolveCompatibility` | Function | `src/core/resolver/resolveInstallPlan.ts` | 184 |
| `resumeCandidates` | Function | `src/core/installer/resumeSources.ts` | 48 |
| `downloadsDirFor` | Function | `src/core/resolver/scanAvailableDownloads.ts` | 40 |
| `scanAvailableDownloads` | Function | `src/core/resolver/scanAvailableDownloads.ts` | 57 |
| `resolveEnabledExtensions` | Function | `src/core/resolver/userState.ts` | 563 |
| `runLoadingPipelineWithReceipt` | Function | `src/ui/pages/install/engine.ts` | 424 |
| `checkAbort` | Function | `src/ui/pages/install/engine.ts` | 450 |
| `warnIfSevenZipBroken` | Function | `src/ui/pages/install/engine.ts` | 658 |
| `receiptProfileStillExists` | Function | `src/core/resolver/userState.ts` | 453 |
| `resumableProfileFromAttempts` | Function | `src/core/resolver/userState.ts` | 304 |
| `decidePlayGameVersion` | Function | `src/core/environment/playGameVersion.ts` | 30 |
| `compareVersions` | Function | `src/core/resolver/gameVersionGuidance.ts` | 170 |
| `parse` | Function | `src/core/resolver/gameVersionGuidance.ts` | 171 |
| `gameVersionGuidance` | Function | `src/core/resolver/gameVersionGuidance.ts` | 116 |
| `walkStagingFolder` | Function | `src/core/manifest/stagingFileWalker.ts` | 113 |
| `collectStagingSetHashTargetsForTest` | Function | `src/core/resolver/enrichStagingSetHashes.ts` | 371 |
| `enrichInstalledModsWithStagingSetHashes` | Function | `src/core/resolver/enrichStagingSetHashes.ts` | 124 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `RunLoadingPipelineWithReceipt → GetVortexUserDataPath` | cross_community | 8 |
| `EnrichInstalledModsWithStagingSetHashes → GetVortexUserDataPath` | cross_community | 7 |
| `Dashboard → ProfileId` | cross_community | 5 |
| `Dashboard → BelongsToGame` | cross_community | 5 |
| `RunLoadingPipelineWithReceipt → AbortError` | cross_community | 5 |
| `RunLoadingPipelineWithReceipt → Cleanup` | cross_community | 5 |
| `RunLoadingPipelineWithReceipt → SafePackageVersion` | cross_community | 5 |
| `RunLoadingPipelineWithReceipt → Update` | cross_community | 5 |
| `EnrichInstalledModsWithStagingSetHashes → BundledArchiveFileName` | cross_community | 4 |
| `Dashboard → GetActiveGameId` | cross_community | 4 |

## How to Explore

1. `context({name: "resolveInstallPlan"})` — see callers and callees
2. `query({search_query: "resolver"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
