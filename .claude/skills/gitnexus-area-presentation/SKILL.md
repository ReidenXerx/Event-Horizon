---
name: gitnexus-area-presentation
description: "Skill for the Presentation area of Event-Horizon. 49 symbols across 9 files."
---

# Presentation

49 symbols | 9 files | Cohesion: 73%

## When to Use

- Working with code in `src/`
- Understanding how hashFileSha256, cleanup, detectExternalDependencies work
- Modifying presentation-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/presentation/presentation.ts` | imageFormatOf, b, isEmptyPresentation, isPresentationEntry, isPresentationFileName (+17) |
| `src/core/presentation/presentationAssets.ts` | PresentationImageError, importPresentationImage, measure, megabytes, readHead (+2) |
| `src/core/presentation/presentationCache.ts` | extractPresentation, fileNameOf, loadCachedPresentation, matches, presentationCacheDir (+2) |
| `src/core/manifest/externalDependencies.ts` | SCRIPT_EXTENDER_VERSION, detectExternalDependencies, findFile |
| `src/core/resolver/collectAvailableDownloads.ts` | belongsToGame, collectAvailableDownloads, readDownloadFiles |
| `src/core/archiveHashing.ts` | hashFileSha256, cleanup |
| `src/core/installer/adoptLocalArchive.ts` | copyIn, holdsSameBytes |
| `src/core/presentation/presentation.test.ts` | many, img |
| `src/core/manifest/packageZip.ts` | validateInput |

## Entry Points

Start here when exploring this area:

- **`hashFileSha256`** (Function) — `src/core/archiveHashing.ts:39`
- **`cleanup`** (Function) — `src/core/archiveHashing.ts:59`
- **`detectExternalDependencies`** (Function) — `src/core/manifest/externalDependencies.ts:479`
- **`imageFormatOf`** (Function) — `src/core/presentation/presentation.ts:89`
- **`b`** (Function) — `src/core/presentation/presentation.ts:90`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `PresentationImageError` | Class | `src/core/presentation/presentationAssets.ts` | 43 |
| `hashFileSha256` | Function | `src/core/archiveHashing.ts` | 39 |
| `cleanup` | Function | `src/core/archiveHashing.ts` | 59 |
| `detectExternalDependencies` | Function | `src/core/manifest/externalDependencies.ts` | 479 |
| `imageFormatOf` | Function | `src/core/presentation/presentation.ts` | 89 |
| `b` | Function | `src/core/presentation/presentation.ts` | 90 |
| `importPresentationImage` | Function | `src/core/presentation/presentationAssets.ts` | 64 |
| `image` | Function | `src/core/presentation/presentationAssets.ts` | 159 |
| `collectAvailableDownloads` | Function | `src/core/resolver/collectAvailableDownloads.ts` | 91 |
| `isEmptyPresentation` | Function | `src/core/presentation/presentation.ts` | 153 |
| `isPresentationEntry` | Function | `src/core/presentation/presentation.ts` | 134 |
| `isPresentationFileName` | Function | `src/core/presentation/presentation.ts` | 128 |
| `readPresentation` | Function | `src/core/presentation/presentation.ts` | 208 |
| `image` | Function | `src/core/presentation/presentation.ts` | 216 |
| `readPresentationConfig` | Function | `src/core/presentation/presentation.ts` | 273 |
| `resolvePresentationForBuild` | Function | `src/core/presentation/presentationAssets.ts` | 147 |
| `presentationImages` | Function | `src/core/presentation/presentation.ts` | 300 |
| `withImagesPresent` | Function | `src/core/presentation/presentation.ts` | 315 |
| `keep` | Function | `src/core/presentation/presentation.ts` | 320 |
| `extractPresentation` | Function | `src/core/presentation/presentationCache.ts` | 99 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `PresentationCard → Channel` | cross_community | 7 |
| `PresentationCard → RgbOf` | cross_community | 7 |
| `CollectionGallery → Channel` | cross_community | 6 |
| `CollectionGallery → RgbOf` | cross_community | 6 |
| `PresentationCard → IsHexColor` | cross_community | 5 |
| `RunLoadingPipelineWithReceipt → AbortError` | cross_community | 5 |
| `RunLoadingPipelineWithReceipt → Cleanup` | cross_community | 5 |
| `RunLoadingPipelineWithReceipt → SafePackageVersion` | cross_community | 5 |
| `RunLoadingPipelineWithReceipt → Update` | cross_community | 5 |
| `ReceiptCard → Channel` | cross_community | 5 |

## How to Explore

1. `context({name: "hashFileSha256"})` — see callers and callees
2. `query({search_query: "presentation"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
