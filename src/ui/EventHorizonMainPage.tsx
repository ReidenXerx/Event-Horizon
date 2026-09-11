/**
 * Top-level component for the Event Horizon mainPage.
 *
 * Layered providers (outermost → innermost):
 *
 *   ApiProvider              ← gives every descendant access to `api`
 *     ErrorProvider          ← global `reportError(...)` + ErrorReportModal
 *       ToastProvider        ← non-blocking notifications
 *         AppErrorBoundary   ← last-resort render-error catcher
 *           NavBar
 *           PageErrorBoundary  ← per-route render-error catcher
 *             RouteOutlet
 *
 * Why this order:
 *   - `ApiProvider` is outermost so error/toast hooks could call into
 *     api if they need to (they don't yet, but the ordering is
 *     forward-compatible).
 *   - `ErrorProvider` wraps the toast provider so a runtime error
 *     while rendering a toast lands in the global modal.
 *   - The two boundaries deliberately differ in scope: the app
 *     boundary survives a navigation, the page boundary recovers on
 *     route change because it gets a fresh `key` per route.
 *
 * Vortex injects `api` via `props: () => ({ api: context.api })`
 * registered in `src/index.ts`.
 */

import * as React from "react";
import type { types } from "@nexusmods/vortex-api";

import { EventHorizonStyles } from "./theme";
import { EventHorizonRoute, ROUTES } from "./routes";
import { EventHorizonLogo } from "./components";
import { ToastProvider } from "./components/Toast";
import { ApiProvider } from "./state";
import {
  ErrorBoundary,
  ErrorProvider,
  useErrorReporterFormatted,
} from "./errors";
import { HomePage } from "./pages/HomePage";
import { AboutPage } from "./pages/AboutPage";
import { InstallPage } from "./pages/install/InstallPage";
import { CollectionsPage } from "./pages/CollectionsPage";
import { BuildPage } from "./pages/build/BuildPage";
import { DoctorPage } from "./pages/doctor/DoctorPage";
import { CuratorPage } from "./pages/curator/CuratorPage";
import { PluginDiffsPage } from "./pages/PluginDiffsPage";
import { ModDiffsPage } from "./pages/ModDiffsPage";
import { EXTENSION_VERSION } from "./version";

export interface EventHorizonMainPageProps {
  /**
   * Vortex IExtensionApi, injected via the `props` callback in
   * `registerMainPage`.
   */
  api: types.IExtensionApi;
  /**
   * Vortex passes `active: boolean` (true when the page is the
   * current tab). Currently unused but kept in the type so future
   * code can pause heavy work when hidden.
   */
  active?: boolean;
}

export function EventHorizonMainPage(
  props: EventHorizonMainPageProps,
): JSX.Element {
  return (
    <div className="eh-app">
      <EventHorizonStyles />
      <ApiProvider api={props.api}>
        <ErrorProvider>
          <ToastProvider>
            <ErrorBoundary where="Event Horizon">
              <AppShell />
            </ErrorBoundary>
          </ToastProvider>
        </ErrorProvider>
      </ApiProvider>
    </div>
  );
}

/**
 * Inside-providers shell. Split out so it can use the
 * `useErrorReporterFormatted` hook for the per-page boundary.
 */
function AppShell(): JSX.Element {
  const [route, setRoute] = React.useState<EventHorizonRoute>("home");
  const reportFormatted = useErrorReporterFormatted();

  return (
    <div className="eh-app__inner">
      <NavBar current={route} onNavigate={setRoute} />
      <main className="eh-app__main">
        <ErrorBoundary
          key={`boundary-${route}`}
          where={`page "${route}"`}
          onReport={reportFormatted}
        >
          <RouteOutlet route={route} onNavigate={setRoute} />
        </ErrorBoundary>
      </main>
    </div>
  );
}

interface NavBarProps {
  current: EventHorizonRoute;
  onNavigate: (route: EventHorizonRoute) => void;
}

function NavBar(props: NavBarProps): JSX.Element {
  const { current, onNavigate } = props;
  const visibleRoutes = ROUTES.filter((r) => !r.hidden);

  return (
    <nav className="eh-nav" aria-label="Event Horizon navigation">
      <button
        type="button"
        className="eh-nav__brand"
        onClick={(): void => onNavigate("home")}
        aria-label="Go to Event Horizon home"
      >
        <EventHorizonLogo size={28} />
        <span className="eh-nav__brand-text eh-text-gradient">
          Event Horizon
        </span>
      </button>
      <div className="eh-nav__items" role="tablist">
        {visibleRoutes.map((r) => {
          const isActive = r.id === current;
          return (
            <button
              key={r.id}
              type="button"
              className={`eh-nav__item${isActive ? " eh-nav__item--active" : ""}`}
              role="tab"
              aria-selected={isActive}
              onClick={(): void => onNavigate(r.id)}
              title={r.description}
            >
              {r.label}
            </button>
          );
        })}
      </div>
      <div className="eh-nav__meta">
        <span aria-label={`Event Horizon version ${EXTENSION_VERSION}`}>
          v{EXTENSION_VERSION}
        </span>
      </div>
    </nav>
  );
}

interface RouteOutletProps {
  route: EventHorizonRoute;
  onNavigate: (route: EventHorizonRoute) => void;
}

function RouteOutlet(props: RouteOutletProps): JSX.Element {
  const { route, onNavigate } = props;

  // We use route as a React `key` so each route gets a fresh mount,
  // which means our entrance animations (eh-fade-up) play every time
  // the user navigates. Cheap because pages are tiny.
  switch (route) {
    case "home":
      return <HomePage key="home" onNavigate={onNavigate} />;
    case "install":
      return <InstallPage key="install" onNavigate={onNavigate} />;
    case "collections":
      return <CollectionsPage key="collections" onNavigate={onNavigate} />;
    case "doctor":
      return <DoctorPage key="doctor" onNavigate={onNavigate} />;
    case "build":
      return <BuildPage key="build" onNavigate={onNavigate} />;
    case "curator":
      return <CuratorPage key="curator" />;
    case "plugin-diffs":
      return <PluginDiffsPage key="plugin-diffs" onNavigate={onNavigate} />;
    case "mod-diffs":
      return <ModDiffsPage key="mod-diffs" onNavigate={onNavigate} />;
    case "about":
      return <AboutPage key="about" />;
    default: {
      const exhaustive: never = route;
      void exhaustive;
      return <HomePage onNavigate={onNavigate} />;
    }
  }
}
