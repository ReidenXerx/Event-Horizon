---
name: gitnexus-area-install
description: "Skill for the Install area of Event-Horizon. 73 symbols across 10 files."
---

# Install

73 symbols | 10 files | Cohesion: 81%

## When to Use

- Working with code in `src/`
- Understanding how reconcileMods, wizardReducer, canProceedFromDecisions work
- Modifying install-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/pages/install/steps.tsx` | BucketList, CuratorReportsNotice, DamagedArchiveNotice, ExternalArchiveNotice, GameIniNotice (+22) |
| `src/ui/pages/install/installSession.ts` | onHashProgress, onPhase, onHashProgress, onPhase, onProgress (+20) |
| `src/ui/pages/install/state.ts` | wizardReducer, canProceedFromDecisions, countUndecidedConflicts, defaultConflictChoice, defaultOrphanChoice (+3) |
| `src/ui/pages/install/installProgress.ts` | describeElapsed, describeQuiet, estimateRemainingMs, formatDuration, trackPhase |
| `src/core/installer/autoDeploy.ts` | blocksInstall, readsAutoDeploy |
| `src/ui/pages/install/deploymentGate.test.ts` | bundle, confirmSession |
| `src/ui/pages/install/fomodModeWiring.test.ts` | atDecisions |
| `src/core/installer/probeDeployment.ts` | probeDeploymentMethod |
| `src/ui/pages/install/InstallPage.tsx` | session |
| `src/ui/pages/install/extractorGate.test.ts` | confirmSession |

## Entry Points

Start here when exploring this area:

- **`reconcileMods`** (Function) — `src/ui/pages/install/steps.tsx:3004`
- **`wizardReducer`** (Function) — `src/ui/pages/install/state.ts:218`
- **`canProceedFromDecisions`** (Function) — `src/ui/pages/install/state.ts:437`
- **`countUndecidedConflicts`** (Function) — `src/ui/pages/install/state.ts:464`
- **`defaultConflictChoice`** (Function) — `src/ui/pages/install/state.ts:395`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `reconcileMods` | Function | `src/ui/pages/install/steps.tsx` | 3004 |
| `wizardReducer` | Function | `src/ui/pages/install/state.ts` | 218 |
| `canProceedFromDecisions` | Function | `src/ui/pages/install/state.ts` | 437 |
| `countUndecidedConflicts` | Function | `src/ui/pages/install/state.ts` | 464 |
| `defaultConflictChoice` | Function | `src/ui/pages/install/state.ts` | 395 |
| `defaultOrphanChoice` | Function | `src/ui/pages/install/state.ts` | 413 |
| `fillDefaultConflictChoices` | Function | `src/ui/pages/install/state.ts` | 480 |
| `fillDefaultOrphanChoices` | Function | `src/ui/pages/install/state.ts` | 496 |
| `selectConflictResolutions` | Function | `src/ui/pages/install/state.ts` | 381 |
| `DecisionsStep` | Function | `src/ui/pages/install/steps.tsx` | 1080 |
| `blocksInstall` | Function | `src/core/installer/autoDeploy.ts` | 48 |
| `readsAutoDeploy` | Function | `src/core/installer/autoDeploy.ts` | 33 |
| `probeDeploymentMethod` | Function | `src/core/installer/probeDeployment.ts` | 60 |
| `describeElapsed` | Function | `src/ui/pages/install/installProgress.ts` | 147 |
| `describeQuiet` | Function | `src/ui/pages/install/installProgress.ts` | 114 |
| `estimateRemainingMs` | Function | `src/ui/pages/install/installProgress.ts` | 89 |
| `formatDuration` | Function | `src/ui/pages/install/installProgress.ts` | 132 |
| `trackPhase` | Function | `src/ui/pages/install/installProgress.ts` | 66 |
| `InstallingStep` | Function | `src/ui/pages/install/steps.tsx` | 2202 |
| `getInstallSession` | Function | `src/ui/pages/install/installSession.ts` | 870 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Heal → EHRuntime` | cross_community | 6 |
| `Heal → Notify` | cross_community | 6 |
| `StartInstall → EHRuntime` | cross_community | 6 |
| `StartInstall → Notify` | cross_community | 6 |
| `Heal → GetSnapshot` | cross_community | 5 |
| `DoneStep → Pill` | cross_community | 5 |
| `StartInstall → GetSnapshot` | cross_community | 5 |
| `OnHashProgress → EHRuntime` | cross_community | 5 |
| `OnHashProgress → Notify` | cross_community | 5 |
| `OnPhase → EHRuntime` | cross_community | 5 |

## How to Explore

1. `context({name: "reconcileMods"})` — see callers and callees
2. `query({search_query: "install"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
