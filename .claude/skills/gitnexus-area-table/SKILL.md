---
name: gitnexus-area-table
description: "Skill for the Table area of Event-Horizon. 14 symbols across 3 files."
---

# Table

14 symbols | 3 files | Cohesion: 100%

## When to Use

- Working with code in `src/`
- Understanding how matchedIds, view, applyTableView work
- Modifying table-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/components/table/tableView.ts` | applyTableView, comparable, compareCells, compareForSort, matchesFilter (+2) |
| `src/ui/components/table/tableView.test.ts` | many, many, many, row |
| `src/ui/components/table/DataTable.tsx` | matchedIds, view, target |

## Entry Points

Start here when exploring this area:

- **`matchedIds`** (Function) — `src/ui/components/table/DataTable.tsx:183`
- **`view`** (Function) — `src/ui/components/table/DataTable.tsx:159`
- **`applyTableView`** (Function) — `src/ui/components/table/tableView.ts:188`
- **`compareCells`** (Function) — `src/ui/components/table/tableView.ts:161`
- **`compareForSort`** (Function) — `src/ui/components/table/tableView.ts:138`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `matchedIds` | Function | `src/ui/components/table/DataTable.tsx` | 183 |
| `view` | Function | `src/ui/components/table/DataTable.tsx` | 159 |
| `applyTableView` | Function | `src/ui/components/table/tableView.ts` | 188 |
| `compareCells` | Function | `src/ui/components/table/tableView.ts` | 161 |
| `compareForSort` | Function | `src/ui/components/table/tableView.ts` | 138 |
| `matchesFilter` | Function | `src/ui/components/table/tableView.ts` | 86 |
| `target` | Function | `src/ui/components/table/DataTable.tsx` | 201 |
| `effectiveTarget` | Function | `src/ui/components/table/tableView.ts` | 281 |
| `comparable` | Function | `src/ui/components/table/tableView.ts` | 106 |
| `text` | Function | `src/ui/components/table/tableView.ts` | 75 |
| `many` | Function | `src/ui/components/table/tableView.test.ts` | 148 |
| `many` | Function | `src/ui/components/table/tableView.test.ts` | 158 |
| `many` | Function | `src/ui/components/table/tableView.test.ts` | 170 |
| `row` | Function | `src/ui/components/table/tableView.test.ts` | 30 |

## How to Explore

1. `context({name: "matchedIds"})` — see callers and callees
2. `query({search_query: "table"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
