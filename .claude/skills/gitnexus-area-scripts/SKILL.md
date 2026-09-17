---
name: gitnexus-area-scripts
description: "Skill for the Scripts area of Event-Horizon. 72 symbols across 13 files."
---

# Scripts

72 symbols | 13 files | Cohesion: 84%

## When to Use

- Working with code in `scripts/`
- Understanding how parseChangedSymbols, nexusClient, parseArgs work
- Modifying scripts-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `scripts/bearing-verify.mjs` | checkFile, checkManifest, checkPackageGates, checkRetiredHookKeys, checkSkillsStore (+12) |
| `scripts/bearing-ci.mjs` | blastRadius, collectDiff, detectChanges, num, git (+9) |
| `scripts/nexus-collection-file.mjs` | UsageError, makeClient, parseArgs, publish, refuseExtensionPage (+2) |
| `scripts/bearing-token-benchmark.mjs` | answered, classicalCost, cypher, gn, graphCost (+2) |
| `scripts/bearing-agent.mjs` | loadStaleness, markRefreshOutcome, run, runAllowFail, currentBranch (+2) |
| `scripts/nexus-page.mjs` | firstDifference, lineBreaksDropped, breaks, collapse, normalizeText |
| `scripts/package-extension.js` | buildZip, crc32, collect, walk |
| `scripts/nexus-collection-file.test.mjs` | fakeClient, makeClient, makeClient |
| `scripts/release-nexus.mjs` | fail, npm, readApiKey |
| `scripts/lib/project-tmp.mjs` | isEnospcError, withProjectTmpEnv |

## Entry Points

Start here when exploring this area:

- **`parseChangedSymbols`** (Function) — `scripts/bearing-test-order.mjs:81`
- **`nexusClient`** (Function) — `scripts/lib/nexusRelease.mjs:235`
- **`parseArgs`** (Function) — `scripts/nexus-collection-file.mjs:50`
- **`publish`** (Function) — `scripts/nexus-collection-file.mjs:179`
- **`refuseExtensionPage`** (Function) — `scripts/nexus-collection-file.mjs:107`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `UsageError` | Class | `scripts/nexus-collection-file.mjs` | 48 |
| `parseChangedSymbols` | Function | `scripts/bearing-test-order.mjs` | 81 |
| `nexusClient` | Function | `scripts/lib/nexusRelease.mjs` | 235 |
| `parseArgs` | Function | `scripts/nexus-collection-file.mjs` | 50 |
| `publish` | Function | `scripts/nexus-collection-file.mjs` | 179 |
| `refuseExtensionPage` | Function | `scripts/nexus-collection-file.mjs` | 107 |
| `uploadNaming` | Function | `scripts/nexus-collection-file.mjs` | 121 |
| `zipHasRootManifest` | Function | `scripts/nexus-collection-file.mjs` | 132 |
| `verifyInstall` | Function | `scripts/bearing-verify.mjs` | 367 |
| `answered` | Function | `scripts/bearing-token-benchmark.mjs` | 163 |
| `isEnospcError` | Function | `scripts/lib/project-tmp.mjs` | 95 |
| `withProjectTmpEnv` | Function | `scripts/lib/project-tmp.mjs` | 25 |
| `firstDifference` | Function | `scripts/nexus-page.mjs` | 79 |
| `lineBreaksDropped` | Function | `scripts/nexus-page.mjs` | 99 |
| `breaks` | Function | `scripts/nexus-page.mjs` | 102 |
| `collapse` | Function | `scripts/nexus-page.mjs` | 100 |
| `normalizeText` | Function | `scripts/nexus-page.mjs` | 67 |
| `blastRadius` | Function | `scripts/bearing-ci.mjs` | 110 |
| `collectDiff` | Function | `scripts/bearing-ci.mjs` | 78 |
| `detectChanges` | Function | `scripts/bearing-ci.mjs` | 92 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `EditPage → NormalizeText` | cross_community | 4 |
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
