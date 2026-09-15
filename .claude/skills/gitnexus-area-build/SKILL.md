---
name: gitnexus-area-build
description: "Skill for the Build area of Event-Horizon. 430 symbols across 96 files."
---

# Build

430 symbols | 96 files | Cohesion: 83%

## When to Use

- Working with code in `src/`
- Understanding how describeEvidence, describeProfileDrift, isProfileUnmoved work
- Modifying build-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/pages/build/BuildPage.tsx` | AvailabilityPanel, BuildDiffCard, BuildRulesScopeSummary, BuildWizard, BuildingPanel (+47) |
| `src/ui/pages/build/buildSession.ts` | cancelLoading, cancelRecovering, getState, subscribe, buildProgress (+30) |
| `src/ui/pages/install/steps.tsx` | ConfirmStep, ConflictRow, DecisionsStep, DoneStep, ExternalDownloadGuide (+20) |
| `src/ui/pages/build/BuildDashboard.tsx` | BuildDashboard, handleDismissBuilt, handleOpenBuilt, handleOpenDraft, DashboardHeader (+19) |
| `src/ui/pages/build/engine.ts` | validateCuratorInput, downloadedFromNexus, findUnidentifiedMods, isExternal, isExternal (+14) |
| `src/ui/pages/build/buildSessionRegistry.ts` | BuildSessionRegistry, getBuildSessionRegistry, ensure, get, makeHooks (+13) |
| `src/ui/pages/build/buildDiff.test.ts` | findPackages, findPackages, findPackages, findPackages, findPackages (+9) |
| `src/core/draftStorage.ts` | getDraftsRoot, listDrafts, deleteDraft, getDraftPath, isPlainObject (+6) |
| `src/ui/pages/HomePage.tsx` | CuratorPanel, Dashboard, DashboardBody, ErrorPanel, FooterRow (+6) |
| `src/core/build/nexusAvailability.ts` | categoryOf, checkNexusAvailability, classifyFile, currentMainFile, fileIdOf (+6) |

## Entry Points

Start here when exploring this area:

- **`describeEvidence`** (Function) — `src/core/curator/cleanupPlan.ts:274`
- **`describeProfileDrift`** (Function) — `src/core/curator/profileDrift.ts:106`
- **`isProfileUnmoved`** (Function) — `src/core/curator/profileDrift.ts:90`
- **`doctorLightFlagBaseline`** (Function) — `src/core/doctor/health.ts:188`
- **`overallHealth`** (Function) — `src/core/doctor/health.ts:861`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
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
| `readPluginDiffReport` | Function | `src/core/pluginDiffStorage.ts` | 95 |
| `Button` | Function | `src/ui/components/Button.tsx` | 38 |

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
| `WriteEnvironmentSnapshot → GetVortexUserDataPath` | cross_community | 9 |

## How to Explore

1. `context({name: "describeEvidence"})` — see callers and callees
2. `query({search_query: "build"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
