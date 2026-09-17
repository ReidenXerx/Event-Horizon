---
name: gitnexus-area-nexus
description: "Skill for the Nexus area of Event-Horizon. 31 symbols across 10 files."
---

# Nexus

31 symbols | 10 files | Cohesion: 76%

## When to Use

- Working with code in `src/`
- Understanding how getInstallLedgerDir, getReceiptPath, listReceipts work
- Modifying nexus-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/installLedger.ts` | InstallLedgerError, expectString, getInstallLedgerDir, getReceiptPath, isIso8601 (+10) |
| `src/core/nexus/collectionUpload.ts` | listOwnNexusCollections, resolveNexusCollection, describeUploadError, toOutcome, callback |
| `src/core/nexus/collectionRevision.ts` | comparable, nexusCollectionOfDownload, readNexusCollectionRevision |
| `src/ui/runtime/collectionUpdates.ts` | downloadRevision, safeFileName |
| `src/core/receiptRoundTrip.test.ts` | throughDisk |
| `src/core/nexus/collectionUpdates.test.ts` | emitAndAwait |
| `src/core/nexus/collectionUpdates.ts` | latestPublishedRevision |
| `src/core/nexus/collectionUpload.test.ts` | emitAndAwait |
| `src/ui/pages/curator/useCuratorActions.ts` | refreshUpdates |
| `src/core/nexus/collectionPayload.ts` | describeNexusPointer |

## Entry Points

Start here when exploring this area:

- **`getInstallLedgerDir`** (Function) — `src/core/installLedger.ts:144`
- **`getReceiptPath`** (Function) — `src/core/installLedger.ts:128`
- **`listReceipts`** (Function) — `src/core/installLedger.ts:535`
- **`parseReceipt`** (Function) — `src/core/installLedger.ts:159`
- **`serializeReceipt`** (Function) — `src/core/installLedger.ts:416`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `InstallLedgerError` | Class | `src/core/installLedger.ts` | 74 |
| `getInstallLedgerDir` | Function | `src/core/installLedger.ts` | 144 |
| `getReceiptPath` | Function | `src/core/installLedger.ts` | 128 |
| `listReceipts` | Function | `src/core/installLedger.ts` | 535 |
| `parseReceipt` | Function | `src/core/installLedger.ts` | 159 |
| `serializeReceipt` | Function | `src/core/installLedger.ts` | 416 |
| `writeReceipt` | Function | `src/core/installLedger.ts` | 472 |
| `nexusCollectionOfDownload` | Function | `src/core/nexus/collectionRevision.ts` | 56 |
| `readNexusCollectionRevision` | Function | `src/core/nexus/collectionRevision.ts` | 25 |
| `latestPublishedRevision` | Function | `src/core/nexus/collectionUpdates.ts` | 39 |
| `listOwnNexusCollections` | Function | `src/core/nexus/collectionUpload.ts` | 105 |
| `resolveNexusCollection` | Function | `src/core/nexus/collectionUpload.ts` | 136 |
| `refreshUpdates` | Function | `src/ui/pages/curator/useCuratorActions.ts` | 698 |
| `downloadRevision` | Function | `src/ui/runtime/collectionUpdates.ts` | 249 |
| `describeNexusPointer` | Function | `src/core/nexus/collectionPayload.ts` | 168 |
| `describeUploadError` | Function | `src/core/nexus/collectionUpload.ts` | 276 |
| `callback` | Function | `src/core/nexus/collectionUpload.ts` | 207 |
| `expectString` | Function | `src/core/installLedger.ts` | 678 |
| `isIso8601` | Function | `src/core/installLedger.ts` | 729 |
| `isSemverLike` | Function | `src/core/installLedger.ts` | 721 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Dashboard → GetEventHorizonRoot` | cross_community | 10 |
| `LoadDashboardData → GetVortexUserDataPath` | cross_community | 10 |
| `Dashboard → Truncate` | cross_community | 7 |
| `RefreshUpdates → GetVortexUserDataPath` | cross_community | 7 |
| `Dashboard → Fail` | cross_community | 5 |
| `Dashboard → Ok` | cross_community | 5 |
| `HandleDelete → InstallLedgerError` | cross_community | 4 |
| `HandleDelete → IsUuid` | cross_community | 4 |
| `Upload → EmitAndAwait` | cross_community | 3 |
| `Upload → EmitAndAwait` | cross_community | 3 |

## How to Explore

1. `context({name: "getInstallLedgerDir"})` — see callers and callees
2. `query({search_query: "nexus"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
