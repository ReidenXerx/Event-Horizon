---
name: gitnexus-area-scripts
description: "Skill for the Scripts area of Event-Horizon. 72 symbols across 12 files."
---

# Scripts

72 symbols | 12 files | Cohesion: 85%

## When to Use

- Working with code in `scripts/`
- Understanding how nexusClient, parseArgs, publish work
- Modifying scripts-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `scripts/bearing-verify.mjs` | checkFile, checkManifest, checkPackageGates, checkRetiredHookKeys, checkSkillsStore (+12) |
| `scripts/bearing-ci.mjs` | blastRadius, collectDiff, detectChanges, num, git (+9) |
| `scripts/nexus-collection-file.mjs` | UsageError, makeClient, parseArgs, publish, refuseExtensionPage (+2) |
| `scripts/bearing-token-benchmark.mjs` | answered, classicalCost, cypher, gn, graphCost (+2) |
| `scripts/loc.py` | code_lines, count, human, main, tracked |
| `scripts/nexus-page.mjs` | firstDifference, lineBreaksDropped, breaks, collapse, normalizeText |
| `scripts/bearing-agent.mjs` | currentBranch, git, resolveBaseRef, run, runAllowFail |
| `scripts/package-extension.js` | buildZip, crc32, collect, walk |
| `scripts/nexus-collection-file.test.mjs` | fakeClient, makeClient, makeClient |
| `scripts/release-nexus.mjs` | fail, npm, readApiKey |

## Entry Points

Start here when exploring this area:

- **`nexusClient`** (Function) — `scripts/lib/nexusRelease.mjs:235`
- **`parseArgs`** (Function) — `scripts/nexus-collection-file.mjs:50`
- **`publish`** (Function) — `scripts/nexus-collection-file.mjs:179`
- **`refuseExtensionPage`** (Function) — `scripts/nexus-collection-file.mjs:107`
- **`uploadNaming`** (Function) — `scripts/nexus-collection-file.mjs:121`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `UsageError` | Class | `scripts/nexus-collection-file.mjs` | 48 |
| `nexusClient` | Function | `scripts/lib/nexusRelease.mjs` | 235 |
| `parseArgs` | Function | `scripts/nexus-collection-file.mjs` | 50 |
| `publish` | Function | `scripts/nexus-collection-file.mjs` | 179 |
| `refuseExtensionPage` | Function | `scripts/nexus-collection-file.mjs` | 107 |
| `uploadNaming` | Function | `scripts/nexus-collection-file.mjs` | 121 |
| `zipHasRootManifest` | Function | `scripts/nexus-collection-file.mjs` | 132 |
| `verifyInstall` | Function | `scripts/bearing-verify.mjs` | 367 |
| `answered` | Function | `scripts/bearing-token-benchmark.mjs` | 163 |
| `code_lines` | Function | `scripts/loc.py` | 71 |
| `count` | Function | `scripts/loc.py` | 126 |
| `human` | Function | `scripts/loc.py` | 139 |
| `main` | Function | `scripts/loc.py` | 143 |
| `tracked` | Function | `scripts/loc.py` | 57 |
| `firstDifference` | Function | `scripts/nexus-page.mjs` | 90 |
| `lineBreaksDropped` | Function | `scripts/nexus-page.mjs` | 110 |
| `breaks` | Function | `scripts/nexus-page.mjs` | 113 |
| `collapse` | Function | `scripts/nexus-page.mjs` | 111 |
| `normalizeText` | Function | `scripts/nexus-page.mjs` | 78 |
| `blastRadius` | Function | `scripts/bearing-ci.mjs` | 110 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `EditPage → NormalizeText` | cross_community | 4 |
| `Main → Git` | intra_community | 3 |
| `Main → Num` | intra_community | 3 |
| `Main → Gn` | intra_community | 3 |
| `VerifyInstall → ReadStealth` | intra_community | 3 |

## How to Explore

1. `context({name: "nexusClient"})` — see callers and callees
2. `query({search_query: "scripts"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
