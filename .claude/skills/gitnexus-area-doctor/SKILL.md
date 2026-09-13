---
name: gitnexus-area-doctor
description: "Skill for the Doctor area of Event-Horizon. 70 symbols across 16 files."
---

# Doctor

70 symbols | 16 files | Cohesion: 76%

## When to Use

- Working with code in `src/`
- Understanding how livePluginList, readPluginList, activeContextFromState work
- Modifying doctor-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/doctor/loadOrderStatus.ts` | activeContextFromState, assessReceiptOrder, baselineOf, currentOrderFromState, installedAtMs (+14) |
| `src/core/doctor/loadOrderWatcher.ts` | assessActiveOrder, readReceipts, reapplyOwned, startLoadOrderWatcher, dismiss (+6) |
| `src/core/doctor/loadOrderWatcher.test.ts` | on, receipt, on, fire, reorder (+1) |
| `src/core/doctor/health.ts` | countCheck, detailList, evaluateHealth, healingBlockedReason, assessObservedLoadOrder |
| `src/core/doctor/gather.ts` | countModRules, gatherObservations, readEnabledModIds, readInstalledModIds, readProfileIds |
| `src/core/doctor/health.test.ts` | drifted, observations, healthy, on |
| `src/ui/pages/doctor/LoadOrderBadge.test.ts` | on, receipt, getState, stateOn |
| `src/ui/pages/doctor/EnvironmentTools.tsx` | saveLogs, saveSnapshot, formatBytes |
| `src/core/curator/pluginPool.ts` | livePluginList, readPluginList |
| `src/ui/pages/doctor/LoadOrderBadge.tsx` | status, badgePill |

## Entry Points

Start here when exploring this area:

- **`livePluginList`** (Function) — `src/core/curator/pluginPool.ts:95`
- **`readPluginList`** (Function) — `src/core/curator/pluginPool.ts:51`
- **`activeContextFromState`** (Function) — `src/core/doctor/loadOrderStatus.ts:95`
- **`assessReceiptOrder`** (Function) — `src/core/doctor/loadOrderStatus.ts:232`
- **`baselineOf`** (Function) — `src/core/doctor/loadOrderStatus.ts:110`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `livePluginList` | Function | `src/core/curator/pluginPool.ts` | 95 |
| `readPluginList` | Function | `src/core/curator/pluginPool.ts` | 51 |
| `activeContextFromState` | Function | `src/core/doctor/loadOrderStatus.ts` | 95 |
| `assessReceiptOrder` | Function | `src/core/doctor/loadOrderStatus.ts` | 232 |
| `baselineOf` | Function | `src/core/doctor/loadOrderStatus.ts` | 110 |
| `currentOrderFromState` | Function | `src/core/doctor/loadOrderStatus.ts` | 174 |
| `nativeNamesFromState` | Function | `src/core/doctor/loadOrderStatus.ts` | 181 |
| `orderOwner` | Function | `src/core/doctor/loadOrderStatus.ts` | 140 |
| `pinnedAnOrder` | Function | `src/core/doctor/loadOrderStatus.ts` | 123 |
| `receiptLabel` | Function | `src/core/doctor/loadOrderStatus.ts` | 154 |
| `skippedPluginOrder` | Function | `src/core/doctor/loadOrderStatus.ts` | 118 |
| `standingOf` | Function | `src/core/doctor/loadOrderStatus.ts` | 159 |
| `assessActiveOrder` | Function | `src/core/doctor/loadOrderWatcher.ts` | 102 |
| `status` | Function | `src/ui/pages/doctor/LoadOrderBadge.tsx` | 105 |
| `evaluateHealth` | Function | `src/core/doctor/health.ts` | 318 |
| `curatorPluginsOff` | Function | `src/core/doctor/loadOrderStatus.ts` | 362 |
| `describeLoadOrder` | Function | `src/core/doctor/loadOrderStatus.ts` | 276 |
| `badgePill` | Function | `src/ui/pages/doctor/LoadOrderBadge.tsx` | 61 |
| `startLoadOrderWatcher` | Function | `src/core/doctor/loadOrderWatcher.ts` | 205 |
| `dismiss` | Function | `src/core/doctor/loadOrderWatcher.ts` | 217 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `StartLoadOrderWatcher → GetVortexUserDataPath` | cross_community | 7 |
| `Look → BaselineOf` | cross_community | 5 |
| `Look → SkippedPluginOrder` | cross_community | 5 |
| `Look → InstalledAtMs` | cross_community | 4 |
| `Look → Key` | cross_community | 3 |
| `Look → ActiveContextFromState` | cross_community | 3 |
| `Look → ReadReceipts` | cross_community | 3 |
| `LoadOrderCard → CuratorPluginsOff` | cross_community | 3 |
| `StartLoadOrderWatcher → EHRuntime` | cross_community | 3 |
| `Look → EHRuntime` | cross_community | 3 |

## How to Explore

1. `context({name: "livePluginList"})` — see callers and callees
2. `query({search_query: "doctor"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
