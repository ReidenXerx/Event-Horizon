---
name: gitnexus-area-components
description: "Skill for the Components area of Event-Horizon. 35 symbols across 8 files."
---

# Components

35 symbols | 8 files | Cohesion: 85%

## When to Use

- Working with code in `src/`
- Understanding how isSafeLink, MarkdownView, renderInline work
- Modifying components-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/components/Markdown.tsx` | InlineLink, MarkdownView, renderInline, flush, key (+5) |
| `src/ui/components/toastModel.ts` | findDuplicateToast, nodeToText, toastDedupKey, held, start (+5) |
| `src/ui/components/Toast.tsx` | commit, dismiss, show, ToastCard, ToastHost (+3) |
| `src/core/revealPath.ts` | loadShell, openExternalUrl |
| `src/ui/components/noInlineStyle.test.ts` | inlineStyles, styleExpression |
| `src/core/presentation/presentation.ts` | isSafeLink |
| `src/core/revealPath.test.ts` | openExternal |
| `src/ui/pages/build/NexusCollectionUpload.tsx` | action |

## Entry Points

Start here when exploring this area:

- **`isSafeLink`** (Function) — `src/core/presentation/presentation.ts:117`
- **`MarkdownView`** (Function) — `src/ui/components/Markdown.tsx:205`
- **`renderInline`** (Function) — `src/ui/components/Markdown.tsx:119`
- **`flush`** (Function) — `src/ui/components/Markdown.tsx:128`
- **`key`** (Function) — `src/ui/components/Markdown.tsx:127`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `isSafeLink` | Function | `src/core/presentation/presentation.ts` | 117 |
| `MarkdownView` | Function | `src/ui/components/Markdown.tsx` | 205 |
| `renderInline` | Function | `src/ui/components/Markdown.tsx` | 119 |
| `flush` | Function | `src/ui/components/Markdown.tsx` | 128 |
| `key` | Function | `src/ui/components/Markdown.tsx` | 127 |
| `commit` | Function | `src/ui/components/Toast.tsx` | 110 |
| `dismiss` | Function | `src/ui/components/Toast.tsx` | 124 |
| `show` | Function | `src/ui/components/Toast.tsx` | 142 |
| `findDuplicateToast` | Function | `src/ui/components/toastModel.ts` | 157 |
| `toastDedupKey` | Function | `src/ui/components/toastModel.ts` | 144 |
| `held` | Function | `src/ui/components/toastModel.ts` | 71 |
| `start` | Function | `src/ui/components/toastModel.ts` | 56 |
| `stop` | Function | `src/ui/components/toastModel.ts` | 65 |
| `openExternalUrl` | Function | `src/core/revealPath.ts` | 139 |
| `action` | Function | `src/ui/pages/build/NexusCollectionUpload.tsx` | 271 |
| `ToastProvider` | Function | `src/ui/components/Toast.tsx` | 95 |
| `createToastTimers` | Function | `src/ui/components/toastModel.ts` | 52 |
| `blocks` | Function | `src/ui/components/Markdown.tsx` | 206 |
| `parseBlocks` | Function | `src/ui/components/Markdown.tsx` | 40 |
| `flush` | Function | `src/ui/components/Markdown.tsx` | 45 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `PresentationCard → Opn` | cross_community | 5 |
| `PresentationCard → Opn` | cross_community | 5 |
| `NexusUploadDialog → Opn` | cross_community | 5 |
| `NexusUploadDialog → Opn` | cross_community | 5 |
| `NexusUploadDialog → Opn` | cross_community | 5 |
| `NexusUploadDialog → Opn` | cross_community | 5 |
| `EventHorizonMainPage → ToastCard` | cross_community | 4 |
| `PresentationCard → OpenExternal` | cross_community | 4 |
| `PresentationCard → LoadShell` | cross_community | 4 |
| `NexusUploadDialog → Describe` | cross_community | 4 |

## How to Explore

1. `context({name: "isSafeLink"})` — see callers and callees
2. `query({search_query: "components"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
