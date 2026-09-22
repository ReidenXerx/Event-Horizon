---
name: gitnexus-area-install
description: "Skill for the Install area of Event-Horizon. 104 symbols across 21 files."
---

# Install

104 symbols | 21 files | Cohesion: 76%

## When to Use

- Working with code in `src/`
- Understanding how Notice, reconcileMods, wizardReducer work
- Modifying install-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/pages/install/installSession.ts` | onProgress, onPhase, onHashProgress, onPhase, onHashProgress (+29) |
| `src/ui/pages/install/steps.tsx` | BucketList, CuratorReportsNotice, DamagedArchiveNotice, DroppedModNotice, ExternalArchiveNotice (+23) |
| `src/ui/pages/install/state.ts` | wizardReducer, canProceedFromDecisions, countUndecidedConflicts, defaultConflictChoice, defaultOrphanChoice (+3) |
| `src/ui/pages/install/engine.ts` | checkEnvironment, checkSystemRuntimes, profileExistsInState, runLoadingPipeline, checkAbort |
| `src/ui/pages/install/installProgress.ts` | describeElapsed, describeQuiet, estimateRemainingMs, formatDuration, trackPhase |
| `src/ui/pages/install/startWarning.test.ts` | bundle, confirmSession, confirm |
| `src/core/doctor/heal.ts` | describeHeal, healNeedsConfirmation |
| `src/ui/pages/install/autoSortGate.test.ts` | bundle, confirmSession |
| `src/ui/pages/install/deploymentGate.test.ts` | bundle, confirmSession |
| `src/core/installer/autoDeploy.ts` | blocksInstall, readsAutoDeploy |

## Entry Points

Start here when exploring this area:

- **`Notice`** (Function) — `src/ui/components/Notice.tsx:21`
- **`reconcileMods`** (Function) — `src/ui/pages/install/steps.tsx:3267`
- **`wizardReducer`** (Function) — `src/ui/pages/install/state.ts:304`
- **`describeHeal`** (Function) — `src/core/doctor/heal.ts:104`
- **`healNeedsConfirmation`** (Function) — `src/core/doctor/heal.ts:79`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `Notice` | Function | `src/ui/components/Notice.tsx` | 21 |
| `reconcileMods` | Function | `src/ui/pages/install/steps.tsx` | 3267 |
| `wizardReducer` | Function | `src/ui/pages/install/state.ts` | 304 |
| `describeHeal` | Function | `src/core/doctor/heal.ts` | 104 |
| `healNeedsConfirmation` | Function | `src/core/doctor/heal.ts` | 79 |
| `getInstallSession` | Function | `src/ui/pages/install/installSession.ts` | 1527 |
| `blocksInstall` | Function | `src/core/installer/autoDeploy.ts` | 48 |
| `readsAutoDeploy` | Function | `src/core/installer/autoDeploy.ts` | 33 |
| `probeDeploymentMethod` | Function | `src/core/installer/probeDeployment.ts` | 60 |
| `canProceedFromDecisions` | Function | `src/ui/pages/install/state.ts` | 571 |
| `countUndecidedConflicts` | Function | `src/ui/pages/install/state.ts` | 598 |
| `defaultConflictChoice` | Function | `src/ui/pages/install/state.ts` | 529 |
| `defaultOrphanChoice` | Function | `src/ui/pages/install/state.ts` | 547 |
| `fillDefaultConflictChoices` | Function | `src/ui/pages/install/state.ts` | 614 |
| `fillDefaultOrphanChoices` | Function | `src/ui/pages/install/state.ts` | 630 |
| `selectConflictResolutions` | Function | `src/ui/pages/install/state.ts` | 515 |
| `pickInstallTarget` | Function | `src/core/resolver/userState.ts` | 158 |
| `runLoadingPipeline` | Function | `src/ui/pages/install/engine.ts` | 142 |
| `checkAbort` | Function | `src/ui/pages/install/engine.ts` | 149 |
| `describeElapsed` | Function | `src/ui/pages/install/installProgress.ts` | 147 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `RunLoadingPipeline → GetEventHorizonRoot` | cross_community | 10 |
| `RunLoadingPipeline → GetVortexUserDataPath` | cross_community | 9 |
| `BeginInstall → EHRuntime` | cross_community | 7 |
| `BeginInstall → Notify` | cross_community | 7 |
| `InstallFromLink → ToPosix` | cross_community | 7 |
| `RunLoadingPipeline → Truncate` | cross_community | 7 |
| `BeginInstall → GetSnapshot` | cross_community | 6 |
| `InstallFromLink → GuessGenericHints` | cross_community | 6 |
| `InstallFromLink → GuessGenericTitle` | cross_community | 6 |
| `InstallFromLink → CountProblems` | cross_community | 6 |

## How to Explore

1. `context({name: "Notice"})` — see callers and callees
2. `query({search_query: "install"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
