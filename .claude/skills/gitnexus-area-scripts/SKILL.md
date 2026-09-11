---
name: gitnexus-area-scripts
description: "Skill for the Scripts area of Event-Horizon. 56 symbols across 8 files."
---

# Scripts

56 symbols | 8 files | Cohesion: 84%

## When to Use

- Working with code in `scripts/`
- Understanding how parseChangedSymbols, verifyInstall, answered work
- Modifying scripts-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `scripts/bearing-verify.mjs` | checkFile, checkManifest, checkPackageGates, checkRetiredHookKeys, checkSkillsStore (+13) |
| `scripts/bearing-ci.mjs` | blastRadius, collectDiff, detectChanges, num, git (+9) |
| `scripts/bearing-token-benchmark.mjs` | answered, classicalCost, cypher, gn, graphCost (+2) |
| `scripts/bearing-agent.mjs` | loadStaleness, markRefreshOutcome, run, runAllowFail, currentBranch (+2) |
| `scripts/package-extension.js` | buildZip, crc32, collect, walk |
| `scripts/release-nexus.mjs` | fail, npm, readApiKey |
| `scripts/lib/project-tmp.mjs` | isEnospcError, withProjectTmpEnv |
| `scripts/bearing-test-order.mjs` | parseChangedSymbols |

## Entry Points

Start here when exploring this area:

- **`parseChangedSymbols`** (Function) — `scripts/bearing-test-order.mjs:81`
- **`verifyInstall`** (Function) — `scripts/bearing-verify.mjs:367`
- **`answered`** (Function) — `scripts/bearing-token-benchmark.mjs:163`
- **`isEnospcError`** (Function) — `scripts/lib/project-tmp.mjs:95`
- **`withProjectTmpEnv`** (Function) — `scripts/lib/project-tmp.mjs:25`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `parseChangedSymbols` | Function | `scripts/bearing-test-order.mjs` | 81 |
| `verifyInstall` | Function | `scripts/bearing-verify.mjs` | 367 |
| `answered` | Function | `scripts/bearing-token-benchmark.mjs` | 163 |
| `isEnospcError` | Function | `scripts/lib/project-tmp.mjs` | 95 |
| `withProjectTmpEnv` | Function | `scripts/lib/project-tmp.mjs` | 25 |
| `blastRadius` | Function | `scripts/bearing-ci.mjs` | 110 |
| `collectDiff` | Function | `scripts/bearing-ci.mjs` | 78 |
| `detectChanges` | Function | `scripts/bearing-ci.mjs` | 92 |
| `num` | Function | `scripts/bearing-ci.mjs` | 95 |
| `git` | Function | `scripts/bearing-ci.mjs` | 49 |
| `gn` | Function | `scripts/bearing-ci.mjs` | 57 |
| `main` | Function | `scripts/bearing-ci.mjs` | 331 |
| `postSticky` | Function | `scripts/bearing-ci.mjs` | 299 |
| `repoName` | Function | `scripts/bearing-ci.mjs` | 73 |
| `structural` | Function | `scripts/bearing-ci.mjs` | 125 |
| `checkFile` | Function | `scripts/bearing-verify.mjs` | 106 |
| `checkManifest` | Function | `scripts/bearing-verify.mjs` | 111 |
| `checkPackageGates` | Function | `scripts/bearing-verify.mjs` | 121 |
| `checkRetiredHookKeys` | Function | `scripts/bearing-verify.mjs` | 270 |
| `checkSkillsStore` | Function | `scripts/bearing-verify.mjs` | 292 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Main → Git` | intra_community | 3 |
| `Main → Num` | intra_community | 3 |
| `Main → Gn` | intra_community | 3 |
| `Main → ParseChangedSymbols` | intra_community | 3 |
| `VerifyInstall → ReadStealth` | intra_community | 3 |

## How to Explore

1. `context({name: "parseChangedSymbols"})` — see callers and callees
2. `query({search_query: "scripts"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
