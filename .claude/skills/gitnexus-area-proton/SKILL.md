---
name: gitnexus-area-proton
description: "Skill for the Proton area of Event-Horizon. 34 symbols across 8 files."
---

# Proton

34 symbols | 8 files | Cohesion: 73%

## When to Use

- Working with code in `src/`
- Understanding how parseAppManifest, parseVdf, readObject work
- Modifying proton-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/proton/gamePrefix.test.ts` | probe, heroicGameConfig, heroicInstalled, linkToGame, onLinux (+3) |
| `src/core/proton/gamePrefix.ts` | driveCOf, probeWinePrefix, distinct, scanHomes, userDirsOf (+1) |
| `src/core/proton/launcherRecords.ts` | steamCandidates, heroicCandidates, addDir, objectOf, stringOf (+1) |
| `src/core/proton/fsFacts.ts` | isDirectory, errorCode, exists, readJson |
| `src/core/proton/host.ts` | linuxPathThroughRoot, linuxPathOf, reachLinuxPath, vortexLinuxPath |
| `src/core/environment/storeFileLists.ts` | parseAppManifest, parseVdf, readObject |
| `src/core/proton/sharedFolders.ts` | shareOf, writesShowUp |
| `src/core/paths/modPath.ts` | segmentsOf |

## Entry Points

Start here when exploring this area:

- **`parseAppManifest`** (Function) — `src/core/environment/storeFileLists.ts:223`
- **`parseVdf`** (Function) — `src/core/environment/storeFileLists.ts:148`
- **`readObject`** (Function) — `src/core/environment/storeFileLists.ts:183`
- **`isDirectory`** (Function) — `src/core/proton/fsFacts.ts:13`
- **`probeWinePrefix`** (Function) — `src/core/proton/gamePrefix.ts:97`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `parseAppManifest` | Function | `src/core/environment/storeFileLists.ts` | 223 |
| `parseVdf` | Function | `src/core/environment/storeFileLists.ts` | 148 |
| `readObject` | Function | `src/core/environment/storeFileLists.ts` | 183 |
| `isDirectory` | Function | `src/core/proton/fsFacts.ts` | 13 |
| `probeWinePrefix` | Function | `src/core/proton/gamePrefix.ts` | 97 |
| `distinct` | Function | `src/core/proton/gamePrefix.ts` | 157 |
| `linuxPathThroughRoot` | Function | `src/core/proton/host.ts` | 66 |
| `steamCandidates` | Function | `src/core/proton/launcherRecords.ts` | 157 |
| `shareOf` | Function | `src/core/proton/sharedFolders.ts` | 58 |
| `errorCode` | Function | `src/core/proton/fsFacts.ts` | 8 |
| `exists` | Function | `src/core/proton/fsFacts.ts` | 21 |
| `readJson` | Function | `src/core/proton/fsFacts.ts` | 35 |
| `heroicCandidates` | Function | `src/core/proton/launcherRecords.ts` | 73 |
| `addDir` | Function | `src/core/proton/launcherRecords.ts` | 94 |
| `segmentsOf` | Function | `src/core/paths/modPath.ts` | 49 |
| `linuxPathOf` | Function | `src/core/proton/host.ts` | 31 |
| `reachLinuxPath` | Function | `src/core/proton/host.ts` | 61 |
| `vortexLinuxPath` | Function | `src/core/proton/host.ts` | 74 |
| `probe` | Function | `src/core/proton/gamePrefix.test.ts` | 45 |
| `driveCOf` | Function | `src/core/proton/gamePrefix.ts` | 32 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `ScanGameFolder → ToPosix` | cross_community | 8 |
| `LoadBuildDiff → ToPosix` | cross_community | 8 |
| `ScanGameFolder → ReadObject` | cross_community | 6 |
| `RunEnvironmentPreflight → ToPosix` | cross_community | 6 |
| `RunEnvironmentPreflight → ErrorCode` | cross_community | 5 |
| `ProbeWinePrefix → ReadObject` | intra_community | 5 |
| `RunEnvironmentPreflight → Fold` | cross_community | 4 |
| `RunEnvironmentPreflight → IsDirectory` | cross_community | 4 |
| `ProbeWinePrefix → ErrorCode` | cross_community | 3 |

## How to Explore

1. `context({name: "parseAppManifest"})` — see callers and callees
2. `query({search_query: "proton"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
