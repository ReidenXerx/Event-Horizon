---
name: gitnexus-area-components
description: "Skill for the Components area of Event-Horizon. 24 symbols across 7 files."
---

# Components

24 symbols | 7 files | Cohesion: 88%

## When to Use

- Working with code in `src/`
- Understanding how arm, handle, clearTimer work
- Modifying components-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/components/Toast.tsx` | arm, handle, clearTimer, commit, dismiss (+9) |
| `src/ui/components/Field.tsx` | Checkbox, ChoiceControl, Radio, useIndeterminate |
| `src/ui/components/noInlineStyle.test.ts` | inlineStyles, styleExpression |
| `src/ui/EventHorizonMainPage.tsx` | EventHorizonMainPage |
| `src/ui/errors/ErrorContext.tsx` | ErrorProvider |
| `src/ui/state/ApiContext.tsx` | ApiProvider |
| `src/ui/theme/EventHorizonStyles.tsx` | EventHorizonStyles |

## Entry Points

Start here when exploring this area:

- **`arm`** (Function) — `src/ui/components/Toast.tsx:130`
- **`handle`** (Function) — `src/ui/components/Toast.tsx:140`
- **`clearTimer`** (Function) — `src/ui/components/Toast.tsx:113`
- **`commit`** (Function) — `src/ui/components/Toast.tsx:108`
- **`dismiss`** (Function) — `src/ui/components/Toast.tsx:122`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `arm` | Function | `src/ui/components/Toast.tsx` | 130 |
| `handle` | Function | `src/ui/components/Toast.tsx` | 140 |
| `clearTimer` | Function | `src/ui/components/Toast.tsx` | 113 |
| `commit` | Function | `src/ui/components/Toast.tsx` | 108 |
| `dismiss` | Function | `src/ui/components/Toast.tsx` | 122 |
| `resume` | Function | `src/ui/components/Toast.tsx` | 155 |
| `show` | Function | `src/ui/components/Toast.tsx` | 164 |
| `EventHorizonMainPage` | Function | `src/ui/EventHorizonMainPage.tsx` | 65 |
| `ToastProvider` | Function | `src/ui/components/Toast.tsx` | 92 |
| `ErrorProvider` | Function | `src/ui/errors/ErrorContext.tsx` | 85 |
| `ApiProvider` | Function | `src/ui/state/ApiContext.tsx` | 25 |
| `EventHorizonStyles` | Function | `src/ui/theme/EventHorizonStyles.tsx` | 47 |
| `Checkbox` | Function | `src/ui/components/Field.tsx` | 217 |
| `Radio` | Function | `src/ui/components/Field.tsx` | 224 |
| `inlineStyles` | Function | `src/ui/components/noInlineStyle.test.ts` | 38 |
| `ToastInput` | Interface | `src/ui/components/Toast.tsx` | 27 |
| `nodeToText` | Function | `src/ui/components/Toast.tsx` | 232 |
| `toastDedupKey` | Function | `src/ui/components/Toast.tsx` | 223 |
| `ToastCard` | Function | `src/ui/components/Toast.tsx` | 265 |
| `ToastHost` | Function | `src/ui/components/Toast.tsx` | 244 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `EventHorizonMainPage → Spinner` | cross_community | 5 |
| `EventHorizonMainPage → ToastCard` | intra_community | 4 |
| `EventHorizonMainPage → Modal` | cross_community | 4 |
| `EventHorizonMainPage → BuildErrorReport` | cross_community | 4 |
| `EventHorizonMainPage → UseApiOptional` | cross_community | 4 |
| `DataTable → UseIndeterminate` | cross_community | 4 |
| `PrerequisitesCard → UseIndeterminate` | cross_community | 4 |
| `Show → ClearTimer` | intra_community | 3 |
| `Show → NodeToText` | intra_community | 3 |

## How to Explore

1. `context({name: "arm"})` — see callers and callees
2. `query({search_query: "components"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
