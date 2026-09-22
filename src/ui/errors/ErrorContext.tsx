/**
 * Global error reporter context for the Event Horizon UI.
 *
 * Any component (or async callback inside a component) can call
 * `useErrorReporter()` to get a `reportError` function. Calling it
 * pops the ErrorReportModal with a fully formatted error.
 *
 * The provider also installs a window-level fallback so:
 *   - `window.addEventListener("error", ...)` and
 *   - `window.addEventListener("unhandledrejection", ...)`
 * that occur while the page is mounted are captured and surfaced
 * (rather than vanishing into Vortex's console).
 *
 * Usage from any descendant:
 *
 *     const reportError = useErrorReporter();
 *     try { await foo(); }
 *     catch (e) { reportError(e, { context: { step: "foo" } }); }
 *
 * The reporter function is stable (same identity across renders) so
 * it's safe to put in `useEffect` dependency arrays.
 */

import { isBenignBrowserNotice } from "./benignNotice";
import { isForeignError } from "./foreignError";
import { ehLog } from "../../core/logging/ehLog";
import * as React from "react";

import { ErrorReportModal } from "./ErrorReportModal";
import {
  FormatErrorOptions,
  FormattedError,
  formatError,
} from "./formatError";

export type ReportErrorFn = (
  err: unknown,
  options?: FormatErrorOptions,
) => void;

interface ErrorContextValue {
  report: ReportErrorFn;
  /**
   * For the rare case where a caller wants to display an
   * already-formatted error (e.g. an ErrorBoundary captured one).
   */
  reportFormatted: (err: FormattedError) => void;
}

const ErrorContext = React.createContext<ErrorContextValue | null>(null);

export function useErrorReporter(): ReportErrorFn {
  const ctx = React.useContext(ErrorContext);
  if (ctx === null) {
    // Provide a graceful stub so a component rendered outside the
    // provider doesn't crash. We log to console so dev sees it.
    return (err: unknown): void => {
      // eslint-disable-next-line no-console
      console.error(
        "[Event Horizon] Error reported outside ErrorProvider:",
        err,
      );
    };
  }
  return ctx.report;
}

export function useErrorReporterFormatted(): (err: FormattedError) => void {
  const ctx = React.useContext(ErrorContext);
  if (ctx === null) {
    return (err: FormattedError): void => {
      // eslint-disable-next-line no-console
      console.error("[Event Horizon] Error reported outside ErrorProvider:", err);
    };
  }
  return ctx.reportFormatted;
}

export interface ErrorProviderProps {
  /**
   * If true, hook into `window.error` and `window.unhandledrejection`
   * while this provider is mounted. Default: true.
   */
  installWindowHandlers?: boolean;
  children: React.ReactNode;
}

export function ErrorProvider(props: ErrorProviderProps): JSX.Element {
  const { installWindowHandlers = true, children } = props;

  const [current, setCurrent] = React.useState<FormattedError | undefined>(
    undefined,
  );

  const reportFormatted = React.useCallback(
    (err: FormattedError): void => {
      // eslint-disable-next-line no-console
      console.error(
        "[Event Horizon] Error reported (formatted):",
        err.title,
        err,
      );
      setCurrent(err);
    },
    [],
  );

  const report = React.useCallback<ReportErrorFn>(
    (err, options) => {
      const formatted = formatError(err, options);
      // eslint-disable-next-line no-console
      console.error(
        "[Event Horizon] Error reported:",
        formatted.title,
        err,
      );
      setCurrent(formatted);
    },
    [],
  );

  React.useEffect(() => {
    if (!installWindowHandlers) return;

    // These listeners are the WHOLE renderer's, not ours. Anything that fails
    // anywhere in Vortex or in another extension arrives here, and used to be
    // presented as an Event Horizon error — a tester was told he had cancelled
    // an install that had in fact completed, by a dialog reporting a rejection
    // raised inside Vortex's own promise machinery. Still caught, because a
    // silent unhandled rejection is worse; no longer claimed.
    const onError = (event: ErrorEvent): void => {
      const err = event.error ?? event.message ?? "Unknown window error";
      /**
       * ─── NOT EVERYTHING ON THIS CHANNEL IS A FAILURE ──────────────────
       * Chromium announces a deferred ResizeObserver delivery through the
       * error event, with no error object and no source. Reported, it reads
       * as "Something went wrong", severity error, with a hint asking the
       * reader to send it to us — which is exactly what one user did. See
       * `benignNotice` for why it is not a fault and not ours.
       *
       * Logged rather than dropped in silence: if one of these ever turns
       * out to matter, the trail is in the log the user already sends.
       */
      if (isBenignBrowserNotice(err)) {
        ehLog("debug", "ui.window-error.benign-notice", {
          message: typeof err === "string" ? err : (err as Error)?.message,
          filename: event.filename,
          why: "a browser scheduling notice, not a failure; not shown to the user",
        });
        return;
      }
      report(err, {
        context: {
          source: "window.error",
          origin: isForeignError(err) ? "vortex" : "event-horizon",
          filename: event.filename,
          line: event.lineno,
          column: event.colno,
        },
      });
    };

    const onRejection = (event: PromiseRejectionEvent): void => {
      report(event.reason, {
        context: {
          source: "window.unhandledrejection",
          origin: isForeignError(event.reason) ? "vortex" : "event-horizon",
        },
      });
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return (): void => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [installWindowHandlers, report]);

  const contextValue = React.useMemo<ErrorContextValue>(
    () => ({ report, reportFormatted }),
    [report, reportFormatted],
  );

  const handleClose = React.useCallback((): void => {
    setCurrent(undefined);
  }, []);

  return (
    <ErrorContext.Provider value={contextValue}>
      {children}
      <ErrorReportModal
        open={current !== undefined}
        error={current}
        onClose={handleClose}
      />
    </ErrorContext.Provider>
  );
}
