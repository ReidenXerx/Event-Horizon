---
name: gitnexus-area-presentation
description: "Skill for the Presentation area of Event-Horizon. 40 symbols across 5 files."
---

# Presentation

40 symbols | 5 files | Cohesion: 79%

## When to Use

- Working with code in `src/`
- Understanding how imageFormatOf, b, isEmptyPresentation work
- Modifying presentation-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/presentation/presentation.ts` | imageFormatOf, b, isEmptyPresentation, isPresentationEntry, isPresentationFileName (+17) |
| `src/core/presentation/presentationAssets.ts` | PresentationImageError, importPresentationImage, measure, megabytes, presentationAssetsDir (+3) |
| `src/core/presentation/presentationCache.ts` | extractPresentation, fileNameOf, loadCachedPresentation, matches, presentationCacheDir (+2) |
| `src/core/presentation/presentation.test.ts` | many, img |
| `src/core/manifest/packageZip.ts` | validateInput |

## Entry Points

Start here when exploring this area:

- **`imageFormatOf`** (Function) — `src/core/presentation/presentation.ts:89`
- **`b`** (Function) — `src/core/presentation/presentation.ts:90`
- **`isEmptyPresentation`** (Function) — `src/core/presentation/presentation.ts:153`
- **`importPresentationImage`** (Function) — `src/core/presentation/presentationAssets.ts:61`
- **`presentationAssetsDir`** (Function) — `src/core/presentation/presentationAssets.ts:35`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `PresentationImageError` | Class | `src/core/presentation/presentationAssets.ts` | 40 |
| `imageFormatOf` | Function | `src/core/presentation/presentation.ts` | 89 |
| `b` | Function | `src/core/presentation/presentation.ts` | 90 |
| `isEmptyPresentation` | Function | `src/core/presentation/presentation.ts` | 153 |
| `importPresentationImage` | Function | `src/core/presentation/presentationAssets.ts` | 61 |
| `presentationAssetsDir` | Function | `src/core/presentation/presentationAssets.ts` | 35 |
| `resolvePresentationForBuild` | Function | `src/core/presentation/presentationAssets.ts` | 104 |
| `image` | Function | `src/core/presentation/presentationAssets.ts` | 116 |
| `isPresentationEntry` | Function | `src/core/presentation/presentation.ts` | 134 |
| `isPresentationFileName` | Function | `src/core/presentation/presentation.ts` | 128 |
| `readPresentation` | Function | `src/core/presentation/presentation.ts` | 208 |
| `image` | Function | `src/core/presentation/presentation.ts` | 216 |
| `readPresentationConfig` | Function | `src/core/presentation/presentation.ts` | 273 |
| `presentationImages` | Function | `src/core/presentation/presentation.ts` | 300 |
| `withImagesPresent` | Function | `src/core/presentation/presentation.ts` | 315 |
| `keep` | Function | `src/core/presentation/presentation.ts` | 320 |
| `extractPresentation` | Function | `src/core/presentation/presentationCache.ts` | 99 |
| `loadCachedPresentation` | Function | `src/core/presentation/presentationCache.ts` | 146 |
| `presentationCacheDir` | Function | `src/core/presentation/presentationCache.ts` | 46 |
| `isHexColor` | Function | `src/core/presentation/presentation.ts` | 113 |

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

1. `context({name: "imageFormatOf"})` — see callers and callees
2. `query({search_query: "presentation"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
