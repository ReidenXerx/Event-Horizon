---
name: gitnexus-area-curator
description: "Skill for the Curator area of Event-Horizon. 458 symbols across 109 files."
---

# Curator

458 symbols | 109 files | Cohesion: 77%

## When to Use

- Working with code in `src/`
- Understanding how archivesFreedByRemoval, cleanupSubset, describeEvidence work
- Modifying curator-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/pages/curator/useCuratorActions.ts` | removeMod, openPageFor, start, refreshUpdates, removeMods (+33) |
| `src/ui/pages/curator/CuratorPage.tsx` | CuratorBody, onSelect, setNote, toggleView, CuratorPage (+28) |
| `src/ui/pages/build/BuildPage.tsx` | AvailabilityPanel, BuildWizard, BuildingPanel, DecisionsGate, DraftRestoredBanner (+19) |
| `src/core/curator/requirements.ts` | dependantsOf, disabledProvidersFor, fetchRequirements, pickProvider, parseGameList (+17) |
| `src/ui/pages/curator/DiskCleanupView.tsx` | DiskCleanupView, freedByRetiring, run, num, render (+13) |
| `src/ui/pages/install/steps.tsx` | ConfirmStep, DoneStep, ExternalDownloadGuide, FomodModeModal, LoadingStep (+8) |
| `src/core/curator/cleanupPlan.ts` | archivesFreedByRemoval, cleanupSubset, describeEvidence, formatSize, findSupersededMods (+7) |
| `src/ui/pages/curator/PluginsView.tsx` | PluginsView, render, render, render, num (+7) |
| `src/core/curator/profileActions.ts` | identityCandidates, findDuplicates, findEndorsable, findFrozen, summarizeProfile (+7) |
| `src/ui/components/Field.tsx` | Checkbox, Chip, ChoiceCard, ChoiceControl, Field (+5) |

## Entry Points

Start here when exploring this area:

- **`archivesFreedByRemoval`** (Function) — `src/core/curator/cleanupPlan.ts:509`
- **`cleanupSubset`** (Function) — `src/core/curator/cleanupPlan.ts:521`
- **`describeEvidence`** (Function) — `src/core/curator/cleanupPlan.ts:274`
- **`formatSize`** (Function) — `src/core/curator/cleanupPlan.ts:475`
- **`describeMastersCell`** (Function) — `src/core/curator/pluginView.ts:167`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `UpdateTimeout` | Class | `src/core/curator/updateOneMod.ts` | 74 |
| `CannotReinstall` | Class | `src/core/curator/reinstallMod.ts` | 45 |
| `archivesFreedByRemoval` | Function | `src/core/curator/cleanupPlan.ts` | 509 |
| `cleanupSubset` | Function | `src/core/curator/cleanupPlan.ts` | 521 |
| `describeEvidence` | Function | `src/core/curator/cleanupPlan.ts` | 274 |
| `formatSize` | Function | `src/core/curator/cleanupPlan.ts` | 475 |
| `describeMastersCell` | Function | `src/core/curator/pluginView.ts` | 167 |
| `describePluginKind` | Function | `src/core/curator/pluginView.ts` | 177 |
| `describeProfileDrift` | Function | `src/core/curator/profileDrift.ts` | 106 |
| `isProfileUnmoved` | Function | `src/core/curator/profileDrift.ts` | 90 |
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
