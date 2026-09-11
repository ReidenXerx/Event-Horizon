/**
 * ErrorBoundary — React-tree level safety net.
 *
 * A render error anywhere in the tree below this boundary captures a
 * `FormattedError` and:
 *   - shows a fallback UI (full-page or inline, configurable);
 *   - if a `ErrorContext` provider is mounted upstream, it also opens
 *     the global ErrorReportModal so the tester sees the same
 *     report layout they'd see for a runtime/async error.
 *
 * Boundaries are intentionally placed at TWO levels:
 *
 *   1. **App boundary** (around the whole `EventHorizonMainPage` body)
 *      catches catastrophic errors that take the page down.
 *   2. **Page boundary** (around each route's content) catches errors
 *      scoped to a single page so navigating elsewhere recovers the
 *      app.
 *
 * The boundary itself is implemented as a class component (React 16
 * has no hook for `componentDidCatch`).
 */

import * as React from "react";

import { Button, Callout, Card } from "../components";
import { EventHorizonLogo } from "../components";
import {
  FormattedError,
  formatError,
} from "./formatError";

export type ErrorBoundaryVariant = "page" | "inline";

export interface ErrorBoundaryProps {
  /**
   * Identifier shown in the fallback UI ("Failed to render: <where>").
   * Helps testers tell us *which* boundary tripped.
   */
  where: string;
  variant?: ErrorBoundaryVariant;
  /**
   * Optional override for the fallback UI. When set, the boundary
   * renders this component with the formatted error and a reset
   * callback.
   */
  fallback?: (
    error: FormattedError,
    reset: () => void,
  ) => React.ReactNode;
  /**
   * If a parent provided a `reportFormatted` callback (from
   * `ErrorContext`), the boundary calls it on catch so the global
   * error modal opens in addition to the inline fallback.
   */
  onReport?: (error: FormattedError) => void;
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: FormattedError | undefined;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  static getDerivedStateFromError(): null {
    // We do final formatting in `componentDidCatch` so we have access
    // to errorInfo (and our own props) — but we still need
    // `getDerivedStateFromError` to switch into the fallback.
    return null;
  }

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: undefined };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    const formatted = formatError(error, {
      title: `Render error in ${this.props.where}`,
      context: {
        boundary: this.props.where,
        componentStack: (info.componentStack ?? "").trim() || undefined,
      },
    });
    this.setState({ error: formatted });
    this.props.onReport?.(formatted);
  }

  reset = (): void => {
    this.setState({ error: undefined });
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (error === undefined) {
      return this.props.children;
    }
    if (this.props.fallback !== undefined) {
      return this.props.fallback(error, this.reset);
    }
    if (this.props.variant === "inline") {
      return <InlineFallback error={error} reset={this.reset} />;
    }
    return <PageFallback error={error} reset={this.reset} />;
  }
}

// ===========================================================================
// Default fallbacks
// ===========================================================================

function PageFallback(props: {
  error: FormattedError;
  reset: () => void;
}): JSX.Element {
  const { error, reset } = props;
  return (
    <div className="eh-centred eh-centred--page">
      <Card className="eh-card--narrow">
        <div className="eh-stack eh-stack--lg">
          <EventHorizonLogo size={88} />
          <div className="eh-stack eh-stack--sm">
            <h2 className="eh-page__title">{error.title}</h2>
            <p className="eh-body">{error.message}</p>
          </div>
          <div className="eh-stack eh-stack--xl">
            <p className="eh-small">
              The full report is showing in the error panel — copy or save it before retrying.
            </p>
            <Button intent="primary" onClick={reset}>
              Try again
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function InlineFallback(props: {
  error: FormattedError;
  reset: () => void;
}): JSX.Element {
  const { error, reset } = props;
  return (
    <Callout
      tone="danger"
      title={error.title}
      actions={
        <Button intent="ghost" size="sm" onClick={reset}>
          Reset
        </Button>
      }
    >
      {error.message}
    </Callout>
  );
}
