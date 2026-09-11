---
name: gitnexus-area-errors
description: "Skill for the Errors area of Event-Horizon. 19 symbols across 4 files."
---

# Errors

19 symbols | 4 files | Cohesion: 82%

## When to Use

- Working with code in `src/`
- Understanding how onError, onRejection, report work
- Modifying errors-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/errors/formatError.ts` | classify, classifyGenericError, classifyMultiError, classifyUnknown, cleanStack (+7) |
| `src/ui/errors/ErrorContext.tsx` | onError, onRejection, report |
| `src/ui/errors/foreignError.ts` | isForeignError, stackOf, describeForeignError |
| `src/ui/errors/ErrorBoundary.tsx` | componentDidCatch |

## Entry Points

Start here when exploring this area:

- **`onError`** (Function) — `src/ui/errors/ErrorContext.tsx:128`
- **`onRejection`** (Function) — `src/ui/errors/ErrorContext.tsx:141`
- **`report`** (Function) — `src/ui/errors/ErrorContext.tsx:106`
- **`isForeignError`** (Function) — `src/ui/errors/foreignError.ts:60`
- **`stackOf`** (Function) — `src/ui/errors/foreignError.ts:41`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `onError` | Function | `src/ui/errors/ErrorContext.tsx` | 128 |
| `onRejection` | Function | `src/ui/errors/ErrorContext.tsx` | 141 |
| `report` | Function | `src/ui/errors/ErrorContext.tsx` | 106 |
| `isForeignError` | Function | `src/ui/errors/foreignError.ts` | 60 |
| `stackOf` | Function | `src/ui/errors/foreignError.ts` | 41 |
| `describeForeignError` | Function | `src/ui/errors/foreignError.ts` | 74 |
| `formatError` | Function | `src/ui/errors/formatError.ts` | 114 |
| `componentDidCatch` | Method | `src/ui/errors/ErrorBoundary.tsx` | 78 |
| `classify` | Function | `src/ui/errors/formatError.ts` | 212 |
| `classifyGenericError` | Function | `src/ui/errors/formatError.ts` | 390 |
| `classifyMultiError` | Function | `src/ui/errors/formatError.ts` | 373 |
| `classifyUnknown` | Function | `src/ui/errors/formatError.ts` | 406 |
| `cleanStack` | Function | `src/ui/errors/formatError.ts` | 509 |
| `countProblems` | Function | `src/ui/errors/formatError.ts` | 313 |
| `guessGenericHints` | Function | `src/ui/errors/formatError.ts` | 467 |
| `guessGenericTitle` | Function | `src/ui/errors/formatError.ts` | 426 |
| `manifestHints` | Function | `src/ui/errors/formatError.ts` | 346 |
| `summarizeManifestProblems` | Function | `src/ui/errors/formatError.ts` | 331 |
| `pickStringContext` | Function | `src/ui/errors/formatError.ts` | 525 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `OnError → ToPosix` | cross_community | 7 |
| `OnRejection → ToPosix` | cross_community | 7 |
| `InstallFromLink → ToPosix` | cross_community | 7 |
| `OnError → GuessGenericHints` | cross_community | 6 |
| `OnError → GuessGenericTitle` | cross_community | 6 |
| `OnError → CountProblems` | cross_community | 6 |
| `OnRejection → GuessGenericHints` | cross_community | 6 |
| `OnRejection → GuessGenericTitle` | cross_community | 6 |
| `OnRejection → CountProblems` | cross_community | 6 |
| `InstallFromLink → GuessGenericHints` | cross_community | 6 |

## How to Explore

1. `context({name: "onError"})` — see callers and callees
2. `query({search_query: "errors"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
