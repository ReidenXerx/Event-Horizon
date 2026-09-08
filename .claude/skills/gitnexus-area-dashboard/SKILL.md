---
name: gitnexus-area-dashboard
description: "Skill for the Dashboard area of Event-Horizon. 8 symbols across 2 files."
---

# Dashboard

8 symbols | 2 files | Cohesion: 59%

## When to Use

- Working with code in `src/`
- Understanding how getCollectionsConfigDir, getCollectionsDir, getEventHorizonDir work
- Modifying dashboard-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/paths.ts` | getCollectionsConfigDir, getCollectionsDir, getEventHorizonDir, getEventHorizonRoot |
| `src/ui/pages/dashboard/data.ts` | loadBuiltPackages, loadCuratorConfigs, loadDashboardData, loadReceipts |

## Entry Points

Start here when exploring this area:

- **`getCollectionsConfigDir`** (Function) — `src/core/paths.ts:71`
- **`getCollectionsDir`** (Function) — `src/core/paths.ts:66`
- **`getEventHorizonDir`** (Function) — `src/core/paths.ts:53`
- **`getEventHorizonRoot`** (Function) — `src/core/paths.ts:43`
- **`loadDashboardData`** (Function) — `src/ui/pages/dashboard/data.ts:108`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `getCollectionsConfigDir` | Function | `src/core/paths.ts` | 71 |
| `getCollectionsDir` | Function | `src/core/paths.ts` | 66 |
| `getEventHorizonDir` | Function | `src/core/paths.ts` | 53 |
| `getEventHorizonRoot` | Function | `src/core/paths.ts` | 43 |
| `loadDashboardData` | Function | `src/ui/pages/dashboard/data.ts` | 108 |
| `loadBuiltPackages` | Function | `src/ui/pages/dashboard/data.ts` | 249 |
| `loadCuratorConfigs` | Function | `src/ui/pages/dashboard/data.ts` | 184 |
| `loadReceipts` | Function | `src/ui/pages/dashboard/data.ts` | 156 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `ExecutePromptUserChoice → GetEventHorizonDir` | cross_community | 10 |
| `RunInstallImpl → GetEventHorizonRoot` | cross_community | 10 |
| `ReadZipEntry → GetVortexUserDataPath` | cross_community | 10 |
| `PublishedDetailsPanel → GetEventHorizonDir` | cross_community | 10 |
| `Dashboard → GetEventHorizonRoot` | cross_community | 10 |
| `RunSelfChecks → GetVortexUserDataPath` | cross_community | 10 |
| `Act → GetEventHorizonDir` | cross_community | 10 |
| `LoadPublishedDetails → GetEventHorizonRoot` | cross_community | 10 |
| `HandleDeletePublished → GetVortexUserDataPath` | cross_community | 10 |
| `RunLoadingPipeline → GetEventHorizonRoot` | cross_community | 10 |

## How to Explore

1. `context({name: "getCollectionsConfigDir"})` — see callers and callees
2. `query({search_query: "dashboard"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
