---
name: gitnexus-area-install
description: "Skill for the Install area of Event-Horizon. 100 symbols across 21 files."
---

# Install

100 symbols | 21 files | Cohesion: 77%

## When to Use

- Working with code in `src/`
- Understanding how Notice, reconcileMods, wizardReducer work
- Modifying install-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/pages/install/installSession.ts` | onPhase, onHashProgress, onPhase, onHashProgress, onPhase (+27) |
| `src/ui/pages/install/steps.tsx` | BucketList, CuratorReportsNotice, DamagedArchiveNotice, ExternalArchiveNotice, FailureBody (+20) |
| `src/ui/pages/install/state.ts` | wizardReducer, canProceedFromDecisions, countUndecidedConflicts, defaultConflictChoice, defaultOrphanChoice (+3) |
| `src/ui/pages/install/fetchLink.ts` | fetchFromNexus, fetchThroughLinkFile, gameMismatchMessage, readKnownGames, throwIfAborted (+2) |
| `src/ui/pages/install/installProgress.ts` | describeElapsed, describeQuiet, estimateRemainingMs, formatDuration, trackPhase |
| `src/core/installer/installLink.ts` | fileSizeOf, nexusFilePageUrl, vortexGamesForNexusDomain |
| `src/core/curator/requirementStep.test.ts` | download, download |
| `src/ui/pages/curator/requirementsIo.ts` | nexusExtOf, fn |
| `src/ui/pages/install/autoSortGate.test.ts` | bundle, confirmSession |
| `src/ui/pages/install/deploymentGate.test.ts` | bundle, confirmSession |

## Entry Points

Start here when exploring this area:

- **`Notice`** (Function) — `src/ui/components/Notice.tsx:21`
- **`reconcileMods`** (Function) — `src/ui/pages/install/steps.tsx:2728`
- **`wizardReducer`** (Function) — `src/ui/pages/install/state.ts:282`
- **`fileSizeOf`** (Function) — `src/core/installer/installLink.ts:315`
- **`nexusFilePageUrl`** (Function) — `src/core/installer/installLink.ts:305`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `Notice` | Function | `src/ui/components/Notice.tsx` | 21 |
| `reconcileMods` | Function | `src/ui/pages/install/steps.tsx` | 2728 |
| `wizardReducer` | Function | `src/ui/pages/install/state.ts` | 282 |
| `fileSizeOf` | Function | `src/core/installer/installLink.ts` | 315 |
| `nexusFilePageUrl` | Function | `src/core/installer/installLink.ts` | 305 |
| `vortexGamesForNexusDomain` | Function | `src/core/installer/installLink.ts` | 293 |
| `nexusExtOf` | Function | `src/ui/pages/curator/requirementsIo.ts` | 177 |
| `fn` | Function | `src/ui/pages/curator/requirementsIo.ts` | 179 |
| `nexus` | Function | `src/ui/pages/curator/useCuratorActions.ts` | 222 |
| `waitForVortexDownload` | Function | `src/ui/pages/install/fetchLink.ts` | 391 |
| `describeHeal` | Function | `src/core/doctor/heal.ts` | 66 |
| `getInstallSession` | Function | `src/ui/pages/install/installSession.ts` | 1350 |
| `blocksInstall` | Function | `src/core/installer/autoDeploy.ts` | 48 |
| `readsAutoDeploy` | Function | `src/core/installer/autoDeploy.ts` | 33 |
| `probeDeploymentMethod` | Function | `src/core/installer/probeDeployment.ts` | 60 |
| `canProceedFromDecisions` | Function | `src/ui/pages/install/state.ts` | 523 |
| `countUndecidedConflicts` | Function | `src/ui/pages/install/state.ts` | 550 |
| `defaultConflictChoice` | Function | `src/ui/pages/install/state.ts` | 481 |
| `defaultOrphanChoice` | Function | `src/ui/pages/install/state.ts` | 499 |
| `fillDefaultConflictChoices` | Function | `src/ui/pages/install/state.ts` | 566 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `RunEnvironmentGate → EHRuntime` | cross_community | 8 |
| `RunEnvironmentGate → Notify` | cross_community | 8 |
| `RunEnvironmentGate → GetSnapshot` | cross_community | 7 |
| `InstallFromLink → ToPosix` | cross_community | 7 |
| `FetchThroughLinkFile → GetVortexUserDataPath` | cross_community | 7 |
| `RunEnvironmentGate → GetVortexUserDataPath` | cross_community | 7 |
| `CuratorBody → Fn` | cross_community | 6 |
| `RunEnvironmentGate → WizardReducer` | cross_community | 6 |
| `Heal → EHRuntime` | cross_community | 6 |
| `Heal → Notify` | cross_community | 6 |

## How to Explore

1. `context({name: "Notice"})` — see callers and callees
2. `query({search_query: "install"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
