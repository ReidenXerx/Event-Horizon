---
name: gitnexus-area-ui
description: "Skill for the Ui area of Event-Horizon. 63 symbols across 14 files."
---

# Ui

63 symbols | 14 files | Cohesion: 92%

## When to Use

- Working with code in `scripts/`
- Understanding how banner, info, nextSteps work
- Modifying ui-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `scripts/ui/fingerprint-screens.mjs` | CliError, accept, check, compare, contentBounds (+12) |
| `scripts/ui/fingerprint-screens.test.mjs` | set, workspace, run, write, background (+11) |
| `scripts/nexus-page.mjs` | connect, editPage, evalJs, send, sleep (+4) |
| `scripts/lib/setup-ui.mjs` | banner, info, nextSteps, ok, step (+2) |
| `scripts/bearing-teaching/merge-package-scripts.mjs` | isStealth, main, resolveGitnexusCmd |
| `scripts/nexus-collection-file.mjs` | log, stamp |
| `scripts/release-nexus.mjs` | info, step |
| `scripts/bearing-verify.mjs` | main |
| `scripts/nexus-collection-file.test.mjs` | log |
| `scripts/nexus-page.test.mjs` | fetchImpl |

## Entry Points

Start here when exploring this area:

- **`banner`** (Function) — `scripts/lib/setup-ui.mjs:19`
- **`info`** (Function) — `scripts/lib/setup-ui.mjs:51`
- **`nextSteps`** (Function) — `scripts/lib/setup-ui.mjs:76`
- **`ok`** (Function) — `scripts/lib/setup-ui.mjs:39`
- **`step`** (Function) — `scripts/lib/setup-ui.mjs:35`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `banner` | Function | `scripts/lib/setup-ui.mjs` | 19 |
| `info` | Function | `scripts/lib/setup-ui.mjs` | 51 |
| `nextSteps` | Function | `scripts/lib/setup-ui.mjs` | 76 |
| `ok` | Function | `scripts/lib/setup-ui.mjs` | 39 |
| `step` | Function | `scripts/lib/setup-ui.mjs` | 35 |
| `summaryTable` | Function | `scripts/lib/setup-ui.mjs` | 58 |
| `warn` | Function | `scripts/lib/setup-ui.mjs` | 43 |
| `firstDifference` | Function | `scripts/nexus-page.mjs` | 72 |
| `normalizeText` | Function | `scripts/nexus-page.mjs` | 60 |
| `withNewTab` | Function | `scripts/nexus-page.mjs` | 39 |
| `compare` | Function | `scripts/ui/fingerprint-screens.mjs` | 189 |
| `contentBounds` | Function | `scripts/ui/fingerprint-screens.mjs` | 127 |
| `decodePng` | Function | `scripts/ui/fingerprint-screens.mjs` | 54 |
| `deserialise` | Function | `scripts/ui/fingerprint-screens.mjs` | 247 |
| `fingerprint` | Function | `scripts/ui/fingerprint-screens.mjs` | 155 |
| `main` | Function | `scripts/ui/fingerprint-screens.mjs` | 394 |
| `log` | Function | `scripts/ui/fingerprint-screens.mjs` | 394 |
| `serialise` | Function | `scripts/ui/fingerprint-screens.mjs` | 238 |
| `EventHorizonMainPage` | Function | `src/ui/EventHorizonMainPage.tsx` | 65 |
| `ErrorProvider` | Function | `src/ui/errors/ErrorContext.tsx` | 85 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Main → Sub` | cross_community | 5 |
| `Main → GateCommentKey` | cross_community | 5 |
| `Accept → RgbOffsets` | intra_community | 5 |
| `EventHorizonMainPage → Spinner` | cross_community | 5 |
| `Check → RgbOffsets` | intra_community | 5 |
| `EventHorizonMainPage → ToastCard` | cross_community | 4 |
| `EventHorizonMainPage → Modal` | cross_community | 4 |
| `EventHorizonMainPage → BuildErrorReport` | cross_community | 4 |
| `EventHorizonMainPage → UseApiOptional` | cross_community | 4 |
| `Banner → Stamp` | intra_community | 3 |

## How to Explore

1. `context({name: "banner"})` — see callers and callees
2. `query({search_query: "ui"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
