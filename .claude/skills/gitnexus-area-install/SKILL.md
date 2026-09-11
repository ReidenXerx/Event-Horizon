---
name: gitnexus-area-install
description: "Skill for the Install area of Event-Horizon. 79 symbols across 13 files."
---

# Install

79 symbols | 13 files | Cohesion: 77%

## When to Use

- Working with code in `src/`
- Understanding how reconcileMods, wizardReducer, blocksInstall work
- Modifying install-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/pages/install/installSession.ts` | onHashProgress, onPhase, onHashProgress, onPhase, onProgress (+24) |
| `src/ui/pages/install/steps.tsx` | BucketList, CuratorReportsNotice, DamagedArchiveNotice, FailureBody, FinishingSkippedNotice (+20) |
| `src/ui/pages/install/state.ts` | wizardReducer, canProceedFromDecisions, countUndecidedConflicts, defaultConflictChoice, defaultOrphanChoice (+3) |
| `src/ui/pages/install/installProgress.ts` | describeElapsed, describeQuiet, estimateRemainingMs, formatDuration, trackPhase |
| `src/core/installer/autoDeploy.ts` | blocksInstall, readsAutoDeploy |
| `src/core/installer/autoSort.ts` | blocksInstall, readsAutoSort |
| `src/ui/pages/install/deploymentGate.test.ts` | bundle, confirmSession |
| `src/ui/pages/install/fomodModeWiring.test.ts` | atDecisions |
| `src/core/installer/probeDeployment.ts` | probeDeploymentMethod |
| `src/ui/pages/install/InstallPage.tsx` | session |

## Entry Points

Start here when exploring this area:

- **`reconcileMods`** (Function) — `src/ui/pages/install/steps.tsx:2549`
- **`wizardReducer`** (Function) — `src/ui/pages/install/state.ts:227`
- **`blocksInstall`** (Function) — `src/core/installer/autoDeploy.ts:48`
- **`readsAutoDeploy`** (Function) — `src/core/installer/autoDeploy.ts:33`
- **`blocksInstall`** (Function) — `src/core/installer/autoSort.ts:61`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `reconcileMods` | Function | `src/ui/pages/install/steps.tsx` | 2549 |
| `wizardReducer` | Function | `src/ui/pages/install/state.ts` | 227 |
| `blocksInstall` | Function | `src/core/installer/autoDeploy.ts` | 48 |
| `readsAutoDeploy` | Function | `src/core/installer/autoDeploy.ts` | 33 |
| `blocksInstall` | Function | `src/core/installer/autoSort.ts` | 61 |
| `readsAutoSort` | Function | `src/core/installer/autoSort.ts` | 42 |
| `probeDeploymentMethod` | Function | `src/core/installer/probeDeployment.ts` | 60 |
| `canProceedFromDecisions` | Function | `src/ui/pages/install/state.ts` | 446 |
| `countUndecidedConflicts` | Function | `src/ui/pages/install/state.ts` | 473 |
| `defaultConflictChoice` | Function | `src/ui/pages/install/state.ts` | 404 |
| `defaultOrphanChoice` | Function | `src/ui/pages/install/state.ts` | 422 |
| `fillDefaultConflictChoices` | Function | `src/ui/pages/install/state.ts` | 489 |
| `fillDefaultOrphanChoices` | Function | `src/ui/pages/install/state.ts` | 505 |
| `selectConflictResolutions` | Function | `src/ui/pages/install/state.ts` | 390 |
| `getInstallSession` | Function | `src/ui/pages/install/installSession.ts` | 1214 |
| `describeElapsed` | Function | `src/ui/pages/install/installProgress.ts` | 147 |
| `describeQuiet` | Function | `src/ui/pages/install/installProgress.ts` | 114 |
| `estimateRemainingMs` | Function | `src/ui/pages/install/installProgress.ts` | 89 |
| `formatDuration` | Function | `src/ui/pages/install/installProgress.ts` | 132 |
| `trackPhase` | Function | `src/ui/pages/install/installProgress.ts` | 66 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `RunEnvironmentGate → EHRuntime` | cross_community | 8 |
| `RunEnvironmentGate → Notify` | cross_community | 8 |
| `RunEnvironmentGate → GetSnapshot` | cross_community | 7 |
| `RunEnvironmentGate → GetVortexUserDataPath` | cross_community | 7 |
| `RunEnvironmentGate → WizardReducer` | cross_community | 6 |
| `Heal → EHRuntime` | cross_community | 6 |
| `Heal → Notify` | cross_community | 6 |
| `RunEnvironmentGate → DismissNotification` | cross_community | 5 |
| `Heal → GetSnapshot` | cross_community | 5 |
| `OpenConfirm → EHRuntime` | cross_community | 5 |

## How to Explore

1. `context({name: "reconcileMods"})` — see callers and callees
2. `query({search_query: "install"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
