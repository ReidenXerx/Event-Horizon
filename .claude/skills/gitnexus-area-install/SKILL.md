---
name: gitnexus-area-install
description: "Skill for the Install area of Event-Horizon. 106 symbols across 22 files."
---

# Install

106 symbols | 22 files | Cohesion: 68%

## When to Use

- Working with code in `src/`
- Understanding how useToast, useErrorReporter, EnvironmentTools work
- Modifying install-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/pages/install/steps.tsx` | ConflictRow, PickStep, handlePick, decisionLabel, describeConflict (+26) |
| `src/ui/pages/install/installSession.ts` | onHashProgress, onPhase, onHashProgress, onPhase, onProgress (+24) |
| `src/ui/pages/install/state.ts` | wizardReducer, canProceedFromDecisions, countUndecidedConflicts, defaultConflictChoice, defaultOrphanChoice (+3) |
| `src/ui/pages/doctor/EnvironmentTools.tsx` | EnvironmentTools, dismiss, onGame, restore, runCheck (+1) |
| `src/ui/pages/install/installProgress.ts` | describeElapsed, describeQuiet, estimateRemainingMs, formatDuration, trackPhase |
| `src/ui/pages/CollectionsPage.tsx` | ReceiptDetailModal, handleExportDiagnostic, describeHostPlatform, saveDiagnosticReport |
| `src/ui/pages/install/InstallPage.tsx` | ErrorRetry, InstallWizard, session |
| `src/ui/pages/build/BuildPage.tsx` | ImportPreviousButton, handleClick |
| `src/ui/play/PlayGameButton.tsx` | PlayGameButton, PlayGameCard |
| `src/core/installer/autoDeploy.ts` | blocksInstall, readsAutoDeploy |

## Entry Points

Start here when exploring this area:

- **`useToast`** (Function) — `src/ui/components/Toast.tsx:61`
- **`useErrorReporter`** (Function) — `src/ui/errors/ErrorContext.tsx:49`
- **`EnvironmentTools`** (Function) — `src/ui/pages/doctor/EnvironmentTools.tsx:48`
- **`dismiss`** (Function) — `src/ui/pages/doctor/EnvironmentTools.tsx:244`
- **`onGame`** (Function) — `src/ui/pages/doctor/EnvironmentTools.tsx:65`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `useToast` | Function | `src/ui/components/Toast.tsx` | 61 |
| `useErrorReporter` | Function | `src/ui/errors/ErrorContext.tsx` | 49 |
| `EnvironmentTools` | Function | `src/ui/pages/doctor/EnvironmentTools.tsx` | 48 |
| `dismiss` | Function | `src/ui/pages/doctor/EnvironmentTools.tsx` | 244 |
| `onGame` | Function | `src/ui/pages/doctor/EnvironmentTools.tsx` | 65 |
| `restore` | Function | `src/ui/pages/doctor/EnvironmentTools.tsx` | 198 |
| `runCheck` | Function | `src/ui/pages/doctor/EnvironmentTools.tsx` | 102 |
| `PickStep` | Function | `src/ui/pages/install/steps.tsx` | 178 |
| `handlePick` | Function | `src/ui/pages/install/steps.tsx` | 188 |
| `PlayGameButton` | Function | `src/ui/play/PlayGameButton.tsx` | 19 |
| `nativeNotify` | Function | `src/ui/runtime/nativeNotify.ts` | 39 |
| `useApi` | Function | `src/ui/state/ApiContext.tsx` | 33 |
| `wizardReducer` | Function | `src/ui/pages/install/state.ts` | 227 |
| `blocksInstall` | Function | `src/core/installer/autoDeploy.ts` | 48 |
| `readsAutoDeploy` | Function | `src/core/installer/autoDeploy.ts` | 33 |
| `blocksInstall` | Function | `src/core/installer/autoSort.ts` | 61 |
| `readsAutoSort` | Function | `src/core/installer/autoSort.ts` | 42 |
| `probeDeploymentMethod` | Function | `src/core/installer/probeDeployment.ts` | 60 |
| `Notice` | Function | `src/ui/components/Notice.tsx` | 21 |
| `reconcileMods` | Function | `src/ui/pages/install/steps.tsx` | 2578 |

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
| `DashboardBody → UseToast` | cross_community | 5 |
| `DashboardBody → UseApi` | cross_community | 5 |
| `RunEnvironmentGate → DismissNotification` | cross_community | 5 |

## How to Explore

1. `context({name: "useToast"})` — see callers and callees
2. `query({search_query: "install"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
