---
name: gitnexus-area-ui
description: "Skill for the Ui area of Event-Horizon. 63 symbols across 13 files."
---

# Ui

63 symbols | 13 files | Cohesion: 88%

## When to Use

- Working with code in `scripts/`
- Understanding how banner, info, nextSteps work
- Modifying ui-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `scripts/ui/fingerprint-screens.mjs` | CliError, accept, check, compare, contentBounds (+12) |
| `scripts/ui/fingerprint-screens.test.mjs` | set, run, background, base, chunk (+9) |
| `scripts/nexus-page.mjs` | connect, editPage, evalJs, readPage, send (+6) |
| `scripts/lib/setup-ui.mjs` | banner, info, nextSteps, ok, step (+2) |
| `src/ui/EventHorizonMainPage.tsx` | AppShell, NavBar, EventHorizonMainPage |
| `scripts/nexus-collection-file.mjs` | log, stamp |
| `scripts/release-nexus.mjs` | info, step |
| `src/ui/runtime/routeRequest.ts` | subscribe, take |
| `scripts/bearing-verify.mjs` | main |
| `scripts/nexus-collection-file.test.mjs` | log |

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
| `parseArgs` | Function | `scripts/nexus-page.mjs` | 127 |
| `value` | Function | `scripts/nexus-page.mjs` | 128 |
| `withNewTab` | Function | `scripts/nexus-page.mjs` | 57 |
| `compare` | Function | `scripts/ui/fingerprint-screens.mjs` | 189 |
| `contentBounds` | Function | `scripts/ui/fingerprint-screens.mjs` | 127 |
| `decodePng` | Function | `scripts/ui/fingerprint-screens.mjs` | 54 |
| `deserialise` | Function | `scripts/ui/fingerprint-screens.mjs` | 247 |
| `fingerprint` | Function | `scripts/ui/fingerprint-screens.mjs` | 155 |
| `main` | Function | `scripts/ui/fingerprint-screens.mjs` | 394 |
| `log` | Function | `scripts/ui/fingerprint-screens.mjs` | 394 |
| `serialise` | Function | `scripts/ui/fingerprint-screens.mjs` | 238 |
| `EventHorizonMainPage` | Function | `src/ui/EventHorizonMainPage.tsx` | 66 |
| `ErrorProvider` | Function | `src/ui/errors/ErrorContext.tsx` | 85 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `EventHorizonMainPage → Spinner` | cross_community | 5 |
| `EditPage → NormalizeText` | cross_community | 4 |
| `EventHorizonMainPage → Noop` | cross_community | 4 |
| `EventHorizonMainPage → ToastCard` | cross_community | 4 |
| `EventHorizonMainPage → Modal` | cross_community | 4 |
| `EventHorizonMainPage → BuildErrorReport` | cross_community | 4 |
| `EventHorizonMainPage → UseApiOptional` | cross_community | 4 |
| `Banner → Stamp` | intra_community | 3 |
| `Banner → Log` | intra_community | 3 |
| `EventHorizonMainPage → CreateToastTimers` | cross_community | 3 |

## How to Explore

1. `context({name: "banner"})` — see callers and callees
2. `query({search_query: "ui"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
