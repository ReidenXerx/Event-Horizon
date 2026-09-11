---
name: gitnexus-area-curator
description: "Skill for the Curator area of Event-Horizon. 193 symbols across 41 files."
---

# Curator

193 symbols | 41 files | Cohesion: 82%

## When to Use

- Working with code in `src/`
- Understanding how checkNexusAvailability, fetchRequirements, pickInstallFile work
- Modifying curator-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/pages/curator/CuratorPage.tsx` | onProgress, downloadRequirement, installRequirement, onProgress, setProgress (+31) |
| `src/core/curator/requirements.ts` | fetchRequirements, pickInstallFile, addMasterRequirements, makeModUid, parseGameList (+11) |
| `src/core/curator/profileActions.ts` | identityCandidates, findDuplicates, findEndorsable, findFrozen, summarizeProfile (+7) |
| `src/ui/pages/curator/DiskCleanupView.tsx` | orphanPlan, retireCandidates, retirePlan, orphans, provenRetire (+6) |
| `src/core/curator/cleanupPlan.ts` | findSupersededMods, consider, planCleanup, identityKey, orphanArchives (+3) |
| `src/ui/pages/curator/curatorSession.ts` | cancel, dismiss, progress, say, set (+3) |
| `src/core/curator/updateOneMod.ts` | UpdateTimeout, installedIdentityReader, asNum, updateOneAndWait, finish (+2) |
| `src/core/curator/bulkUpdate.test.ts` | update, update, update, wait, candidate (+1) |
| `src/core/curator/collectionDiff.ts` | settle, diffCollectionAgainstProfile, candidate, firstUnclaimed, nexusModIdOf (+1) |
| `src/core/curator/runCleanup.ts` | dependsOnFailedRemoval, describeCleanupOutcome, gb, runCleanup, asNumber (+1) |

## Entry Points

Start here when exploring this area:

- **`checkNexusAvailability`** (Function) — `src/core/build/nexusAvailability.ts:241`
- **`fetchRequirements`** (Function) — `src/core/curator/requirements.ts:126`
- **`pickInstallFile`** (Function) — `src/core/curator/requirements.ts:576`
- **`applyPluginLightFlags`** (Function) — `src/core/installer/applyPluginLightFlags.ts:105`
- **`countsAsRegular`** (Function) — `src/core/installer/applyPluginLightFlags.ts:154`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `UpdateTimeout` | Class | `src/core/curator/updateOneMod.ts` | 68 |
| `CannotReinstall` | Class | `src/core/curator/reinstallMod.ts` | 45 |
| `checkNexusAvailability` | Function | `src/core/build/nexusAvailability.ts` | 241 |
| `fetchRequirements` | Function | `src/core/curator/requirements.ts` | 126 |
| `pickInstallFile` | Function | `src/core/curator/requirements.ts` | 576 |
| `applyPluginLightFlags` | Function | `src/core/installer/applyPluginLightFlags.ts` | 105 |
| `countsAsRegular` | Function | `src/core/installer/applyPluginLightFlags.ts` | 154 |
| `noteUnreadable` | Function | `src/core/installer/applyPluginLightFlags.ts` | 141 |
| `findDriftedMods` | Function | `src/core/installer/detectStagingDrift.ts` | 112 |
| `capturePluginFlags` | Function | `src/core/manifest/capturePluginFlags.ts` | 33 |
| `detectExternalDependencies` | Function | `src/core/manifest/externalDependencies.ts` | 479 |
| `readPluginFlags` | Function | `src/core/manifest/pluginFlags.ts` | 137 |
| `readPluginFlagsDetailed` | Function | `src/core/manifest/pluginFlags.ts` | 86 |
| `onProgress` | Function | `src/ui/pages/curator/requirementsIo.ts` | 116 |
| `pluginOwners` | Function | `src/core/curator/pluginPool.ts` | 65 |
| `readPluginList` | Function | `src/core/curator/pluginPool.ts` | 37 |
| `addMasterRequirements` | Function | `src/core/curator/requirements.ts` | 378 |
| `makeModUid` | Function | `src/core/curator/requirements.ts` | 49 |
| `parseGameList` | Function | `src/core/curator/requirements.ts` | 72 |
| `summarizeRequirements` | Function | `src/core/curator/requirements.ts` | 446 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Act → GetEventHorizonDir` | cross_community | 10 |
| `DisableWithDependants → GetVortexUserDataPath` | cross_community | 9 |
| `EnableWithProviders → GetVortexUserDataPath` | cross_community | 9 |
| `ReadRequirements → GetVortexUserDataPath` | cross_community | 9 |
| `Reinstall → GetVortexUserDataPath` | cross_community | 9 |
| `Act → Clamp` | cross_community | 8 |
| `Act → Scale` | cross_community | 8 |
| `Act → Truncate` | cross_community | 8 |
| `CheckNexusAvailability → GetVortexUserDataPath` | cross_community | 8 |
| `ApplyCleanup → GetVortexUserDataPath` | cross_community | 8 |

## How to Explore

1. `context({name: "checkNexusAvailability"})` — see callers and callees
2. `query({search_query: "curator"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
