---
name: gitnexus-area-installer
description: "Skill for the Installer area of Event-Horizon. 319 symbols across 73 files."
---

# Installer

319 symbols | 73 files | Cohesion: 76%

## When to Use

- Working with code in `src/`
- Understanding how describeGameIniApplication, shouldApplyGameIni, applyIniTweaks work
- Modifying installer-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/installer/runInstall.ts` | buildAbortedResult, buildDisplayNameByModId, buildFailReceipt, buildManifestIndex, buildNexusModIdMap (+61) |
| `src/core/installer/modInstall.ts` | safeRmTempDir, delayRespectingAbort, downloadFolderFor, downloadNexusArchiveOnly, installFromBundledArchive (+24) |
| `src/core/installLedger.ts` | InstallLedgerError, expectString, getInstallLedgerDir, getReceiptPath, isIso8601 (+10) |
| `src/core/installer/applyUserlist.ts` | applyGroupDefinition, applyGroupRule, applyPluginEntry, applyPluginGroup, applyPluginRuleWithCollectionWins (+8) |
| `src/core/installer/bundledPrefetch.ts` | BundledPrefetchPool, dispose, prime, pump, runExtraction (+2) |
| `src/core/installer/applyGameIni.ts` | describeGameIniApplication, shouldApplyGameIni, applyGameIni, describeIniChanges, isSectionHeader (+2) |
| `src/core/installer/installJournal.ts` | logJournalSummary, ownedModIds, clearJournal, appendJournalEntry, getJournalDir (+2) |
| `src/core/installer/checkNexusAccount.ts` | hasNexusSlice, nexusSlice, readNexusAccount, readUserInfo, readViaSelectors (+2) |
| `src/core/installer/profile.ts` | createFreshProfile, makeAbortError, pickNonCollidingName, switchToProfile, disableModInProfile (+1) |
| `src/core/installer/timeBudgets.ts` | countMods, clamp, deployBudgetMs, profileSwitchBudgetMs, scale (+1) |

## Entry Points

Start here when exploring this area:

- **`describeGameIniApplication`** (Function) — `src/core/installer/applyGameIni.ts:340`
- **`shouldApplyGameIni`** (Function) — `src/core/installer/applyGameIni.ts:315`
- **`applyIniTweaks`** (Function) — `src/core/installer/applyIniTweaks.ts:53`
- **`emptyIniTweakApplication`** (Function) — `src/core/installer/applyIniTweaks.ts:41`
- **`applyLoadOrder`** (Function) — `src/core/installer/applyLoadOrder.ts:113`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `BundledPrefetchPool` | Class | `src/core/installer/bundledPrefetch.ts` | 117 |
| `InstallStreaks` | Class | `src/core/installer/installStreaks.ts` | 59 |
| `InstallLedgerError` | Class | `src/core/installLedger.ts` | 72 |
| `describeGameIniApplication` | Function | `src/core/installer/applyGameIni.ts` | 340 |
| `shouldApplyGameIni` | Function | `src/core/installer/applyGameIni.ts` | 315 |
| `applyIniTweaks` | Function | `src/core/installer/applyIniTweaks.ts` | 53 |
| `emptyIniTweakApplication` | Function | `src/core/installer/applyIniTweaks.ts` | 41 |
| `applyLoadOrder` | Function | `src/core/installer/applyLoadOrder.ts` | 113 |
| `describeModTypeChanges` | Function | `src/core/installer/applyModTypes.ts` | 159 |
| `label` | Function | `src/core/installer/applyModTypes.ts` | 163 |
| `planModTypeChanges` | Function | `src/core/installer/applyModTypes.ts` | 63 |
| `readCurrentModTypes` | Function | `src/core/installer/applyModTypes.ts` | 106 |
| `describeModTypeMismatches` | Function | `src/core/installer/checkModTypes.ts` | 83 |
| `label` | Function | `src/core/installer/checkModTypes.ts` | 88 |
| `findModTypeMismatches` | Function | `src/core/installer/checkModTypes.ts` | 41 |
| `emptyPluginOrderDrift` | Function | `src/core/installer/checkPluginOrder.ts` | 55 |
| `readUserPluginsTxt` | Function | `src/core/installer/checkPluginOrder.ts` | 185 |
| `describeSevenZipHealth` | Function | `src/core/installer/checkSevenZipHealth.ts` | 136 |
| `looksLikeWine` | Function | `src/core/installer/checkSevenZipHealth.ts` | 106 |
| `buildCuratorReport` | Function | `src/core/installer/curatorReport.ts` | 108 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `InstallNexusViaApi → GetEventHorizonRoot` | cross_community | 10 |
| `ExecutePromptUserChoice → GetEventHorizonDir` | cross_community | 10 |
| `RunInstallImpl → GetEventHorizonRoot` | cross_community | 10 |
| `Dashboard → GetEventHorizonRoot` | cross_community | 10 |
| `Act → GetEventHorizonDir` | cross_community | 10 |
| `LoadDashboardData → GetVortexUserDataPath` | cross_community | 10 |
| `Take → GetVortexUserDataPath` | cross_community | 10 |
| `ExecutePromptUserChoice → Truncate` | cross_community | 9 |
| `Act → Clamp` | cross_community | 8 |
| `Act → Scale` | cross_community | 8 |

## How to Explore

1. `context({name: "describeGameIniApplication"})` — see callers and callees
2. `query({search_query: "installer"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
