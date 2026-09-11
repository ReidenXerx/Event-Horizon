---
name: gitnexus-area-e2e
description: "Skill for the E2e area of Event-Horizon. 9 symbols across 5 files."
---

# E2e

9 symbols | 5 files | Cohesion: 73%

## When to Use

- Working with code in `test/`
- Understanding how makeWorld, makeZip, makeFakeVortex work
- Modifying e2e-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `test/e2e/installDriver.e2e.test.ts` | mirroredWorld, sha, packageFrom |
| `test/e2e/fakeVortex.ts` | makeFakeVortex, complete, nexusDownload |
| `src/core/installer/bundledEntryRecovery.test.ts` | packageWith |
| `test/e2e/world.ts` | makeWorld |
| `test/makeZip.ts` | makeZip |

## Entry Points

Start here when exploring this area:

- **`makeWorld`** (Function) — `test/e2e/world.ts:78`
- **`makeZip`** (Function) — `test/makeZip.ts:13`
- **`makeFakeVortex`** (Function) — `test/e2e/fakeVortex.ts:53`
- **`complete`** (Function) — `test/e2e/fakeVortex.ts:132`
- **`nexusDownload`** (Function) — `test/e2e/fakeVortex.ts:287`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `makeWorld` | Function | `test/e2e/world.ts` | 78 |
| `makeZip` | Function | `test/makeZip.ts` | 13 |
| `makeFakeVortex` | Function | `test/e2e/fakeVortex.ts` | 53 |
| `complete` | Function | `test/e2e/fakeVortex.ts` | 132 |
| `nexusDownload` | Function | `test/e2e/fakeVortex.ts` | 287 |
| `packageWith` | Function | `src/core/installer/bundledEntryRecovery.test.ts` | 41 |
| `mirroredWorld` | Function | `test/e2e/installDriver.e2e.test.ts` | 522 |
| `sha` | Function | `test/e2e/installDriver.e2e.test.ts` | 508 |
| `packageFrom` | Function | `test/e2e/installDriver.e2e.test.ts` | 47 |

## How to Explore

1. `context({name: "makeWorld"})` — see callers and callees
2. `query({search_query: "e2e"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
