---
name: gitnexus-area-curator
description: "Skill for the Curator area of Event-Horizon. 567 symbols across 131 files."
---

# Curator

567 symbols | 131 files | Cohesion: 80%

## When to Use

- Working with code in `src/`
- Understanding how archivesFreedByRemoval, cleanupSubset, describeEvidence work
- Modifying curator-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/pages/curator/useCuratorActions.ts` | num, useCuratorActions, removeMod, askThree, disableWithDependants (+38) |
| `src/ui/pages/curator/CuratorPage.tsx` | CuratorBody, onSelect, setNote, toggleView, CuratorPage (+29) |
| `src/core/curator/requirements.ts` | dependantClosure, dependantsOf, describeEnableQuestion, list, losesALine (+28) |
| `src/ui/pages/build/BuildPage.tsx` | AvailabilityPanel, BuildDiffCard, BuildWizard, BuildingPanel, DecisionsGate (+18) |
| `src/ui/pages/install/steps.tsx` | ConfirmStep, ConflictRow, DecisionsStep, DoneStep, ExternalDownloadGuide (+18) |
| `src/ui/pages/curator/DiskCleanupView.tsx` | DiskCleanupView, freedByRetiring, run, num, render (+13) |
| `src/core/curator/cleanupPlan.ts` | archivesFreedByRemoval, cleanupSubset, describeEvidence, formatSize, findSupersededMods (+7) |
| `src/ui/pages/CollectionsPage.tsx` | CollectionsList, handleContinueInstall, refresh, FailedAttempts, InterruptedInstalls (+7) |
| `src/ui/pages/curator/PluginsView.tsx` | PluginsView, render, render, render, num (+7) |
| `src/core/curator/profileActions.ts` | findDuplicates, findEndorsable, findFrozen, findManualUpdates, findUpdatable (+7) |

## Entry Points

Start here when exploring this area:

- **`archivesFreedByRemoval`** (Function) — `src/core/curator/cleanupPlan.ts:509`
- **`cleanupSubset`** (Function) — `src/core/curator/cleanupPlan.ts:521`
- **`describeEvidence`** (Function) — `src/core/curator/cleanupPlan.ts:274`
- **`formatSize`** (Function) — `src/core/curator/cleanupPlan.ts:475`
- **`describeMastersCell`** (Function) — `src/core/curator/pluginView.ts:223`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `CannotReinstall` | Class | `src/core/curator/reinstallMod.ts` | 45 |
| `UpdateTimeout` | Class | `src/core/curator/updateOneMod.ts` | 96 |
| `archivesFreedByRemoval` | Function | `src/core/curator/cleanupPlan.ts` | 509 |
| `cleanupSubset` | Function | `src/core/curator/cleanupPlan.ts` | 521 |
| `describeEvidence` | Function | `src/core/curator/cleanupPlan.ts` | 274 |
| `formatSize` | Function | `src/core/curator/cleanupPlan.ts` | 475 |
| `describeMastersCell` | Function | `src/core/curator/pluginView.ts` | 223 |
| `describePluginKind` | Function | `src/core/curator/pluginView.ts` | 233 |
| `describeProfileDrift` | Function | `src/core/curator/profileDrift.ts` | 106 |
| `isProfileUnmoved` | Function | `src/core/curator/profileDrift.ts` | 90 |
| `doctorLightFlagBaseline` | Function | `src/core/doctor/health.ts` | 188 |
| `overallHealth` | Function | `src/core/doctor/health.ts` | 861 |
| `canReapply` | Function | `src/core/doctor/loadOrderStatus.ts` | 254 |
| `getDraftsRoot` | Function | `src/core/draftStorage.ts` | 122 |
| `listDrafts` | Function | `src/core/draftStorage.ts` | 163 |
| `describeInstallAttempt` | Function | `src/core/installer/attemptRecord.ts` | 231 |
| `describeFomodModes` | Function | `src/core/installer/fomodReplayMode.ts` | 78 |
| `s` | Function | `src/core/installer/fomodReplayMode.ts` | 84 |
| `mustAskReplayMode` | Function | `src/core/installer/fomodReplayMode.ts` | 183 |
| `countKinds` | Function | `src/core/manifest/unexplainedFiles.ts` | 175 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `LaunchGame → GetVortexUserDataPath` | cross_community | 10 |
| `ExecutePromptUserChoice → GetEventHorizonDir` | cross_community | 10 |
| `RunInstallImpl → GetEventHorizonRoot` | cross_community | 10 |
| `ReadZipEntry → GetVortexUserDataPath` | cross_community | 10 |
| `PublishedDetailsPanel → GetEventHorizonDir` | cross_community | 10 |
| `Dashboard → GetEventHorizonRoot` | cross_community | 10 |
| `RunSelfChecks → GetVortexUserDataPath` | cross_community | 10 |
| `InstallDownloads → GetEventHorizonDir` | cross_community | 10 |
| `LoadPublishedDetails → GetEventHorizonRoot` | cross_community | 10 |
| `HandleDeletePublished → GetVortexUserDataPath` | cross_community | 10 |

## How to Explore

1. `context({name: "archivesFreedByRemoval"})` — see callers and callees
2. `query({search_query: "curator"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
