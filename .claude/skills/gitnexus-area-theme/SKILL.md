---
name: gitnexus-area-theme
description: "Skill for the Theme area of Event-Horizon. 10 symbols across 2 files."
---

# Theme

10 symbols | 2 files | Cohesion: 100%

## When to Use

- Working with code in `src/`
- Understanding how declaredClasses, referencedClasses, templatedPrefixes work
- Modifying theme-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/theme/classes.test.ts` | declaredClasses, referencedClasses, sourceFiles, stripComments, templatedPrefixes (+3) |
| `src/ui/theme/tokens.test.ts` | referencesWithoutFallback, sourceFiles |

## Entry Points

Start here when exploring this area:

- **`declaredClasses`** (Function) — `src/ui/theme/classes.test.ts:48`
- **`referencedClasses`** (Function) — `src/ui/theme/classes.test.ts:124`
- **`templatedPrefixes`** (Function) — `src/ui/theme/classes.test.ts:145`
- **`themeCss`** (Function) — `src/ui/theme/classes.test.ts:61`
- **`cssRules`** (Function) — `src/ui/theme/classes.test.ts:80`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `declaredClasses` | Function | `src/ui/theme/classes.test.ts` | 48 |
| `referencedClasses` | Function | `src/ui/theme/classes.test.ts` | 124 |
| `templatedPrefixes` | Function | `src/ui/theme/classes.test.ts` | 145 |
| `themeCss` | Function | `src/ui/theme/classes.test.ts` | 61 |
| `cssRules` | Function | `src/ui/theme/classes.test.ts` | 80 |
| `emptyEhRules` | Function | `src/ui/theme/classes.test.ts` | 109 |
| `sourceFiles` | Function | `src/ui/theme/classes.test.ts` | 19 |
| `stripComments` | Function | `src/ui/theme/classes.test.ts` | 43 |
| `referencesWithoutFallback` | Function | `src/ui/theme/tokens.test.ts` | 48 |
| `sourceFiles` | Function | `src/ui/theme/tokens.test.ts` | 23 |

## How to Explore

1. `context({name: "declaredClasses"})` — see callers and callees
2. `query({search_query: "theme"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
