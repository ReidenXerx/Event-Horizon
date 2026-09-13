---
name: gitnexus-area-installer
description: "Skill for the Installer area of Event-Horizon. 406 symbols across 95 files."
---

# Installer

406 symbols | 95 files | Cohesion: 76%

## When to Use

- Working with code in `src/`
- Understanding how describeGameIniApplication, shouldApplyGameIni, applyIniTweaks work
- Modifying installer-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/installer/runInstall.ts` | buildAbortedResult, buildDisplayNameByModId, buildFailReceipt, buildManifestIndex, buildNexusModIdMap (+59) |
| `src/core/installer/modInstall.ts` | delayRespectingAbort, downloadFolderFor, downloadNexusArchiveOnly, installFromBundledArchive, installFromExistingDownload (+19) |
| `src/core/installer/downloadDirect.ts` | defaultRequest, discardPart, download, formatDuration, formatSize (+17) |
| `src/core/installer/installLink.ts` | dispositionParams, fileNameFromContentDisposition, safeDownloadName, sanitizeFileName, checksumOf (+9) |
| `src/core/installLedger.ts` | InstallLedgerError, expectString, getReceiptPath, isIso8601, isSemverLike (+8) |
| `src/core/installer/applyUserlist.ts` | applyGroupDefinition, applyGroupRule, applyPluginEntry, applyPluginGroup, applyPluginRuleWithCollectionWins (+8) |
| `src/core/installer/checkNexusAccount.ts` | describeSelectorAvailability, hasNexusSlice, nexusSlice, probeNexusAccount, readNexusAccount (+4) |
| `src/core/installer/bundledPrefetch.ts` | BundledPrefetchPool, dispose, prime, pump, runExtraction (+3) |
| `src/core/installer/linkCarrier.ts` | crc32, findEndOfCentralDirectory, readLinkCarrier, readSmallZip, baseName (+3) |
| `src/core/installer/applyGameIni.ts` | describeGameIniApplication, shouldApplyGameIni, applyGameIni, describeIniChanges, isSectionHeader (+2) |

## Entry Points

Start here when exploring this area:

- **`describeGameIniApplication`** (Function) — `src/core/installer/applyGameIni.ts:340`
- **`shouldApplyGameIni`** (Function) — `src/core/installer/applyGameIni.ts:315`
- **`applyIniTweaks`** (Function) — `src/core/installer/applyIniTweaks.ts:53`
- **`emptyIniTweakApplication`** (Function) — `src/core/installer/applyIniTweaks.ts:41`
- **`describeModTypeChanges`** (Function) — `src/core/installer/applyModTypes.ts:159`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `BundledPrefetchPool` | Class | `src/core/installer/bundledPrefetch.ts` | 117 |
| `InstallStreaks` | Class | `src/core/installer/installStreaks.ts` | 59 |
| `InstallLedgerError` | Class | `src/core/installLedger.ts` | 72 |
| `DiskSpaceError` | Class | `src/utils/diskSpace.ts` | 112 |
| `ChecksumMismatchError` | Class | `src/core/installer/downloadDirect.ts` | 70 |
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
| `describeSevenZipHealth` | Function | `src/core/installer/checkSevenZipHealth.ts` | 108 |
| `buildCuratorReport` | Function | `src/core/installer/curatorReport.ts` | 108 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `LaunchGame → GetVortexUserDataPath` | cross_community | 10 |
| `RunInstallImpl → GetEventHorizonRoot` | cross_community | 10 |
| `PublishedDetailsPanel → GetEventHorizonDir` | cross_community | 10 |
| `RunSelfChecks → GetVortexUserDataPath` | cross_community | 10 |
| `Dashboard → GetEventHorizonRoot` | cross_community | 10 |
| `InstallDownloads → GetEventHorizonDir` | cross_community | 10 |
| `HandleDeletePublished → GetVortexUserDataPath` | cross_community | 10 |
| `LoadPublishedDetails → GetEventHorizonRoot` | cross_community | 10 |
| `Act → GetEventHorizonDir` | cross_community | 10 |
| `PublishedDetailsPanel → GetVortexUserDataPath` | cross_community | 10 |

## How to Explore

1. `context({name: "describeGameIniApplication"})` — see callers and callees
2. `query({search_query: "installer"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
