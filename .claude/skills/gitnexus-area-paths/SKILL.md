---
name: gitnexus-area-paths
description: "Skill for the Paths area of Event-Horizon. 13 symbols across 5 files."
---

# Paths

13 symbols | 5 files | Cohesion: 60%

## When to Use

- Working with code in `src/`
- Understanding how getCollectionsConfigDir, getCollectionsDir, getEventHorizonDir work
- Modifying paths-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/paths/appDataPaths.ts` | getCollectionsConfigDir, getCollectionsDir, getEventHorizonDir, getEventHorizonRoot |
| `src/ui/pages/dashboard/data.ts` | loadBuiltPackages, loadCuratorConfigs, loadDashboardData, loadReceipts |
| `src/core/paths/modPath.ts` | basenameOf, extensionOf, segmentsOf |
| `src/core/manifest/storeCompatibility.ts` | isScriptExtenderPlugin |
| `src/core/volatileFiles.ts` | volatileReason |

## Entry Points

Start here when exploring this area:

- **`getCollectionsConfigDir`** (Function) — `src/core/paths/appDataPaths.ts:71`
- **`getCollectionsDir`** (Function) — `src/core/paths/appDataPaths.ts:66`
- **`getEventHorizonDir`** (Function) — `src/core/paths/appDataPaths.ts:53`
- **`getEventHorizonRoot`** (Function) — `src/core/paths/appDataPaths.ts:43`
- **`loadDashboardData`** (Function) — `src/ui/pages/dashboard/data.ts:108`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `getCollectionsConfigDir` | Function | `src/core/paths/appDataPaths.ts` | 71 |
| `getCollectionsDir` | Function | `src/core/paths/appDataPaths.ts` | 66 |
| `getEventHorizonDir` | Function | `src/core/paths/appDataPaths.ts` | 53 |
| `getEventHorizonRoot` | Function | `src/core/paths/appDataPaths.ts` | 43 |
| `loadDashboardData` | Function | `src/ui/pages/dashboard/data.ts` | 108 |
| `isScriptExtenderPlugin` | Function | `src/core/manifest/storeCompatibility.ts` | 83 |
| `basenameOf` | Function | `src/core/paths/modPath.ts` | 56 |
| `extensionOf` | Function | `src/core/paths/modPath.ts` | 79 |
| `segmentsOf` | Function | `src/core/paths/modPath.ts` | 49 |
| `volatileReason` | Function | `src/core/volatileFiles.ts` | 93 |
| `loadBuiltPackages` | Function | `src/ui/pages/dashboard/data.ts` | 249 |
| `loadCuratorConfigs` | Function | `src/ui/pages/dashboard/data.ts` | 184 |
| `loadReceipts` | Function | `src/ui/pages/dashboard/data.ts` | 156 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `InstallNexusViaApi → GetEventHorizonRoot` | cross_community | 10 |
| `ExecutePromptUserChoice → GetEventHorizonDir` | cross_community | 10 |
| `ReadZipEntry → GetVortexUserDataPath` | cross_community | 10 |
| `RunInstallImpl → GetEventHorizonRoot` | cross_community | 10 |
| `PublishedDetailsPanel → GetEventHorizonDir` | cross_community | 10 |
| `RunSelfChecks → GetVortexUserDataPath` | cross_community | 10 |
| `Dashboard → GetEventHorizonRoot` | cross_community | 10 |
| `Act → GetEventHorizonDir` | cross_community | 10 |
| `SelfCheckMod → GetVortexUserDataPath` | cross_community | 10 |
| `LoadPublishedDetails → GetEventHorizonRoot` | cross_community | 10 |

## How to Explore

1. `context({name: "getCollectionsConfigDir"})` — see callers and callees
2. `query({search_query: "paths"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
