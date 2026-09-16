---
name: gitnexus-area-runtime
description: "Skill for the Runtime area of Event-Horizon. 36 symbols across 12 files."
---

# Runtime

36 symbols | 12 files | Cohesion: 81%

## When to Use

- Working with code in `src/`
- Understanding how verify, installPrerequisites, summarisePrereqResults work
- Modifying runtime-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/runtime/collectionUpdates.ts` | CollectionUpdateStore, checkCollectionUpdates, getCollectionUpdateStore, notifyUpdate, watchCollectionUpdates (+5) |
| `src/core/runtime/detectRuntimes.ts` | detectRuntimes, probeDirectX9, probeDotNet48, probeDotNetDesktop8, probeVcRedist (+1) |
| `src/core/runtime/nodePrereqDeps.ts` | run, download, finish, armStall, go |
| `src/ui/runtime/routeRequest.ts` | RouteRequest, getRouteRequest, request |
| `src/core/curator/bulkUpdate.test.ts` | verify, ok |
| `src/core/curator/requirementStep.test.ts` | download, download |
| `src/core/runtime/installPrerequisites.ts` | installPrerequisites, summarisePrereqResults |
| `src/core/runtime/prerequisites.ts` | classifyExitCode, verdictIsGood |
| `src/core/curator/bulkUpdate.ts` | verify |
| `src/core/runtime/installPrerequisites.test.ts` | run |

## Entry Points

Start here when exploring this area:

- **`verify`** (Function) — `src/core/curator/bulkUpdate.ts:120`
- **`installPrerequisites`** (Function) — `src/core/runtime/installPrerequisites.ts:85`
- **`summarisePrereqResults`** (Function) — `src/core/runtime/installPrerequisites.ts:217`
- **`classifyExitCode`** (Function) — `src/core/runtime/prerequisites.ts:154`
- **`verdictIsGood`** (Function) — `src/core/runtime/prerequisites.ts:186`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `verify` | Function | `src/core/curator/bulkUpdate.ts` | 120 |
| `installPrerequisites` | Function | `src/core/runtime/installPrerequisites.ts` | 85 |
| `summarisePrereqResults` | Function | `src/core/runtime/installPrerequisites.ts` | 217 |
| `classifyExitCode` | Function | `src/core/runtime/prerequisites.ts` | 154 |
| `verdictIsGood` | Function | `src/core/runtime/prerequisites.ts` | 186 |
| `checkCollectionUpdates` | Function | `src/ui/runtime/collectionUpdates.ts` | 106 |
| `getCollectionUpdateStore` | Function | `src/ui/runtime/collectionUpdates.ts` | 76 |
| `watchCollectionUpdates` | Function | `src/ui/runtime/collectionUpdates.ts` | 342 |
| `later` | Function | `src/ui/runtime/collectionUpdates.ts` | 344 |
| `detectRuntimes` | Function | `src/core/runtime/detectRuntimes.ts` | 214 |
| `getRouteRequest` | Function | `src/ui/runtime/routeRequest.ts` | 72 |
| `describeRuntimeFindings` | Function | `src/core/runtime/detectRuntimes.ts` | 265 |
| `runtimeLines` | Function | `src/ui/pages/install/steps.tsx` | 741 |
| `CollectionUpdateStore` | Class | `src/ui/runtime/collectionUpdates.ts` | 38 |
| `RouteRequest` | Class | `src/ui/runtime/routeRequest.ts` | 27 |
| `verify` | Function | `src/core/curator/bulkUpdate.test.ts` | 72 |
| `ok` | Function | `src/core/curator/bulkUpdate.test.ts` | 28 |
| `download` | Function | `src/core/curator/requirementStep.test.ts` | 142 |
| `download` | Function | `src/core/curator/requirementStep.test.ts` | 71 |
| `run` | Function | `src/core/runtime/installPrerequisites.test.ts` | 192 |

## How to Explore

1. `context({name: "verify"})` — see callers and callees
2. `query({search_query: "runtime"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
