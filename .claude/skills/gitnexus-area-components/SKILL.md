---
name: gitnexus-area-components
description: "Skill for the Components area of Event-Horizon. 20 symbols across 3 files."
---

# Components

20 symbols | 3 files | Cohesion: 94%

## When to Use

- Working with code in `src/`
- Understanding how commit, dismiss, show work
- Modifying components-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/components/toastModel.ts` | findDuplicateToast, nodeToText, toastDedupKey, held, start (+5) |
| `src/ui/components/Toast.tsx` | commit, dismiss, show, ToastCard, ToastHost (+3) |
| `src/ui/components/noInlineStyle.test.ts` | inlineStyles, styleExpression |

## Entry Points

Start here when exploring this area:

- **`commit`** (Function) — `src/ui/components/Toast.tsx:110`
- **`dismiss`** (Function) — `src/ui/components/Toast.tsx:124`
- **`show`** (Function) — `src/ui/components/Toast.tsx:142`
- **`findDuplicateToast`** (Function) — `src/ui/components/toastModel.ts:157`
- **`toastDedupKey`** (Function) — `src/ui/components/toastModel.ts:144`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `commit` | Function | `src/ui/components/Toast.tsx` | 110 |
| `dismiss` | Function | `src/ui/components/Toast.tsx` | 124 |
| `show` | Function | `src/ui/components/Toast.tsx` | 142 |
| `findDuplicateToast` | Function | `src/ui/components/toastModel.ts` | 157 |
| `toastDedupKey` | Function | `src/ui/components/toastModel.ts` | 144 |
| `held` | Function | `src/ui/components/toastModel.ts` | 71 |
| `start` | Function | `src/ui/components/toastModel.ts` | 56 |
| `stop` | Function | `src/ui/components/toastModel.ts` | 65 |
| `ToastProvider` | Function | `src/ui/components/Toast.tsx` | 95 |
| `createToastTimers` | Function | `src/ui/components/toastModel.ts` | 52 |
| `inlineStyles` | Function | `src/ui/components/noInlineStyle.test.ts` | 38 |
| `ToastInput` | Interface | `src/ui/components/Toast.tsx` | 37 |
| `arm` | Method | `src/ui/components/toastModel.ts` | 74 |
| `forget` | Method | `src/ui/components/toastModel.ts` | 115 |
| `release` | Method | `src/ui/components/toastModel.ts` | 105 |
| `nodeToText` | Function | `src/ui/components/toastModel.ts` | 165 |
| `ToastCard` | Function | `src/ui/components/Toast.tsx` | 211 |
| `ToastHost` | Function | `src/ui/components/Toast.tsx` | 190 |
| `styleExpression` | Function | `src/ui/components/noInlineStyle.test.ts` | 26 |
| `ToastInstance` | Interface | `src/ui/components/Toast.tsx` | 51 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `EventHorizonMainPage → ToastCard` | cross_community | 4 |
| `EventHorizonMainPage → CreateToastTimers` | cross_community | 3 |
| `Show → NodeToText` | intra_community | 3 |

## How to Explore

1. `context({name: "commit"})` — see callers and callees
2. `query({search_query: "components"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
