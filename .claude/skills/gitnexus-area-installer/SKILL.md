---
name: gitnexus-area-installer
description: "Skill for the Installer area of Event-Horizon. 493 symbols across 119 files."
---

# Installer

493 symbols | 119 files | Cohesion: 72%

## When to Use

- Working with code in `src/`
- Understanding how purgeGameDeployment, describeGameIniApplication, shouldApplyGameIni work
- Modifying installer-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/installer/runInstall.ts` | buildAbortedResult, buildDisplayNameByModId, buildFailReceipt, buildManifestIndex, buildNexusModIdMap (+69) |
| `src/core/installer/downloadDirect.ts` | discardPart, download, formatDuration, formatSize, hostOf (+20) |
| `src/core/installer/modInstall.ts` | uninstallMod, delayRespectingAbort, downloadFolderFor, downloadNexusArchiveOnly, installFromBundledArchive (+19) |
| `src/core/installLedger.ts` | InstallLedgerError, expectString, getInstallLedgerDir, getReceiptPath, isIso8601 (+12) |
| `src/core/installer/installLink.ts` | dispositionParams, fileNameFromContentDisposition, safeDownloadName, sanitizeFileName, categoryOf (+10) |
| `src/core/installer/applyUserlist.ts` | applyGroupDefinition, applyGroupRule, applyPluginEntry, applyPluginGroup, applyPluginRuleWithCollectionWins (+8) |
| `src/core/installer/applyMirrors.ts` | applyMirrorPlan, mirrorEntryFor, placeFile, replaceFile, restoreOne (+7) |
| `src/core/installer/checkNexusAccount.ts` | describeSelectorAvailability, hasNexusSlice, nexusSlice, probeNexusAccount, readNexusAccount (+4) |
| `src/core/installer/installMarker.ts` | clearInstallMarker, getMarkerDir, listInterruptedInstalls, markerPath, parseMarker (+4) |
| `src/core/installer/bundledPrefetch.ts` | BundledPrefetchPool, dispose, prime, pump, runExtraction (+3) |

## Entry Points

Start here when exploring this area:

- **`purgeGameDeployment`** (Function) — `src/core/environment/vortexEnvironment.ts:175`
- **`describeGameIniApplication`** (Function) — `src/core/installer/applyGameIni.ts:340`
- **`shouldApplyGameIni`** (Function) — `src/core/installer/applyGameIni.ts:315`
- **`applyIniTweaks`** (Function) — `src/core/installer/applyIniTweaks.ts:53`
- **`emptyIniTweakApplication`** (Function) — `src/core/installer/applyIniTweaks.ts:41`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `BundledPrefetchPool` | Class | `src/core/installer/bundledPrefetch.ts` | 117 |
| `InstallStreaks` | Class | `src/core/installer/installStreaks.ts` | 59 |
| `InstallLedgerError` | Class | `src/core/installLedger.ts` | 74 |
| `AbortError` | Class | `src/utils/abortError.ts` | 22 |
| `DiskSpaceError` | Class | `src/utils/diskSpace.ts` | 112 |
| `ChecksumMismatchError` | Class | `src/core/installer/downloadDirect.ts` | 70 |
| `purgeGameDeployment` | Function | `src/core/environment/vortexEnvironment.ts` | 175 |
| `describeGameIniApplication` | Function | `src/core/installer/applyGameIni.ts` | 340 |
| `shouldApplyGameIni` | Function | `src/core/installer/applyGameIni.ts` | 315 |
| `applyIniTweaks` | Function | `src/core/installer/applyIniTweaks.ts` | 53 |
| `emptyIniTweakApplication` | Function | `src/core/installer/applyIniTweaks.ts` | 41 |
| `describeModTypeChanges` | Function | `src/core/installer/applyModTypes.ts` | 159 |
| `label` | Function | `src/core/installer/applyModTypes.ts` | 163 |
| `planModTypeChanges` | Function | `src/core/installer/applyModTypes.ts` | 63 |
| `readCurrentModTypes` | Function | `src/core/installer/applyModTypes.ts` | 106 |
| `describeModTypeMismatches` | Function | `src/core/installer/checkModTypes.ts` | 83 |
| `label` | Function | `src/core/installer/checkModTypes.ts` | 88 |
| `findModTypeMismatches` | Function | `src/core/installer/checkModTypes.ts` | 41 |
| `emptyPluginOrderDrift` | Function | `src/core/installer/checkPluginOrder.ts` | 55 |
| `readUserPluginsTxt` | Function | `src/core/installer/checkPluginOrder.ts` | 185 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `LaunchGame → GetVortexUserDataPath` | cross_community | 10 |
| `RunInstallImpl → GetEventHorizonRoot` | cross_community | 10 |
| `PublishedDetailsPanel → ResolveLogFile` | cross_community | 10 |
| `LoadPublishedDetails → GetEventHorizonDir` | cross_community | 10 |
| `RunSelfChecks → GetVortexUserDataPath` | cross_community | 10 |
| `Dashboard → GetEventHorizonRoot` | cross_community | 10 |
| `LoadPublishedDetails → ResolveLogFile` | cross_community | 10 |
| `InstallDownloads → GetEventHorizonDir` | cross_community | 10 |
| `HandleDeletePublished → GetVortexUserDataPath` | cross_community | 10 |
| `NexusUploadModal → GetEventHorizonRoot` | cross_community | 10 |

## How to Explore

1. `context({name: "purgeGameDeployment"})` — see callers and callees
2. `query({search_query: "installer"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
