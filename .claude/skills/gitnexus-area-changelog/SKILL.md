---
name: gitnexus-area-changelog
description: "Skill for the Changelog area of Event-Horizon. 30 symbols across 2 files."
---

# Changelog

30 symbols | 2 files | Cohesion: 94%

## When to Use

- Working with code in `src/`
- Understanding how changeSections, add, describeUnknowns work
- Modifying changelog-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/changelog/changelog.ts` | changeSections, add, day, describeUnknowns, plural (+22) |
| `src/core/changelog/changelog.test.ts` | v, mod, snapshot |

## Entry Points

Start here when exploring this area:

- **`changeSections`** (Function) — `src/core/changelog/changelog.ts:612`
- **`add`** (Function) — `src/core/changelog/changelog.ts:614`
- **`describeUnknowns`** (Function) — `src/core/changelog/changelog.ts:719`
- **`renderChangelogBbcode`** (Function) — `src/core/changelog/changelog.ts:762`
- **`renderChangelogMarkdown`** (Function) — `src/core/changelog/changelog.ts:736`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `changeSections` | Function | `src/core/changelog/changelog.ts` | 612 |
| `add` | Function | `src/core/changelog/changelog.ts` | 614 |
| `describeUnknowns` | Function | `src/core/changelog/changelog.ts` | 719 |
| `renderChangelogBbcode` | Function | `src/core/changelog/changelog.ts` | 762 |
| `renderChangelogMarkdown` | Function | `src/core/changelog/changelog.ts` | 736 |
| `summarizeEntry` | Function | `src/core/changelog/changelog.ts` | 685 |
| `count` | Function | `src/core/changelog/changelog.ts` | 694 |
| `diffSnapshots` | Function | `src/core/changelog/changelog.ts` | 296 |
| `gameLabel` | Function | `src/core/changelog/changelog.ts` | 350 |
| `movedInOrder` | Function | `src/core/changelog/changelog.ts` | 258 |
| `recordBuild` | Function | `src/core/changelog/changelog.ts` | 552 |
| `describeRule` | Function | `src/core/changelog/changelog.ts` | 312 |
| `day` | Function | `src/core/changelog/changelog.ts` | 733 |
| `plural` | Function | `src/core/changelog/changelog.ts` | 606 |
| `diffMods` | Function | `src/core/changelog/changelog.ts` | 379 |
| `compareState` | Function | `src/core/changelog/changelog.ts` | 397 |
| `take` | Function | `src/core/changelog/changelog.ts` | 390 |
| `update` | Function | `src/core/changelog/changelog.ts` | 437 |
| `was` | Function | `src/core/changelog/changelog.ts` | 469 |
| `line` | Function | `src/core/changelog/changelog.ts` | 239 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `DiffSnapshots → CanonicalSelections` | cross_community | 5 |
| `DiffSnapshots → SelectionEvidence` | cross_community | 5 |
| `DiffSnapshots → CompareState` | cross_community | 4 |
| `DiffSnapshots → CompareShapes` | cross_community | 4 |
| `DiffSnapshots → Take` | cross_community | 3 |
| `DiffSnapshots → PageOf` | cross_community | 3 |
| `DiffSnapshots → Push` | cross_community | 3 |
| `DiffSnapshots → Key` | intra_community | 3 |
| `DiffSnapshots → MovedInOrder` | intra_community | 3 |
| `SummarizeEntry → Add` | intra_community | 3 |

## How to Explore

1. `context({name: "changeSections"})` — see callers and callees
2. `query({search_query: "changelog"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
