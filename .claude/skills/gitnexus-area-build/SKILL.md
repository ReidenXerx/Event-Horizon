---
name: gitnexus-area-build
description: "Skill for the Build area of Event-Horizon. 521 symbols across 117 files."
---

# Build

521 symbols | 117 files | Cohesion: 83%

## When to Use

- Working with code in `src/`
- Understanding how compareVersionStrings, entriesSince, archivesFreedByRemoval work
- Modifying build-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/pages/build/BuildPage.tsx` | AvailabilityPanel, BuildChangelog, BuildDiffCard, BuildRulesScopeSummary, BuildWizard (+57) |
| `src/ui/pages/build/buildSession.ts` | cancelLoading, cancelRecovering, getState, subscribe, buildProgress (+30) |
| `src/ui/pages/install/steps.tsx` | ConfirmStep, ConflictRow, checkPickedFile, handlePickFile, DecisionsStep (+25) |
| `src/ui/pages/build/BuildDashboard.tsx` | BuildDashboard, handleDismissBuilt, handleOpenBuilt, handleOpenDraft, DashboardHeader (+20) |
| `src/ui/pages/build/engine.ts` | validateCuratorInput, describeMissingArchives, downloadedFromNexus, findUnidentifiedMods, isBundled (+17) |
| `src/ui/pages/build/buildSessionRegistry.ts` | BuildSessionRegistry, getBuildSessionRegistry, get, notifyStateChanged, emit (+13) |
| `src/ui/pages/build/NexusCollectionUpload.tsx` | Body, Choose, NexusCollectionUpload, close, Reasons (+12) |
| `src/ui/pages/build/buildDiff.test.ts` | findPackages, findPackages, findPackages, findPackages, findPackages (+9) |
| `src/core/build/nexusAvailability.ts` | checkNexusAvailability, isAbort, categoryOf, classifyFile, currentMainFile (+6) |
| `src/ui/components/Field.tsx` | Checkbox, Chip, ChoiceCard, ChoiceControl, Field (+5) |

## Entry Points

Start here when exploring this area:

- **`compareVersionStrings`** (Function) — `src/core/changelog/changelog.ts:826`
- **`entriesSince`** (Function) — `src/core/changelog/changelog.ts:862`
- **`archivesFreedByRemoval`** (Function) — `src/core/curator/cleanupPlan.ts:509`
- **`cleanupSubset`** (Function) — `src/core/curator/cleanupPlan.ts:521`
- **`describeEvidence`** (Function) — `src/core/curator/cleanupPlan.ts:274`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `compareVersionStrings` | Function | `src/core/changelog/changelog.ts` | 826 |
| `entriesSince` | Function | `src/core/changelog/changelog.ts` | 862 |
| `archivesFreedByRemoval` | Function | `src/core/curator/cleanupPlan.ts` | 509 |
| `cleanupSubset` | Function | `src/core/curator/cleanupPlan.ts` | 521 |
| `describeEvidence` | Function | `src/core/curator/cleanupPlan.ts` | 274 |
| `formatSize` | Function | `src/core/curator/cleanupPlan.ts` | 475 |
| `describeProfileDrift` | Function | `src/core/curator/profileDrift.ts` | 106 |
| `isProfileUnmoved` | Function | `src/core/curator/profileDrift.ts` | 90 |
| `profilesEnabling` | Function | `src/core/curator/profilesEnabling.ts` | 44 |
| `doctorLightFlagBaseline` | Function | `src/core/doctor/health.ts` | 188 |
| `overallHealth` | Function | `src/core/doctor/health.ts` | 873 |
| `canReapply` | Function | `src/core/doctor/loadOrderStatus.ts` | 254 |
| `pickDoctorReceipt` | Function | `src/core/doctor/pickReceipt.ts` | 62 |
| `toHealthView` | Function | `src/core/doctor/receiptView.ts` | 21 |
| `describeInstallAttempt` | Function | `src/core/installer/attemptRecord.ts` | 231 |
| `describeFomodModes` | Function | `src/core/installer/fomodReplayMode.ts` | 78 |
| `s` | Function | `src/core/installer/fomodReplayMode.ts` | 84 |
| `mustAskReplayMode` | Function | `src/core/installer/fomodReplayMode.ts` | 183 |
| `countKinds` | Function | `src/core/manifest/unexplainedFiles.ts` | 175 |
| `describeUnexplainedFile` | Function | `src/core/manifest/unexplainedFiles.ts` | 153 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `PublishedDetailsPanel → ResolveLogFile` | cross_community | 10 |
| `PublishedDetailsPanel → Truncate` | cross_community | 10 |
| `LoadPublishedDetails → GetEventHorizonDir` | cross_community | 10 |
| `NexusUploadModal → GetEventHorizonRoot` | cross_community | 10 |
| `LoadPublishedDetails → ResolveLogFile` | cross_community | 10 |
| `HandleDeletePublished → GetVortexUserDataPath` | cross_community | 10 |
| `DashboardPage → ResolveLogFile` | cross_community | 10 |
| `BuildPage → GetVortexUserDataPath` | cross_community | 10 |
| `BuildWizard → GetVortexUserDataPath` | cross_community | 10 |
| `OnRecovered → GetVortexUserDataPath` | cross_community | 10 |

## How to Explore

1. `context({name: "compareVersionStrings"})` — see callers and callees
2. `query({search_query: "build"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
