---
name: gitnexus-area-actions
description: "Skill for the Actions area of Event-Horizon. 38 symbols across 6 files."
---

# Actions

38 symbols | 6 files | Cohesion: 87%

## When to Use

- Working with code in `src/`
- Understanding how pickModArchiveFile, action, action work
- Modifying actions-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/actions/installCollectionAction.ts` | collectUserDecisions, formatDivergedConflictText, formatOrphanText, formatPromptUserText, pickConflictChoice (+23) |
| `src/utils/utils.ts` | pickModArchiveFile, openFile, openFolder |
| `src/actions/compareModsAction.ts` | action, action |
| `src/actions/comparePluginsAction.ts` | action, action |
| `src/actions/exportModsAction.ts` | action, action |
| `src/ui/pages/install/steps.tsx` | handlePickFile |

## Entry Points

Start here when exploring this area:

- **`pickModArchiveFile`** (Function) — `src/utils/utils.ts:113`
- **`action`** (Function) — `src/actions/compareModsAction.ts:104`
- **`action`** (Function) — `src/actions/comparePluginsAction.ts:71`
- **`action`** (Function) — `src/actions/exportModsAction.ts:124`
- **`openFile`** (Function) — `src/utils/utils.ts:39`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `pickModArchiveFile` | Function | `src/utils/utils.ts` | 113 |
| `action` | Function | `src/actions/compareModsAction.ts` | 104 |
| `action` | Function | `src/actions/comparePluginsAction.ts` | 71 |
| `action` | Function | `src/actions/exportModsAction.ts` | 124 |
| `openFile` | Function | `src/utils/utils.ts` | 39 |
| `action` | Function | `src/actions/compareModsAction.ts` | 110 |
| `action` | Function | `src/actions/comparePluginsAction.ts` | 77 |
| `action` | Function | `src/actions/exportModsAction.ts` | 128 |
| `openFolder` | Function | `src/utils/utils.ts` | 35 |
| `collectUserDecisions` | Function | `src/actions/installCollectionAction.ts` | 857 |
| `formatDivergedConflictText` | Function | `src/actions/installCollectionAction.ts` | 1069 |
| `formatOrphanText` | Function | `src/actions/installCollectionAction.ts` | 1168 |
| `formatPromptUserText` | Function | `src/actions/installCollectionAction.ts` | 1131 |
| `pickConflictChoice` | Function | `src/actions/installCollectionAction.ts` | 920 |
| `pickExternalPromptUserChoice` | Function | `src/actions/installCollectionAction.ts` | 965 |
| `pickOrphanChoice` | Function | `src/actions/installCollectionAction.ts` | 1040 |
| `truncSha` | Function | `src/actions/installCollectionAction.ts` | 1189 |
| `handlePickFile` | Function | `src/ui/pages/install/steps.tsx` | 1125 |
| `formatExternalDeps` | Function | `src/actions/installCollectionAction.ts` | 768 |
| `formatInstallTarget` | Function | `src/actions/installCollectionAction.ts` | 612 |

## How to Explore

1. `context({name: "pickModArchiveFile"})` — see callers and callees
2. `query({search_query: "actions"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
