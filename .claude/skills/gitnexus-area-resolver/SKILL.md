---
name: gitnexus-area-resolver
description: "Skill for the Resolver area of Event-Horizon. 50 symbols across 9 files."
---

# Resolver

50 symbols | 9 files | Cohesion: 79%

## When to Use

- Working with code in `src/`
- Understanding how describeStoreMismatch, scriptExtenderMods, resolveCompatibility work
- Modifying resolver-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/resolver/resolveInstallPlan.ts` | checkDeploymentMethod, checkExtensions, checkGameVersion, checkVortexVersion, compareSemverLike (+24) |
| `src/core/resolver/collectAvailableDownloads.test.ts` | action, engine, pipelines, read |
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
- **`resolveCompatibility`** (Function) — `src/core/resolver/resolveInstallPlan.ts:183`
- **`resolveInstallPlan`** (Function) — `src/core/resolver/resolveInstallPlan.ts:94`
- **`repairDecisionFor`** (Function) — `src/core/resolver/resolveInstallPlan.ts:1136`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `describeStoreMismatch` | Function | `src/core/manifest/storeCompatibility.ts` | 122 |
| `scriptExtenderMods` | Function | `src/core/manifest/storeCompatibility.ts` | 98 |
| `resolveCompatibility` | Function | `src/core/resolver/resolveInstallPlan.ts` | 183 |
| `resolveInstallPlan` | Function | `src/core/resolver/resolveInstallPlan.ts` | 94 |
| `repairDecisionFor` | Function | `src/core/resolver/resolveInstallPlan.ts` | 1136 |
| `planInstallEpochs` | Function | `src/core/resolver/installEpochs.ts` | 85 |
| `logInstallPlan` | Function | `src/core/resolver/logInstallPlan.ts` | 95 |
| `compareVersions` | Function | `src/core/resolver/gameVersionGuidance.ts` | 167 |
| `parse` | Function | `src/core/resolver/gameVersionGuidance.ts` | 168 |
| `gameVersionGuidance` | Function | `src/core/resolver/gameVersionGuidance.ts` | 116 |
| `checkDeploymentMethod` | Function | `src/core/resolver/resolveInstallPlan.ts` | 396 |
| `checkExtensions` | Function | `src/core/resolver/resolveInstallPlan.ts` | 342 |
| `checkGameVersion` | Function | `src/core/resolver/resolveInstallPlan.ts` | 252 |
| `checkVortexVersion` | Function | `src/core/resolver/resolveInstallPlan.ts` | 380 |
| `compareSemverLike` | Function | `src/core/resolver/resolveInstallPlan.ts` | 1194 |
| `parseSemver` | Function | `src/core/resolver/resolveInstallPlan.ts` | 1204 |
| `wineVersionNote` | Function | `src/core/resolver/resolveInstallPlan.ts` | 243 |
| `enforceInstallTargetInvariant` | Function | `src/core/resolver/resolveInstallPlan.ts` | 140 |
| `resolveExternalDependencies` | Function | `src/core/resolver/resolveInstallPlan.ts` | 713 |
| `resolveOrphanedMods` | Function | `src/core/resolver/resolveInstallPlan.ts` | 676 |

## How to Explore

1. `context({name: "describeStoreMismatch"})` — see callers and callees
2. `query({search_query: "resolver"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
