---
name: gitnexus-area-cluster-138
description: "Skill for the Cluster_138 area of Event-Horizon. 12 symbols across 1 files."
---

# Cluster_138

12 symbols | 1 files | Cohesion: 88%

## When to Use

- Working with code in `src/`
- Understanding how liveFomodSelections work
- Modifying cluster_138-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/getModsListForProfile.ts` | assignInstallOrder, hasAnySelectedFomodChoices, liveFomodSelections, normalizeCollectionIds, normalizeFomodSelections (+7) |

## Entry Points

Start here when exploring this area:

- **`liveFomodSelections`** (Function) — `src/core/getModsListForProfile.ts:423`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `liveFomodSelections` | Function | `src/core/getModsListForProfile.ts` | 423 |
| `assignInstallOrder` | Function | `src/core/getModsListForProfile.ts` | 718 |
| `hasAnySelectedFomodChoices` | Function | `src/core/getModsListForProfile.ts` | 475 |
| `normalizeCollectionIds` | Function | `src/core/getModsListForProfile.ts` | 346 |
| `normalizeFomodSelections` | Function | `src/core/getModsListForProfile.ts` | 441 |
| `normalizeInstallTime` | Function | `src/core/getModsListForProfile.ts` | 371 |
| `normalizeModRules` | Function | `src/core/getModsListForProfile.ts` | 539 |
| `normalizeRuleReference` | Function | `src/core/getModsListForProfile.ts` | 489 |
| `normalizeStringArray` | Function | `src/core/getModsListForProfile.ts` | 397 |
| `pickInstallerChoices` | Function | `src/core/getModsListForProfile.ts` | 333 |
| `readMods` | Function | `src/core/getModsListForProfile.ts` | 625 |
| `rulesSortKey` | Function | `src/core/getModsListForProfile.ts` | 528 |

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
2. `query({search_query: "cluster_138"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
