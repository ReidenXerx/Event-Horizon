---
name: gitnexus-area-doctor
description: "Skill for the Doctor area of Event-Horizon. 52 symbols across 16 files."
---

# Doctor

52 symbols | 16 files | Cohesion: 76%

## When to Use

- Working with code in `src/`
- Understanding how readPluginList, healingBlockedReason, assessLoadOrder work
- Modifying doctor-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/doctor/loadOrderStatus.ts` | assessLoadOrder, currentOrderFromState, describeLoadOrder, driftSignature, key (+2) |
| `src/core/doctor/loadOrderWatcher.ts` | activeGameIdOf, assessActiveGame, baselineOf, latestReceiptWithOrder, startLoadOrderWatcher (+2) |
| `src/core/doctor/health.ts` | healingBlockedReason, countCheck, detailList, evaluateHealth, overallHealth |
| `src/core/doctor/gather.ts` | countModRules, gatherObservations, readEnabledModIds, readInstalledModIds, readProfileIds |
| `src/ui/pages/doctor/DoctorPage.tsx` | CollectionDoctor, toHealthView, heal, unavailableHeal |
| `src/ui/pages/doctor/DoctorPanel.tsx` | DoctorPanel, VerdictRing, rank, textToneClass |
| `src/core/doctor/health.test.ts` | drifted, observations, healthy, on |
| `src/core/doctor/runHeal.ts` | healImpl, resolveModMaps, runHeal |
| `src/ui/pages/doctor/EnvironmentTools.tsx` | saveLogs, saveSnapshot, formatBytes |
| `src/core/doctor/heal.ts` | describeHeal, healNeedsManifest |

## Entry Points

Start here when exploring this area:

- **`readPluginList`** (Function) — `src/core/curator/pluginPool.ts:51`
- **`healingBlockedReason`** (Function) — `src/core/doctor/health.ts:790`
- **`assessLoadOrder`** (Function) — `src/core/doctor/loadOrderStatus.ts:60`
- **`currentOrderFromState`** (Function) — `src/core/doctor/loadOrderStatus.ts:45`
- **`describeLoadOrder`** (Function) — `src/core/doctor/loadOrderStatus.ts:92`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `readPluginList` | Function | `src/core/curator/pluginPool.ts` | 51 |
| `healingBlockedReason` | Function | `src/core/doctor/health.ts` | 790 |
| `assessLoadOrder` | Function | `src/core/doctor/loadOrderStatus.ts` | 60 |
| `currentOrderFromState` | Function | `src/core/doctor/loadOrderStatus.ts` | 45 |
| `describeLoadOrder` | Function | `src/core/doctor/loadOrderStatus.ts` | 92 |
| `driftSignature` | Function | `src/core/doctor/loadOrderStatus.ts` | 84 |
| `nativeNamesFromState` | Function | `src/core/doctor/loadOrderStatus.ts` | 52 |
| `previewRepin` | Function | `src/core/doctor/loadOrderStatus.ts` | 150 |
| `assessActiveGame` | Function | `src/core/doctor/loadOrderWatcher.ts` | 60 |
| `baselineOf` | Function | `src/core/doctor/loadOrderWatcher.ts` | 55 |
| `latestReceiptWithOrder` | Function | `src/core/doctor/loadOrderWatcher.ts` | 43 |
| `startLoadOrderWatcher` | Function | `src/core/doctor/loadOrderWatcher.ts` | 100 |
| `look` | Function | `src/core/doctor/loadOrderWatcher.ts` | 107 |
| `schedule` | Function | `src/core/doctor/loadOrderWatcher.ts` | 172 |
| `status` | Function | `src/ui/pages/doctor/LoadOrderBadge.tsx` | 20 |
| `describeHeal` | Function | `src/core/doctor/heal.ts` | 66 |
| `runHeal` | Function | `src/core/doctor/runHeal.ts` | 98 |
| `nexusModIdOfCompareKey` | Function | `src/core/identity/compareKey.ts` | 96 |
| `parseCompareKey` | Function | `src/core/identity/compareKey.ts` | 79 |
| `gatherObservations` | Function | `src/core/doctor/gather.ts` | 115 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `StartLoadOrderWatcher → Key` | cross_community | 7 |
| `StartLoadOrderWatcher → GetVortexUserDataPath` | cross_community | 7 |
| `StartLoadOrderWatcher → Key` | intra_community | 6 |
| `Heal → EHRuntime` | cross_community | 6 |
| `Heal → Notify` | cross_community | 6 |
| `StartLoadOrderWatcher → ActiveGameIdOf` | intra_community | 5 |
| `StartLoadOrderWatcher → LatestReceiptWithOrder` | intra_community | 5 |
| `Heal → GetSnapshot` | cross_community | 5 |
| `StartLoadOrderWatcher → EHRuntime` | cross_community | 5 |
| `StartLoadOrderWatcher → GetSnapshot` | intra_community | 4 |

## How to Explore

1. `context({name: "readPluginList"})` — see callers and callees
2. `query({search_query: "doctor"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
