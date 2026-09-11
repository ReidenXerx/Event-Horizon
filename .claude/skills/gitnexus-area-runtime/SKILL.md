---
name: gitnexus-area-runtime
description: "Skill for the Runtime area of Event-Horizon. 30 symbols across 13 files."
---

# Runtime

30 symbols | 13 files | Cohesion: 87%

## When to Use

- Working with code in `src/`
- Understanding how getEHRuntime, runtime, verify work
- Modifying runtime-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/runtime/detectRuntimes.ts` | detectRuntimes, probeDirectX9, probeDotNet48, probeDotNetDesktop8, probeVcRedist (+1) |
| `src/core/runtime/nodePrereqDeps.ts` | run, download, finish, armStall, go |
| `src/ui/runtime/ehRuntime.ts` | EHRuntime, getEHRuntime, setInstallBusy |
| `src/ui/pages/install/installSession.ts` | cancelInstall, getSnapshot, notify |
| `src/ui/pages/curator/curatorSession.ts` | begin, finish |
| `src/core/curator/bulkUpdate.test.ts` | verify, ok |
| `src/core/runtime/installPrerequisites.ts` | installPrerequisites, summarisePrereqResults |
| `src/core/runtime/prerequisites.ts` | classifyExitCode, verdictIsGood |
| `src/ui/runtime/useEHRuntime.ts` | runtime |
| `src/core/curator/bulkUpdate.ts` | verify |

## Entry Points

Start here when exploring this area:

- **`getEHRuntime`** (Function) — `src/ui/runtime/ehRuntime.ts:79`
- **`runtime`** (Function) — `src/ui/runtime/useEHRuntime.ts:14`
- **`verify`** (Function) — `src/core/curator/bulkUpdate.ts:120`
- **`installPrerequisites`** (Function) — `src/core/runtime/installPrerequisites.ts:85`
- **`summarisePrereqResults`** (Function) — `src/core/runtime/installPrerequisites.ts:217`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `getEHRuntime` | Function | `src/ui/runtime/ehRuntime.ts` | 79 |
| `runtime` | Function | `src/ui/runtime/useEHRuntime.ts` | 14 |
| `verify` | Function | `src/core/curator/bulkUpdate.ts` | 120 |
| `installPrerequisites` | Function | `src/core/runtime/installPrerequisites.ts` | 85 |
| `summarisePrereqResults` | Function | `src/core/runtime/installPrerequisites.ts` | 217 |
| `classifyExitCode` | Function | `src/core/runtime/prerequisites.ts` | 154 |
| `verdictIsGood` | Function | `src/core/runtime/prerequisites.ts` | 186 |
| `detectRuntimes` | Function | `src/core/runtime/detectRuntimes.ts` | 214 |
| `describeRuntimeFindings` | Function | `src/core/runtime/detectRuntimes.ts` | 265 |
| `runtimeLines` | Function | `src/ui/pages/install/steps.tsx` | 540 |
| `EHRuntime` | Class | `src/ui/runtime/ehRuntime.ts` | 38 |
| `verify` | Function | `src/core/curator/bulkUpdate.test.ts` | 72 |
| `ok` | Function | `src/core/curator/bulkUpdate.test.ts` | 28 |
| `run` | Function | `src/core/runtime/installPrerequisites.test.ts` | 192 |
| `run` | Function | `src/core/runtime/nodePrereqDeps.ts` | 165 |
| `only` | Function | `src/core/runtime/detectRuntimes.test.ts` | 41 |
| `probeDirectX9` | Function | `src/core/runtime/detectRuntimes.ts` | 179 |
| `probeDotNet48` | Function | `src/core/runtime/detectRuntimes.ts` | 122 |
| `probeDotNetDesktop8` | Function | `src/core/runtime/detectRuntimes.ts` | 158 |
| `probeVcRedist` | Function | `src/core/runtime/detectRuntimes.ts` | 87 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `RunEnvironmentGate → EHRuntime` | cross_community | 8 |
| `RunEnvironmentGate → Notify` | cross_community | 8 |
| `RunEnvironmentGate → GetSnapshot` | cross_community | 7 |
| `Heal → EHRuntime` | cross_community | 6 |
| `Heal → Notify` | cross_community | 6 |
| `Heal → GetSnapshot` | cross_community | 5 |
| `Session → EHRuntime` | cross_community | 5 |
| `OpenConfirm → EHRuntime` | cross_community | 5 |
| `OpenConfirm → Notify` | cross_community | 5 |
| `ResolveStaleReceipt → EHRuntime` | cross_community | 5 |

## How to Explore

1. `context({name: "getEHRuntime"})` — see callers and callees
2. `query({search_query: "runtime"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
