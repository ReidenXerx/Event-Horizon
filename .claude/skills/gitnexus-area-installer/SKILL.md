---
name: gitnexus-area-installer
description: "Skill for the Installer area of Event-Horizon. 274 symbols across 61 files."
---

# Installer

274 symbols | 61 files | Cohesion: 84%

## When to Use

- Working with code in `src/`
- Understanding how describeGameIniApplication, shouldApplyGameIni, applyIniTweaks work
- Modifying installer-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/installer/runInstall.ts` | buildAbortedResult, buildDisplayNameByModId, buildFailReceipt, buildManifestIndex, buildNexusModIdMap (+52) |
| `src/core/installer/modInstall.ts` | uninstallMod, delayRespectingAbort, installFromBundledArchive, installFromExistingDownload, installFromLocalArchive (+18) |
| `src/core/installLedger.ts` | InstallLedgerError, expectString, getInstallLedgerDir, getReceiptPath, isIso8601 (+10) |
| `src/core/installer/applyUserlist.ts` | applyGroupDefinition, applyGroupRule, applyPluginEntry, applyPluginGroup, applyPluginRuleWithCollectionWins (+8) |
| `src/core/installer/installMarker.ts` | clearInstallMarker, getMarkerDir, listInterruptedInstalls, markerPath, parseMarker (+4) |
| `src/core/installer/profile.ts` | createFreshProfile, enableModInProfile, makeAbortError, pickNonCollidingName, switchToProfile (+3) |
| `src/core/installer/bundledPrefetch.ts` | BundledPrefetchPool, prime, pump, runExtraction, startExtraction (+2) |
| `src/core/installer/checkNexusAccount.ts` | hasNexusSlice, nexusSlice, readNexusAccount, readUserInfo, readViaSelectors (+2) |
| `src/core/installer/timeBudgets.ts` | countMods, clamp, deployBudgetMs, profileSwitchBudgetMs, scale (+1) |
| `src/core/installer/adoptLocalArchive.ts` | adoptLocalArchive, copyIn, deriveId, downloadFolder, isInside (+1) |

## Entry Points

Start here when exploring this area:

- **`describeGameIniApplication`** (Function) — `src/core/installer/applyGameIni.ts:335`
- **`shouldApplyGameIni`** (Function) — `src/core/installer/applyGameIni.ts:315`
- **`applyIniTweaks`** (Function) — `src/core/installer/applyIniTweaks.ts:53`
- **`describeIniTweaks`** (Function) — `src/core/installer/applyIniTweaks.ts:114`
- **`emptyIniTweakApplication`** (Function) — `src/core/installer/applyIniTweaks.ts:41`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `BundledPrefetchPool` | Class | `src/core/installer/bundledPrefetch.ts` | 102 |
| `InstallLedgerError` | Class | `src/core/installLedger.ts` | 72 |
| `describeGameIniApplication` | Function | `src/core/installer/applyGameIni.ts` | 335 |
| `shouldApplyGameIni` | Function | `src/core/installer/applyGameIni.ts` | 315 |
| `applyIniTweaks` | Function | `src/core/installer/applyIniTweaks.ts` | 53 |
| `describeIniTweaks` | Function | `src/core/installer/applyIniTweaks.ts` | 114 |
| `emptyIniTweakApplication` | Function | `src/core/installer/applyIniTweaks.ts` | 41 |
| `applyLoadOrder` | Function | `src/core/installer/applyLoadOrder.ts` | 113 |
| `applyMirrorPlan` | Function | `src/core/installer/applyMirrors.ts` | 54 |
| `describeMirrorOutcome` | Function | `src/core/installer/applyMirrors.ts` | 138 |
| `mirrorEntryFor` | Function | `src/core/installer/applyMirrors.ts` | 46 |
| `describeModTypeChanges` | Function | `src/core/installer/applyModTypes.ts` | 159 |
| `label` | Function | `src/core/installer/applyModTypes.ts` | 163 |
| `planModTypeChanges` | Function | `src/core/installer/applyModTypes.ts` | 63 |
| `readCurrentModTypes` | Function | `src/core/installer/applyModTypes.ts` | 106 |
| `describePluginFlagRepair` | Function | `src/core/installer/applyPluginLightFlags.ts` | 199 |
| `describePluginOrderApplication` | Function | `src/core/installer/applyPluginOrder.ts` | 370 |
| `describeModTypeMismatches` | Function | `src/core/installer/checkModTypes.ts` | 83 |
| `label` | Function | `src/core/installer/checkModTypes.ts` | 88 |
| `findModTypeMismatches` | Function | `src/core/installer/checkModTypes.ts` | 41 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `ExecutePromptUserChoice → GetEventHorizonDir` | cross_community | 10 |
| `RunInstallImpl → GetEventHorizonRoot` | cross_community | 10 |
| `Dashboard → GetEventHorizonRoot` | cross_community | 10 |
| `Act → GetEventHorizonDir` | cross_community | 10 |
| `LoadDashboardData → GetVortexUserDataPath` | cross_community | 10 |
| `Take → GetVortexUserDataPath` | cross_community | 10 |
| `ExecutePromptUserChoice → Truncate` | cross_community | 9 |
| `Act → Clamp` | cross_community | 8 |
| `Act → Scale` | cross_community | 8 |
| `HomePage → Truncate` | cross_community | 8 |

## How to Explore

1. `context({name: "describeGameIniApplication"})` — see callers and callees
2. `query({search_query: "installer"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
