---
name: gitnexus-area-e2e
description: "Skill for the E2e area of Event-Horizon. 15 symbols across 10 files."
---

# E2e

15 symbols | 10 files | Cohesion: 62%

## When to Use

- Working with code in `test/`
- Understanding how captureStagingFiles, scopeCollectionMods, makeWorld work
- Modifying e2e-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `test/e2e/installDriver.e2e.test.ts` | packageFrom, mirroredWorld, sha |
| `test/e2e/fakeVortex.ts` | makeFakeVortex, complete, nexusDownload |
| `src/core/manifest/collectionScope.ts` | normalizeInstallName, scopeCollectionMods |
| `src/core/manifest/captureStagingFiles.ts` | captureStagingFiles |
| `test/e2e/curatorToUser.e2e.test.ts` | buildFromWorld |
| `test/e2e/stopAfterDeploy.e2e.test.ts` | packageFrom |
| `test/e2e/verification.e2e.test.ts` | packageFrom |
| `src/core/installer/bundledEntryRecovery.test.ts` | packageWith |
| `test/e2e/world.ts` | makeWorld |
| `test/makeZip.ts` | makeZip |

## Entry Points

Start here when exploring this area:

- **`captureStagingFiles`** (Function) — `src/core/manifest/captureStagingFiles.ts:107`
- **`scopeCollectionMods`** (Function) — `src/core/manifest/collectionScope.ts:133`
- **`makeWorld`** (Function) — `test/e2e/world.ts:78`
- **`makeZip`** (Function) — `test/makeZip.ts:13`
- **`makeFakeVortex`** (Function) — `test/e2e/fakeVortex.ts:53`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `captureStagingFiles` | Function | `src/core/manifest/captureStagingFiles.ts` | 107 |
| `scopeCollectionMods` | Function | `src/core/manifest/collectionScope.ts` | 133 |
| `makeWorld` | Function | `test/e2e/world.ts` | 78 |
| `makeZip` | Function | `test/makeZip.ts` | 13 |
| `makeFakeVortex` | Function | `test/e2e/fakeVortex.ts` | 53 |
| `complete` | Function | `test/e2e/fakeVortex.ts` | 132 |
| `nexusDownload` | Function | `test/e2e/fakeVortex.ts` | 287 |
| `normalizeInstallName` | Function | `src/core/manifest/collectionScope.ts` | 91 |
| `buildFromWorld` | Function | `test/e2e/curatorToUser.e2e.test.ts` | 35 |
| `packageFrom` | Function | `test/e2e/installDriver.e2e.test.ts` | 47 |
| `packageFrom` | Function | `test/e2e/stopAfterDeploy.e2e.test.ts` | 52 |
| `packageFrom` | Function | `test/e2e/verification.e2e.test.ts` | 60 |
| `packageWith` | Function | `src/core/installer/bundledEntryRecovery.test.ts` | 41 |
| `mirroredWorld` | Function | `test/e2e/installDriver.e2e.test.ts` | 522 |
| `sha` | Function | `test/e2e/installDriver.e2e.test.ts` | 508 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `CurrentFingerprint → GroupBy` | cross_community | 3 |
| `CurrentFingerprint → NormalizeInstallName` | cross_community | 3 |
| `RefreshProfileMembership → GroupBy` | cross_community | 3 |
| `RefreshProfileMembership → NormalizeInstallName` | cross_community | 3 |
| `CurrentFingerprint → NexusCompareKey` | cross_community | 3 |
| `RefreshProfileMembership → NexusCompareKey` | cross_community | 3 |

## How to Explore

1. `context({name: "captureStagingFiles"})` — see callers and callees
2. `query({search_query: "e2e"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
