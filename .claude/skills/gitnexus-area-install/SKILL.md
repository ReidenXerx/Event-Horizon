---
name: gitnexus-area-install
description: "Skill for the Install area of Event-Horizon. 69 symbols across 8 files."
---

# Install

69 symbols | 8 files | Cohesion: 83%

## When to Use

- Working with code in `src/`
- Understanding how reconcileMods, wizardReducer, canProceedFromDecisions work
- Modifying install-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/pages/install/steps.tsx` | BucketList, CuratorReportsNotice, DamagedArchiveNotice, ExternalArchiveNotice, FailureBody (+25) |
| `src/ui/pages/install/installSession.ts` | onHashProgress, onPhase, onHashProgress, onPhase, onProgress (+16) |
| `src/ui/pages/install/state.ts` | wizardReducer, canProceedFromDecisions, countUndecidedConflicts, defaultConflictChoice, defaultOrphanChoice (+3) |
| `src/ui/pages/install/installProgress.ts` | describeElapsed, describeQuiet, estimateRemainingMs, formatDuration, trackPhase |
| `src/ui/pages/install/deploymentGate.test.ts` | bundle, confirmSession |
| `src/ui/pages/install/fomodModeWiring.test.ts` | atDecisions |
| `src/ui/pages/install/InstallPage.tsx` | session |
| `src/ui/pages/install/extractorGate.test.ts` | confirmSession |

## Entry Points

Start here when exploring this area:

- **`reconcileMods`** (Function) — `src/ui/pages/install/steps.tsx:3163`
- **`wizardReducer`** (Function) — `src/ui/pages/install/state.ts:218`
- **`canProceedFromDecisions`** (Function) — `src/ui/pages/install/state.ts:437`
- **`countUndecidedConflicts`** (Function) — `src/ui/pages/install/state.ts:464`
- **`defaultConflictChoice`** (Function) — `src/ui/pages/install/state.ts:395`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `reconcileMods` | Function | `src/ui/pages/install/steps.tsx` | 3163 |
| `wizardReducer` | Function | `src/ui/pages/install/state.ts` | 218 |
| `canProceedFromDecisions` | Function | `src/ui/pages/install/state.ts` | 437 |
| `countUndecidedConflicts` | Function | `src/ui/pages/install/state.ts` | 464 |
| `defaultConflictChoice` | Function | `src/ui/pages/install/state.ts` | 395 |
| `defaultOrphanChoice` | Function | `src/ui/pages/install/state.ts` | 413 |
| `fillDefaultConflictChoices` | Function | `src/ui/pages/install/state.ts` | 480 |
| `fillDefaultOrphanChoices` | Function | `src/ui/pages/install/state.ts` | 496 |
| `selectConflictResolutions` | Function | `src/ui/pages/install/state.ts` | 381 |
| `DecisionsStep` | Function | `src/ui/pages/install/steps.tsx` | 1097 |
| `describeElapsed` | Function | `src/ui/pages/install/installProgress.ts` | 147 |
| `describeQuiet` | Function | `src/ui/pages/install/installProgress.ts` | 114 |
| `estimateRemainingMs` | Function | `src/ui/pages/install/installProgress.ts` | 89 |
| `formatDuration` | Function | `src/ui/pages/install/installProgress.ts` | 132 |
| `trackPhase` | Function | `src/ui/pages/install/installProgress.ts` | 66 |
| `InstallingStep` | Function | `src/ui/pages/install/steps.tsx` | 2227 |
| `getInstallSession` | Function | `src/ui/pages/install/installSession.ts` | 976 |
| `isAbortError` | Function | `src/ui/pages/install/installSession.ts` | 989 |
| `InstallSession` | Class | `src/ui/pages/install/installSession.ts` | 86 |
| `BucketList` | Function | `src/ui/pages/install/steps.tsx` | 4128 |

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
