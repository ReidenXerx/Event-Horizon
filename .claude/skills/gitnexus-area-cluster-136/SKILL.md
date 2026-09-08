---
name: gitnexus-area-cluster-136
description: "Skill for the Cluster_136 area of Event-Horizon. 11 symbols across 1 files."
---

# Cluster_136

11 symbols | 1 files | Cohesion: 91%

## When to Use

- Working with code in `src/`
- Understanding how assignInstallOrder, hasAnySelectedFomodChoices, normalizeCollectionIds work
- Modifying cluster_136-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/getModsListForProfile.ts` | assignInstallOrder, hasAnySelectedFomodChoices, normalizeCollectionIds, normalizeFomodSelections, normalizeInstallTime (+6) |

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `assignInstallOrder` | Function | `src/core/getModsListForProfile.ts` | 690 |
| `hasAnySelectedFomodChoices` | Function | `src/core/getModsListForProfile.ts` | 447 |
| `normalizeCollectionIds` | Function | `src/core/getModsListForProfile.ts` | 346 |
| `normalizeFomodSelections` | Function | `src/core/getModsListForProfile.ts` | 413 |
| `normalizeInstallTime` | Function | `src/core/getModsListForProfile.ts` | 371 |
| `normalizeModRules` | Function | `src/core/getModsListForProfile.ts` | 511 |
| `normalizeRuleReference` | Function | `src/core/getModsListForProfile.ts` | 461 |
| `normalizeStringArray` | Function | `src/core/getModsListForProfile.ts` | 397 |
| `pickInstallerChoices` | Function | `src/core/getModsListForProfile.ts` | 333 |
| `readMods` | Function | `src/core/getModsListForProfile.ts` | 597 |
| `rulesSortKey` | Function | `src/core/getModsListForProfile.ts` | 500 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `CurrentFingerprint → NormalizeRuleReference` | cross_community | 5 |
| `CurrentFingerprint → RulesSortKey` | cross_community | 5 |
| `RecentlyBuilt → NormalizeRuleReference` | cross_community | 5 |
| `RecentlyBuilt → RulesSortKey` | cross_community | 5 |
| `Diff → NormalizeRuleReference` | cross_community | 5 |
| `Diff → RulesSortKey` | cross_community | 5 |
| `RunLoadingPipelineWithReceipt → NormalizeRuleReference` | cross_community | 5 |
| `RunLoadingPipelineWithReceipt → RulesSortKey` | cross_community | 5 |
| `CurrentFingerprint → NormalizeCollectionIds` | cross_community | 4 |
| `CurrentFingerprint → NormalizeFomodSelections` | cross_community | 4 |

## How to Explore

1. `context({name: "assignInstallOrder"})` — see callers and callees
2. `query({search_query: "cluster_136"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
