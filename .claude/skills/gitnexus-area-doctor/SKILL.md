---
name: gitnexus-area-doctor
description: "Skill for the Doctor area of Event-Horizon. 26 symbols across 9 files."
---

# Doctor

26 symbols | 9 files | Cohesion: 86%

## When to Use

- Working with code in `src/`
- Understanding how describeHeal, runHeal, nexusModIdOfCompareKey work
- Modifying doctor-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/doctor/gather.ts` | countModRules, gatherObservations, readEnabledModIds, readInstalledModIds, readProfileIds |
| `src/core/doctor/health.test.ts` | drifted, observations, healthy, on |
| `src/core/doctor/runHeal.ts` | healImpl, resolveModMaps, runHeal |
| `src/core/doctor/health.ts` | countCheck, detailList, evaluateHealth |
| `src/ui/pages/doctor/EnvironmentTools.tsx` | saveLogs, saveSnapshot, formatBytes |
| `src/core/doctor/heal.ts` | describeHeal, healNeedsManifest |
| `src/core/identity/compareKey.ts` | nexusModIdOfCompareKey, parseCompareKey |
| `src/ui/pages/doctor/DoctorPage.tsx` | heal, unavailableHeal |
| `src/core/installer/checkPluginOrder.ts` | comparePluginOrder, key |

## Entry Points

Start here when exploring this area:

- **`describeHeal`** (Function) — `src/core/doctor/heal.ts:66`
- **`runHeal`** (Function) — `src/core/doctor/runHeal.ts:98`
- **`nexusModIdOfCompareKey`** (Function) — `src/core/identity/compareKey.ts:96`
- **`parseCompareKey`** (Function) — `src/core/identity/compareKey.ts:79`
- **`gatherObservations`** (Function) — `src/core/doctor/gather.ts:115`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `describeHeal` | Function | `src/core/doctor/heal.ts` | 66 |
| `runHeal` | Function | `src/core/doctor/runHeal.ts` | 98 |
| `nexusModIdOfCompareKey` | Function | `src/core/identity/compareKey.ts` | 96 |
| `parseCompareKey` | Function | `src/core/identity/compareKey.ts` | 79 |
| `gatherObservations` | Function | `src/core/doctor/gather.ts` | 115 |
| `evaluateHealth` | Function | `src/core/doctor/health.ts` | 213 |
| `comparePluginOrder` | Function | `src/core/installer/checkPluginOrder.ts` | 68 |
| `saveLogs` | Function | `src/ui/pages/doctor/EnvironmentTools.tsx` | 165 |
| `saveSnapshot` | Function | `src/ui/pages/doctor/EnvironmentTools.tsx` | 122 |
| `healNeedsManifest` | Function | `src/core/doctor/heal.ts` | 42 |
| `healImpl` | Function | `src/core/doctor/runHeal.ts` | 133 |
| `resolveModMaps` | Function | `src/core/doctor/runHeal.ts` | 60 |
| `heal` | Function | `src/ui/pages/doctor/DoctorPage.tsx` | 321 |
| `countModRules` | Function | `src/core/doctor/gather.ts` | 70 |
| `readEnabledModIds` | Function | `src/core/doctor/gather.ts` | 53 |
| `readInstalledModIds` | Function | `src/core/doctor/gather.ts` | 37 |
| `readProfileIds` | Function | `src/core/doctor/gather.ts` | 25 |
| `countCheck` | Function | `src/core/doctor/health.ts` | 645 |
| `detailList` | Function | `src/core/doctor/health.ts` | 201 |
| `key` | Function | `src/core/installer/checkPluginOrder.ts` | 59 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Heal → EHRuntime` | cross_community | 6 |
| `Heal → Notify` | cross_community | 6 |
| `Heal → GetSnapshot` | cross_community | 5 |
| `Heal → WizardReducer` | cross_community | 4 |

## How to Explore

1. `context({name: "describeHeal"})` — see callers and callees
2. `query({search_query: "doctor"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
