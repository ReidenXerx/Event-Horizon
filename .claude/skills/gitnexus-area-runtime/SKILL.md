---
name: gitnexus-area-runtime
description: "Skill for the Runtime area of Event-Horizon. 21 symbols across 9 files."
---

# Runtime

21 symbols | 9 files | Cohesion: 92%

## When to Use

- Working with code in `src/`
- Understanding how verify, installPrerequisites, summarisePrereqResults work
- Modifying runtime-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/runtime/detectRuntimes.ts` | detectRuntimes, probeDirectX9, probeDotNet48, probeDotNetDesktop8, probeVcRedist (+1) |
| `src/core/runtime/nodePrereqDeps.ts` | run, download, finish, armStall, go |
| `src/core/curator/bulkUpdate.test.ts` | verify, ok |
| `src/core/runtime/installPrerequisites.ts` | installPrerequisites, summarisePrereqResults |
| `src/core/runtime/prerequisites.ts` | classifyExitCode, verdictIsGood |
| `src/core/curator/bulkUpdate.ts` | verify |
| `src/core/runtime/installPrerequisites.test.ts` | run |
| `src/core/runtime/detectRuntimes.test.ts` | only |
| `src/ui/pages/install/steps.tsx` | runtimeLines |

## Entry Points

Start here when exploring this area:

- **`verify`** (Function) — `src/core/curator/bulkUpdate.ts:120`
- **`installPrerequisites`** (Function) — `src/core/runtime/installPrerequisites.ts:85`
- **`summarisePrereqResults`** (Function) — `src/core/runtime/installPrerequisites.ts:217`
- **`classifyExitCode`** (Function) — `src/core/runtime/prerequisites.ts:154`
- **`verdictIsGood`** (Function) — `src/core/runtime/prerequisites.ts:186`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `verify` | Function | `src/core/curator/bulkUpdate.ts` | 120 |
| `installPrerequisites` | Function | `src/core/runtime/installPrerequisites.ts` | 85 |
| `summarisePrereqResults` | Function | `src/core/runtime/installPrerequisites.ts` | 217 |
| `classifyExitCode` | Function | `src/core/runtime/prerequisites.ts` | 154 |
| `verdictIsGood` | Function | `src/core/runtime/prerequisites.ts` | 186 |
| `detectRuntimes` | Function | `src/core/runtime/detectRuntimes.ts` | 214 |
| `describeRuntimeFindings` | Function | `src/core/runtime/detectRuntimes.ts` | 265 |
| `runtimeLines` | Function | `src/ui/pages/install/steps.tsx` | 540 |
| `verify` | Function | `src/core/curator/bulkUpdate.test.ts` | 72 |
| `ok` | Function | `src/core/curator/bulkUpdate.test.ts` | 28 |
| `run` | Function | `src/core/runtime/installPrerequisites.test.ts` | 192 |
| `run` | Function | `src/core/runtime/nodePrereqDeps.ts` | 165 |
| `only` | Function | `src/core/runtime/detectRuntimes.test.ts` | 41 |
| `probeDirectX9` | Function | `src/core/runtime/detectRuntimes.ts` | 179 |
| `probeDotNet48` | Function | `src/core/runtime/detectRuntimes.ts` | 122 |
| `probeDotNetDesktop8` | Function | `src/core/runtime/detectRuntimes.ts` | 158 |
| `probeVcRedist` | Function | `src/core/runtime/detectRuntimes.ts` | 87 |
| `download` | Function | `src/core/runtime/nodePrereqDeps.ts` | 45 |
| `finish` | Function | `src/core/runtime/nodePrereqDeps.ts` | 53 |
| `armStall` | Function | `src/core/runtime/nodePrereqDeps.ts` | 89 |

## How to Explore

1. `context({name: "verify"})` — see callers and callees
2. `query({search_query: "runtime"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
