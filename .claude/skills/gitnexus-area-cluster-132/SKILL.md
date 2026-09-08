---
name: gitnexus-area-cluster-132
description: "Skill for the Cluster_132 area of Event-Horizon. 6 symbols across 1 files."
---

# Cluster_132

6 symbols | 1 files | Cohesion: 67%

## When to Use

- Working with code in `src/`
- Understanding how getDraftPath, loadDraft work
- Modifying cluster_132-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/draftStorage.ts` | getDraftPath, isPlainObject, loadDraft, migrateV1Payload, readDraftFile (+1) |

## Entry Points

Start here when exploring this area:

- **`getDraftPath`** (Function) — `src/core/draftStorage.ts:102`
- **`loadDraft`** (Function) — `src/core/draftStorage.ts:143`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `getDraftPath` | Function | `src/core/draftStorage.ts` | 102 |
| `loadDraft` | Function | `src/core/draftStorage.ts` | 143 |
| `isPlainObject` | Function | `src/core/draftStorage.ts` | 556 |
| `migrateV1Payload` | Function | `src/core/draftStorage.ts` | 432 |
| `readDraftFile` | Function | `src/core/draftStorage.ts` | 199 |
| `sanitizeKey` | Function | `src/core/draftStorage.ts` | 549 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `BuildWizard → GetVortexUserDataPath` | cross_community | 10 |
| `BuildWizard → Truncate` | cross_community | 6 |
| `BuildWizard → SanitizeKey` | cross_community | 5 |
| `BuildWizard → IsPlainObject` | cross_community | 5 |
| `BuildWizard → MigrateV1Payload` | cross_community | 5 |
| `HandleDiscardDraft → SanitizeKey` | cross_community | 5 |
| `HandleDiscardDraft → SanitizeKey` | cross_community | 4 |
| `Handle → SanitizeKey` | cross_community | 4 |

## How to Explore

1. `context({name: "getDraftPath"})` — see callers and callees
2. `query({search_query: "cluster_132"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
