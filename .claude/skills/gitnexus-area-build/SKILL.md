---
name: gitnexus-area-build
description: "Skill for the Build area of Event-Horizon. 457 symbols across 100 files."
---

# Build

457 symbols | 100 files | Cohesion: 84%

## When to Use

- Working with code in `src/`
- Understanding how compareVersionStrings, entriesSince, describeEvidence work
- Modifying build-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/pages/build/BuildPage.tsx` | AvailabilityPanel, BuildChangelog, BuildDiffCard, BuildWizard, BuildingPanel (+57) |
| `src/ui/pages/build/buildSession.ts` | cancelLoading, cancelRecovering, getState, subscribe, buildProgress (+30) |
| `src/ui/pages/build/BuildDashboard.tsx` | BuildDashboard, handleDismissBuilt, handleOpenBuilt, handleOpenDraft, DashboardHeader (+19) |
| `src/ui/pages/install/steps.tsx` | ConfirmStep, ConflictRow, DecisionsStep, DoNotInterfereModal, DoneStep (+19) |
| `src/ui/pages/build/engine.ts` | validateCuratorInput, downloadedFromNexus, findUnidentifiedMods, isExternal, isExternal (+14) |
| `src/ui/pages/build/buildSessionRegistry.ts` | BuildSessionRegistry, getBuildSessionRegistry, ensure, get, makeHooks (+13) |
| `src/ui/pages/build/buildDiff.test.ts` | findPackages, findPackages, findPackages, findPackages, findPackages (+9) |
| `src/core/draftStorage.ts` | getDraftsRoot, listDrafts, deleteDraft, getDraftPath, isPlainObject (+6) |
| `src/ui/pages/HomePage.tsx` | CuratorPanel, Dashboard, DashboardBody, ErrorPanel, FooterRow (+6) |
| `src/core/build/nexusAvailability.ts` | categoryOf, checkNexusAvailability, classifyFile, currentMainFile, fileIdOf (+6) |

## Entry Points

Start here when exploring this area:

- **`compareVersionStrings`** (Function) — `src/core/changelog/changelog.ts:826`
- **`entriesSince`** (Function) — `src/core/changelog/changelog.ts:862`
- **`describeEvidence`** (Function) — `src/core/curator/cleanupPlan.ts:274`
- **`describeProfileDrift`** (Function) — `src/core/curator/profileDrift.ts:106`
- **`isProfileUnmoved`** (Function) — `src/core/curator/profileDrift.ts:90`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `compareVersionStrings` | Function | `src/core/changelog/changelog.ts` | 826 |
| `entriesSince` | Function | `src/core/changelog/changelog.ts` | 862 |
| `describeEvidence` | Function | `src/core/curator/cleanupPlan.ts` | 274 |
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
| `describeUnexplainedFile` | Function | `src/core/manifest/unexplainedFiles.ts` | 153 |
| `formatBytes` | Function | `src/core/manifest/unexplainedFiles.ts` | 139 |
| `listModDiffFiles` | Function | `src/core/modDiffStorage.ts` | 60 |
| `readModDiffReport` | Function | `src/core/modDiffStorage.ts` | 95 |
| `listPluginDiffFiles` | Function | `src/core/pluginDiffStorage.ts` | 60 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `PublishedDetailsPanel → ResolveLogFile` | cross_community | 10 |
| `PublishedDetailsPanel → Truncate` | cross_community | 10 |
| `LoadPublishedDetails → GetEventHorizonDir` | cross_community | 10 |
| `Dashboard → GetEventHorizonRoot` | cross_community | 10 |
| `LoadPublishedDetails → ResolveLogFile` | cross_community | 10 |
| `HandleDeletePublished → GetVortexUserDataPath` | cross_community | 10 |
| `BuildPage → GetVortexUserDataPath` | cross_community | 10 |
| `BuildWizard → GetVortexUserDataPath` | cross_community | 10 |
| `OnRecovered → GetVortexUserDataPath` | cross_community | 10 |
| `PrepareChangelog → ToPosix` | cross_community | 9 |

## How to Explore

1. `context({name: "compareVersionStrings"})` — see callers and callees
2. `query({search_query: "build"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
