---
name: gitnexus-area-changelog
description: "Skill for the Changelog area of Event-Horizon. 49 symbols across 4 files."
---

# Changelog

49 symbols | 4 files | Cohesion: 85%

## When to Use

- Working with code in `src/`
- Understanding how changeSections, add, describeUnknowns work
- Modifying changelog-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/changelog/changelog.ts` | changeSections, add, day, describeUnknowns, plural (+36) |
| `src/core/changelog/changelogHistory.ts` | changelogHistoryPath, loadChangelogHistory, saveChangelogHistory, snapshotOrUndefined |
| `src/core/changelog/changelog.test.ts` | v, mod, snapshot |
| `src/ui/components/ChangelogView.tsx` | ChangelogEntryView |

## Entry Points

Start here when exploring this area:

- **`changeSections`** (Function) — `src/core/changelog/changelog.ts:631`
- **`add`** (Function) — `src/core/changelog/changelog.ts:633`
- **`describeUnknowns`** (Function) — `src/core/changelog/changelog.ts:754`
- **`renderChangelogBbcode`** (Function) — `src/core/changelog/changelog.ts:797`
- **`renderChangelogMarkdown`** (Function) — `src/core/changelog/changelog.ts:771`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `changeSections` | Function | `src/core/changelog/changelog.ts` | 631 |
| `add` | Function | `src/core/changelog/changelog.ts` | 633 |
| `describeUnknowns` | Function | `src/core/changelog/changelog.ts` | 754 |
| `renderChangelogBbcode` | Function | `src/core/changelog/changelog.ts` | 797 |
| `renderChangelogMarkdown` | Function | `src/core/changelog/changelog.ts` | 771 |
| `summarizeEntry` | Function | `src/core/changelog/changelog.ts` | 704 |
| `count` | Function | `src/core/changelog/changelog.ts` | 725 |
| `ChangelogEntryView` | Function | `src/ui/components/ChangelogView.tsx` | 34 |
| `diffSnapshots` | Function | `src/core/changelog/changelog.ts` | 296 |
| `gameLabel` | Function | `src/core/changelog/changelog.ts` | 360 |
| `inNextKeys` | Function | `src/core/changelog/changelog.ts` | 313 |
| `renamed` | Function | `src/core/changelog/changelog.ts` | 312 |
| `movedInOrder` | Function | `src/core/changelog/changelog.ts` | 258 |
| `recordBuild` | Function | `src/core/changelog/changelog.ts` | 571 |
| `readChangelogEntries` | Function | `src/core/changelog/changelog.ts` | 895 |
| `changelogHistoryPath` | Function | `src/core/changelog/changelogHistory.ts` | 24 |
| `loadChangelogHistory` | Function | `src/core/changelog/changelogHistory.ts` | 48 |
| `saveChangelogHistory` | Function | `src/core/changelog/changelogHistory.ts` | 86 |
| `describeRule` | Function | `src/core/changelog/changelog.ts` | 322 |
| `day` | Function | `src/core/changelog/changelog.ts` | 768 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `BuildChangelog → Add` | cross_community | 5 |
| `PrepareChangelog → PageOf` | cross_community | 5 |
| `PrepareChangelog → Push` | cross_community | 5 |
| `BuildChangelog → Plural` | cross_community | 4 |
| `PrepareChangelog → EmptyChanges` | cross_community | 4 |

## How to Explore

1. `context({name: "changeSections"})` — see callers and callees
2. `query({search_query: "changelog"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
