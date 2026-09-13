---
name: gitnexus-area-paths
description: "Skill for the Paths area of Event-Horizon. 16 symbols across 8 files."
---

# Paths

16 symbols | 8 files | Cohesion: 52%

## When to Use

- Working with code in `src/`
- Understanding how logBundleDirs, getInstallLedgerDir, listReceipts work
- Modifying paths-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/paths/appDataPaths.ts` | getCollectionsConfigDir, getCollectionsDir, getEventHorizonDir, getEventHorizonRoot |
| `src/ui/pages/dashboard/data.ts` | loadBuiltPackages, loadCuratorConfigs, loadDashboardData, loadReceipts |
| `src/core/installLedger.ts` | getInstallLedgerDir, listReceipts |
| `src/core/paths/modPath.ts` | basenameOf, extensionOf |
| `src/core/diagnostics/logBundle.ts` | logBundleDirs |
| `src/core/environment/winePrefix.ts` | pick |
| `src/core/manifest/storeCompatibility.ts` | isScriptExtenderPlugin |
| `src/ui/play/PlayGameButton.tsx` | play |

## Entry Points

Start here when exploring this area:

- **`logBundleDirs`** (Function) — `src/core/diagnostics/logBundle.ts:45`
- **`getInstallLedgerDir`** (Function) — `src/core/installLedger.ts:142`
- **`listReceipts`** (Function) — `src/core/installLedger.ts:510`
- **`getCollectionsConfigDir`** (Function) — `src/core/paths/appDataPaths.ts:71`
- **`getCollectionsDir`** (Function) — `src/core/paths/appDataPaths.ts:66`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `logBundleDirs` | Function | `src/core/diagnostics/logBundle.ts` | 45 |
| `getInstallLedgerDir` | Function | `src/core/installLedger.ts` | 142 |
| `listReceipts` | Function | `src/core/installLedger.ts` | 510 |
| `getCollectionsConfigDir` | Function | `src/core/paths/appDataPaths.ts` | 71 |
| `getCollectionsDir` | Function | `src/core/paths/appDataPaths.ts` | 66 |
| `getEventHorizonDir` | Function | `src/core/paths/appDataPaths.ts` | 53 |
| `getEventHorizonRoot` | Function | `src/core/paths/appDataPaths.ts` | 43 |
| `loadDashboardData` | Function | `src/ui/pages/dashboard/data.ts` | 108 |
| `pick` | Function | `src/core/environment/winePrefix.ts` | 613 |
| `isScriptExtenderPlugin` | Function | `src/core/manifest/storeCompatibility.ts` | 83 |
| `basenameOf` | Function | `src/core/paths/modPath.ts` | 56 |
| `extensionOf` | Function | `src/core/paths/modPath.ts` | 79 |
| `play` | Function | `src/ui/play/PlayGameButton.tsx` | 29 |
| `loadBuiltPackages` | Function | `src/ui/pages/dashboard/data.ts` | 249 |
| `loadCuratorConfigs` | Function | `src/ui/pages/dashboard/data.ts` | 184 |
| `loadReceipts` | Function | `src/ui/pages/dashboard/data.ts` | 156 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `LaunchGame → GetVortexUserDataPath` | cross_community | 10 |
| `RunInstallImpl → GetEventHorizonRoot` | cross_community | 10 |
| `PublishedDetailsPanel → GetEventHorizonDir` | cross_community | 10 |
| `RunSelfChecks → GetVortexUserDataPath` | cross_community | 10 |
| `Dashboard → GetEventHorizonRoot` | cross_community | 10 |
| `InstallDownloads → GetEventHorizonDir` | cross_community | 10 |
| `HandleDeletePublished → GetVortexUserDataPath` | cross_community | 10 |
| `LoadPublishedDetails → GetEventHorizonRoot` | cross_community | 10 |
| `Act → GetEventHorizonDir` | cross_community | 10 |
| `PublishedDetailsPanel → GetVortexUserDataPath` | cross_community | 10 |

## How to Explore

1. `context({name: "logBundleDirs"})` — see callers and callees
2. `query({search_query: "paths"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
