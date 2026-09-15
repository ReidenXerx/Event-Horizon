---
name: gitnexus-area-curator
description: "Skill for the Curator area of Event-Horizon. 390 symbols across 75 files."
---

# Curator

390 symbols | 75 files | Cohesion: 74%

## When to Use

- Working with code in `src/`
- Understanding how freezeAttribute, installRequirementStep, endIfIdle work
- Modifying curator-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/pages/curator/useCuratorActions.ts` | isPremium, useCuratorActions, guard, installDownloads, installOne (+39) |
| `src/core/curator/requirements.ts` | fetchRequirements, parseGameList, reusableAnswers, byFile, compareSegment (+28) |
| `src/ui/pages/curator/CuratorPage.tsx` | confirm, makeConfirmer, applied, dismissFor, pageKeyOf (+26) |
| `src/ui/pages/curator/DiskCleanupView.tsx` | DiskCleanupView, freedByRetiring, run, num, render (+11) |
| `src/core/curator/profileActions.ts` | findDuplicates, findEndorsable, findFrozen, findManualUpdates, findUpdatable (+7) |
| `src/core/curator/requirementDismissals.ts` | applyDismissals, dependentPageKey, dismissRequirement, isDismissible, kindOf (+6) |
| `src/core/curator/cleanupPlan.ts` | archivesFreedByRemoval, cleanupSubset, formatSize, findSupersededMods, consider (+6) |
| `src/core/curator/updateOneMod.ts` | UpdateTimeout, installedIdentityReader, asNum, updateOneAndWait, arm (+5) |
| `src/ui/pages/curator/curatorSession.ts` | begin, cancel, dismiss, finish, progress (+5) |
| `src/ui/pages/curator/workbench.ts` | buildRows, rowsForView, rowsForViews, viewCounts, outsideDataTypes (+4) |

## Entry Points

Start here when exploring this area:

- **`freezeAttribute`** (Function) — `src/core/curator/readProfile.ts:151`
- **`installRequirementStep`** (Function) — `src/core/curator/requirementStep.ts:100`
- **`endIfIdle`** (Function) — `src/core/curator/requirementStep.ts:119`
- **`onStop`** (Function) — `src/core/curator/requirementStep.ts:132`
- **`somethingRunning`** (Function) — `src/core/curator/requirementStep.ts:115`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `UpdateTimeout` | Class | `src/core/curator/updateOneMod.ts` | 96 |
| `CannotReinstall` | Class | `src/core/curator/reinstallMod.ts` | 45 |
| `freezeAttribute` | Function | `src/core/curator/readProfile.ts` | 151 |
| `installRequirementStep` | Function | `src/core/curator/requirementStep.ts` | 100 |
| `endIfIdle` | Function | `src/core/curator/requirementStep.ts` | 119 |
| `onStop` | Function | `src/core/curator/requirementStep.ts` | 132 |
| `somethingRunning` | Function | `src/core/curator/requirementStep.ts` | 115 |
| `fallBack` | Function | `src/core/curator/requirementStep.ts` | 186 |
| `start` | Function | `src/core/curator/requirementStep.ts` | 168 |
| `installedIdentityReader` | Function | `src/core/curator/updateOneMod.ts` | 227 |
| `asNum` | Function | `src/core/curator/updateOneMod.ts` | 241 |
| `updateOneAndWait` | Function | `src/core/curator/updateOneMod.ts` | 106 |
| `arm` | Function | `src/core/curator/updateOneMod.ts` | 171 |
| `widen` | Function | `src/core/curator/updateOneMod.ts` | 192 |
| `runHeal` | Function | `src/core/doctor/runHeal.ts` | 98 |
| `cleanGameFolder` | Function | `src/core/environment/cleanGameFolder.ts` | 44 |
| `onExit` | Function | `src/core/environment/launchGame.ts` | 217 |
| `nexusModIdOfCompareKey` | Function | `src/core/identity/compareKey.ts` | 96 |
| `parseCompareKey` | Function | `src/core/identity/compareKey.ts` | 79 |
| `probeNexusAccount` | Function | `src/core/installer/checkNexusAccount.ts` | 243 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `LaunchGame → GetVortexUserDataPath` | cross_community | 10 |
| `RunInstallImpl → GetEventHorizonRoot` | cross_community | 10 |
| `PublishedDetailsPanel → ResolveLogFile` | cross_community | 10 |
| `PublishedDetailsPanel → Truncate` | cross_community | 10 |
| `LoadPublishedDetails → GetEventHorizonDir` | cross_community | 10 |
| `RunSelfChecks → GetVortexUserDataPath` | cross_community | 10 |
| `Dashboard → GetEventHorizonRoot` | cross_community | 10 |
| `LoadPublishedDetails → ResolveLogFile` | cross_community | 10 |
| `InstallDownloads → GetEventHorizonDir` | cross_community | 10 |
| `HandleDeletePublished → GetVortexUserDataPath` | cross_community | 10 |

## How to Explore

1. `context({name: "freezeAttribute"})` — see callers and callees
2. `query({search_query: "curator"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
