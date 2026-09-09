---
name: gitnexus-area-cluster-46
description: "Skill for the Cluster_46 area of Event-Horizon. 5 symbols across 1 files."
---

# Cluster_46

5 symbols | 1 files | Cohesion: 80%

## When to Use

- Working with code in `scripts/`
- Understanding how dfMount, enospcHelp, getProjectTmpDir work
- Modifying cluster_46-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `scripts/lib/project-tmp.mjs` | dfMount, enospcHelp, getProjectTmpDir, parseUsePct, tmpSpaceReport |

## Entry Points

Start here when exploring this area:

- **`dfMount`** (Function) — `scripts/lib/project-tmp.mjs:34`
- **`enospcHelp`** (Function) — `scripts/lib/project-tmp.mjs:104`
- **`getProjectTmpDir`** (Function) — `scripts/lib/project-tmp.mjs:15`
- **`parseUsePct`** (Function) — `scripts/lib/project-tmp.mjs:57`
- **`tmpSpaceReport`** (Function) — `scripts/lib/project-tmp.mjs:65`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `dfMount` | Function | `scripts/lib/project-tmp.mjs` | 34 |
| `enospcHelp` | Function | `scripts/lib/project-tmp.mjs` | 104 |
| `getProjectTmpDir` | Function | `scripts/lib/project-tmp.mjs` | 15 |
| `parseUsePct` | Function | `scripts/lib/project-tmp.mjs` | 57 |
| `tmpSpaceReport` | Function | `scripts/lib/project-tmp.mjs` | 65 |

## How to Explore

1. `context({name: "dfMount"})` — see callers and callees
2. `query({search_query: "cluster_46"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
