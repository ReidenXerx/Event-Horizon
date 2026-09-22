---
name: gitnexus-area-e2e
description: "Skill for the E2e area of Event-Horizon. 27 symbols across 13 files."
---

# E2e

27 symbols | 13 files | Cohesion: 58%

## When to Use

- Working with code in `test/`
- Understanding how profileDriftSince, getModsForProfile, profileFingerprint work
- Modifying e2e-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `test/e2e/installDriver.e2e.test.ts` | oneModWorld, mirroredWorld, sha, packageFrom, install (+2) |
| `src/core/manifest/collectionScope.ts` | profileFingerprint, normalizeInstallName, scopeCollectionMods |
| `test/e2e/verification.e2e.test.ts` | packageFrom, install, userState |
| `test/e2e/fakeVortex.ts` | makeFakeVortex, complete, nexusDownload |
| `src/ui/pages/build/BuildDashboard.tsx` | currentFingerprint, recentlyBuilt |
| `src/core/installer/runInstall.ts` | formatError, runInstall |
| `src/core/curator/profileDrift.ts` | profileDriftSince |
| `src/core/getModsListForProfile.ts` | getModsForProfile |
| `test/e2e/world.ts` | makeWorld |
| `test/makeZip.ts` | makeZip |

## Entry Points

Start here when exploring this area:

- **`profileDriftSince`** (Function) — `src/core/curator/profileDrift.ts:51`
- **`getModsForProfile`** (Function) — `src/core/getModsListForProfile.ts:631`
- **`profileFingerprint`** (Function) — `src/core/manifest/collectionScope.ts:289`
- **`currentFingerprint`** (Function) — `src/ui/pages/build/BuildDashboard.tsx:322`
- **`recentlyBuilt`** (Function) — `src/ui/pages/build/BuildDashboard.tsx:657`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `profileDriftSince` | Function | `src/core/curator/profileDrift.ts` | 51 |
| `getModsForProfile` | Function | `src/core/getModsListForProfile.ts` | 631 |
| `profileFingerprint` | Function | `src/core/manifest/collectionScope.ts` | 289 |
| `currentFingerprint` | Function | `src/ui/pages/build/BuildDashboard.tsx` | 322 |
| `recentlyBuilt` | Function | `src/ui/pages/build/BuildDashboard.tsx` | 657 |
| `makeWorld` | Function | `test/e2e/world.ts` | 78 |
| `makeZip` | Function | `test/makeZip.ts` | 13 |
| `captureStagingFiles` | Function | `src/core/manifest/captureStagingFiles.ts` | 167 |
| `scopeCollectionMods` | Function | `src/core/manifest/collectionScope.ts` | 133 |
| `runInstall` | Function | `src/core/installer/runInstall.ts` | 630 |
| `makeFakeVortex` | Function | `test/e2e/fakeVortex.ts` | 53 |
| `complete` | Function | `test/e2e/fakeVortex.ts` | 138 |
| `nexusDownload` | Function | `test/e2e/fakeVortex.ts` | 313 |
| `oneModWorld` | Function | `test/e2e/installDriver.e2e.test.ts` | 292 |
| `mirroredWorld` | Function | `test/e2e/installDriver.e2e.test.ts` | 680 |
| `sha` | Function | `test/e2e/installDriver.e2e.test.ts` | 666 |
| `normalizeInstallName` | Function | `src/core/manifest/collectionScope.ts` | 91 |
| `buildFromWorld` | Function | `test/e2e/curatorToUser.e2e.test.ts` | 35 |
| `packageFrom` | Function | `test/e2e/installDriver.e2e.test.ts` | 47 |
| `packageFrom` | Function | `test/e2e/stopAfterDeploy.e2e.test.ts` | 52 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `CurrentFingerprint → GetVortexUserDataPath` | cross_community | 7 |
| `CurrentFingerprint → NormalizeRuleReference` | cross_community | 5 |
| `CurrentFingerprint → RulesSortKey` | cross_community | 5 |
| `RecentlyBuilt → NormalizeRuleReference` | cross_community | 5 |
| `RecentlyBuilt → RulesSortKey` | cross_community | 5 |
| `CurrentFingerprint → NormalizeCollectionIds` | cross_community | 4 |
| `CurrentFingerprint → NormalizeFomodSelections` | cross_community | 4 |
| `CurrentFingerprint → PickInstallerChoices` | cross_community | 4 |
| `RecentlyBuilt → NormalizeCollectionIds` | cross_community | 4 |
| `RecentlyBuilt → NormalizeFomodSelections` | cross_community | 4 |

## How to Explore

1. `context({name: "profileDriftSince"})` — see callers and callees
2. `query({search_query: "e2e"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
