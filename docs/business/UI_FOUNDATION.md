# UI Foundation — Phase 5.0

The first slice of the Event Horizon React UI. Establishes the design system, the animated brand mark, the page shell, and the route table. Later slices (5.1 install wizard, 5.2 collections list, 5.3 build wizard) plug into this foundation without touching the chrome.

> **Status:** shipped — `EventHorizonMainPage` is registered with Vortex and the `home`, `about`, `install`, `collections`, and `build` routes render. `install` / `collections` / `build` show "still cooking" placeholders that will be replaced in their own slices.

---

## Trigger

The user clicks the **Event Horizon** entry in Vortex's main left-side navigation. Vortex hosts our `EventHorizonMainPage` component inside its main content area; from there everything is internal to our React tree.

## Preconditions

- Vortex 2.x with `@nexusmods/vortex-api` (provides `MainPage`, `FlexLayout`, `Icon`, etc.).
- React 18 runtime (provided by Vortex itself). Was React 16 until the Vortex 2.x
  migration; the extension declares no React dependency of its own beyond types.
- Our extension's `src/index.ts#init` has called `context.registerMainPage(EH_SIDEBAR_ICON, "Event Horizon", EventHorizonMainPage, { id: "event-horizon", group: "global", priority: 50, props: () => ({ api: context.api }) })`, where `EH_SIDEBAR_ICON` is `"event-horizon-logo"` — the symbol id in the SVG sprite installed by `installEventHorizonIconSet()`.
- No other prerequisite — the foundation has zero dependency on the install / build pipelines and works on a fresh Vortex install with no profile selected.

## Inputs

| Source | Used for |
|---|---|
| Vortex `props.active` (boolean) | Currently ignored. Reserved for future "pause heavy work when hidden" optimizations. |
| Internal `useState<EventHorizonRoute>` | The active page within our nav. Defaults to `home`. |
| `prefers-reduced-motion: reduce` (CSS media query) | Disables ambient rotation/orbit/warp animations and dampens entrance durations. Glows and colors stay intact. |

No Redux state, no filesystem reads, no profile data — the foundation is **pure presentation**.

## Behavior

### 1. Style injection

`EventHorizonMainPage` mounts **once per page render** and immediately renders an `<EventHorizonStyles />` component as its first child. This component emits a single `<style id="eh-styles">` element containing the concatenation of:

1. `tokens.ts`     — `:root { --eh-* }` design tokens (colors, spacing, typography, motion).
2. `keyframes.ts`  — every `@keyframes` block used anywhere in the UI.
3. `base.ts`       — base reset + typography + starfield + scrollbar styling, all scoped under `.eh-app`.
4. `components.ts` — class styles for `.eh-button`, `.eh-card`, `.eh-pill`, `.eh-nav`, `.eh-page`, `.eh-hero`, etc.
5. `logo.ts`       — animation rules for the `EventHorizonLogo` SVG layers.

**Why inline `<style>` instead of imported `.css` files?** The extension is built with bare `tsc` (no bundler). tsc cannot bundle CSS and Vortex's runtime has no loader resolution for `import "./foo.css"`. Inline strings ship as part of the compiled JS — zero extra build pipeline.

The `<style>` carries a stable `id` (`"eh-styles"`) so React renders never produce duplicates if the page re-mounts.

### 2. Page shell

The shell DOM is:

```
.eh-app
  ├── <style id="eh-styles">     ← all CSS, injected once
  └── .eh-app__inner
        ├── .eh-nav              ← top nav bar (sticky)
        └── .eh-app__main        ← scrollable content area
              └── (current route's page component)
```

`.eh-app::before` is a pure-CSS starfield (10 layered radial-gradient dots, twinkling on the warp timer). `.eh-app::after` is two faint nebular washes for depth (no animation). Both pseudo-elements live in the page background and never intercept clicks.

### 3. Navigation

`NavBar` renders a brand button (`logo + "EVENT HORIZON" wordmark`), a list of route tabs, and a meta strip with the version. Each tab is a `<button role="tab">`; the active tab gets:
- text color → `--eh-text-primary`
- a 2px gradient bar underneath, animated in via `eh-fade-in`

Hidden routes (`RouteDescriptor.hidden = true`) are filtered out of the visible nav, but the `RouteOutlet` still handles their ids if navigated to programmatically.

### 4. Route resolution

`RouteOutlet` is a switch on the current route. Each case returns the corresponding page component **with `key={routeId}`**, so navigating between routes always remounts the destination — letting the page's entrance animations replay without bookkeeping.

| Route id | Page component | Status |
|---|---|---|
| `home` | `HomePage` | Shipped |
| `install` | `InstallPage` | Shipped |
| `collections` | `CollectionsPage` | Shipped |
| `build` | `BuildPage` | Shipped |
| `plugin-diffs` | `PluginDiffsPage` | Shipped |
| `mod-diffs` | `ModDiffsPage` | Shipped |
| `about` | `AboutPage` | Shipped |

