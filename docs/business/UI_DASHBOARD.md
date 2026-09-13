# UI Dashboard — Phase 5.4

The home of the Event Horizon UI. A single read-only summary screen that shows the user (player + curator) what's installed, what's been built, and what the system thinks is going on. Renders at the `home` route.

> **Status:** shipped — `HomePage.tsx` is now a fully-featured dashboard, replacing the earlier hero-only landing page from Phase 5.0.

---

## Trigger

| Source | What happens |
|---|---|
| User opens the Event Horizon page in Vortex | The default route is `home`, so `<HomePage>` mounts |
| User clicks the **Dashboard** tab in the EH nav | `EventHorizonMainPage` switches the route, remounts the page (route key) |
| User clicks **Done** at the end of the build wizard | Calls `props.onNavigate("home")`, mounts the dashboard |
| User clicks **Refresh** on the dashboard itself | Bumps `refreshTick`, re-runs the loader |

The page is always mounted in the `loading` state — there is no cached data between navigations. This is the simplest correctness guarantee: anything the user did elsewhere (install / uninstall / build) is reflected on the next mount.

## Preconditions

- Standard provider stack (api / errors / toasts).
- `<appData>/Vortex/event-horizon/` may not exist yet — the loader treats it as empty for every section.
- An active game / profile is **not** required. Sections that need it ("active profile" tile) display "—" / "No game selected".

## Inputs

| Source | Used for |
|---|---|
| `useApi()` | Reading active game, profile, Vortex version |
| `loadDashboardData(api)` | Single concurrent fetch of every section |
| `<appData>/Vortex/event-horizon/installs/*.json` | Player panel — `listReceipts` |
| `<appData>/Vortex/event-horizon/collections/.config/*.json` | Curator panel — config summaries |
| `<appData>/Vortex/event-horizon/collections/*.ehcoll` | Curator panel — built-package summaries |
| `refreshTick` (internal) | Forces a re-fetch on user action |

The dashboard does no Redux subscriptions and no filesystem watching — it's a snapshot view, refreshed on demand.

## Behavior

### 1. State machine

```
loading
  ↓ loadDashboardData resolves
ready { data }
  ↑ refresh() (bumps refreshTick)
error
  ↑ Try again button on the ErrorPanel
```

