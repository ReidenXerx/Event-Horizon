---
name: gitnexus-area-resolver
description: "Skill for the Resolver area of Event-Horizon. 53 symbols across 9 files."
---

# Resolver

53 symbols | 9 files | Cohesion: 83%

## When to Use

- Working with code in `src/`
- Understanding how repairDecisionFor, describeStoreMismatch, scriptExtenderMods work
- Modifying resolver-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/resolver/resolveInstallPlan.ts` | bundledZipPath, extractExtension, findDownloadBySha, findInstalledByNexusExact, findInstalledByNexusFileMismatch (+24) |
| `src/core/resolver/collectAvailableDownloads.test.ts` | action, engine, pipelines, read |
| `src/core/resolver/enrichStagingSetHashes.ts` | bundledInstallName, collectExternalStagingSetHashTargets, collectStagingSetHashTargetsForTest, normalizeName |
| `src/core/resolver/gameVersionGuidance.ts` | compareVersions, parse, describe, gameVersionGuidance |
| `src/core/resolver/userState.ts` | buildLineageTagIndex, coerceNexusId, lineageTagFor, projectInstalledMods |
| `src/core/resolver/logInstallPlan.ts` | countBy, describeInputs, logInstallPlan |
| `src/core/manifest/storeCompatibility.ts` | describeStoreMismatch, scriptExtenderMods |
| `src/core/resolver/resumeIdentity.test.ts` | decide, manifest |
| `src/actions/installCollectionAction.ts` | logPlanSummary |

## Entry Points

Start here when exploring this area:

- **`repairDecisionFor`** (Function) — `src/core/resolver/resolveInstallPlan.ts:1142`
- **`describeStoreMismatch`** (Function) — `src/core/manifest/storeCompatibility.ts:122`
- **`scriptExtenderMods`** (Function) — `src/core/manifest/storeCompatibility.ts:98`
- **`resolveCompatibility`** (Function) — `src/core/resolver/resolveInstallPlan.ts:182`
- **`resolveInstallPlan`** (Function) — `src/core/resolver/resolveInstallPlan.ts:93`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `repairDecisionFor` | Function | `src/core/resolver/resolveInstallPlan.ts` | 1142 |
| `describeStoreMismatch` | Function | `src/core/manifest/storeCompatibility.ts` | 122 |
| `scriptExtenderMods` | Function | `src/core/manifest/storeCompatibility.ts` | 98 |
| `resolveCompatibility` | Function | `src/core/resolver/resolveInstallPlan.ts` | 182 |
| `resolveInstallPlan` | Function | `src/core/resolver/resolveInstallPlan.ts` | 93 |
| `logInstallPlan` | Function | `src/core/resolver/logInstallPlan.ts` | 94 |
| `collectStagingSetHashTargetsForTest` | Function | `src/core/resolver/enrichStagingSetHashes.ts` | 371 |
| `compareVersions` | Function | `src/core/resolver/gameVersionGuidance.ts` | 167 |
| `parse` | Function | `src/core/resolver/gameVersionGuidance.ts` | 168 |
| `gameVersionGuidance` | Function | `src/core/resolver/gameVersionGuidance.ts` | 116 |
| `bundledZipPath` | Function | `src/core/resolver/resolveInstallPlan.ts` | 1113 |
| `extractExtension` | Function | `src/core/resolver/resolveInstallPlan.ts` | 1167 |
| `findDownloadBySha` | Function | `src/core/resolver/resolveInstallPlan.ts` | 1094 |
| `findInstalledByNexusExact` | Function | `src/core/resolver/resolveInstallPlan.ts` | 961 |
| `findInstalledByNexusFileMismatch` | Function | `src/core/resolver/resolveInstallPlan.ts` | 1051 |
| `findInstalledByNexusModId` | Function | `src/core/resolver/resolveInstallPlan.ts` | 1032 |
| `findInstalledBySha` | Function | `src/core/resolver/resolveInstallPlan.ts` | 1069 |
| `findInstalledByStagingSetHash` | Function | `src/core/resolver/resolveInstallPlan.ts` | 1087 |
| `resolveExternalMod` | Function | `src/core/resolver/resolveInstallPlan.ts` | 567 |
| `resolveModResolutions` | Function | `src/core/resolver/resolveInstallPlan.ts` | 425 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `EnrichInstalledModsWithStagingSetHashes → ArchiveExtensionOf` | cross_community | 5 |
| `EnrichInstalledModsWithStagingSetHashes → NormalizeName` | cross_community | 3 |

## How to Explore

1. `context({name: "repairDecisionFor"})` — see callers and callees
2. `query({search_query: "resolver"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
