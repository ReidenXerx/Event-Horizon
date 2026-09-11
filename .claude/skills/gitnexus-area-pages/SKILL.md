---
name: gitnexus-area-pages
description: "Skill for the Pages area of Event-Horizon. 28 symbols across 10 files."
---

# Pages

28 symbols | 10 files | Cohesion: 74%

## When to Use

- Working with code in `src/`
- Understanding how useErrorReporterFormatted, CollectionsPage, HomePage work
- Modifying pages-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/pages/ModDiffsPage.tsx` | ModDiffsPage, ChangedModList, ChangedModRow, FieldDiffRow, TierBadge (+6) |
| `src/ui/pages/PluginDiffsPage.tsx` | PluginDiffsPage, EnabledMismatchList, PluginEntryList, PluginNameCell, PositionChangedList (+1) |
| `src/ui/EventHorizonMainPage.tsx` | AppShell, NavBar, RouteOutlet |
| `src/ui/pages/AboutPage.tsx` | handleClick, openExternal |
| `src/ui/errors/ErrorContext.tsx` | useErrorReporterFormatted |
| `src/ui/pages/CollectionsPage.tsx` | CollectionsPage |
| `src/ui/pages/HomePage.tsx` | HomePage |
| `src/ui/pages/build/BuildPage.tsx` | BuildPage |
| `src/ui/pages/install/InstallPage.tsx` | InstallPage |
| `src/ui/components/DiffSectionBlock.tsx` | DiffSectionBlock |

## Entry Points

Start here when exploring this area:

- **`useErrorReporterFormatted`** (Function) — `src/ui/errors/ErrorContext.tsx:65`
- **`CollectionsPage`** (Function) — `src/ui/pages/CollectionsPage.tsx:101`
- **`HomePage`** (Function) — `src/ui/pages/HomePage.tsx:53`
- **`ModDiffsPage`** (Function) — `src/ui/pages/ModDiffsPage.tsx:67`
- **`PluginDiffsPage`** (Function) — `src/ui/pages/PluginDiffsPage.tsx:53`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `useErrorReporterFormatted` | Function | `src/ui/errors/ErrorContext.tsx` | 65 |
| `CollectionsPage` | Function | `src/ui/pages/CollectionsPage.tsx` | 101 |
| `HomePage` | Function | `src/ui/pages/HomePage.tsx` | 53 |
| `ModDiffsPage` | Function | `src/ui/pages/ModDiffsPage.tsx` | 67 |
| `PluginDiffsPage` | Function | `src/ui/pages/PluginDiffsPage.tsx` | 53 |
| `BuildPage` | Function | `src/ui/pages/build/BuildPage.tsx` | 139 |
| `InstallPage` | Function | `src/ui/pages/install/InstallPage.tsx` | 50 |
| `DiffSectionBlock` | Function | `src/ui/components/DiffSectionBlock.tsx` | 33 |
| `AppShell` | Function | `src/ui/EventHorizonMainPage.tsx` | 88 |
| `NavBar` | Function | `src/ui/EventHorizonMainPage.tsx` | 113 |
| `RouteOutlet` | Function | `src/ui/EventHorizonMainPage.tsx` | 162 |
| `EnabledMismatchList` | Function | `src/ui/pages/PluginDiffsPage.tsx` | 339 |
| `PluginEntryList` | Function | `src/ui/pages/PluginDiffsPage.tsx` | 315 |
| `PluginNameCell` | Function | `src/ui/pages/PluginDiffsPage.tsx` | 399 |
| `PositionChangedList` | Function | `src/ui/pages/PluginDiffsPage.tsx` | 369 |
| `ReportView` | Function | `src/ui/pages/PluginDiffsPage.tsx` | 243 |
| `ChangedModList` | Function | `src/ui/pages/ModDiffsPage.tsx` | 399 |
| `ChangedModRow` | Function | `src/ui/pages/ModDiffsPage.tsx` | 433 |
| `FieldDiffRow` | Function | `src/ui/pages/ModDiffsPage.tsx` | 557 |
| `TierBadge` | Function | `src/ui/pages/ModDiffsPage.tsx` | 312 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `BuildPage → GetVortexUserDataPath` | cross_community | 10 |
| `RouteOutlet → Fail` | cross_community | 7 |
| `RouteOutlet → Ok` | cross_community | 7 |
| `RouteOutlet → ProfileId` | cross_community | 7 |
| `RouteOutlet → BelongsToGame` | cross_community | 7 |
| `RouteOutlet → GetActiveGameId` | cross_community | 6 |
| `RouteOutlet → ResolveProfileName` | cross_community | 6 |
| `RouteOutlet → ResolveVortexVersion` | cross_community | 6 |
| `BuildPage → NotifyStateChanged` | cross_community | 6 |
| `BuildPage → Truncate` | cross_community | 6 |

## How to Explore

1. `context({name: "useErrorReporterFormatted"})` — see callers and callees
2. `query({search_query: "pages"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
