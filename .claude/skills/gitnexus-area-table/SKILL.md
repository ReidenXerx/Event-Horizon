---
name: gitnexus-area-table
description: "Skill for the Table area of Event-Horizon. 23 symbols across 4 files."
---

# Table

23 symbols | 4 files | Cohesion: 91%

## When to Use

- Working with code in `src/`
- Understanding how DataTable, clickRow, describeTableView work
- Modifying table-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/components/table/tableView.ts` | describeTableView, distinctValues, applyTableView, comparable, compareCells (+4) |
| `src/ui/components/table/DataTable.tsx` | DataTable, clickRow, nextSort, matchedIds, view (+1) |
| `src/ui/pages/curator/CuratorPage.tsx` | kindOf, stateOf, value, value |
| `src/ui/components/table/tableView.test.ts` | many, many, many, row |

## Entry Points

Start here when exploring this area:

- **`DataTable`** (Function) — `src/ui/components/table/DataTable.tsx:64`
- **`clickRow`** (Function) — `src/ui/components/table/DataTable.tsx:202`
- **`describeTableView`** (Function) — `src/ui/components/table/tableView.ts:241`
- **`distinctValues`** (Function) — `src/ui/components/table/tableView.ts:170`
- **`matchedIds`** (Function) — `src/ui/components/table/DataTable.tsx:132`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `DataTable` | Function | `src/ui/components/table/DataTable.tsx` | 64 |
| `clickRow` | Function | `src/ui/components/table/DataTable.tsx` | 202 |
| `describeTableView` | Function | `src/ui/components/table/tableView.ts` | 241 |
| `distinctValues` | Function | `src/ui/components/table/tableView.ts` | 170 |
| `matchedIds` | Function | `src/ui/components/table/DataTable.tsx` | 132 |
| `view` | Function | `src/ui/components/table/DataTable.tsx` | 121 |
| `applyTableView` | Function | `src/ui/components/table/tableView.ts` | 188 |
| `compareCells` | Function | `src/ui/components/table/tableView.ts` | 161 |
| `compareForSort` | Function | `src/ui/components/table/tableView.ts` | 138 |
| `matchesFilter` | Function | `src/ui/components/table/tableView.ts` | 86 |
| `target` | Function | `src/ui/components/table/DataTable.tsx` | 150 |
| `effectiveTarget` | Function | `src/ui/components/table/tableView.ts` | 281 |
| `nextSort` | Function | `src/ui/components/table/DataTable.tsx` | 58 |
| `kindOf` | Function | `src/ui/pages/curator/CuratorPage.tsx` | 198 |
| `stateOf` | Function | `src/ui/pages/curator/CuratorPage.tsx` | 200 |
| `value` | Function | `src/ui/pages/curator/CuratorPage.tsx` | 212 |
| `value` | Function | `src/ui/pages/curator/CuratorPage.tsx` | 315 |
| `comparable` | Function | `src/ui/components/table/tableView.ts` | 106 |
| `text` | Function | `src/ui/components/table/tableView.ts` | 75 |
| `many` | Function | `src/ui/components/table/tableView.test.ts` | 148 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `DataTable → UseIndeterminate` | cross_community | 4 |

## How to Explore

1. `context({name: "DataTable"})` — see callers and callees
2. `query({search_query: "table"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
