---
name: gitnexus-area-curator
description: "Skill for the Curator area of Event-Horizon. 147 symbols across 31 files."
---

# Curator

147 symbols | 31 files | Cohesion: 86%

## When to Use

- Working with code in `src/`
- Understanding how getEHRuntime, runtime, findSupersededMods work
- Modifying curator-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/pages/curator/CuratorPage.tsx` | orphanPlan, retireCandidates, retirePlan, manualUpdates, shadowed (+28) |
| `src/core/curator/profileActions.ts` | identityCandidates, fileIdentity, findManualUpdates, findUpdatable, findUpdateShadowed (+7) |
| `src/ui/pages/curator/curatorSession.ts` | begin, cancel, dismiss, finish, progress (+4) |
| `src/core/curator/cleanupPlan.ts` | findSupersededMods, consider, planCleanup, identityKey, orphanArchives (+3) |
| `src/core/curator/collectionDiff.ts` | settle, describeCollectionDiff, isUnchanged, diffCollectionAgainstProfile, candidate (+3) |
| `src/core/curator/updateOneMod.ts` | UpdateTimeout, installedIdentityReader, asNum, updateOneAndWait, finish (+2) |
| `src/core/curator/bulkUpdate.test.ts` | update, update, update, wait, candidate (+1) |
| `src/core/curator/runCleanup.ts` | dependsOnFailedRemoval, describeCleanupOutcome, gb, runCleanup, asNumber (+1) |
| `src/core/curator/readProfile.ts` | asNumber, asString, opt, readCuratorMods, readEnabledModIds |
| `src/core/curator/fileNameVersion.ts` | escapeForRegExp, nameForms, stripKnownVersion, stripTrailingVersion |

## Entry Points

Start here when exploring this area:

- **`getEHRuntime`** (Function) — `src/ui/runtime/ehRuntime.ts:79`
- **`runtime`** (Function) — `src/ui/runtime/useEHRuntime.ts:14`
- **`findSupersededMods`** (Function) — `src/core/curator/cleanupPlan.ts:167`
- **`consider`** (Function) — `src/core/curator/cleanupPlan.ts:184`
- **`planCleanup`** (Function) — `src/core/curator/cleanupPlan.ts:287`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `UpdateTimeout` | Class | `src/core/curator/updateOneMod.ts` | 68 |
| `CannotReinstall` | Class | `src/core/curator/reinstallMod.ts` | 45 |
| `getEHRuntime` | Function | `src/ui/runtime/ehRuntime.ts` | 79 |
| `runtime` | Function | `src/ui/runtime/useEHRuntime.ts` | 14 |
| `findSupersededMods` | Function | `src/core/curator/cleanupPlan.ts` | 167 |
| `consider` | Function | `src/core/curator/cleanupPlan.ts` | 184 |
| `planCleanup` | Function | `src/core/curator/cleanupPlan.ts` | 287 |
| `identityKey` | Function | `src/core/curator/cleanupPlan.ts` | 353 |
| `nameForms` | Function | `src/core/curator/fileNameVersion.ts` | 139 |
| `stripKnownVersion` | Function | `src/core/curator/fileNameVersion.ts` | 115 |
| `stripTrailingVersion` | Function | `src/core/curator/fileNameVersion.ts` | 76 |
| `identityCandidates` | Function | `src/core/curator/profileActions.ts` | 553 |
| `fileIdentity` | Function | `src/core/curator/profileActions.ts` | 519 |
| `findManualUpdates` | Function | `src/core/curator/profileActions.ts` | 234 |
| `findUpdatable` | Function | `src/core/curator/profileActions.ts` | 313 |
| `findUpdateShadowed` | Function | `src/core/curator/profileActions.ts` | 355 |
| `updateGroupKey` | Function | `src/core/curator/profileActions.ts` | 307 |
| `vortexReportsUpdate` | Function | `src/core/curator/profileActions.ts` | 210 |
| `describeTypeChanges` | Function | `src/core/curator/bulkToggles.ts` | 72 |
| `label` | Function | `src/core/curator/bulkToggles.ts` | 76 |

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
