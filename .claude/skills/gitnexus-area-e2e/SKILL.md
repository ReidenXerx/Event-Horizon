---
name: gitnexus-area-e2e
description: "Skill for the E2e area of Event-Horizon. 8 symbols across 4 files."
---

# E2e

8 symbols | 4 files | Cohesion: 71%

## When to Use

- Working with code in `test/`
- Understanding how runInstall, makeFakeVortex, complete work
- Modifying e2e-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `test/e2e/fakeVortex.ts` | makeFakeVortex, complete, nexusDownload |
| `test/e2e/installDriver.e2e.test.ts` | install, userState |
| `test/e2e/verification.e2e.test.ts` | install, userState |
| `src/core/installer/runInstall.ts` | runInstall |

## Entry Points

Start here when exploring this area:

- **`runInstall`** (Function) — `src/core/installer/runInstall.ts:581`
- **`makeFakeVortex`** (Function) — `test/e2e/fakeVortex.ts:44`
- **`complete`** (Function) — `test/e2e/fakeVortex.ts:121`
- **`nexusDownload`** (Function) — `test/e2e/fakeVortex.ts:238`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `runInstall` | Function | `src/core/installer/runInstall.ts` | 581 |
| `makeFakeVortex` | Function | `test/e2e/fakeVortex.ts` | 44 |
| `complete` | Function | `test/e2e/fakeVortex.ts` | 121 |
| `nexusDownload` | Function | `test/e2e/fakeVortex.ts` | 238 |
| `install` | Function | `test/e2e/installDriver.e2e.test.ts` | 89 |
| `userState` | Function | `test/e2e/installDriver.e2e.test.ts` | 67 |
| `install` | Function | `test/e2e/verification.e2e.test.ts` | 115 |
| `userState` | Function | `test/e2e/verification.e2e.test.ts` | 81 |

## How to Explore

1. `context({name: "runInstall"})` — see callers and callees
2. `query({search_query: "e2e"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
