# UI Error Layer — Phase 5 (cross-cutting)

The observability spine that every Event Horizon React page sits on top of. Catches every error — thrown, rejected, or mid-render — and surfaces it as a structured, copy-able report so testers and contributors don't drown in cryptic stack traces.

> **Status:** shipped — wired into `EventHorizonMainPage` so the install wizard (5.1), collections page (5.2), build wizard (5.3), and dashboard all share the same reporting machinery.

---

## Trigger

Anything that goes wrong inside the Event Horizon React tree:

| Trigger | Reaches the layer via |
|---|---|
| A component throws during render or in a lifecycle | `ErrorBoundary` (per-app + per-page) |
| An effect's promise rejects and the component calls `reportError(...)` | `ErrorContext` |
| An uncaught error fires `window.onerror` | `ErrorProvider`'s global listener |
| An unhandled promise rejection fires `window.onunhandledrejection` | `ErrorProvider`'s global listener |
| Code wants a non-blocking notification (success / info) | `useToast()` (separate from error reporting, but documented here for completeness) |

The legacy toolbar actions (`installCollectionAction.ts`, `buildPackageAction.ts`) reported via Vortex's notification system; both have been removed (the install one on 2026-09-15), so installs and builds report through this layer.

## Preconditions

- The component using `reportError` / `useErrorReporterFormatted` is mounted inside `<ErrorProvider>` (and `EventHorizonMainPage` always provides one as part of its standard provider stack).
- The component using `useToast` is mounted inside `<ToastProvider>` (likewise provided).
- The Vortex IExtensionApi is accessible (the layer itself does not require it; downstream save-to-file uses Electron's renderer-side modules and is best-effort).

No filesystem or Redux preconditions. The layer works on a fresh Vortex install with no profile selected.

## Inputs

| Source | Used for |
|---|---|
| `unknown` (any thrown value) | Classified by `formatError` into a `FormattedError` |
| Optional `FormatErrorOptions` | Caller-provided `title` override and free-form `context` map merged into the report |
| `window.error` / `window.unhandledrejection` events | Auto-reported with title `"Uncaught error"` / `"Unhandled rejection"` |
| Electron's `clipboard` / `dialog` (best-effort `require("electron")`) | Copy-to-clipboard fallback and Save Report flow |

No state. The layer is pure UI.

## Behavior

### 1. Error formatting (`formatError`)

`formatError(err, opts?)` is a pure function `(unknown, FormatErrorOptions?) → FormattedError`. It walks an if/else ladder:

1. Already-formatted? If `err` already matches the `FormattedError` shape, return it unchanged (idempotent).
2. Project-known error class? Branches on `instanceof` for the named errors the rest of the codebase throws:

   | Class | Title | Hint surfaced |
   |---|---|---|
   | `ReadEhcollError` | "Couldn't open the .ehcoll package" | Verify the path and that 7z is available |
   | `ParseManifestError` | "Manifest is invalid" | Lists every `errors[]` entry from the parser |
   | `BuildManifestError` | "Manifest build failed" | Lists every fatal `errors[]` |
   | `PackageEhcollError` | "Packaging failed" | Lists every fatal `errors[]` |
   | `CollectionConfigError` | "Collection config invalid" | Hand-edit the JSON to match the schema |
   | `InstallLedgerError` | "Receipt is invalid" | Delete the receipt JSON if irrecoverable |

3. Plain `Error`? Title is the constructor's `name`, message is `err.message`, technical block holds the stack.
4. Anything else (string, plain object, primitive)? Title is `"Unknown error"`, message is `String(err)`, technical block holds the JSON-stringified value.

The result has stable fields:

```ts
type FormattedError = {
  title: string;
  message: string;
  severity: "error" | "warning";
  className: string;       // e.g. "BuildManifestError"
  hints: string[];         // user-actionable advice
  technical: string;       // multi-line text dump (stack, sub-errors, etc.)
  context?: Record<string, unknown>; // caller-supplied breadcrumbs
};
```

`buildErrorReport(formatted)` produces a copy/paste-friendly plain-text dump combining all fields plus a timestamp and a `### Event Horizon error report ###` banner.

### 2. ErrorBoundary (`ErrorBoundary`)

A class component (necessary — React's `componentDidCatch` is class-only). Two variants:

| Variant | Wrapping | Visual |
|---|---|---|
| `app` (default) | The whole `.eh-app__inner` | Full-page card, "Event Horizon hit a snag" |
| `page` | A single route's component (re-mounted via `key={route}`) | Inline card matching the page padding |
| `inline` | Any subtree | Compact card with reset button |

On `componentDidCatch`, the boundary:
1. Calls `formatError` on the thrown value.
2. If `props.onReport` is set, invokes it with the formatted error so the global modal opens. (`EventHorizonMainPage` wires `onReport={useErrorReporterFormatted()}` for both the app and per-page boundaries.)
3. Renders the local fallback UI with a "Try again" button that calls `setState({ error: undefined })` — re-mounting children clears the boundary's local error state.

### 3. ErrorContext + ErrorProvider

`ErrorProvider` owns one piece of state: the currently-displayed `FormattedError | undefined`. It exposes two hooks:

- `useErrorReporter()` → `(err: unknown, opts?) => void`. Auto-formats with `formatError`. The default for callers that just want to report a thrown value.
- `useErrorReporterFormatted()` → `(formatted: FormattedError) => void`. For places (like `ErrorBoundary`) that have already classified the error.

Both shape into the same `setCurrent(formatted)` call. The provider also installs `window.addEventListener("error", ...)` and `addEventListener("unhandledrejection", ...)` on mount, so out-of-tree async failures (timer callbacks, microtasks) end up in the same modal.

When that state (`current` in `ErrorContext.tsx`) is set, `<ErrorReportModal>` renders inside `.eh-app` (not portaled to body — see `Modal` rationale in UI_FOUNDATION).

### 4. ErrorReportModal

The modal's anatomy:

| Section | Behavior |
|---|---|
| Header | Title + severity pill (red for `error`, amber for `warning`) + class name pill |
| Message | The human-readable summary |
| Hints list | Bulleted; collapsed if empty |
| Context | Key-value tiles, only rendered if `formatted.context` is set |
| Technical (collapsed by default) | `<details>` element holding the multi-line dump |
| Footer | "Copy report", "Save as file…", "Close" |

**Copy report** uses `navigator.clipboard.writeText` first; if that throws (Electron renderer occasionally lacks Permissions on first call) it falls back to `require("electron").clipboard.writeText`. The fallback is best-effort wrapped in try/catch.

**Save as file…** opens an Electron save dialog (`remote.dialog.showSaveDialog` if available, else `electron.dialog.showSaveDialog`) defaulting to `event-horizon-error-<ISO timestamp>-<sanitized-title>.txt` and writes the result of `buildErrorReport` to disk. If neither dialog API is reachable (very old Vortex), the modal surfaces an inline error and copy-to-clipboard remains available.

Closing the modal clears `current` and the boundaries continue to render their local fallback so the user can decide to retry or stay put.

### 5. Toast system (sibling, not error)

`<ToastProvider>` and `useToast()` deliver non-blocking feedback for happy paths ("Switched to profile X", "Built v1.0.0"). Toasts:
- Render in a fixed-position list at the right edge.
- Animate in via `eh-slide-in-right` and out via fade.
- Auto-dismiss after `duration` ms (default 4500); manually dismissable by clicking the toast.
- Carry `intent ∈ { success, info, warning, danger }` mapping to the same color tokens as the error modal.

The toast layer is independent of the error layer but lives next to it because both wrap content in providers and both render inside `.eh-app`.

## Outputs

The layer produces:

- **One DOM modal at a time** (`.eh-modal__backdrop`) when an error is active.
- **Zero-N toast cards** in the toast host.
- **An optional file written by the user** through the Save dialog. No file is written without explicit user action.
- **Clipboard text** when the user clicks Copy.

No filesystem reads, no Redux dispatches, no Vortex notifications — the legacy code paths are the only ones that touch Vortex's notification rail.

## Failure modes

| Symptom | Likely cause | Mitigation |
|---|---|---|
| Modal opens but message says "Unknown error" with `String(err)` body | A non-Error value was thrown (e.g. `throw "boom"`) | Replace the throw site with `throw new Error("boom")`; the modal still works, just prefer real Errors. |
| Save Report button shows "Electron dialog API not available" | Vortex stripped `remote.dialog` and `dialog` from the renderer | Use Copy → paste into a text editor. Tell us the Vortex version so we can add a fallback. |
| Copy Report does nothing | Renderer has no `navigator.clipboard` and no `electron.clipboard` | Fallback path returns and modal stays open. Save-to-file is the workaround. |
| Modal fires inside an effect loop | A component repeatedly throws on every render (e.g. malformed plan rendered into the preview step) | Boundary's "Try again" remounts the subtree. If still broken, navigate away — the per-page boundary is keyed on route id so route change clears it. |
| Toast disappears before the user reads it | `duration` too short for a long message | Pass an explicit `duration` when calling `useToast()({ ... })`. |
| `gitnexus` tooling reports stale index | New `.tsx` files in `errors/` weren't picked up | Run `npx gitnexus analyze --force`. |

## Quirks & invariants

- **INVARIANT: every page wraps its body in `<ErrorBoundary variant="page" onReport={...}>`.** This is enforced by the page conventions, not the type system. The `EventHorizonMainPage` outer boundary catches anything the page boundary missed.
- **INVARIANT: the error modal lives inside `.eh-app`, not portaled to `<body>`.** Same reason as the generic `Modal` primitive — Vortex's chrome must remain visible so the user can navigate away.
- **The reporter is fire-and-forget.** `reportError` returns `void`. There's no per-call promise to await — the modal manages its own lifecycle.
- **Errors are deduplicated by replacement, not by stack hash.** If two errors fire in quick succession the second one replaces the first in the modal. Designed for "the user sees the most recent failure"; we accept losing earlier ones because they usually come from the same root cause.
- **Hints are user-actionable, not developer-actionable.** "Re-run gitnexus analyze --force" doesn't belong in a hint; "Verify the .ehcoll path is correct" does. Stack traces and class names go in the technical block.
- **No analytics, no telemetry.** The layer never phones home. Reports stay on the user's machine until they choose to share.
- **`windows.onerror` listener is single-instance.** `ErrorProvider` only attaches one listener regardless of remount count, by hard-coding the listener identity inside a `useEffect([])` block.
- **Toasts and the error modal can co-exist.** Toasts use `z-index: 2000` (`--eh-z-toast`), the modal backdrop uses `1000` (`--eh-z-modal`), so success toasts triggered while a modal is open render above the dimming.
- **QUIRK:** `formatError` matches by `instanceof`, which means errors that crossed a webpack/runtime boundary may fall back to the generic Error case. Match by `name` if that ever bites; for now, all of our throws stay in-process.

## Acknowledged gaps

- **No "report bundle" export.** `buildErrorReport` produces a single text file. A future iteration could zip it together with the recent log lines and the active manifest for one-click sharing.
- **No retry policy hooks.** The boundary's "Try again" remounts, but we don't surface "retry the last action" as a first-class concept; pages implement their own retry UI (the install wizard's `ErrorRetry` view, for example).
- **No localization.** Strings are English. Translatable bundles can land later — every string in `formatError` is centralized so swapping is a one-file change.
- **No throttling.** A pathological component that throws on every keystroke would flood the modal. Acceptable for now; we'd add `throttle(reportError, 500)` if it ever happens in practice.

## Code references

| File | What it owns |
|---|---|
| `src/ui/errors/formatError.ts` | The pure classifier + `buildErrorReport` |
| `src/ui/errors/ErrorContext.tsx` | `ErrorProvider`, `ErrorContext`, `useErrorReporter`, `useErrorReporterFormatted`, the global window listeners |
| `src/ui/errors/ErrorBoundary.tsx` | The class boundary with `app` / `page` / `inline` variants |
| `src/ui/errors/ErrorReportModal.tsx` | The modal body + Copy / Save flows |
| `src/ui/errors/index.ts` | Public re-exports |
| `src/ui/components/Modal.tsx` | The generic modal primitive used by `ErrorReportModal` and confirmations |
| `src/ui/components/Toast.tsx` | `ToastProvider`, `ToastHost`, `useToast`, `useToastDismiss` |
| `src/ui/EventHorizonMainPage.tsx` | Provider stack — `ApiProvider → ErrorProvider → ToastProvider → AppErrorBoundary → … → PageErrorBoundary` |
| `src/ui/state/ApiContext.tsx` | Sibling: injects `IExtensionApi` to anywhere via `useApi()` |

## What this enables

The error layer is what makes the higher-level pages comfortable to test with non-engineers:

- **Install wizard** (5.1): every async failure (read package, hash mods, resolve plan, run installer) goes through a `try { … } catch (err) { reportError(err, { context: { step: "loading", zipPath } }) }` block, and the wizard transitions to its own `error` state with a "Start over" button. The user sees both the inline retry UI and the global modal with a copy-able report.
- **Collections page** (5.2): list / parse failures are isolated per-receipt (one bad file doesn't take the page down), but uninstall failures land in the modal so the tester knows exactly which mod the driver couldn't remove.
- **Build wizard** (5.3): `BuildManifestError`, `PackageEhcollError`, `BundleResolutionError`, and `CollectionConfigError` each get their named-class branch in `formatError` so the curator sees an actionable summary instead of a raw stack.
- **Dashboard**: a single load failure shows the error card in-place; partial failures (one bad receipt JSON) still render every other tile.
