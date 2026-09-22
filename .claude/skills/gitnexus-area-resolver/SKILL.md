---
name: gitnexus-area-resolver
description: "Skill for the Resolver area of Event-Horizon. 88 symbols across 24 files."
---

# Resolver

88 symbols | 24 files | Cohesion: 70%

## When to Use

- Working with code in `src/`
- Understanding how resolveInstallPlan, describeJudgedStoreMismatch, describeStoreMismatch work
- Modifying resolver-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/resolver/resolveInstallPlan.ts` | enforceInstallTargetInvariant, resolveExternalDependencies, resolveInstallPlan, resolveOrphanedMods, resolvePluginOrder (+21) |
| `src/core/resolver/userState.ts` | readDisabledExtensionsMap, resolveEnabledExtensions, judgeResumeCandidate, lookupProfile, profileForGame (+10) |
| `src/core/resolver/gameVersionGuidance.ts` | compareVersions, parse, describe, gameVersionGuidance |
| `src/core/resolver/enrichStagingSetHashes.ts` | bundledInstallName, collectExternalStagingSetHashTargets, collectStagingSetHashTargetsForTest, normalizeName |
| `src/core/resolver/deploymentMethodGate.test.ts` | errorsOf, manifest, planWith |
| `src/core/manifest/storeCompatibility.ts` | describeJudgedStoreMismatch, describeStoreMismatch, scriptExtenderMods |
| `src/core/resolver/versionMismatch.ts` | byMod, describeVersionMismatch, plural |
| `src/ui/pages/install/engine.ts` | runLoadingPipelineWithReceipt, checkAbort, warnIfSevenZipBroken |
| `src/core/resolver/collectAvailableDownloads.ts` | belongsToGame, collectAvailableDownloads, readDownloadFiles |
| `src/core/resolver/logInstallPlan.ts` | countBy, describeInputs, logInstallPlan |

## Entry Points

Start here when exploring this area:

- **`resolveInstallPlan`** (Function) — `src/core/resolver/resolveInstallPlan.ts:96`
- **`describeJudgedStoreMismatch`** (Function) — `src/core/manifest/storeCompatibility.ts:161`
- **`describeStoreMismatch`** (Function) — `src/core/manifest/storeCompatibility.ts:122`
- **`scriptExtenderMods`** (Function) — `src/core/manifest/storeCompatibility.ts:98`
- **`resolveCompatibility`** (Function) — `src/core/resolver/resolveInstallPlan.ts:185`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `resolveInstallPlan` | Function | `src/core/resolver/resolveInstallPlan.ts` | 96 |
| `describeJudgedStoreMismatch` | Function | `src/core/manifest/storeCompatibility.ts` | 161 |
| `describeStoreMismatch` | Function | `src/core/manifest/storeCompatibility.ts` | 122 |
| `scriptExtenderMods` | Function | `src/core/manifest/storeCompatibility.ts` | 98 |
| `resolveCompatibility` | Function | `src/core/resolver/resolveInstallPlan.ts` | 185 |
| `describeVersionMismatch` | Function | `src/core/resolver/versionMismatch.ts` | 150 |
| `plural` | Function | `src/core/resolver/versionMismatch.ts` | 180 |
| `resumeCandidates` | Function | `src/core/installer/resumeSources.ts` | 48 |
| `downloadsDirFor` | Function | `src/core/resolver/scanAvailableDownloads.ts` | 40 |
| `scanAvailableDownloads` | Function | `src/core/resolver/scanAvailableDownloads.ts` | 57 |
| `resolveEnabledExtensions` | Function | `src/core/resolver/userState.ts` | 634 |
| `runLoadingPipelineWithReceipt` | Function | `src/ui/pages/install/engine.ts` | 430 |
| `checkAbort` | Function | `src/ui/pages/install/engine.ts` | 456 |
| `warnIfSevenZipBroken` | Function | `src/ui/pages/install/engine.ts` | 669 |
| `receiptProfileStillExists` | Function | `src/core/resolver/userState.ts` | 524 |
| `resumableProfileFromAttempts` | Function | `src/core/resolver/userState.ts` | 375 |
| `archiveFileCacheKey` | Function | `src/core/archiveHashCache.ts` | 110 |
| `checkArchiveIdentity` | Function | `src/core/installer/checkArchiveIdentity.ts` | 92 |
| `collectAvailableDownloads` | Function | `src/core/resolver/collectAvailableDownloads.ts` | 91 |
| `decidePlayGameVersion` | Function | `src/core/environment/playGameVersion.ts` | 30 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `RunLoadingPipelineWithReceipt → GetVortexUserDataPath` | cross_community | 8 |
| `Dashboard → ProfileId` | cross_community | 5 |
| `Dashboard → BelongsToGame` | cross_community | 5 |
| `RunLoadingPipelineWithReceipt → AbortError` | cross_community | 5 |
| `RunLoadingPipelineWithReceipt → Cleanup` | cross_community | 5 |
| `RunLoadingPipelineWithReceipt → SafePackageVersion` | cross_community | 5 |
| `RunLoadingPipelineWithReceipt → Update` | cross_community | 5 |
| `EnrichInstalledModsWithStagingSetHashes → BundledArchiveFileName` | cross_community | 4 |
| `Dashboard → GetActiveGameId` | cross_community | 4 |
| `Dashboard → ResolveProfileName` | cross_community | 4 |

## How to Explore

1. `context({name: "resolveInstallPlan"})` — see callers and callees
2. `query({search_query: "resolver"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
