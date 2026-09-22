---
name: gitnexus-area-install
description: "Skill for the Install area of Event-Horizon. 111 symbols across 24 files."
---

# Install

111 symbols | 24 files | Cohesion: 68%

## When to Use

- Working with code in `src/`
- Understanding how wizardReducer, describeHeal, healNeedsConfirmation work
- Modifying install-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/pages/install/installSession.ts` | onProgress, onPhase, onHashProgress, onPhase, onHashProgress (+29) |
| `src/ui/pages/install/steps.tsx` | DroppedModNotice, ExternalArchiveNotice, GameIniNotice, IniTweakNotice, InstallNotes (+25) |
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

- **`wizardReducer`** (Function) — `src/ui/pages/install/state.ts:304`
- **`describeHeal`** (Function) — `src/core/doctor/heal.ts:104`
- **`healNeedsConfirmation`** (Function) — `src/core/doctor/heal.ts:79`
- **`getInstallSession`** (Function) — `src/ui/pages/install/installSession.ts:1527`
- **`Notice`** (Function) — `src/ui/components/Notice.tsx:21`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `wizardReducer` | Function | `src/ui/pages/install/state.ts` | 304 |
| `describeHeal` | Function | `src/core/doctor/heal.ts` | 104 |
| `healNeedsConfirmation` | Function | `src/core/doctor/heal.ts` | 79 |
| `getInstallSession` | Function | `src/ui/pages/install/installSession.ts` | 1527 |
| `Notice` | Function | `src/ui/components/Notice.tsx` | 21 |
| `reconcileMods` | Function | `src/ui/pages/install/steps.tsx` | 3247 |
| `blocksInstall` | Function | `src/core/installer/autoDeploy.ts` | 48 |
| `readsAutoDeploy` | Function | `src/core/installer/autoDeploy.ts` | 33 |
| `probeDeploymentMethod` | Function | `src/core/installer/probeDeployment.ts` | 60 |
| `StatGrid` | Function | `src/ui/components/StatTile.tsx` | 60 |
| `StatTile` | Function | `src/ui/components/StatTile.tsx` | 35 |
| `AboutPage` | Function | `src/ui/pages/AboutPage.tsx` | 21 |
| `canProceedFromDecisions` | Function | `src/ui/pages/install/state.ts` | 571 |
| `countUndecidedConflicts` | Function | `src/ui/pages/install/state.ts` | 598 |
| `defaultConflictChoice` | Function | `src/ui/pages/install/state.ts` | 529 |
| `defaultOrphanChoice` | Function | `src/ui/pages/install/state.ts` | 547 |
| `fillDefaultConflictChoices` | Function | `src/ui/pages/install/state.ts` | 614 |
| `fillDefaultOrphanChoices` | Function | `src/ui/pages/install/state.ts` | 630 |
| `selectConflictResolutions` | Function | `src/ui/pages/install/state.ts` | 515 |
| `pickInstallTarget` | Function | `src/core/resolver/userState.ts` | 158 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `RunLoadingPipeline → GetEventHorizonRoot` | cross_community | 10 |
| `RunLoadingPipeline → GetVortexUserDataPath` | cross_community | 9 |
| `RunEnvironmentGate → GetVortexUserDataPath` | cross_community | 9 |
| `RunEnvironmentGate → EHRuntime` | cross_community | 8 |
| `RunEnvironmentGate → Notify` | cross_community | 8 |
| `RunEnvironmentGate → GetSnapshot` | cross_community | 7 |
| `BeginInstall → EHRuntime` | cross_community | 7 |
| `BeginInstall → Notify` | cross_community | 7 |
| `InstallFromLink → ToPosix` | cross_community | 7 |
| `RunLoadingPipeline → Truncate` | cross_community | 7 |

## How to Explore

1. `context({name: "wizardReducer"})` — see callers and callees
2. `query({search_query: "install"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
