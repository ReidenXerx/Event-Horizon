---
name: gitnexus-area-identity
description: "Skill for the Identity area of Event-Horizon. 30 symbols across 6 files."
---

# Identity

30 symbols | 6 files | Cohesion: 76%

## When to Use

- Working with code in `src/`
- Understanding how runKeyTier, normalizeVersion, archiveReference work
- Modifying identity-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/identity/modIdentity.ts` | archiveShaKey, runKeyTier, nameVersionKey, nexusFileKey, nexusModKey (+12) |
| `src/core/identity/compareKey.ts` | archiveReference, nexusFileReference, nexusModReference, externalArchiveCompareKey, nexusCompareKey |
| `src/core/manifest/buildManifest.ts` | buildRule, buildRules, synthesizeRuleReference |
| `src/core/manifest/collectionScope.ts` | findHashedIdentityCollisions, groupBy |
| `src/utils/utils.ts` | compareSnapshots, getModCompareKey |
| `src/core/curator/collectionDiff.ts` | keyFor |

## Entry Points

Start here when exploring this area:

- **`runKeyTier`** (Function) — `src/core/identity/modIdentity.ts:268`
- **`normalizeVersion`** (Function) — `src/core/identity/modIdentity.ts:113`
- **`archiveReference`** (Function) — `src/core/identity/compareKey.ts:121`
- **`nexusFileReference`** (Function) — `src/core/identity/compareKey.ts:102`
- **`nexusModReference`** (Function) — `src/core/identity/compareKey.ts:116`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `runKeyTier` | Function | `src/core/identity/modIdentity.ts` | 268 |
| `normalizeVersion` | Function | `src/core/identity/modIdentity.ts` | 113 |
| `archiveReference` | Function | `src/core/identity/compareKey.ts` | 121 |
| `nexusFileReference` | Function | `src/core/identity/compareKey.ts` | 102 |
| `nexusModReference` | Function | `src/core/identity/compareKey.ts` | 116 |
| `normalizeModName` | Function | `src/core/identity/modIdentity.ts` | 164 |
| `externalArchiveCompareKey` | Function | `src/core/identity/compareKey.ts` | 50 |
| `nexusCompareKey` | Function | `src/core/identity/compareKey.ts` | 42 |
| `findHashedIdentityCollisions` | Function | `src/core/manifest/collectionScope.ts` | 192 |
| `matchSnapshots` | Function | `src/core/identity/modIdentity.ts` | 249 |
| `compareSnapshots` | Function | `src/utils/utils.ts` | 378 |
| `getModCompareKey` | Function | `src/utils/utils.ts` | 288 |
| `archiveShaKey` | Function | `src/core/identity/modIdentity.ts` | 214 |
| `nameVersionKey` | Function | `src/core/identity/modIdentity.ts` | 230 |
| `nexusFileKey` | Function | `src/core/identity/modIdentity.ts` | 207 |
| `nexusModKey` | Function | `src/core/identity/modIdentity.ts` | 226 |
| `stagingSetKey` | Function | `src/core/identity/modIdentity.ts` | 220 |
| `str` | Function | `src/core/identity/modIdentity.ts` | 201 |
| `buildRule` | Function | `src/core/manifest/buildManifest.ts` | 820 |
| `buildRules` | Function | `src/core/manifest/buildManifest.ts` | 772 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `BuildDiffCard → NexusCompareKey` | cross_community | 5 |
| `BuildDiffCard → IsNexusSourced` | cross_community | 5 |
| `OnRecovered → NexusCompareKey` | cross_community | 5 |
| `MatchSnapshots → StripVersionTokens` | cross_community | 4 |
| `MatchSnapshots → StripVortexPin` | cross_community | 4 |
| `MatchSnapshots → Str` | cross_community | 4 |
| `Diff → IsNexusSourced` | cross_community | 4 |
| `Diff → NexusCompareKey` | cross_community | 4 |
| `MatchSnapshots → DiceCoefficient` | intra_community | 3 |
| `MatchSnapshots → ArchiveShaKey` | cross_community | 3 |

## How to Explore

1. `context({name: "runKeyTier"})` — see callers and callees
2. `query({search_query: "identity"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
