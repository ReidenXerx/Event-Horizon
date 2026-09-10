---
name: gitnexus-area-errors
description: "Skill for the Errors area of Event-Horizon. 45 symbols across 13 files."
---

# Errors

45 symbols | 13 files | Cohesion: 79%

## When to Use

- Working with code in `src/`
- Understanding how EventHorizonLogo, useErrorReporterFormatted, CollectionsPage work
- Modifying errors-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/errors/formatError.ts` | buildErrorReport, classify, classifyGenericError, classifyMultiError, classifyUnknown (+8) |
| `src/ui/errors/ErrorReportModal.tsx` | BulletList, ErrorReportModal, handleCopy, handleSave, Section (+4) |
| `src/ui/errors/ErrorBoundary.tsx` | InlineFallback, PageFallback, render, componentDidCatch |
| `src/ui/errors/ErrorContext.tsx` | useErrorReporterFormatted, onError, onRejection, report |
| `src/ui/EventHorizonMainPage.tsx` | AppShell, NavBar, RouteOutlet |
| `src/ui/pages/install/InstallPage.tsx` | InstallPage, handleCopy, copyTextToClipboard |
| `src/ui/errors/foreignError.ts` | isForeignError, stackOf, describeForeignError |
| `src/ui/components/EventHorizonLogo.tsx` | EventHorizonLogo |
| `src/ui/pages/CollectionsPage.tsx` | CollectionsPage |
| `src/ui/pages/HomePage.tsx` | HomePage |

## Entry Points

Start here when exploring this area:

- **`EventHorizonLogo`** (Function) — `src/ui/components/EventHorizonLogo.tsx:47`
- **`useErrorReporterFormatted`** (Function) — `src/ui/errors/ErrorContext.tsx:65`
- **`CollectionsPage`** (Function) — `src/ui/pages/CollectionsPage.tsx:92`
- **`HomePage`** (Function) — `src/ui/pages/HomePage.tsx:48`
- **`ModDiffsPage`** (Function) — `src/ui/pages/ModDiffsPage.tsx:67`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `EventHorizonLogo` | Function | `src/ui/components/EventHorizonLogo.tsx` | 47 |
| `useErrorReporterFormatted` | Function | `src/ui/errors/ErrorContext.tsx` | 65 |
| `CollectionsPage` | Function | `src/ui/pages/CollectionsPage.tsx` | 92 |
| `HomePage` | Function | `src/ui/pages/HomePage.tsx` | 48 |
| `ModDiffsPage` | Function | `src/ui/pages/ModDiffsPage.tsx` | 67 |
| `PluginDiffsPage` | Function | `src/ui/pages/PluginDiffsPage.tsx` | 53 |
| `BuildPage` | Function | `src/ui/pages/build/BuildPage.tsx` | 127 |
| `InstallPage` | Function | `src/ui/pages/install/InstallPage.tsx` | 50 |
| `ErrorReportModal` | Function | `src/ui/errors/ErrorReportModal.tsx` | 38 |
| `handleCopy` | Function | `src/ui/errors/ErrorReportModal.tsx` | 67 |
| `handleSave` | Function | `src/ui/errors/ErrorReportModal.tsx` | 78 |
| `buildErrorReport` | Function | `src/ui/errors/formatError.ts` | 149 |
| `onError` | Function | `src/ui/errors/ErrorContext.tsx` | 128 |
| `onRejection` | Function | `src/ui/errors/ErrorContext.tsx` | 141 |
| `report` | Function | `src/ui/errors/ErrorContext.tsx` | 106 |
| `isForeignError` | Function | `src/ui/errors/foreignError.ts` | 60 |
| `stackOf` | Function | `src/ui/errors/foreignError.ts` | 41 |
| `describeForeignError` | Function | `src/ui/errors/foreignError.ts` | 74 |
| `formatError` | Function | `src/ui/errors/formatError.ts` | 114 |
| `render` | Method | `src/ui/errors/ErrorBoundary.tsx` | 94 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `BuildPage → GetVortexUserDataPath` | cross_community | 10 |
| `HomePage → Truncate` | cross_community | 8 |
| `RouteOutlet → Fail` | cross_community | 7 |
| `RouteOutlet → Ok` | cross_community | 7 |
| `RouteOutlet → BelongsToGame` | cross_community | 7 |
| `OnError → ToPosix` | cross_community | 7 |
| `OnRejection → ToPosix` | cross_community | 7 |
| `RouteOutlet → GetActiveGameId` | cross_community | 6 |
| `RouteOutlet → ResolveProfileName` | cross_community | 6 |
| `RouteOutlet → ResolveVortexVersion` | cross_community | 6 |

## How to Explore

1. `context({name: "EventHorizonLogo"})` — see callers and callees
2. `query({search_query: "errors"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
