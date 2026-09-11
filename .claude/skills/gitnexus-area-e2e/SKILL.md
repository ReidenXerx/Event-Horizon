---
name: gitnexus-area-e2e
description: "Skill for the E2e area of Event-Horizon. 15 symbols across 7 files."
---

# E2e

15 symbols | 7 files | Cohesion: 65%

## When to Use

- Working with code in `test/`
- Understanding how makeWorld, makeZip, runInstall work
- Modifying e2e-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `test/e2e/installDriver.e2e.test.ts` | mirroredWorld, sha, packageFrom, install, userState |
| `test/e2e/fakeVortex.ts` | makeFakeVortex, complete, nexusDownload |
| `src/core/installer/runInstall.ts` | formatError, runInstall |
| `test/e2e/verification.e2e.test.ts` | install, userState |
| `src/core/installer/bundledEntryRecovery.test.ts` | packageWith |
| `test/e2e/world.ts` | makeWorld |
| `test/makeZip.ts` | makeZip |

## Entry Points

Start here when exploring this area:

- **`makeWorld`** (Function) — `test/e2e/world.ts:78`
- **`makeZip`** (Function) — `test/makeZip.ts:13`
- **`runInstall`** (Function) — `src/core/installer/runInstall.ts:595`
- **`makeFakeVortex`** (Function) — `test/e2e/fakeVortex.ts:53`
- **`complete`** (Function) — `test/e2e/fakeVortex.ts:132`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `makeWorld` | Function | `test/e2e/world.ts` | 78 |
| `makeZip` | Function | `test/makeZip.ts` | 13 |
| `runInstall` | Function | `src/core/installer/runInstall.ts` | 595 |
| `makeFakeVortex` | Function | `test/e2e/fakeVortex.ts` | 53 |
| `complete` | Function | `test/e2e/fakeVortex.ts` | 132 |
| `nexusDownload` | Function | `test/e2e/fakeVortex.ts` | 287 |
| `packageWith` | Function | `src/core/installer/bundledEntryRecovery.test.ts` | 41 |
| `mirroredWorld` | Function | `test/e2e/installDriver.e2e.test.ts` | 522 |
| `sha` | Function | `test/e2e/installDriver.e2e.test.ts` | 508 |
| `packageFrom` | Function | `test/e2e/installDriver.e2e.test.ts` | 47 |
| `formatError` | Function | `src/core/installer/runInstall.ts` | 6076 |
| `install` | Function | `test/e2e/installDriver.e2e.test.ts` | 89 |
| `userState` | Function | `test/e2e/installDriver.e2e.test.ts` | 67 |
| `install` | Function | `test/e2e/verification.e2e.test.ts` | 117 |
| `userState` | Function | `test/e2e/verification.e2e.test.ts` | 83 |

## How to Explore

1. `context({name: "makeWorld"})` — see callers and callees
2. `query({search_query: "e2e"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
