---
name: gitnexus-area-resolver
description: "Skill for the Resolver area of Event-Horizon. 54 symbols across 10 files."
---

# Resolver

54 symbols | 10 files | Cohesion: 79%

## When to Use

- Working with code in `src/`
- Understanding how describeStoreMismatch, scriptExtenderMods, resolveCompatibility work
- Modifying resolver-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/resolver/resolveInstallPlan.ts` | checkDeploymentMethod, checkExtensions, checkGameVersion, checkVortexVersion, compareSemverLike (+24) |
| `src/core/resolver/collectAvailableDownloads.test.ts` | action, engine, pipelines, read |
| `src/core/resolver/enrichStagingSetHashes.ts` | bundledInstallName, collectExternalStagingSetHashTargets, collectStagingSetHashTargetsForTest, normalizeName |
| `src/core/resolver/gameVersionGuidance.ts` | compareVersions, parse, describe, gameVersionGuidance |
| `src/core/resolver/userState.ts` | buildLineageTagIndex, coerceNexusId, lineageTagFor, projectInstalledMods |
| `src/core/resolver/logInstallPlan.ts` | countBy, describeInputs, logInstallPlan |
| `src/core/manifest/storeCompatibility.ts` | describeStoreMismatch, scriptExtenderMods |
| `src/core/resolver/resumeIdentity.test.ts` | decide, manifest |
| `src/actions/installCollectionAction.ts` | logPlanSummary |
| `src/core/resolver/installEpochs.ts` | planInstallEpochs |

## Entry Points

Start here when exploring this area:

- **`describeStoreMismatch`** (Function) — `src/core/manifest/storeCompatibility.ts:122`
- **`scriptExtenderMods`** (Function) — `src/core/manifest/storeCompatibility.ts:98`
- **`resolveCompatibility`** (Function) — `src/core/resolver/resolveInstallPlan.ts:182`
- **`resolveInstallPlan`** (Function) — `src/core/resolver/resolveInstallPlan.ts:93`
- **`repairDecisionFor`** (Function) — `src/core/resolver/resolveInstallPlan.ts:1142`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `describeStoreMismatch` | Function | `src/core/manifest/storeCompatibility.ts` | 122 |
| `scriptExtenderMods` | Function | `src/core/manifest/storeCompatibility.ts` | 98 |
| `resolveCompatibility` | Function | `src/core/resolver/resolveInstallPlan.ts` | 182 |
| `resolveInstallPlan` | Function | `src/core/resolver/resolveInstallPlan.ts` | 93 |
| `repairDecisionFor` | Function | `src/core/resolver/resolveInstallPlan.ts` | 1142 |
| `planInstallEpochs` | Function | `src/core/resolver/installEpochs.ts` | 85 |
| `logInstallPlan` | Function | `src/core/resolver/logInstallPlan.ts` | 95 |
| `collectStagingSetHashTargetsForTest` | Function | `src/core/resolver/enrichStagingSetHashes.ts` | 371 |
| `compareVersions` | Function | `src/core/resolver/gameVersionGuidance.ts` | 167 |
| `parse` | Function | `src/core/resolver/gameVersionGuidance.ts` | 168 |
| `gameVersionGuidance` | Function | `src/core/resolver/gameVersionGuidance.ts` | 116 |
| `checkDeploymentMethod` | Function | `src/core/resolver/resolveInstallPlan.ts` | 402 |
| `checkExtensions` | Function | `src/core/resolver/resolveInstallPlan.ts` | 348 |
| `checkGameVersion` | Function | `src/core/resolver/resolveInstallPlan.ts` | 258 |
| `checkVortexVersion` | Function | `src/core/resolver/resolveInstallPlan.ts` | 386 |
| `compareSemverLike` | Function | `src/core/resolver/resolveInstallPlan.ts` | 1200 |
| `parseSemver` | Function | `src/core/resolver/resolveInstallPlan.ts` | 1210 |
| `wineVersionNote` | Function | `src/core/resolver/resolveInstallPlan.ts` | 242 |
| `enforceInstallTargetInvariant` | Function | `src/core/resolver/resolveInstallPlan.ts` | 139 |
| `resolveExternalDependencies` | Function | `src/core/resolver/resolveInstallPlan.ts` | 719 |

## How to Explore

1. `context({name: "describeStoreMismatch"})` — see callers and callees
2. `query({search_query: "resolver"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
