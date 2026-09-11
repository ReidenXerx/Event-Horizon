---
name: gitnexus-area-build
description: "Skill for the Build area of Event-Horizon. 435 symbols across 94 files."
---

# Build

435 symbols | 94 files | Cohesion: 80%

## When to Use

- Working with code in `src/`
- Understanding how describeEnableChanges, planEnableChanges, archivesFreedByRemoval work
- Modifying build-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/pages/build/BuildPage.tsx` | AvailabilityPanel, BuildDiffCard, BuildWizard, BuildingPanel, DecisionsGate (+45) |
| `src/ui/pages/build/buildSession.ts` | cancelLoading, cancelRecovering, getState, subscribe, queuePosition (+30) |
| `src/ui/pages/build/engine.ts` | BuildRefusedError, BundleResolutionError, applyPostProcessedDeclarations, buildOutputFileName, collectMirrorPayload (+25) |
| `src/ui/pages/build/BuildDashboard.tsx` | BuildDashboard, handleDismissBuilt, handleOpenBuilt, handleOpenDraft, DashboardHeader (+20) |
| `src/ui/pages/install/steps.tsx` | ConfirmStep, ConflictRow, DecisionsStep, DoneStep, ExternalDownloadGuide (+17) |
| `src/ui/pages/build/buildSessionRegistry.ts` | BuildSessionRegistry, getBuildSessionRegistry, ensure, get, makeHooks (+13) |
| `src/ui/pages/curator/CuratorPage.tsx` | CuratorBody, endorseAll, freedByRetiring, refreshUpdates, setEnabledFor (+9) |
| `src/ui/pages/build/buildDiff.test.ts` | findPackages, findPackages, findPackages, findPackages, findPackages (+9) |
| `src/core/draftStorage.ts` | getDraftsRoot, listDrafts, deleteDraft, getAppDataPath, getDraftPath (+6) |
| `src/ui/pages/CollectionsPage.tsx` | CollectionsList, handleContinueInstall, refresh, FailedAttempts, InterruptedInstalls (+6) |

## Entry Points

Start here when exploring this area:

- **`describeEnableChanges`** (Function) — `src/core/curator/bulkToggles.ts:61`
- **`planEnableChanges`** (Function) — `src/core/curator/bulkToggles.ts:34`
- **`archivesFreedByRemoval`** (Function) — `src/core/curator/cleanupPlan.ts:509`
- **`cleanupSubset`** (Function) — `src/core/curator/cleanupPlan.ts:521`
- **`describeEvidence`** (Function) — `src/core/curator/cleanupPlan.ts:274`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `BuildRefusedError` | Class | `src/ui/pages/build/engine.ts` | 1116 |
| `BundleResolutionError` | Class | `src/ui/pages/build/engine.ts` | 583 |
| `describeEnableChanges` | Function | `src/core/curator/bulkToggles.ts` | 61 |
| `planEnableChanges` | Function | `src/core/curator/bulkToggles.ts` | 34 |
| `archivesFreedByRemoval` | Function | `src/core/curator/cleanupPlan.ts` | 509 |
| `cleanupSubset` | Function | `src/core/curator/cleanupPlan.ts` | 521 |
| `describeEvidence` | Function | `src/core/curator/cleanupPlan.ts` | 274 |
| `formatSize` | Function | `src/core/curator/cleanupPlan.ts` | 475 |
| `describeEndorseDuration` | Function | `src/core/curator/endorsePace.ts` | 44 |
| `endorseDurationMs` | Function | `src/core/curator/endorsePace.ts` | 31 |
| `endorseIsLong` | Function | `src/core/curator/endorsePace.ts` | 63 |
| `describeProfileDrift` | Function | `src/core/curator/profileDrift.ts` | 106 |
| `isProfileUnmoved` | Function | `src/core/curator/profileDrift.ts` | 90 |
| `freezeAttribute` | Function | `src/core/curator/readProfile.ts` | 124 |
| `healingBlockedReason` | Function | `src/core/doctor/health.ts` | 777 |
| `overallHealth` | Function | `src/core/doctor/health.ts` | 705 |
| `getDraftsRoot` | Function | `src/core/draftStorage.ts` | 122 |
| `listDrafts` | Function | `src/core/draftStorage.ts` | 163 |
| `describeInstallAttempt` | Function | `src/core/installer/attemptRecord.ts` | 231 |
| `describeFomodModes` | Function | `src/core/installer/fomodReplayMode.ts` | 78 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `PublishedDetailsPanel → GetEventHorizonDir` | cross_community | 10 |
| `Dashboard → GetEventHorizonRoot` | cross_community | 10 |
| `LoadPublishedDetails → GetEventHorizonRoot` | cross_community | 10 |
| `HandleDeletePublished → GetVortexUserDataPath` | cross_community | 10 |
| `PublishedDetailsPanel → GetVortexUserDataPath` | cross_community | 10 |
| `BuildPage → GetVortexUserDataPath` | cross_community | 10 |
| `BuildWizard → GetVortexUserDataPath` | cross_community | 10 |
| `OnRecovered → GetVortexUserDataPath` | cross_community | 10 |
| `WriteEnvironmentSnapshot → GetVortexUserDataPath` | cross_community | 9 |
| `HandleCleanupUnbuilt → GetVortexUserDataPath` | cross_community | 9 |

## How to Explore

1. `context({name: "describeEnableChanges"})` — see callers and callees
2. `query({search_query: "build"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