All seven routes now resolve to a real page. `ComingSoonPage` was the placeholder
used while 5.1-5.3 were in flight; it has been deleted along with its barrel export.

The exhaustiveness check at the bottom of `RouteOutlet` (`const exhaustive: never = route`) guarantees TypeScript will fail the build if a new `EventHorizonRoute` member is added without a matching case.

### 5. Hero (HomePage)

The home page hero is a vertical column:

| Element | Animation timeline |
|---|---|
| Animated logo (180 px) | `eh-fade-scale 720ms` |
| Tagline ("A Vortex collection installer") | `eh-text-reveal 720ms`, delay 80ms |
| Wordmark "Event Horizon" with disk-gradient text fill | `eh-text-reveal 720ms`, delay 200ms |
| Subtitle paragraph | `eh-text-reveal 720ms`, delay 320ms |

Below the hero, the CTA grid is wrapped in `.eh-stagger`, which gives every direct child a sequential 80ms delay on its `eh-fade-up` entrance. Three cards (Install / Collections / Build) lead the user into the route they care about; each card has the disk-gradient border-on-hover effect (CSS `mask-composite: exclude` trick) and a subtle translate-Y hover.

### 6. Animated logo (`EventHorizonLogo`)

Five SVG layers rendered inside a 200×200 viewBox, each with its own per-instance `<defs>` ids (so multiple logos on the same page never collide on gradient-id resolution).

| Layer | Element | Animation |
|---|---|---|
| 1 — Halo | `<circle>` filled with a faint radial gradient + Gaussian blur | `eh-pulse-glow 4s` (CSS class on the wrapper, not the layer) |
| 2 — Photon ring | `<circle>` stroke at radius 86, mostly faint with one bright cyan dash | `eh-rotate-ccw` over `--eh-dur-orbit` (20 s default) |
| 3 — Accretion disk | Two `<circle>` strokes (radii 74 + 62) using the disk gradient, plus dashed bright "embers" | `eh-rotate-cw` over `--eh-dur-orbit-fast` (12 s default) |
| 4 — Lens arc | A short bright `<path>` arc (one quadrant) | `eh-doppler-sweep 8s` — fades in/out while rotating |
| 5 — Singularity core | `<circle>` filled with a radial-gradient (black centre, faint violet ring at the edge) | `eh-pulse-opacity 4s` (subtle breathing) |

The wrapper `<span>` itself runs `eh-warp-pulse` on `--eh-dur-warp` (6 s) — every cycle the whole logo briefly scales 1.025× with a tiny blur, reading as a subtle gravitational shimmer.

Under `prefers-reduced-motion: reduce`, layers 1–4's rotation/sweep animations are killed (`animation: none !important`); only the core breathing remains so the logo doesn't feel dead.

### 7. Reduced-motion handling

`tokens.ts` ships a `@media (prefers-reduced-motion: reduce)` block that overrides:

```css
--eh-dur-warp: 0s;
--eh-dur-orbit: 0s;
--eh-dur-orbit-fast: 0s;
--eh-dur-deliberate: var(--eh-dur-fast);
--eh-dur-slow: var(--eh-dur-fast);
--eh-dur-base: var(--eh-dur-fast);
```

That single block collapses every ambient + entrance animation to either "instant" (rotation, orbit, warp) or "fast" (entrances), without touching any component-specific code. Glows, gradients, and colors stay intact — accessibility doesn't mean ugly.

## Outputs

The foundation produces no side effects outside the React tree:

- **No filesystem writes.**
- **No Redux dispatches.**
- **No notifications, dialogs, or toasts.**
- **One stable `<style>` element** appended to the document.

When a user clicks a CTA card or nav tab, the only effect is `setRoute(...)`, which triggers a remount of the route component.

## Failure modes

| Symptom | Likely cause | Mitigation |
|---|---|---|
| Page is invisible / black | `<style>` failed to inject (very rare) | Errors during render bubble up to Vortex's error boundary; refresh the page. |
| Logo is unanimated | `prefers-reduced-motion: reduce` is set OS-wide | Intentional. Logo still renders, just static. |
| CTA cards don't fade in sequentially | User has reduced-motion enabled | Intentional — they fade in fast but together. |
| Multiple "Event Horizon" entries appear in Vortex sidebar | Old extension copy still present in `%APPDATA%/Vortex/plugins/` | Run `npm run deploy:vortex` to overwrite, or remove the stale folder. |
| `gitnexus` tooling reports stale index | New `.tsx` files weren't picked up | Run `npx gitnexus analyze --force`. |

## Quirks & invariants

