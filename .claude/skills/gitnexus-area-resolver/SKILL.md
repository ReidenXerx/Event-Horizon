---
name: gitnexus-area-resolver
description: "Skill for the Resolver area of Event-Horizon. 60 symbols across 13 files."
---

# Resolver

60 symbols | 13 files | Cohesion: 79%

## When to Use

- Working with code in `src/`
- Understanding how runInstall, resolveInstallPlan, describeStoreMismatch work
- Modifying resolver-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/resolver/resolveInstallPlan.ts` | enforceInstallTargetInvariant, resolveExternalDependencies, resolveInstallPlan, resolveOrphanedMods, resolvePluginOrder (+24) |
| `src/core/resolver/collectAvailableDownloads.test.ts` | action, engine, pipelines, read |
| `src/core/resolver/enrichStagingSetHashes.ts` | bundledInstallName, collectExternalStagingSetHashTargets, collectStagingSetHashTargetsForTest, normalizeName |
| `src/core/resolver/gameVersionGuidance.ts` | compareVersions, parse, describe, gameVersionGuidance |
| `src/core/resolver/userState.ts` | buildLineageTagIndex, coerceNexusId, lineageTagFor, projectInstalledMods |
| `src/core/resolver/logInstallPlan.ts` | countBy, describeInputs, logInstallPlan |
| `src/core/installer/runInstall.ts` | formatError, runInstall |
| `src/core/resolver/resumeIdentity.test.ts` | decide, manifest |
| `test/e2e/installDriver.e2e.test.ts` | install, userState |
| `test/e2e/verification.e2e.test.ts` | install, userState |

## Entry Points

Start here when exploring this area:

- **`runInstall`** (Function) — `src/core/installer/runInstall.ts:595`
- **`resolveInstallPlan`** (Function) — `src/core/resolver/resolveInstallPlan.ts:93`
- **`describeStoreMismatch`** (Function) — `src/core/manifest/storeCompatibility.ts:122`
- **`scriptExtenderMods`** (Function) — `src/core/manifest/storeCompatibility.ts:98`
- **`resolveCompatibility`** (Function) — `src/core/resolver/resolveInstallPlan.ts:182`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `runInstall` | Function | `src/core/installer/runInstall.ts` | 595 |
| `resolveInstallPlan` | Function | `src/core/resolver/resolveInstallPlan.ts` | 93 |
| `describeStoreMismatch` | Function | `src/core/manifest/storeCompatibility.ts` | 122 |
| `scriptExtenderMods` | Function | `src/core/manifest/storeCompatibility.ts` | 98 |
| `resolveCompatibility` | Function | `src/core/resolver/resolveInstallPlan.ts` | 182 |
| `repairDecisionFor` | Function | `src/core/resolver/resolveInstallPlan.ts` | 1142 |
| `planInstallEpochs` | Function | `src/core/resolver/installEpochs.ts` | 85 |
| `logInstallPlan` | Function | `src/core/resolver/logInstallPlan.ts` | 95 |
| `collectStagingSetHashTargetsForTest` | Function | `src/core/resolver/enrichStagingSetHashes.ts` | 371 |
| `compareVersions` | Function | `src/core/resolver/gameVersionGuidance.ts` | 167 |
| `parse` | Function | `src/core/resolver/gameVersionGuidance.ts` | 168 |
| `gameVersionGuidance` | Function | `src/core/resolver/gameVersionGuidance.ts` | 116 |
| `formatError` | Function | `src/core/installer/runInstall.ts` | 6076 |
| `enforceInstallTargetInvariant` | Function | `src/core/resolver/resolveInstallPlan.ts` | 139 |
| `resolveExternalDependencies` | Function | `src/core/resolver/resolveInstallPlan.ts` | 719 |
| `resolveOrphanedMods` | Function | `src/core/resolver/resolveInstallPlan.ts` | 682 |
| `resolvePluginOrder` | Function | `src/core/resolver/resolveInstallPlan.ts` | 806 |
| `resolveRulePlan` | Function | `src/core/resolver/resolveInstallPlan.ts` | 828 |
| `resolveSingleExternalDependency` | Function | `src/core/resolver/resolveInstallPlan.ts` | 728 |
| `summarize` | Function | `src/core/resolver/resolveInstallPlan.ts` | 867 |

## How to Explore

1. `context({name: "runInstall"})` — see callers and callees
2. `query({search_query: "resolver"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
