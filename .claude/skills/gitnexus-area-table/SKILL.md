---
name: gitnexus-area-table
description: "Skill for the Table area of Event-Horizon. 42 symbols across 7 files."
---

# Table

42 symbols | 7 files | Cohesion: 90%

## When to Use

- Working with code in `src/`
- Understanding how matchedIds, view, applyTableView work
- Modifying table-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/components/table/rowWindow.ts` | clampTop, computeRowWindow, estimateRowHeight, offsetsOf, placeRowWindow (+4) |
| `src/ui/components/table/columnWidths.ts` | clampWidth, parseStoredWidths, resetColumn, resizeColumn, readStoredWidths (+3) |
| `src/ui/components/table/tableView.ts` | applyTableView, comparable, compareCells, compareForSort, matchesFilter (+2) |
| `src/ui/components/table/DataTable.tsx` | matchedIds, view, changeWidths, headerWidth, resizer (+1) |
| `src/ui/components/table/tableSort.ts` | parseStoredSort, readStoredSort, sortStorageKeyFor, storage, writeStoredSort |
| `src/ui/components/table/tableView.test.ts` | many, many, many, row |
| `src/ui/components/table/rowWindow.test.ts` | sequence, trueHeight, settle |

## Entry Points

Start here when exploring this area:

- **`matchedIds`** (Function) — `src/ui/components/table/DataTable.tsx:285`
- **`view`** (Function) — `src/ui/components/table/DataTable.tsx:244`
- **`applyTableView`** (Function) — `src/ui/components/table/tableView.ts:188`
- **`compareCells`** (Function) — `src/ui/components/table/tableView.ts:161`
- **`compareForSort`** (Function) — `src/ui/components/table/tableView.ts:138`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `matchedIds` | Function | `src/ui/components/table/DataTable.tsx` | 285 |
| `view` | Function | `src/ui/components/table/DataTable.tsx` | 244 |
| `applyTableView` | Function | `src/ui/components/table/tableView.ts` | 188 |
| `compareCells` | Function | `src/ui/components/table/tableView.ts` | 161 |
| `compareForSort` | Function | `src/ui/components/table/tableView.ts` | 138 |
| `matchesFilter` | Function | `src/ui/components/table/tableView.ts` | 86 |
| `computeRowWindow` | Function | `src/ui/components/table/rowWindow.ts` | 141 |
| `estimateRowHeight` | Function | `src/ui/components/table/rowWindow.ts` | 78 |
| `placeRowWindow` | Function | `src/ui/components/table/rowWindow.ts` | 172 |
| `changeWidths` | Function | `src/ui/components/table/DataTable.tsx` | 150 |
| `headerWidth` | Function | `src/ui/components/table/DataTable.tsx` | 154 |
| `resizer` | Function | `src/ui/components/table/DataTable.tsx` | 156 |
| `clampWidth` | Function | `src/ui/components/table/columnWidths.ts` | 26 |
| `parseStoredWidths` | Function | `src/ui/components/table/columnWidths.ts` | 37 |
| `resetColumn` | Function | `src/ui/components/table/columnWidths.ts` | 61 |
| `resizeColumn` | Function | `src/ui/components/table/columnWidths.ts` | 56 |
| `parseStoredSort` | Function | `src/ui/components/table/tableSort.ts` | 26 |
| `readStoredSort` | Function | `src/ui/components/table/tableSort.ts` | 58 |
| `sortStorageKeyFor` | Function | `src/ui/components/table/tableSort.ts` | 17 |
| `writeStoredSort` | Function | `src/ui/components/table/tableSort.ts` | 67 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `DownloadsView → ClampWidth` | cross_community | 5 |
| `DownloadsView → Storage` | cross_community | 4 |
| `DownloadsView → StorageKeyFor` | cross_community | 4 |
| `DownloadsView → ClampTop` | cross_community | 4 |
| `DownloadsView → EstimateRowHeight` | cross_community | 4 |
| `DownloadsView → OffsetsOf` | cross_community | 4 |
| `DownloadsView → SameIds` | cross_community | 4 |
| `DownloadsView → RecordRowHeights` | cross_community | 3 |
| `Resizer → ClampWidth` | intra_community | 3 |

## How to Explore

1. `context({name: "matchedIds"})` — see callers and callees
2. `query({search_query: "table"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
