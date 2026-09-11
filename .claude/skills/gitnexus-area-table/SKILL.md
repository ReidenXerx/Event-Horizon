---
name: gitnexus-area-table
description: "Skill for the Table area of Event-Horizon. 26 symbols across 5 files."
---

# Table

26 symbols | 5 files | Cohesion: 93%

## When to Use

- Working with code in `src/`
- Understanding how matchedIds, view, applyTableView work
- Modifying table-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/components/table/rowWindow.ts` | clampTop, computeRowWindow, estimateRowHeight, offsetsOf, placeRowWindow (+4) |
| `src/ui/components/table/tableView.ts` | applyTableView, comparable, compareCells, compareForSort, matchesFilter (+2) |
| `src/ui/components/table/tableView.test.ts` | many, many, many, row |
| `src/ui/components/table/DataTable.tsx` | matchedIds, view, target |
| `src/ui/components/table/rowWindow.test.ts` | sequence, trueHeight, settle |

## Entry Points

Start here when exploring this area:

- **`matchedIds`** (Function) — `src/ui/components/table/DataTable.tsx:202`
- **`view`** (Function) — `src/ui/components/table/DataTable.tsx:161`
- **`applyTableView`** (Function) — `src/ui/components/table/tableView.ts:188`
- **`compareCells`** (Function) — `src/ui/components/table/tableView.ts:161`
- **`compareForSort`** (Function) — `src/ui/components/table/tableView.ts:138`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `matchedIds` | Function | `src/ui/components/table/DataTable.tsx` | 202 |
| `view` | Function | `src/ui/components/table/DataTable.tsx` | 161 |
| `applyTableView` | Function | `src/ui/components/table/tableView.ts` | 188 |
| `compareCells` | Function | `src/ui/components/table/tableView.ts` | 161 |
| `compareForSort` | Function | `src/ui/components/table/tableView.ts` | 138 |
| `matchesFilter` | Function | `src/ui/components/table/tableView.ts` | 86 |
| `computeRowWindow` | Function | `src/ui/components/table/rowWindow.ts` | 141 |
| `estimateRowHeight` | Function | `src/ui/components/table/rowWindow.ts` | 78 |
| `placeRowWindow` | Function | `src/ui/components/table/rowWindow.ts` | 172 |
| `recordRowHeights` | Function | `src/ui/components/table/rowWindow.ts` | 215 |
| `target` | Function | `src/ui/components/table/DataTable.tsx` | 220 |
| `effectiveTarget` | Function | `src/ui/components/table/tableView.ts` | 281 |
| `comparable` | Function | `src/ui/components/table/tableView.ts` | 106 |
| `text` | Function | `src/ui/components/table/tableView.ts` | 75 |
| `clampTop` | Function | `src/ui/components/table/rowWindow.ts` | 107 |
| `offsetsOf` | Function | `src/ui/components/table/rowWindow.ts` | 88 |
| `sameIds` | Function | `src/ui/components/table/rowWindow.ts` | 157 |
| `spanOf` | Function | `src/ui/components/table/rowWindow.ts` | 111 |
| `windowFromOffsets` | Function | `src/ui/components/table/rowWindow.ts` | 122 |
| `sequence` | Function | `src/ui/components/table/rowWindow.test.ts` | 114 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `DownloadsView → ClampTop` | cross_community | 4 |
| `DownloadsView → EstimateRowHeight` | cross_community | 4 |
| `DownloadsView → OffsetsOf` | cross_community | 4 |
| `DownloadsView → SameIds` | cross_community | 4 |
| `DownloadsView → RecordRowHeights` | cross_community | 3 |

## How to Explore

1. `context({name: "matchedIds"})` — see callers and callees
2. `query({search_query: "table"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
