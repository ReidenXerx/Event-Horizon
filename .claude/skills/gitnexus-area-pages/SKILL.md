---
name: gitnexus-area-pages
description: "Skill for the Pages area of Event-Horizon. 170 symbols across 43 files."
---

# Pages

170 symbols | 43 files | Cohesion: 82%

## When to Use

- Working with code in `src/`
- Understanding how describeEnableChanges, planEnableChanges, archivesFreedByRemoval work
- Modifying pages-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/pages/build/BuildPage.tsx` | AvailabilityPanel, BuildDiffCard, BuildWizard, BuildingPanel, DecisionsGate (+17) |
| `src/ui/pages/install/steps.tsx` | ConfirmStep, ConflictRow, DoneStep, ExternalDownloadGuide, FomodModeModal (+16) |
| `src/ui/pages/curator/CuratorPage.tsx` | CuratorBody, endorseAll, freedByRetiring, refreshUpdates, setEnabledFor (+12) |
| `src/ui/pages/CollectionsPage.tsx` | CollectionsList, handleContinueInstall, refresh, DetailTile, EmptyState (+8) |
| `src/ui/pages/HomePage.tsx` | CuratorPanel, Dashboard, DashboardBody, ErrorPanel, FooterRow (+7) |
| `src/ui/pages/ModDiffsPage.tsx` | ChangedModList, ChangedModRow, FieldDiffRow, TierBadge, formatFieldValue (+7) |
| `src/ui/pages/PluginDiffsPage.tsx` | FileSelector, PluginDiffsView, EnabledMismatchList, PluginEntryList, PluginNameCell (+2) |
| `src/ui/pages/AboutPage.tsx` | AboutPage, LinkRow, Stat, handleClick, openExternal |
| `src/core/curator/cleanupPlan.ts` | archivesFreedByRemoval, cleanupSubset, describeEvidence, formatSize |
| `src/ui/pages/doctor/DoctorPanel.tsx` | CheckCard, DoctorPanel, VerdictRing, rank |

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
| `describeEnableChanges` | Function | `src/core/curator/bulkToggles.ts` | 61 |
| `planEnableChanges` | Function | `src/core/curator/bulkToggles.ts` | 34 |
| `archivesFreedByRemoval` | Function | `src/core/curator/cleanupPlan.ts` | 509 |
| `cleanupSubset` | Function | `src/core/curator/cleanupPlan.ts` | 521 |
| `describeEvidence` | Function | `src/core/curator/cleanupPlan.ts` | 274 |
| `formatSize` | Function | `src/core/curator/cleanupPlan.ts` | 475 |
| `describeEndorseDuration` | Function | `src/core/curator/endorsePace.ts` | 44 |
| `endorseDurationMs` | Function | `src/core/curator/endorsePace.ts` | 31 |
| `endorseIsLong` | Function | `src/core/curator/endorsePace.ts` | 63 |
| `freezeAttribute` | Function | `src/core/curator/readProfile.ts` | 124 |
| `healingBlockedReason` | Function | `src/core/doctor/health.ts` | 777 |
| `overallHealth` | Function | `src/core/doctor/health.ts` | 705 |
| `describeInstallAttempt` | Function | `src/core/installer/attemptRecord.ts` | 231 |
| `describeFomodModes` | Function | `src/core/installer/fomodReplayMode.ts` | 78 |
| `s` | Function | `src/core/installer/fomodReplayMode.ts` | 84 |
| `mustAskReplayMode` | Function | `src/core/installer/fomodReplayMode.ts` | 183 |
| `Button` | Function | `src/ui/components/Button.tsx` | 31 |
| `Card` | Function | `src/ui/components/Card.tsx` | 31 |
| `EventHorizonMark` | Function | `src/ui/components/EventHorizonMark.tsx` | 51 |
| `HashingCard` | Function | `src/ui/components/HashingCard.tsx` | 49 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Dashboard → GetEventHorizonRoot` | cross_community | 10 |
| `BuildWizard → GetVortexUserDataPath` | cross_community | 10 |
| `BuildDiffCard → ToPosix` | cross_community | 9 |
| `HomePage → Truncate` | cross_community | 8 |
| `Dashboard → GetVortexUserDataPath` | cross_community | 8 |
| `RouteOutlet → Fail` | cross_community | 7 |
| `RouteOutlet → Ok` | cross_community | 7 |
| `RouteOutlet → BelongsToGame` | cross_community | 7 |
| `EndorseAll → GetVortexUserDataPath` | cross_community | 7 |
| `RefreshUpdates → GetVortexUserDataPath` | cross_community | 7 |

## How to Explore

1. `context({name: "describeEnableChanges"})` — see callers and callees
2. `query({search_query: "pages"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
