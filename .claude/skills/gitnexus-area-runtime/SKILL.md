---
name: gitnexus-area-runtime
description: "Skill for the Runtime area of Event-Horizon. 61 symbols across 22 files."
---

# Runtime

61 symbols | 22 files | Cohesion: 85%

## When to Use

- Working with code in `src/`
- Understanding how verify, fileSizeOf, nexusFilePageUrl work
- Modifying runtime-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/runtime/collectionUpdates.ts` | openInstall, CollectionUpdateStore, checkCollectionUpdates, getCollectionUpdateStore, notifyUpdate (+2) |
| `src/ui/pages/install/fetchLink.ts` | fetchFromNexus, gameMismatchMessage, readKnownGames, throwIfAborted, vortexDownloadPath (+1) |
| `src/ui/runtime/ensurePackage.test.ts` | download, ensure, locate, download, store (+1) |
| `src/core/runtime/detectRuntimes.ts` | detectRuntimes, probeDirectX9, probeDotNet48, probeDotNetDesktop8, probeVcRedist (+1) |
| `src/core/runtime/nodePrereqDeps.ts` | download, finish, armStall, go, run |
| `src/core/runtime/scriptExtenderLog.ts` | baseName, parseScriptExtenderLog, close, readScriptExtenderLog, scriptExtenderLogFor |
| `src/core/installer/installLink.ts` | fileSizeOf, nexusFilePageUrl, vortexGamesForNexusDomain |
| `src/ui/runtime/routeRequest.ts` | RouteRequest, getRouteRequest, request |
| `src/core/curator/bulkUpdate.test.ts` | verify, ok |
| `src/core/curator/requirementStep.test.ts` | download, download |

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
| `classifyExitCode` | Function | `src/core/runtime/prerequisites.ts` | 230 |
| `verdictIsGood` | Function | `src/core/runtime/prerequisites.ts` | 262 |
| `nexusExtOf` | Function | `src/ui/pages/curator/requirementsIo.ts` | 177 |
| `fn` | Function | `src/ui/pages/curator/requirementsIo.ts` | 179 |
| `nexus` | Function | `src/ui/pages/curator/useCuratorActions.ts` | 225 |
| `waitForVortexDownload` | Function | `src/ui/pages/install/fetchLink.ts` | 364 |
| `ensureCollectionPackage` | Function | `src/ui/runtime/ensurePackage.ts` | 96 |
| `install` | Function | `src/core/installer/collectionIntercept.ts` | 137 |
| `getRouteRequest` | Function | `src/ui/runtime/routeRequest.ts` | 72 |
| `checkCollectionUpdates` | Function | `src/ui/runtime/collectionUpdates.ts` | 142 |
| `getCollectionUpdateStore` | Function | `src/ui/runtime/collectionUpdates.ts` | 100 |
| `detectRuntimes` | Function | `src/core/runtime/detectRuntimes.ts` | 241 |
| `parseScriptExtenderLog` | Function | `src/core/runtime/scriptExtenderLog.ts` | 76 |
| `close` | Function | `src/core/runtime/scriptExtenderLog.ts` | 82 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `EnsureCollectionPackage → GetVortexUserDataPath` | cross_community | 7 |
| `UseCuratorActions → Fn` | cross_community | 5 |
| `RunPlan → Fn` | cross_community | 5 |
| `FetchFromNexus → VortexGamesForNexusDomain` | intra_community | 3 |
| `FetchFromNexus → ReadKnownGames` | intra_community | 3 |
| `FetchFromNexus → NexusDomainOf` | cross_community | 3 |
| `FetchFromNexus → Fn` | intra_community | 3 |
| `EnsureCollectionPackage → Truncate` | cross_community | 3 |

## How to Explore

1. `context({name: "verify"})` — see callers and callees
2. `query({search_query: "runtime"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
