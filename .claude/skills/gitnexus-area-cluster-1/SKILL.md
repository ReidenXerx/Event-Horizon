---
name: gitnexus-area-cluster-1
description: "Skill for the Cluster_1 area of Event-Horizon. 13 symbols across 2 files."
---

# Cluster_1

13 symbols | 2 files | Cohesion: 89%

## When to Use

- Working with code in `scripts/`
- Understanding how assertHeaderSafeFilename, backoffMs, hashFile work
- Modifying cluster_1-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `scripts/lib/nexusRelease.mjs` | PartError, assertHeaderSafeFilename, backoffMs, bareEtag, hashFile (+6) |
| `scripts/lib/nexusRelease.test.mjs` | random, onState |

## Entry Points

Start here when exploring this area:

- **`assertHeaderSafeFilename`** (Function) — `scripts/lib/nexusRelease.mjs:45`
- **`backoffMs`** (Function) — `scripts/lib/nexusRelease.mjs:98`
- **`hashFile`** (Function) — `scripts/lib/nexusRelease.mjs:67`
- **`stop`** (Function) — `scripts/lib/nexusRelease.mjs:382`
- **`uploadPart`** (Function) — `scripts/lib/nexusRelease.mjs:389`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `assertHeaderSafeFilename` | Function | `scripts/lib/nexusRelease.mjs` | 45 |
| `backoffMs` | Function | `scripts/lib/nexusRelease.mjs` | 98 |
| `hashFile` | Function | `scripts/lib/nexusRelease.mjs` | 67 |
| `stop` | Function | `scripts/lib/nexusRelease.mjs` | 382 |
| `uploadPart` | Function | `scripts/lib/nexusRelease.mjs` | 389 |
| `worker` | Function | `scripts/lib/nexusRelease.mjs` | 438 |
| `uploadArchive` | Method | `scripts/lib/nexusRelease.mjs` | 256 |
| `uploadArchiveFromDisk` | Method | `scripts/lib/nexusRelease.mjs` | 333 |
| `PartError` | Class | `scripts/lib/nexusRelease.mjs` | 104 |
| `bareEtag` | Function | `scripts/lib/nexusRelease.mjs` | 112 |
| `storageRefusal` | Function | `scripts/lib/nexusRelease.mjs` | 117 |
| `random` | Function | `scripts/lib/nexusRelease.test.mjs` | 186 |
| `onState` | Function | `scripts/lib/nexusRelease.test.mjs` | 286 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Worker → PartError` | intra_community | 4 |
| `Worker → BareEtag` | intra_community | 3 |
| `Worker → OnState` | intra_community | 3 |
| `UploadArchive → NexusApiError` | cross_community | 3 |

## How to Explore

1. `context({name: "assertHeaderSafeFilename"})` — see callers and callees
2. `query({search_query: "cluster_1"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