- **No router.** We deliberately do not use `react-router`. Vortex hosts us inside its own electron-router, and layering routers causes hash-fragment conflicts. We use a plain `useState<EventHorizonRoute>` and reload the destination on every navigation by keying on the route id.
- **No global state.** Phase 5.0 has zero Redux, zero context. Routes are local state; this keeps the foundation independent of every other slice. Later slices can add context providers as they need them, but the chrome won't.
- **Single CSS bundle.** All theme files export plain strings; the only place they're concatenated is `EventHorizonStyles.tsx`. This makes A/B-testing a different palette ("Penrose" / "Hawking") a one-file change — swap which `tokens.ts` is concatenated.
- **Per-instance SVG ids.** `EventHorizonLogo` allocates a fresh integer id on first mount via a module-scope counter. Multiple logos on the same page (the nav has one at 28 px, the hero at 180 px) therefore never collide on gradient-id resolution. The counter is module-scoped, not React state, so re-renders don't allocate new ids.
- **CSS variables, not props.** Every visible measurement (size, color, motion duration) reads from CSS variables defined in `tokens.ts`. To restyle anything (e.g. shrink the logo or pick a colder accent), edit one variable, not one component.
- **No external animation library.** Every motion is pure CSS `@keyframes`. Vortex doesn't bundle framer-motion / react-spring; introducing them would require a webpack pipeline. The CSS approach is also strictly more performant — animations run on the compositor without touching the React render loop.
- **Fonts are system-stack.** We rely on Vortex's environment fonts (Segoe UI on Windows, SF on macOS) plus an Inter / SF Pro Display preference. No webfont download — keeps offline use working and avoids a FOUT.
- **Starfield is decorative.** It's rendered via `.eh-app::before` and is `pointer-events: none`. No JS, no canvas, no asset.

## Acknowledged gaps

- **No global error boundary inside `.eh-app`.** If a page component throws, Vortex's outer error boundary catches it but the user sees Vortex's generic error UI rather than an EH-themed one. Adding `.eh-app__error` is a Phase 5.4 polish item.
- **No toast / notification system inside `.eh-app`.** Phase 5.0 doesn't need it; Phase 5.1's install wizard will need to surface non-blocking events (download started, mod installed, abort confirmed). When that lands we'll add a portaled `Toast` primitive.
- **No keyboard shortcut binding.** Vortex's `IMainPageOptions.hotkey` is left unset; we'll wire one up if the extension ships outside the toolbar.
- **Version string is hardcoded.** `src/ui/version.ts` exports a string literal that must be hand-kept in sync with `package.json#version`. Wiring tsc to a `version.gen.ts` is a follow-up.

## Code references

| File | What it owns |
|---|---|
| `src/ui/theme/tokens.ts` | Design token CSS variables + reduced-motion overrides |
| `src/ui/theme/keyframes.ts` | Every `@keyframes` block used anywhere |
| `src/ui/theme/base.ts` | Body / typography / starfield / scrollbar / focus-ring styles, all scoped under `.eh-app` |
| `src/ui/theme/components.ts` | Class styles for nav, page, button, card, pill, ring, steps, hero, CTA grid, empty / coming-soon states |
| `src/ui/theme/logo.ts` | Animation rules for `EventHorizonLogo`'s five SVG layers |
| `src/ui/theme/EventHorizonStyles.tsx` | Concatenates the five CSS files into a single `<style>` element |
| `src/ui/components/EventHorizonLogo.tsx` | The animated SVG brand mark |
| `src/ui/components/Button.tsx`, `Card.tsx`, `Pill.tsx`, `ProgressRing.tsx`, `StepDots.tsx`, `Page.tsx` | UI primitives |
| `src/ui/routes.ts` | Route id type + descriptor table |
| `src/ui/version.ts` | Hardcoded `EXTENSION_VERSION` |
| `src/ui/EventHorizonMainPage.tsx` | Top-level component registered with Vortex; owns route state and `RouteOutlet` |
| `src/ui/pages/` (`HomePage`, `InstallPage`, `CollectionsPage`, `BuildPage`, `PluginDiffsPage`, `ModDiffsPage`, `AboutPage`) | Page bodies |
| `src/index.ts` | Calls `context.registerMainPage(...)` to wire the page into Vortex |

## Landed since this document was written

| Phase | Page | Replaced |
|---|---|---|
| **5.1** | `InstallPage` (multi-step wizard) | The `showDialog` chain in `installCollectionAction.ts` |
| **5.2** | `CollectionsPage` (receipt list + details) | Manual inspection of ledger files |
| **5.3** | `BuildPage` (curator wizard) | The dialog chain in `buildPackageAction.ts` |

The `installCollectionAction` and `buildPackageAction` dialog chains were removed (the build one
first, the install one on 2026-09-15): each had to be kept in step with its page by hand, and
both fell behind. The pages are the only path.
| **5.4** | Polish — toasts, error boundary, empty-state illustrations, full a11y audit | — |
