---
name: gitnexus-area-proton
description: "Skill for the Proton area of Event-Horizon. 39 symbols across 9 files."
---

# Proton

39 symbols | 9 files | Cohesion: 79%

## When to Use

- Working with code in `src/`
- Understanding how crcOf, rebaseUnder, relativeUnder work
- Modifying proton-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/proton/gamePrefix.test.ts` | probe, heroicGameConfig, heroicInstalled, linkToGame, onLinux (+3) |
| `src/core/proton/gamePrefix.ts` | driveCOf, probeWinePrefix, distinct, scanHomes, userDirsOf (+1) |
| `src/core/proton/host.ts` | linuxPathThroughRoot, vortexLinuxPath, linuxPathOf, reachLinuxPath, readWineHost (+1) |
| `src/core/proton/launcherRecords.ts` | steamCandidates, heroicCandidate, heroicCandidates, addDir, objectOf (+1) |
| `src/core/paths/modPath.ts` | rebaseUnder, relativeUnder, fold, segmentsOf |
| `src/core/proton/fsFacts.ts` | isDirectory, errorCode, exists, readJson |
| `src/core/environment/preflight.ts` | gameSideSettings, move |
| `src/core/proton/sharedFolders.ts` | shareOf, writesShowUp |
| `src/core/manifest/mirrorPayload.ts` | crcOf |

## Entry Points

Start here when exploring this area:

- **`crcOf`** (Function) — `src/core/manifest/mirrorPayload.ts:219`
- **`rebaseUnder`** (Function) — `src/core/paths/modPath.ts:193`
- **`relativeUnder`** (Function) — `src/core/paths/modPath.ts:184`
- **`fold`** (Function) — `src/core/paths/modPath.ts:185`
- **`segmentsOf`** (Function) — `src/core/paths/modPath.ts:49`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `crcOf` | Function | `src/core/manifest/mirrorPayload.ts` | 219 |
| `rebaseUnder` | Function | `src/core/paths/modPath.ts` | 193 |
| `relativeUnder` | Function | `src/core/paths/modPath.ts` | 184 |
| `fold` | Function | `src/core/paths/modPath.ts` | 185 |
| `segmentsOf` | Function | `src/core/paths/modPath.ts` | 49 |
| `isDirectory` | Function | `src/core/proton/fsFacts.ts` | 13 |
| `probeWinePrefix` | Function | `src/core/proton/gamePrefix.ts` | 97 |
| `distinct` | Function | `src/core/proton/gamePrefix.ts` | 157 |
| `linuxPathThroughRoot` | Function | `src/core/proton/host.ts` | 66 |
| `vortexLinuxPath` | Function | `src/core/proton/host.ts` | 74 |
| `steamCandidates` | Function | `src/core/proton/launcherRecords.ts` | 157 |
| `shareOf` | Function | `src/core/proton/sharedFolders.ts` | 58 |
| `errorCode` | Function | `src/core/proton/fsFacts.ts` | 8 |
| `exists` | Function | `src/core/proton/fsFacts.ts` | 21 |
| `readJson` | Function | `src/core/proton/fsFacts.ts` | 35 |
| `linuxPathOf` | Function | `src/core/proton/host.ts` | 31 |
| `reachLinuxPath` | Function | `src/core/proton/host.ts` | 61 |
| `readWineHost` | Function | `src/core/proton/host.ts` | 39 |
| `addHome` | Function | `src/core/proton/host.ts` | 41 |
| `heroicCandidates` | Function | `src/core/proton/launcherRecords.ts` | 73 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `PrepareChangelog → ToPosix` | cross_community | 9 |
| `LoadBuildDiff → ToPosix` | cross_community | 8 |
| `RunEnvironmentPreflight → ToPosix` | cross_community | 6 |
| `RunEnvironmentPreflight → ErrorCode` | cross_community | 5 |
| `ProbeWinePrefix → ReadObject` | cross_community | 5 |
| `RunEnvironmentPreflight → Fold` | cross_community | 4 |
| `RunEnvironmentPreflight → IsDirectory` | cross_community | 4 |
| `ProbeWinePrefix → ErrorCode` | cross_community | 3 |

## How to Explore

1. `context({name: "crcOf"})` — see callers and callees
2. `query({search_query: "proton"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
