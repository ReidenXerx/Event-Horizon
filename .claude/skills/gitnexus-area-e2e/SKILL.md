---
name: gitnexus-area-e2e
description: "Skill for the E2e area of Event-Horizon. 12 symbols across 5 files."
---

# E2e

12 symbols | 5 files | Cohesion: 63%

## When to Use

- Working with code in `test/`
- Understanding how runInstall, makeWorld, makeFakeVortex work
- Modifying e2e-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `test/e2e/installDriver.e2e.test.ts` | install, userState, mirroredWorld, sha, packageFrom |
| `test/e2e/fakeVortex.ts` | makeFakeVortex, complete, nexusDownload |
| `test/e2e/verification.e2e.test.ts` | install, userState |
| `src/core/installer/runInstall.ts` | runInstall |
| `test/e2e/world.ts` | makeWorld |

## Entry Points

Start here when exploring this area:

- **`runInstall`** (Function) — `src/core/installer/runInstall.ts:534`
- **`makeWorld`** (Function) — `test/e2e/world.ts:78`
- **`makeFakeVortex`** (Function) — `test/e2e/fakeVortex.ts:44`
- **`complete`** (Function) — `test/e2e/fakeVortex.ts:121`
- **`nexusDownload`** (Function) — `test/e2e/fakeVortex.ts:238`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `runInstall` | Function | `src/core/installer/runInstall.ts` | 534 |
| `makeWorld` | Function | `test/e2e/world.ts` | 78 |
| `makeFakeVortex` | Function | `test/e2e/fakeVortex.ts` | 44 |
| `complete` | Function | `test/e2e/fakeVortex.ts` | 121 |
| `nexusDownload` | Function | `test/e2e/fakeVortex.ts` | 238 |
| `install` | Function | `test/e2e/installDriver.e2e.test.ts` | 89 |
| `userState` | Function | `test/e2e/installDriver.e2e.test.ts` | 67 |
| `install` | Function | `test/e2e/verification.e2e.test.ts` | 115 |
| `userState` | Function | `test/e2e/verification.e2e.test.ts` | 81 |
| `mirroredWorld` | Function | `test/e2e/installDriver.e2e.test.ts` | 478 |
| `sha` | Function | `test/e2e/installDriver.e2e.test.ts` | 464 |
| `packageFrom` | Function | `test/e2e/installDriver.e2e.test.ts` | 47 |

## How to Explore

1. `context({name: "runInstall"})` — see callers and callees
2. `query({search_query: "e2e"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
