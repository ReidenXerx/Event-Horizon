---
name: gitnexus-area-dashboard
description: "Skill for the Dashboard area of Event-Horizon. 30 symbols across 8 files."
---

# Dashboard

30 symbols | 8 files | Cohesion: 65%

## When to Use

- Working with code in `src/`
- Understanding how packageFormatOf, getCollectionsConfigDir, getCollectionsDir work
- Modifying dashboard-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/pages/dashboard/useDashboardView.ts` | buildLabel, heroCandidates, toViewModel, heroOf, artFor (+4) |
| `src/ui/pages/dashboard/DashboardView.tsx` | CompositionCard, Hero, Stat, describeNativePlugins, n (+2) |
| `src/ui/pages/dashboard/data.ts` | loadBuiltPackages, loadCuratorConfigs, loadDashboardData, loadReceipts, installedAtMs |
| `src/ui/pages/dashboard/summary.ts` | collectionFigures, healthRollup, since |
| `src/core/paths/appDataPaths.ts` | getCollectionsConfigDir, getCollectionsDir |
| `src/ui/components/charts.tsx` | Ring, StackBar |
| `src/core/manifest/packageFileName.ts` | packageFormatOf |
| `src/ui/pages/build/engine.ts` | recordPostProcessingDecision |

## Entry Points

Start here when exploring this area:

- **`packageFormatOf`** (Function) — `src/core/manifest/packageFileName.ts:49`
- **`getCollectionsConfigDir`** (Function) — `src/core/paths/appDataPaths.ts:71`
- **`getCollectionsDir`** (Function) — `src/core/paths/appDataPaths.ts:66`
- **`recordPostProcessingDecision`** (Function) — `src/ui/pages/build/engine.ts:391`
- **`loadDashboardData`** (Function) — `src/ui/pages/dashboard/data.ts:109`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `packageFormatOf` | Function | `src/core/manifest/packageFileName.ts` | 49 |
| `getCollectionsConfigDir` | Function | `src/core/paths/appDataPaths.ts` | 71 |
| `getCollectionsDir` | Function | `src/core/paths/appDataPaths.ts` | 66 |
| `recordPostProcessingDecision` | Function | `src/ui/pages/build/engine.ts` | 391 |
| `loadDashboardData` | Function | `src/ui/pages/dashboard/data.ts` | 109 |
| `Ring` | Function | `src/ui/components/charts.tsx` | 58 |
| `StackBar` | Function | `src/ui/components/charts.tsx` | 196 |
| `collectionFigures` | Function | `src/ui/pages/dashboard/summary.ts` | 100 |
| `healthRollup` | Function | `src/ui/pages/dashboard/summary.ts` | 38 |
| `since` | Function | `src/ui/pages/dashboard/summary.ts` | 151 |
| `heroCandidates` | Function | `src/ui/pages/dashboard/useDashboardView.ts` | 36 |
| `toViewModel` | Function | `src/ui/pages/dashboard/useDashboardView.ts` | 181 |
| `heroOf` | Function | `src/ui/pages/dashboard/useDashboardView.ts` | 200 |
| `healthOf` | Function | `src/ui/pages/dashboard/useDashboardView.ts` | 81 |
| `loadDashboardSources` | Function | `src/ui/pages/dashboard/useDashboardView.ts` | 270 |
| `useDashboardView` | Function | `src/ui/pages/dashboard/useDashboardView.ts` | 332 |
| `loadBuiltPackages` | Function | `src/ui/pages/dashboard/data.ts` | 261 |
| `loadCuratorConfigs` | Function | `src/ui/pages/dashboard/data.ts` | 196 |
| `loadReceipts` | Function | `src/ui/pages/dashboard/data.ts` | 157 |
| `installedAtMs` | Function | `src/ui/pages/dashboard/data.ts` | 184 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `DashboardPage → ResolveLogFile` | cross_community | 10 |
| `LoadDashboardSources → GetEventHorizonRoot` | cross_community | 10 |
| `UseDashboardView → GetEventHorizonDir` | cross_community | 10 |
| `LoadDashboardData → GetVortexUserDataPath` | cross_community | 10 |
| `DashboardPage → Truncate` | cross_community | 9 |
| `RecordPostProcessingDecision → GetVortexUserDataPath` | cross_community | 9 |
| `DashboardPage → Fail` | cross_community | 7 |
| `DashboardPage → Ok` | cross_community | 7 |
| `DashboardPage → ProfileId` | cross_community | 7 |
| `DashboardPage → BelongsToGame` | cross_community | 7 |

## How to Explore

1. `context({name: "packageFormatOf"})` — see callers and callees
2. `query({search_query: "dashboard"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
