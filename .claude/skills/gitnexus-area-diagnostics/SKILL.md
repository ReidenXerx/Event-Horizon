---
name: gitnexus-area-diagnostics
description: "Skill for the Diagnostics area of Event-Horizon. 9 symbols across 2 files."
---

# Diagnostics

9 symbols | 2 files | Cohesion: 83%

## When to Use

- Working with code in `src/`
- Understanding how writeLogBundle, entries, crc32 work
- Modifying diagnostics-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/diagnostics/logBundle.ts` | writeLogBundle, entries, collectLogSources, add, inEh (+1) |
| `src/core/diagnostics/zipWriter.ts` | crc32, dosDateTime, writeZip |

## Entry Points

Start here when exploring this area:

- **`writeLogBundle`** (Function) — `src/core/diagnostics/logBundle.ts:117`
- **`entries`** (Function) — `src/core/diagnostics/logBundle.ts:125`
- **`crc32`** (Function) — `src/core/diagnostics/zipWriter.ts:29`
- **`writeZip`** (Function) — `src/core/diagnostics/zipWriter.ts:58`
- **`collectLogSources`** (Function) — `src/core/diagnostics/logBundle.ts:80`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `writeLogBundle` | Function | `src/core/diagnostics/logBundle.ts` | 117 |
| `entries` | Function | `src/core/diagnostics/logBundle.ts` | 125 |
| `crc32` | Function | `src/core/diagnostics/zipWriter.ts` | 29 |
| `writeZip` | Function | `src/core/diagnostics/zipWriter.ts` | 58 |
| `collectLogSources` | Function | `src/core/diagnostics/logBundle.ts` | 80 |
| `add` | Function | `src/core/diagnostics/logBundle.ts` | 83 |
| `inEh` | Function | `src/core/diagnostics/logBundle.ts` | 94 |
| `dosDateTime` | Function | `src/core/diagnostics/zipWriter.ts` | 35 |
| `filesUnder` | Function | `src/core/diagnostics/logBundle.ts` | 60 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `WriteZip → Write` | cross_community | 3 |
| `WriteZip → Write` | cross_community | 3 |
| `WriteZip → Write` | cross_community | 3 |
| `WriteZip → Write` | cross_community | 3 |
| `CollectLogSources → ToPosix` | cross_community | 3 |

## How to Explore

1. `context({name: "writeLogBundle"})` — see callers and callees
2. `query({search_query: "diagnostics"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
