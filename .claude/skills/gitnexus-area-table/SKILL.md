---
name: gitnexus-area-table
description: "Skill for the Table area of Event-Horizon. 57 symbols across 11 files."
---

# Table

57 symbols | 11 files | Cohesion: 81%

## When to Use

- Working with code in `src/`
- Understanding how describeMastersCell, describePluginKind, DataTable work
- Modifying table-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/components/table/DataTable.tsx` | DataTable, clickRow, widthOf, nextSort, matchedIds (+5) |
| `src/ui/components/table/columnWidths.ts` | tableMinWidth, clampWidth, parseStoredWidths, resetColumn, resizeColumn (+4) |
| `src/ui/components/table/tableView.ts` | describeTableView, distinctValues, applyTableView, comparable, compareCells (+4) |
| `src/ui/components/table/rowWindow.ts` | clampTop, computeRowWindow, estimateRowHeight, offsetsOf, placeRowWindow (+4) |
| `src/ui/components/table/tableSort.ts` | initialSort, parseStoredSort, readStoredSort, sortStorageKeyFor, storage (+1) |
| `src/ui/components/table/tableView.test.ts` | many, many, many, row |
| `src/ui/pages/curator/PluginsView.tsx` | render, render, stateOf |
| `src/ui/components/table/rowWindow.test.ts` | sequence, trueHeight, settle |
| `src/core/curator/pluginView.ts` | describeMastersCell, describePluginKind |
| `src/ui/pages/curator/CuratorPage.tsx` | render |

## Entry Points

Start here when exploring this area:

- **`describeMastersCell`** (Function) — `src/core/curator/pluginView.ts:223`
- **`describePluginKind`** (Function) — `src/core/curator/pluginView.ts:233`
- **`DataTable`** (Function) — `src/ui/components/table/DataTable.tsx:84`
- **`clickRow`** (Function) — `src/ui/components/table/DataTable.tsx:372`
- **`widthOf`** (Function) — `src/ui/components/table/DataTable.tsx:205`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `describeMastersCell` | Function | `src/core/curator/pluginView.ts` | 223 |
| `describePluginKind` | Function | `src/core/curator/pluginView.ts` | 233 |
| `DataTable` | Function | `src/ui/components/table/DataTable.tsx` | 84 |
| `clickRow` | Function | `src/ui/components/table/DataTable.tsx` | 372 |
| `widthOf` | Function | `src/ui/components/table/DataTable.tsx` | 205 |
| `tableMinWidth` | Function | `src/ui/components/table/columnWidths.ts` | 75 |
| `initialSort` | Function | `src/ui/components/table/tableSort.ts` | 43 |
| `describeTableView` | Function | `src/ui/components/table/tableView.ts` | 241 |
| `distinctValues` | Function | `src/ui/components/table/tableView.ts` | 170 |
| `describeRowState` | Function | `src/ui/pages/curator/workbench.ts` | 272 |
| `matchedIds` | Function | `src/ui/components/table/DataTable.tsx` | 302 |
| `view` | Function | `src/ui/components/table/DataTable.tsx` | 261 |
| `applyTableView` | Function | `src/ui/components/table/tableView.ts` | 188 |
| `compareCells` | Function | `src/ui/components/table/tableView.ts` | 161 |
| `compareForSort` | Function | `src/ui/components/table/tableView.ts` | 138 |
| `matchesFilter` | Function | `src/ui/components/table/tableView.ts` | 86 |
| `computeRowWindow` | Function | `src/ui/components/table/rowWindow.ts` | 141 |
| `estimateRowHeight` | Function | `src/ui/components/table/rowWindow.ts` | 78 |
| `placeRowWindow` | Function | `src/ui/components/table/rowWindow.ts` | 172 |
| `changeWidths` | Function | `src/ui/components/table/DataTable.tsx` | 156 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `DownloadsView → ClampWidth` | cross_community | 5 |
| `DownloadsView → Storage` | cross_community | 4 |
| `DownloadsView → StorageKeyFor` | cross_community | 4 |
| `DownloadsView → ParseStoredSort` | cross_community | 4 |
| `DownloadsView → SortStorageKeyFor` | cross_community | 4 |
| `DownloadsView → Storage` | cross_community | 4 |
| `DownloadsView → InitialSort` | cross_community | 3 |
| `Resizer → ClampWidth` | intra_community | 3 |

## How to Explore

1. `context({name: "describeMastersCell"})` — see callers and callees
2. `query({search_query: "table"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
