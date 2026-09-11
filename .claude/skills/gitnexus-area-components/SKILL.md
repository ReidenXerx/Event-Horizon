---
name: gitnexus-area-components
description: "Skill for the Components area of Event-Horizon. 21 symbols across 6 files."
---

# Components

21 symbols | 6 files | Cohesion: 88%

## When to Use

- Working with code in `src/`
- Understanding how arm, handle, clearTimer work
- Modifying components-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/components/Toast.tsx` | arm, handle, clearTimer, dismiss, resume (+8) |
| `src/ui/components/Field.tsx` | Checkbox, ChoiceControl, Radio, useIndeterminate |
| `src/ui/EventHorizonMainPage.tsx` | EventHorizonMainPage |
| `src/ui/errors/ErrorContext.tsx` | ErrorProvider |
| `src/ui/state/ApiContext.tsx` | ApiProvider |
| `src/ui/theme/EventHorizonStyles.tsx` | EventHorizonStyles |

## Entry Points

Start here when exploring this area:

- **`arm`** (Function) — `src/ui/components/Toast.tsx:114`
- **`handle`** (Function) — `src/ui/components/Toast.tsx:117`
- **`clearTimer`** (Function) — `src/ui/components/Toast.tsx:97`
- **`dismiss`** (Function) — `src/ui/components/Toast.tsx:106`
- **`resume`** (Function) — `src/ui/components/Toast.tsx:132`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `arm` | Function | `src/ui/components/Toast.tsx` | 114 |
| `handle` | Function | `src/ui/components/Toast.tsx` | 117 |
| `clearTimer` | Function | `src/ui/components/Toast.tsx` | 97 |
| `dismiss` | Function | `src/ui/components/Toast.tsx` | 106 |
| `resume` | Function | `src/ui/components/Toast.tsx` | 132 |
| `show` | Function | `src/ui/components/Toast.tsx` | 141 |
| `EventHorizonMainPage` | Function | `src/ui/EventHorizonMainPage.tsx` | 65 |
| `ToastProvider` | Function | `src/ui/components/Toast.tsx` | 92 |
| `ErrorProvider` | Function | `src/ui/errors/ErrorContext.tsx` | 85 |
| `ApiProvider` | Function | `src/ui/state/ApiContext.tsx` | 25 |
| `EventHorizonStyles` | Function | `src/ui/theme/EventHorizonStyles.tsx` | 47 |
| `Checkbox` | Function | `src/ui/components/Field.tsx` | 216 |
| `Radio` | Function | `src/ui/components/Field.tsx` | 223 |
| `ToastInput` | Interface | `src/ui/components/Toast.tsx` | 27 |
| `nodeToText` | Function | `src/ui/components/Toast.tsx` | 217 |
| `toastDedupKey` | Function | `src/ui/components/Toast.tsx` | 208 |
| `ToastCard` | Function | `src/ui/components/Toast.tsx` | 250 |
| `ToastHost` | Function | `src/ui/components/Toast.tsx` | 229 |
| `ChoiceControl` | Function | `src/ui/components/Field.tsx` | 179 |
| `useIndeterminate` | Function | `src/ui/components/Field.tsx` | 170 |

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
