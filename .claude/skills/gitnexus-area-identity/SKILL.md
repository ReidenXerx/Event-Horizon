---
name: gitnexus-area-identity
description: "Skill for the Identity area of Event-Horizon. 33 symbols across 7 files."
---

# Identity

33 symbols | 7 files | Cohesion: 74%

## When to Use

- Working with code in `src/`
- Understanding how createCompareModsAction, matchSnapshots, compareSnapshots work
- Modifying identity-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/identity/modIdentity.ts` | diceCoefficient, matchBySimilarity, matchSnapshots, archiveShaKey, runKeyTier (+12) |
| `src/core/identity/compareKey.ts` | archiveReference, nexusFileReference, nexusModReference, externalArchiveCompareKey, nexusCompareKey |
| `src/utils/utils.ts` | compareSnapshots, exportDiffReport, getModCompareKey, pickJsonFile |
| `src/core/manifest/buildManifest.ts` | buildRule, buildRules, synthesizeRuleReference |
| `src/core/manifest/collectionScope.ts` | findHashedIdentityCollisions, groupBy |
| `src/actions/compareModsAction.ts` | createCompareModsAction |
| `src/core/curator/collectionDiff.ts` | keyFor |

## Entry Points

Start here when exploring this area:

- **`createCompareModsAction`** (Function) — `src/actions/compareModsAction.ts:21`
- **`matchSnapshots`** (Function) — `src/core/identity/modIdentity.ts:249`
- **`compareSnapshots`** (Function) — `src/utils/utils.ts:379`
- **`exportDiffReport`** (Function) — `src/utils/utils.ts:455`
- **`getModCompareKey`** (Function) — `src/utils/utils.ts:289`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `createCompareModsAction` | Function | `src/actions/compareModsAction.ts` | 21 |
| `matchSnapshots` | Function | `src/core/identity/modIdentity.ts` | 249 |
| `compareSnapshots` | Function | `src/utils/utils.ts` | 379 |
| `exportDiffReport` | Function | `src/utils/utils.ts` | 455 |
| `getModCompareKey` | Function | `src/utils/utils.ts` | 289 |
| `pickJsonFile` | Function | `src/utils/utils.ts` | 70 |
| `runKeyTier` | Function | `src/core/identity/modIdentity.ts` | 268 |
| `normalizeVersion` | Function | `src/core/identity/modIdentity.ts` | 113 |
| `archiveReference` | Function | `src/core/identity/compareKey.ts` | 121 |
| `nexusFileReference` | Function | `src/core/identity/compareKey.ts` | 102 |
| `nexusModReference` | Function | `src/core/identity/compareKey.ts` | 116 |
| `normalizeModName` | Function | `src/core/identity/modIdentity.ts` | 164 |
| `externalArchiveCompareKey` | Function | `src/core/identity/compareKey.ts` | 50 |
| `nexusCompareKey` | Function | `src/core/identity/compareKey.ts` | 42 |
| `findHashedIdentityCollisions` | Function | `src/core/manifest/collectionScope.ts` | 192 |
| `diceCoefficient` | Function | `src/core/identity/modIdentity.ts` | 186 |
| `matchBySimilarity` | Function | `src/core/identity/modIdentity.ts` | 362 |
| `archiveShaKey` | Function | `src/core/identity/modIdentity.ts` | 214 |
| `nameVersionKey` | Function | `src/core/identity/modIdentity.ts` | 230 |
| `nexusFileKey` | Function | `src/core/identity/modIdentity.ts` | 207 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `OnRecovered → NexusCompareKey` | cross_community | 5 |
| `Diff → IsNexusSourced` | cross_community | 4 |
| `Diff → NexusCompareKey` | cross_community | 4 |
| `LoadBuildDiff → IsNexusSourced` | cross_community | 4 |
| `LoadBuildDiff → NexusCompareKey` | cross_community | 4 |
| `CurrentFingerprint → GroupBy` | cross_community | 3 |
| `RefreshProfileMembership → GroupBy` | cross_community | 3 |
| `CurrentFingerprint → NexusCompareKey` | cross_community | 3 |
| `RefreshProfileMembership → NexusCompareKey` | cross_community | 3 |

## How to Explore

1. `context({name: "createCompareModsAction"})` — see callers and callees
2. `query({search_query: "identity"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
