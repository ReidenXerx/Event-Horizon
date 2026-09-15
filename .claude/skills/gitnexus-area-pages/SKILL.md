---
name: gitnexus-area-pages
description: "Skill for the Pages area of Event-Horizon. 29 symbols across 11 files."
---

# Pages

29 symbols | 11 files | Cohesion: 73%

## When to Use

- Working with code in `src/`
- Understanding how useErrorReporterFormatted, CollectionsPage, HomePage work
- Modifying pages-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/pages/ModDiffsPage.tsx` | ModDiffsPage, MatchedModList, ModEntryList, ReportView, SnapshotMeta (+6) |
| `src/ui/pages/PluginDiffsPage.tsx` | PluginDiffsPage, EnabledMismatchList, PluginEntryList, PluginNameCell, PositionChangedList (+1) |
| `src/ui/EventHorizonMainPage.tsx` | AppShell, NavBar, RouteOutlet |
| `src/ui/pages/AboutPage.tsx` | handleClick, openExternal |
| `src/ui/errors/ErrorContext.tsx` | useErrorReporterFormatted |
| `src/ui/pages/CollectionsPage.tsx` | CollectionsPage |
| `src/ui/pages/HomePage.tsx` | HomePage |
| `src/ui/pages/build/BuildPage.tsx` | BuildPage |
| `src/ui/pages/install/InstallPage.tsx` | InstallPage |
| `src/ui/components/ChangelogView.tsx` | ChangeGroup |

## Entry Points

Start here when exploring this area:

- **`useErrorReporterFormatted`** (Function) — `src/ui/errors/ErrorContext.tsx:65`
- **`CollectionsPage`** (Function) — `src/ui/pages/CollectionsPage.tsx:109`
- **`HomePage`** (Function) — `src/ui/pages/HomePage.tsx:54`
- **`ModDiffsPage`** (Function) — `src/ui/pages/ModDiffsPage.tsx:67`
- **`PluginDiffsPage`** (Function) — `src/ui/pages/PluginDiffsPage.tsx:53`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `useErrorReporterFormatted` | Function | `src/ui/errors/ErrorContext.tsx` | 65 |
| `CollectionsPage` | Function | `src/ui/pages/CollectionsPage.tsx` | 109 |
| `HomePage` | Function | `src/ui/pages/HomePage.tsx` | 54 |
| `ModDiffsPage` | Function | `src/ui/pages/ModDiffsPage.tsx` | 67 |
| `PluginDiffsPage` | Function | `src/ui/pages/PluginDiffsPage.tsx` | 53 |
| `BuildPage` | Function | `src/ui/pages/build/BuildPage.tsx` | 157 |
| `InstallPage` | Function | `src/ui/pages/install/InstallPage.tsx` | 53 |
| `DiffSectionBlock` | Function | `src/ui/components/DiffSectionBlock.tsx` | 33 |
| `AppShell` | Function | `src/ui/EventHorizonMainPage.tsx` | 88 |
| `NavBar` | Function | `src/ui/EventHorizonMainPage.tsx` | 113 |
| `RouteOutlet` | Function | `src/ui/EventHorizonMainPage.tsx` | 162 |
| `ChangeGroup` | Function | `src/ui/components/ChangelogView.tsx` | 69 |
| `MatchedModList` | Function | `src/ui/pages/ModDiffsPage.tsx` | 528 |
| `ModEntryList` | Function | `src/ui/pages/ModDiffsPage.tsx` | 374 |
| `ReportView` | Function | `src/ui/pages/ModDiffsPage.tsx` | 255 |
| `SnapshotMeta` | Function | `src/ui/pages/ModDiffsPage.tsx` | 346 |
| `ChangedModList` | Function | `src/ui/pages/ModDiffsPage.tsx` | 403 |
| `ChangedModRow` | Function | `src/ui/pages/ModDiffsPage.tsx` | 437 |
| `FieldDiffRow` | Function | `src/ui/pages/ModDiffsPage.tsx` | 561 |
| `TierBadge` | Function | `src/ui/pages/ModDiffsPage.tsx` | 316 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `BuildPage → GetVortexUserDataPath` | cross_community | 10 |
| `BuildPage → NotifyStateChanged` | cross_community | 6 |
| `BuildPage → Truncate` | cross_community | 6 |
| `ReportView → FormatFieldValue` | cross_community | 5 |
| `ReportView → TierBadge` | cross_community | 4 |
| `ReportView → PartitionDiffs` | cross_community | 4 |
| `BuildPage → GetDraftsRoot` | cross_community | 4 |
| `BuildPage → Ok` | cross_community | 4 |
| `BuildPage → GetState` | cross_community | 3 |
| `BuildPage → Subscribe` | cross_community | 3 |

## How to Explore

1. `context({name: "useErrorReporterFormatted"})` — see callers and callees
2. `query({search_query: "pages"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
