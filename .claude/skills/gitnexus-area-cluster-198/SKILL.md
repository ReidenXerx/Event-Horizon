---
name: gitnexus-area-cluster-198
description: "Skill for the Cluster_198 area of Event-Horizon. 12 symbols across 1 files."
---

# Cluster_198

12 symbols | 1 files | Cohesion: 89%

## When to Use

- Working with code in `src/`
- Understanding how liveFomodSelections, pickInstallerChoices work
- Modifying cluster_198-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/getModsListForProfile.ts` | assignInstallOrder, hasAnySelectedFomodChoices, liveFomodSelections, normalizeCollectionIds, normalizeFomodSelections (+7) |

## Entry Points

Start here when exploring this area:

- **`liveFomodSelections`** (Function) — `src/core/getModsListForProfile.ts:459`
- **`pickInstallerChoices`** (Function) — `src/core/getModsListForProfile.ts:372`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `liveFomodSelections` | Function | `src/core/getModsListForProfile.ts` | 459 |
| `pickInstallerChoices` | Function | `src/core/getModsListForProfile.ts` | 372 |
| `assignInstallOrder` | Function | `src/core/getModsListForProfile.ts` | 754 |
| `hasAnySelectedFomodChoices` | Function | `src/core/getModsListForProfile.ts` | 511 |
| `normalizeCollectionIds` | Function | `src/core/getModsListForProfile.ts` | 382 |
| `normalizeFomodSelections` | Function | `src/core/getModsListForProfile.ts` | 477 |
| `normalizeInstallTime` | Function | `src/core/getModsListForProfile.ts` | 407 |
| `normalizeModRules` | Function | `src/core/getModsListForProfile.ts` | 575 |
| `normalizeRuleReference` | Function | `src/core/getModsListForProfile.ts` | 525 |
| `normalizeStringArray` | Function | `src/core/getModsListForProfile.ts` | 433 |
| `readMods` | Function | `src/core/getModsListForProfile.ts` | 661 |
| `rulesSortKey` | Function | `src/core/getModsListForProfile.ts` | 564 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `CurrentFingerprint → NormalizeRuleReference` | cross_community | 5 |
| `CurrentFingerprint → RulesSortKey` | cross_community | 5 |
| `RecentlyBuilt → NormalizeRuleReference` | cross_community | 5 |
| `RecentlyBuilt → RulesSortKey` | cross_community | 5 |
| `RunLoadingPipelineWithReceipt → NormalizeRuleReference` | cross_community | 5 |
| `RunLoadingPipelineWithReceipt → RulesSortKey` | cross_community | 5 |
| `CurrentFingerprint → NormalizeCollectionIds` | cross_community | 4 |
| `CurrentFingerprint → NormalizeFomodSelections` | cross_community | 4 |
| `CurrentFingerprint → PickInstallerChoices` | cross_community | 4 |
| `RecentlyBuilt → NormalizeCollectionIds` | cross_community | 4 |

## How to Explore

1. `context({name: "liveFomodSelections"})` — see callers and callees
2. `query({search_query: "cluster_198"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
