---
name: gitnexus-area-runtime
description: "Skill for the Runtime area of Event-Horizon. 53 symbols across 16 files."
---

# Runtime

53 symbols | 16 files | Cohesion: 82%

## When to Use

- Working with code in `src/`
- Understanding how verify, fileSizeOf, nexusFilePageUrl work
- Modifying runtime-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/runtime/collectionUpdates.ts` | CollectionUpdateStore, checkCollectionUpdates, getCollectionUpdateStore, notifyUpdate, watchCollectionUpdates (+5) |
| `src/ui/pages/install/fetchLink.ts` | fetchFromNexus, gameMismatchMessage, readKnownGames, throwIfAborted, vortexDownloadPath (+1) |
| `src/ui/runtime/ensurePackage.test.ts` | download, ensure, locate, download, store (+1) |
| `src/core/runtime/detectRuntimes.ts` | detectRuntimes, probeDirectX9, probeDotNet48, probeDotNetDesktop8, probeVcRedist (+1) |
| `src/core/runtime/nodePrereqDeps.ts` | download, finish, armStall, go, run |
| `src/core/installer/installLink.ts` | fileSizeOf, nexusFilePageUrl, vortexGamesForNexusDomain |
| `src/ui/runtime/routeRequest.ts` | RouteRequest, getRouteRequest, request |
| `src/core/curator/bulkUpdate.test.ts` | verify, ok |
| `src/core/curator/requirementStep.test.ts` | download, download |
| `src/core/runtime/installPrerequisites.ts` | installPrerequisites, summarisePrereqResults |

## Entry Points

Start here when exploring this area:

- **`verify`** (Function) — `src/core/curator/bulkUpdate.ts:120`
- **`fileSizeOf`** (Function) — `src/core/installer/installLink.ts:321`
- **`nexusFilePageUrl`** (Function) — `src/core/installer/installLink.ts:311`
- **`vortexGamesForNexusDomain`** (Function) — `src/core/installer/installLink.ts:299`
- **`installPrerequisites`** (Function) — `src/core/runtime/installPrerequisites.ts:85`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `verify` | Function | `src/core/curator/bulkUpdate.ts` | 120 |
| `fileSizeOf` | Function | `src/core/installer/installLink.ts` | 321 |
| `nexusFilePageUrl` | Function | `src/core/installer/installLink.ts` | 311 |
| `vortexGamesForNexusDomain` | Function | `src/core/installer/installLink.ts` | 299 |
| `installPrerequisites` | Function | `src/core/runtime/installPrerequisites.ts` | 85 |
| `summarisePrereqResults` | Function | `src/core/runtime/installPrerequisites.ts` | 217 |
| `classifyExitCode` | Function | `src/core/runtime/prerequisites.ts` | 154 |
| `verdictIsGood` | Function | `src/core/runtime/prerequisites.ts` | 186 |
| `waitForVortexDownload` | Function | `src/ui/pages/install/fetchLink.ts` | 364 |
| `ensureCollectionPackage` | Function | `src/ui/runtime/ensurePackage.ts` | 96 |
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

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `EnsureCollectionPackage → GetVortexUserDataPath` | cross_community | 7 |
| `FetchFromNexus → VortexGamesForNexusDomain` | intra_community | 3 |
| `FetchFromNexus → ReadKnownGames` | intra_community | 3 |
| `FetchFromNexus → NexusDomainOf` | cross_community | 3 |
| `FetchFromNexus → Fn` | cross_community | 3 |
| `EnsureCollectionPackage → Truncate` | cross_community | 3 |

## How to Explore

1. `context({name: "verify"})` — see callers and callees
2. `query({search_query: "runtime"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
