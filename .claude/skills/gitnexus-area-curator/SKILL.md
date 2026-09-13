---
name: gitnexus-area-curator
description: "Skill for the Curator area of Event-Horizon. 377 symbols across 77 files."
---

# Curator

377 symbols | 77 files | Cohesion: 74%

## When to Use

- Working with code in `src/`
- Understanding how describeRemoveConfirm, resolveInstallFiles, pluginOwners work
- Modifying curator-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/pages/curator/useCuratorActions.ts` | num, useCuratorActions, removeMod, askThree, disableWithDependants (+38) |
| `src/core/curator/requirements.ts` | dependantClosure, dependantsOf, describeEnableQuestion, list, losesALine (+28) |
| `src/ui/pages/curator/CuratorPage.tsx` | confirm, makeConfirmer, applied, dismissFor, pageKeyOf (+25) |
| `src/core/curator/profileActions.ts` | findDuplicates, findEndorsable, findFrozen, findManualUpdates, findUpdatable (+7) |
| `src/core/curator/requirementDismissals.ts` | applyDismissals, dependentPageKey, dismissRequirement, isDismissible, kindOf (+6) |
| `src/ui/pages/curator/DiskCleanupView.tsx` | retireCandidates, orphanPlan, retirePlan, orphans, provenRetire (+6) |
| `src/ui/pages/curator/curatorSession.ts` | begin, cancel, dismiss, finish, progress (+5) |
| `src/core/curator/updateOneMod.ts` | installedIdentityReader, asNum, updateOneAndWait, UpdateTimeout, arm (+5) |
| `src/core/curator/installPlan.ts` | resolveInstallFiles, planRequirementClosure, absorb, noteTruncated, topologicalOrder (+4) |
| `src/core/logging/ehLog.ts` | fail, ok, step, ehLog, enqueue (+3) |

## Entry Points

Start here when exploring this area:

- **`describeRemoveConfirm`** (Function) — `src/core/curator/archiveOnDisk.ts:38`
- **`resolveInstallFiles`** (Function) — `src/core/curator/installPlan.ts:340`
- **`pluginOwners`** (Function) — `src/core/curator/pluginPool.ts:111`
- **`freezeAttribute`** (Function) — `src/core/curator/readProfile.ts:151`
- **`endIfIdle`** (Function) — `src/core/curator/requirementStep.ts:119`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `CannotReinstall` | Class | `src/core/curator/reinstallMod.ts` | 45 |
| `UpdateTimeout` | Class | `src/core/curator/updateOneMod.ts` | 96 |
| `describeRemoveConfirm` | Function | `src/core/curator/archiveOnDisk.ts` | 38 |
| `resolveInstallFiles` | Function | `src/core/curator/installPlan.ts` | 340 |
| `pluginOwners` | Function | `src/core/curator/pluginPool.ts` | 111 |
| `freezeAttribute` | Function | `src/core/curator/readProfile.ts` | 151 |
| `endIfIdle` | Function | `src/core/curator/requirementStep.ts` | 119 |
| `onStop` | Function | `src/core/curator/requirementStep.ts` | 132 |
| `somethingRunning` | Function | `src/core/curator/requirementStep.ts` | 115 |
| `fallBack` | Function | `src/core/curator/requirementStep.ts` | 186 |
| `start` | Function | `src/core/curator/requirementStep.ts` | 168 |
| `dependantClosure` | Function | `src/core/curator/requirements.ts` | 733 |
| `dependantsOf` | Function | `src/core/curator/requirements.ts` | 707 |
| `describeEnableQuestion` | Function | `src/core/curator/requirements.ts` | 909 |
| `list` | Function | `src/core/curator/requirements.ts` | 913 |
| `parseGameList` | Function | `src/core/curator/requirements.ts` | 72 |
| `pickInstallFile` | Function | `src/core/curator/requirements.ts` | 984 |
| `reusableAnswers` | Function | `src/core/curator/requirements.ts` | 198 |
| `runHeal` | Function | `src/core/doctor/runHeal.ts` | 98 |
| `cleanGameFolder` | Function | `src/core/environment/cleanGameFolder.ts` | 44 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `LaunchGame → GetVortexUserDataPath` | cross_community | 10 |
| `RunInstallImpl → GetEventHorizonRoot` | cross_community | 10 |
| `PublishedDetailsPanel → GetEventHorizonDir` | cross_community | 10 |
| `RunSelfChecks → GetVortexUserDataPath` | cross_community | 10 |
| `Dashboard → GetEventHorizonRoot` | cross_community | 10 |
| `InstallDownloads → GetEventHorizonDir` | cross_community | 10 |
| `HandleDeletePublished → GetVortexUserDataPath` | cross_community | 10 |
| `LoadPublishedDetails → GetEventHorizonRoot` | cross_community | 10 |
| `Act → GetEventHorizonDir` | cross_community | 10 |
| `PublishedDetailsPanel → GetVortexUserDataPath` | cross_community | 10 |

## How to Explore

1. `context({name: "describeRemoveConfirm"})` — see callers and callees
2. `query({search_query: "curator"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
