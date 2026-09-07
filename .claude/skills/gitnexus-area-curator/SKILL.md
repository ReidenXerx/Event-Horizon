---
name: gitnexus-area-curator
description: "Skill for the Curator area of Event-Horizon. 142 symbols across 26 files."
---

# Curator

142 symbols | 26 files | Cohesion: 83%

## When to Use

- Working with code in `src/`
- Understanding how getEHRuntime, runtime, profileDriftSince work
- Modifying curator-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/pages/curator/CuratorPage.tsx` | act, setTypeFor, update, confirm, reinstall (+28) |
| `src/core/getModsListForProfile.ts` | assignInstallOrder, getModsForProfile, hasAnySelectedFomodChoices, normalizeCollectionIds, normalizeFomodSelections (+6) |
| `src/ui/pages/curator/curatorSession.ts` | begin, cancel, dismiss, finish, progress (+4) |
| `src/core/curator/profileActions.ts` | findDuplicates, findEndorsable, findFrozen, summarizeProfile, fileIdentity (+4) |
| `src/core/curator/collectionDiff.ts` | diffCollectionAgainstProfile, candidate, firstUnclaimed, settle, nexusModIdOf (+3) |
| `src/core/curator/updateOneMod.ts` | UpdateTimeout, installedIdentityReader, asNum, updateOneAndWait, finish (+2) |
| `src/core/curator/cleanupPlan.ts` | findSupersededMods, consider, planCleanup, orphanArchives, provenSupersedes (+2) |
| `src/ui/pages/build/BuildDashboard.tsx` | recentlyBuilt, diff, DetailRow, PublishedDetailsPanel, RecentlyBuiltCard (+1) |
| `src/core/curator/bulkUpdate.test.ts` | update, update, update, wait, candidate (+1) |
| `src/core/curator/runCleanup.ts` | dependsOnFailedRemoval, describeCleanupOutcome, gb, runCleanup, asNumber (+1) |

## Entry Points

Start here when exploring this area:

- **`getEHRuntime`** (Function) — `src/ui/runtime/ehRuntime.ts:79`
- **`runtime`** (Function) — `src/ui/runtime/useEHRuntime.ts:14`
- **`profileDriftSince`** (Function) — `src/core/curator/profileDrift.ts:51`
- **`getModsForProfile`** (Function) — `src/core/getModsListForProfile.ts:541`
- **`recentlyBuilt`** (Function) — `src/ui/pages/build/BuildDashboard.tsx:668`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `UpdateTimeout` | Class | `src/core/curator/updateOneMod.ts` | 68 |
| `CannotReinstall` | Class | `src/core/curator/reinstallMod.ts` | 45 |
| `getEHRuntime` | Function | `src/ui/runtime/ehRuntime.ts` | 79 |
| `runtime` | Function | `src/ui/runtime/useEHRuntime.ts` | 14 |
| `profileDriftSince` | Function | `src/core/curator/profileDrift.ts` | 51 |
| `getModsForProfile` | Function | `src/core/getModsListForProfile.ts` | 541 |
| `recentlyBuilt` | Function | `src/ui/pages/build/BuildDashboard.tsx` | 668 |
| `describeTypeChanges` | Function | `src/core/curator/bulkToggles.ts` | 72 |
| `label` | Function | `src/core/curator/bulkToggles.ts` | 76 |
| `planTypeChanges` | Function | `src/core/curator/bulkToggles.ts` | 50 |
| `reinstallArgs` | Function | `src/core/curator/reinstallMod.ts` | 128 |
| `restorationFor` | Function | `src/core/curator/reinstallMod.ts` | 106 |
| `applyModTypeChanges` | Function | `src/core/installer/applyModTypes.ts` | 133 |
| `installedIdentityReader` | Function | `src/core/curator/updateOneMod.ts` | 181 |
| `asNum` | Function | `src/core/curator/updateOneMod.ts` | 195 |
| `updateOneAndWait` | Function | `src/core/curator/updateOneMod.ts` | 78 |
| `finish` | Function | `src/core/curator/updateOneMod.ts` | 94 |
| `onAbort` | Function | `src/core/curator/updateOneMod.ts` | 129 |
| `onInstalled` | Function | `src/core/curator/updateOneMod.ts` | 103 |
| `describeBulkUpdate` | Function | `src/core/curator/bulkUpdate.ts` | 167 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `PublishedDetailsPanel → GetEventHorizonDir` | cross_community | 10 |
| `Act → GetEventHorizonDir` | cross_community | 10 |
| `PublishedDetailsPanel → GetVortexUserDataPath` | cross_community | 10 |
| `Reinstall → GetVortexUserDataPath` | cross_community | 9 |
| `UpdateAll → GetVortexUserDataPath` | cross_community | 9 |
| `Act → Clamp` | cross_community | 8 |
| `Act → Scale` | cross_community | 8 |
| `PublishedDetailsPanel → Truncate` | cross_community | 8 |
| `Act → Truncate` | cross_community | 8 |
| `Update → GetVortexUserDataPath` | cross_community | 8 |

## How to Explore

1. `context({name: "getEHRuntime"})` — see callers and callees
2. `query({search_query: "curator"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
