---
name: gitnexus-area-table
description: "Skill for the Table area of Event-Horizon. 21 symbols across 5 files."
---

# Table

21 symbols | 5 files | Cohesion: 88%

## When to Use

- Working with code in `src/`
- Understanding how matchedIds, view, applyTableView work
- Modifying table-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/components/table/tableView.ts` | applyTableView, comparable, compareCells, compareForSort, matchesFilter (+4) |
| `src/ui/components/table/DataTable.tsx` | matchedIds, view, DataTable, clickRow, nextSort (+1) |
| `src/ui/components/table/tableView.test.ts` | many, many, many, row |
| `src/ui/pages/curator/CuratorPage.tsx` | render |
| `src/ui/pages/curator/workbench.ts` | describeRowState |

## Entry Points

Start here when exploring this area:

- **`matchedIds`** (Function) — `src/ui/components/table/DataTable.tsx:139`
- **`view`** (Function) — `src/ui/components/table/DataTable.tsx:128`
- **`applyTableView`** (Function) — `src/ui/components/table/tableView.ts:188`
- **`compareCells`** (Function) — `src/ui/components/table/tableView.ts:161`
- **`compareForSort`** (Function) — `src/ui/components/table/tableView.ts:138`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `matchedIds` | Function | `src/ui/components/table/DataTable.tsx` | 139 |
| `view` | Function | `src/ui/components/table/DataTable.tsx` | 128 |
| `applyTableView` | Function | `src/ui/components/table/tableView.ts` | 188 |
| `compareCells` | Function | `src/ui/components/table/tableView.ts` | 161 |
| `compareForSort` | Function | `src/ui/components/table/tableView.ts` | 138 |
| `matchesFilter` | Function | `src/ui/components/table/tableView.ts` | 86 |
| `DataTable` | Function | `src/ui/components/table/DataTable.tsx` | 64 |
| `clickRow` | Function | `src/ui/components/table/DataTable.tsx` | 209 |
| `describeTableView` | Function | `src/ui/components/table/tableView.ts` | 241 |
| `distinctValues` | Function | `src/ui/components/table/tableView.ts` | 170 |
| `describeRowState` | Function | `src/ui/pages/curator/workbench.ts` | 200 |
| `target` | Function | `src/ui/components/table/DataTable.tsx` | 157 |
| `effectiveTarget` | Function | `src/ui/components/table/tableView.ts` | 281 |
| `comparable` | Function | `src/ui/components/table/tableView.ts` | 106 |
| `text` | Function | `src/ui/components/table/tableView.ts` | 75 |
| `nextSort` | Function | `src/ui/components/table/DataTable.tsx` | 58 |
| `render` | Function | `src/ui/pages/curator/CuratorPage.tsx` | 193 |
| `many` | Function | `src/ui/components/table/tableView.test.ts` | 148 |
| `many` | Function | `src/ui/components/table/tableView.test.ts` | 158 |
| `many` | Function | `src/ui/components/table/tableView.test.ts` | 170 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `DataTable → UseIndeterminate` | cross_community | 4 |

## How to Explore

1. `context({name: "matchedIds"})` — see callers and callees
2. `query({search_query: "table"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
