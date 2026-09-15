---
name: gitnexus-area-environment
description: "Skill for the Environment area of Event-Horizon. 112 symbols across 17 files."
---

# Environment

112 symbols | 17 files | Cohesion: 80%

## When to Use

- Working with code in `src/`
- Understanding how describeCleanPlan, decideBinaryImports, decideGameFolder work
- Modifying environment-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/environment/environmentChecks.ts` | decideBinaryImports, decideGameFolder, decideGameManaged, decideIniLeftovers, decideLauncherRan (+10) |
| `src/core/environment/gameFolderScan.ts` | groupEntries, loadVanillaList, readGogHashdbRecord, idOf, readGogRecord (+10) |
| `src/core/environment/quarantine.ts` | countOnDisk, dismissQuarantine, exists, isSafeRelative, listQuarantines (+7) |
| `src/core/environment/storeFileLists.ts` | Truncated, fields, varint, parseAppManifest, parseDepotManifest (+6) |
| `src/core/environment/peImage.ts` | missingImports, parsePeImage, Malformed, parse, cstring (+4) |
| `src/core/environment/snapshot.ts` | readText, safe, writeEnvironmentSnapshot, close, field (+4) |
| `src/core/environment/launchGame.ts` | chooseLaunchTarget, isCancellation, isFile, launchGame, onSpawned (+3) |
| `src/core/environment/binaryImports.ts` | probeImportMismatches, load, rootDllOwnership, closure, refs (+1) |
| `src/core/environment/vortexEnvironment.ts` | readDiscovery, str, extensionGame, gameDisplayName, gameExecutable (+1) |
| `src/core/environment/fixtures.testutil.ts` | buildDepotManifest, lenField, section, varField, varint |

## Entry Points

Start here when exploring this area:

- **`describeCleanPlan`** (Function) — `src/core/environment/cleanGameFolder.ts:144`
- **`decideBinaryImports`** (Function) — `src/core/environment/environmentChecks.ts:380`
- **`decideGameFolder`** (Function) — `src/core/environment/environmentChecks.ts:427`
- **`decideGameManaged`** (Function) — `src/core/environment/environmentChecks.ts:74`
- **`decideIniLeftovers`** (Function) — `src/core/environment/environmentChecks.ts:512`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `describeCleanPlan` | Function | `src/core/environment/cleanGameFolder.ts` | 144 |
| `decideBinaryImports` | Function | `src/core/environment/environmentChecks.ts` | 380 |
| `decideGameFolder` | Function | `src/core/environment/environmentChecks.ts` | 427 |
| `decideGameManaged` | Function | `src/core/environment/environmentChecks.ts` | 74 |
| `decideIniLeftovers` | Function | `src/core/environment/environmentChecks.ts` | 512 |
| `decideLauncherRan` | Function | `src/core/environment/environmentChecks.ts` | 309 |
| `decideProtectedLocation` | Function | `src/core/environment/environmentChecks.ts` | 237 |
| `decideWinePrefix` | Function | `src/core/environment/environmentChecks.ts` | 154 |
| `folderLine` | Function | `src/core/environment/environmentChecks.ts` | 183 |
| `protectedRootOf` | Function | `src/core/environment/environmentChecks.ts` | 226 |
| `norm` | Function | `src/core/environment/environmentChecks.ts` | 227 |
| `groupEntries` | Function | `src/core/environment/gameFolderScan.ts` | 242 |
| `logEnvironmentReport` | Function | `src/core/environment/preflight.ts` | 334 |
| `runEnvironmentPreflight` | Function | `src/core/environment/preflight.ts` | 205 |
| `loadVanillaList` | Function | `src/core/environment/gameFolderScan.ts` | 585 |
| `parseAppManifest` | Function | `src/core/environment/storeFileLists.ts` | 223 |
| `parseDepotManifest` | Function | `src/core/environment/storeFileLists.ts` | 271 |
| `parseGogFileList` | Function | `src/core/environment/storeFileLists.ts` | 64 |
| `parseGogHashdb` | Function | `src/core/environment/storeFileLists.ts` | 116 |
| `parseVdf` | Function | `src/core/environment/storeFileLists.ts` | 148 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `LaunchGame → GetVortexUserDataPath` | cross_community | 10 |
| `WriteEnvironmentSnapshot → GetVortexUserDataPath` | cross_community | 9 |
| `QuarantineFiles → GetVortexUserDataPath` | cross_community | 7 |
| `RestoreQuarantine → GetVortexUserDataPath` | cross_community | 7 |
| `RunEnvironmentPreflight → ToPosix` | cross_community | 6 |
| `LaunchGame → Truncate` | cross_community | 6 |
| `LaunchGame → MyGamesFolderCandidates` | cross_community | 5 |
| `RunEnvironmentPreflight → ErrorCode` | cross_community | 5 |
| `ProbeWinePrefix → ReadObject` | cross_community | 5 |
| `WriteEnvironmentSnapshot → MyGamesFolderCandidates` | cross_community | 5 |

## How to Explore

1. `context({name: "describeCleanPlan"})` — see callers and callees
2. `query({search_query: "environment"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