`loadDashboardData` is **resilient** — it always resolves with a `DashboardData` object even if individual sections failed. The dashboard only enters `error` if the top-level call itself throws (e.g. `useApi()` returned undefined, which shouldn't happen). Per-section errors land on the relevant slice (`receiptErrors`, `curatorConfigs[i].error`).

### 2. The data layer (`loadDashboardData`)

Single function in `src/ui/pages/dashboard/data.ts`:

1. `readSystemStatus(api)` — synchronous; reads `getActiveGameId`, `getActiveProfileIdFromState`, `resolveProfileName`, `resolveVortexVersion`, `util.getVortexPath("appData")`. Builds `SystemStatus`.
2. `Promise.all([loadReceipts, loadCuratorConfigs, loadBuiltPackages])` — three independent reads in parallel.

#### `loadReceipts(appDataPath)`
- Calls `listReceipts(appDataPath, onParseError)` from `core/installLedger.ts`.
- Wraps the call in try/catch; a top-level throw goes into `errors[0]` with filename `"<install-ledger>"`.
- Sorts results newest-first by `installedAt`.

#### `loadCuratorConfigs(appDataPath)`
- `fsp.readdir(<appData>/Vortex/event-horizon/collections/.config/)` — `ENOENT` returns `[]`.
- Filters to `*.json`, parallelizes per-file.
- Each entry: `Promise.all([fsp.stat, fsp.readFile])` then `JSON.parse`. Either of those failing yields a `{ slug, configPath, modifiedAt: stat?.mtimeMs ?? 0, error }` summary.
- Sorts newest-mtime-first.

#### `loadBuiltPackages(appDataPath)`
- `fsp.readdir(<appData>/Vortex/event-horizon/collections/)` — `ENOENT` returns `[]`.
- Filters to `*.ehcoll`, `fsp.stat` per file, skipping non-files (and silently skipping files that disappear between readdir and stat).
- Sorts newest-mtime-first.

### 3. The page anatomy

When `state.kind === "ready"` the dashboard renders five horizontal bands:

| Band | Component | Purpose |
|---|---|---|
| Hero (compact) | `Hero` | Logo, "Event Horizon" wordmark, tagline. Always visible. |
| System status bar | `SystemStatusBar` | 4 status tiles + a Refresh button |
| Quick actions row | `QuickActionsRow` | 3 large CTA cards (Install / Collections / Build) tagged "Player" / "Curator" |
| Player + Curator grid | `PlayerCuratorGrid` | Two side-by-side panels |
| Footer row | `FooterRow` | Supported games chip list + appData path |

Each band animates in with `eh-fade-up` staggered via the `eh-stagger` parent class so the page reads as a deliberate reveal rather than a wall of text on mount.

### 4. The system status bar (`SystemStatusBar`)

Four `StatusTile`s:

| Tile | Content | Pill |
|---|---|---|
| Active game | `status.gameLabel` | `success` "supported" / `warning` "unsupported" / `neutral` "no game" |
| Active profile | `status.profileName ?? "—"` | `info` with the profile id (monospace) |
| Vortex version | `status.vortexVersion` | `neutral` |
| Receipts | `data.receipts.length` collections | `info` if > 0 |

A Refresh button to the right re-runs the loader. The button shows a small spinner during loading.

### 5. The quick actions row (`QuickActionsRow`)

Three `Card`s in a 3-column grid:

| Card | Icon | Tag | CTA → |
|---|---|---|---|
| Install a collection | EventHorizonLogo small | Player | `install` |
| My Collections | filled disk icon | Player | `collections` |
| Build a collection | tools icon | Curator | `build` |

Each card uses the disk-gradient hover effect from `UI_FOUNDATION.md`. Hovering nudges the card up by 2 px.

### 6. The player panel (`PlayerPanel`)

Single `Card`. Title: "Player". Body:

| Region | Contents |
|---|---|
| Header | Receipt count (e.g. "3 collections") |
| Receipts list | Top 3 by `installedAt`, each row: package name + version pill + `installed Xd ago`. Click → `onNavigate("collections")`. |
| Receipt errors | If `receiptErrors.length > 0`, danger-colored summary with the first 3 file names |
| Footer CTA | "Open My Collections" → `onNavigate("collections")` |
| Empty state | If both receipts and errors are empty, a centered message + "Install your first collection" CTA → `onNavigate("install")` |

Receipt rows do NOT open the detail modal in-place — clicking takes the user to the Collections page where the detail modal lives. Keeping the dashboard read-only is a deliberate constraint.

### 7. The curator panel (`CuratorPanel`)

Two stacked sub-cards.

**"Collection configs"**:
- Subtitle: count of configs.
- Top 3 by `modifiedAt`, each row: slug + `package.id` (monospace, faint) + `edited Xh ago`.
- Click → `onNavigate("build")` (the build wizard opens on the most recently used slug by default).
- Errored configs render a danger-color row with the parser message.

**"Built packages"**:
- Subtitle: count of `.ehcoll` files.
- Top 3 by `modifiedAt`, each row: file name + `formatBytes(sizeBytes)` + `built Xd ago`.
- Click does not open Electron's shell directly — keeps the dashboard read-only. The curator opens the file from the Build wizard's done step or from the file system.

**Empty states** for both sub-cards: prompt to "Open the build wizard" → `onNavigate("build")`.

### 8. The footer (`FooterRow`)

A horizontal pill list of every supported game (`skyrimse`, `fallout3`, `falloutnv`, `fallout4`, `starfield`) with the active one styled with the disk gradient. Below that, the `appData` path (monospace, click-to-copy via toast feedback).

### 9. The error state (`ErrorPanel`)

If the top-level `loadDashboardData` throws, the page renders a small card with the formatted error title + a "Try again" button that calls `refresh()`. The full report is already available in the global `ErrorReportModal`. Per-section failures never reach this panel — they render in-place inside their respective sub-cards.

## Outputs

| Output | When |
|---|---|
| Three reads under `<appData>/Vortex/event-horizon/` | On mount and on every refresh |
| Vortex state read (synchronous) | On mount and on every refresh |
| Click-to-copy toast for the `appData` path | On user click |
| Navigation calls (`onNavigate`) | On any CTA click |
| Global error modal | If `loadDashboardData` itself throws |

The dashboard does not write to disk and does not mutate Vortex state.

## Failure modes

| Symptom | Likely cause | Mitigation |
|---|---|---|
| Dashboard sits at "Loading…" forever | One of the three `Promise.all` arms is genuinely hung (unlikely; readdir + per-file stat are fast) | Click Refresh — the alive-ref guard suppresses the stale dispatch and a fresh load kicks off. |
| Receipts panel says "1 receipt failed to load" | A file under `installs/` has invalid JSON | Open Collections page (it shows the same error banner with full filename) and fix or delete the file. |
| Curator config row says "(parse error)" | Hand-edited config has invalid JSON | Click the row → opens Build wizard. Build will refuse with `CollectionConfigError` until fixed. Alternative: delete the file for a fresh config. |
| "Active game" tile shows "Unsupported" | User is on a non-Creation-Engine game | Switch games in Vortex; refresh. |
| Built packages list is empty even though the user just built one | The build wizard wrote to a different appData (rare; usually a multi-Vortex-install scenario) | Verify the path shown in the footer matches the directory the wizard logs. |
| Stale data after install/build elsewhere | Dashboard doesn't auto-refresh | Click Refresh. By design — see Quirks. |

## Quirks & invariants

- **INVARIANT: the dashboard is read-only.** No filesystem writes, no Vortex mutations. Every action is either navigation, refresh, or copy-to-clipboard.
- **INVARIANT: per-section errors never block other sections.** A bad receipt JSON shows in the player panel; the curator panel keeps working. A `readdir` error becomes "0 results"; nothing throws.
- **INVARIANT: the data layer always resolves.** The `state.kind === "error"` branch is a safety net for unexpected throws; in practice it should never fire.
- **No filesystem watching.** Refresh is manual. The page is meant to be a checkpoint, not a live monitor — Vortex itself is the live monitor.
- **Top-3 limits are hard-coded.** Receipts, configs, and packages each show the 3 most-recent entries; the rest are accessible via the Collections page or the file system. Adding a "show more" toggle is trivial but unrequested.
- **The active-game pill uses a strict supported-set membership check.** Even if the user has a perfectly working extension for a game we don't list, the tile says "Unsupported" — that's by design, the install + build pipelines also gate on this set.
- **Refresh resets the loading state.** Already-rendered data is replaced by a spinner. We considered showing the previous data with a subtle overlay, but tester feedback was "I want to know it actually re-fetched", so the spinner stays.
- **QUIRK:** `formatRelativeTime` uses calendar buckets (sec / min / h / d / w / mo / y) without any timezone awareness — the underlying mtimes are `mtimeMs` and `installedAt` is an ISO timestamp. Edge cases (DST swaps, system clock changes) can produce odd "Xh ago" values for the very recent entries. Acceptable.
- **QUIRK:** Curator config rows show the slug, not the collection's `package.name` from the config. Names can drift from slugs over time (re-renaming inside the wizard). Showing the slug is unambiguous; showing the name would require parsing every config (already done) and surfacing the readable name is a future polish item.
- **The "active" pill on the Receipts panel uses `settings.profiles.activeProfileId`** — same logic as the Collections page. The dashboard panel does not show this pill; it's purely a Collections-page concern.

## Acknowledged gaps

- **No "tail" log feed.** Useful for testers — we'd surface the last N events from the install / build pipelines. Currently this lives only in the wizard's running step.
- **No "size on disk" total.** The footer doesn't say "Event Horizon takes up X MB on this machine"; computing that requires summing the bundle records + receipts + configs.
- **No theme switcher** (Gargantua → alt palette). The token system supports it; the UI doesn't expose it.
- **No keyboard shortcut binding for Refresh.** F5 falls through to Vortex's renderer, which usually no-ops. Adding `useEffect` with `keydown` listener is straightforward.
- **No localization.**
- **No "open in Explorer" action on the appData path.** The path is selectable text; one click copies. Adding `shell.openPath` is one line — not done because we want the dashboard kept strictly read-only.
- **No per-game grouping in the receipts panel.** With <50 receipts in practice, a flat list works. We'll add grouping if a tester actually has 50.

## Code references

| File | What it owns |
|---|---|
| `src/ui/pages/HomePage.tsx` | The page — `HomePage` (boundary wrapper), `Dashboard`, `Hero`, `LoadingPanel`, `ErrorPanel`, `DashboardBody`, `SystemStatusBar`, `StatusTile`, `QuickActionsRow`, `PlayerCuratorGrid`, `PlayerPanel`, `CuratorPanel`, `FooterRow` |
| `src/ui/pages/dashboard/data.ts` | `loadDashboardData`, `readSystemStatus`, `loadReceipts`, `loadCuratorConfigs`, `loadBuiltPackages`, `formatBytes`, `formatRelativeTime`, `SUPPORTED_GAME_IDS`, `GAME_LABELS` |
| `src/core/installLedger.ts` | `listReceipts` (player section) |
| `src/core/getModsListForProfile.ts` | `getActiveGameId`, `getActiveProfileIdFromState` |
| `src/core/resolver/userState.ts` | `resolveProfileName`, `resolveVortexVersion` |
| `src/ui/state/ApiContext.tsx` | `useApi` |
| `src/ui/errors/index.ts` | `ErrorBoundary`, `useErrorReporter`, `useErrorReporterFormatted` |
| `src/ui/components/Card.tsx`, `Pill.tsx`, `Button.tsx`, `EventHorizonLogo.tsx`, `ProgressRing.tsx` | UI primitives |
| `src/ui/routes.ts` | The `home` route descriptor (label "Dashboard") |

## Relationship to the rest of the system

The dashboard is the most read-heavy page; it mirrors what the install wizard, the collections page, and the build wizard each look at piecewise:

| Data source | Dashboard band | Other consumer |
|---|---|---|
| `installs/*.json` | Player panel | Collections page (full list + actions), Install wizard (receipt lookup) |
| `collections/.config/*.json` | Curator panel | Build wizard (loaded into form) |
| `collections/*.ehcoll` | Curator panel | Build wizard's output |
| Active game / profile / Vortex version | Status bar | Install + Build engines (validation) |

If any of those four data shapes change, this page must update too — the dashboard is the canary that surfaces "the on-disk shape drifted" before testers notice in the Collections or Build pages.
