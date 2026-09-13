---
name: gitnexus-area-environment
description: "Skill for the Environment area of Event-Horizon. 149 symbols across 20 files."
---

# Environment

149 symbols | 20 files | Cohesion: 76%

## When to Use

- Working with code in `src/`
- Understanding how describeCleanPlan, decideBinaryImports, decideGameFolder work
- Modifying environment-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/environment/winePrefix.ts` | errorCode, exists, heroicCandidate, heroicCandidates, addDir (+19) |
| `src/core/environment/environmentChecks.ts` | decideBinaryImports, decideGameFolder, decideGameManaged, decideIniLeftovers, decideLauncherRan (+10) |
| `src/core/environment/gameFolderScan.ts` | groupEntries, loadVanillaList, readGogHashdbRecord, idOf, readGogRecord (+10) |
| `src/core/environment/quarantine.ts` | countOnDisk, dismissQuarantine, exists, isSafeRelative, listQuarantines (+7) |
| `src/core/environment/storeFileLists.ts` | Truncated, fields, varint, parseDepotManifest, parseGogFileList (+6) |
| `src/core/environment/peImage.ts` | missingImports, parsePeImage, Malformed, parse, cstring (+4) |
| `src/core/environment/snapshot.ts` | readText, safe, writeEnvironmentSnapshot, close, field (+4) |
| `src/core/environment/launchGame.ts` | chooseLaunchTarget, isCancellation, isFile, launchGame, onSpawned (+3) |
| `src/core/environment/winePrefix.test.ts` | probe, heroicGameConfig, heroicInstalled, linkToGame, onLinux (+3) |
| `src/core/environment/preflight.ts` | isDirectory, isFile, logEnvironmentReport, runEnvironmentPreflight, declaredPrerequisitePaths (+2) |

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
| `logEnvironmentReport` | Function | `src/core/environment/preflight.ts` | 332 |
| `runEnvironmentPreflight` | Function | `src/core/environment/preflight.ts` | 203 |
| `logPaths` | Function | `src/core/environment/logPaths.ts` | 13 |
| `dismissQuarantine` | Function | `src/core/environment/quarantine.ts` | 379 |
| `listQuarantines` | Function | `src/core/environment/quarantine.ts` | 275 |
| `quarantineFiles` | Function | `src/core/environment/quarantine.ts` | 162 |
| `quarantineRootFor` | Function | `src/core/environment/quarantine.ts` | 45 |
| `readQuarantineRecord` | Function | `src/core/environment/quarantine.ts` | 253 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `LaunchGame → GetVortexUserDataPath` | cross_community | 10 |
| `WriteEnvironmentSnapshot → GetVortexUserDataPath` | cross_community | 9 |
| `ScanGameFolder → Truncated` | cross_community | 8 |
| `ScanGameFolder → ToPosix` | cross_community | 8 |
| `LoadBuildDiff → ToPosix` | cross_community | 8 |
| `ScanGameFolder → GetVortexUserDataPath` | cross_community | 8 |
| `OnSpawned → GetVortexUserDataPath` | cross_community | 7 |
| `QuarantineFiles → GetVortexUserDataPath` | cross_community | 7 |
| `RestoreQuarantine → GetVortexUserDataPath` | cross_community | 7 |
| `ScanGameFolder → ReadObject` | cross_community | 6 |

## How to Explore

1. `context({name: "describeCleanPlan"})` — see callers and callees
2. `query({search_query: "environment"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
