/**
 * Event Horizon home — the dashboard.
 *
 * The home page is split into four bands:
 *
 *   1. Hero (compact). Logo + wordmark + system-status pill row.
 *   2. Quick actions. Three big cards: install, build, my collections.
 *   3. Two side-by-side panels:
 *        a. "Player" — installed receipts (top-3 newest + link to all).
 *        b. "Curator" — collection configs and built packages (top-3 each).
 *   4. Footer pill row — supported games + appData path.
 *
 * Everything reactive. The dashboard re-fetches when the user
 * navigates back to it (the route component is keyed on `home`, so a
 * mount runs the `useEffect` again — see `EventHorizonMainPage`).
 *
 * Empty states are explicit ("No collections installed yet — install
 * your first .ehcoll →") and double as CTAs into the relevant page.
 */

import * as React from "react";

import {
  Button,
  Callout,
  Card,
  EventHorizonMark,
  Pill,
  ProgressRing,
  Section,
  StatGrid,
  StatTile,
} from "../components";
import { ErrorBoundary, useErrorReporter, useErrorReporterFormatted } from "../errors";
import { useApi } from "../state";
import {
  formatBytes,
  formatRelativeTime,
  loadDashboardData,
  type DashboardData,
} from "./dashboard/data";
import type { EventHorizonRoute } from "../routes";
import { PlayGameButton } from "../play/PlayGameButton";

export interface HomePageProps {
  onNavigate: (route: EventHorizonRoute) => void;
}

type DashboardState =
  | { kind: "loading" }
  | { kind: "ready"; data: DashboardData }
  | { kind: "error" };

export function HomePage(props: HomePageProps): JSX.Element {
  const reportFormatted = useErrorReporterFormatted();
  return (
    <ErrorBoundary
      where="HomePage"
      variant="page"
      onReport={reportFormatted}
    >
      <Dashboard onNavigate={props.onNavigate} />
    </ErrorBoundary>
  );
}

function Dashboard(props: HomePageProps): JSX.Element {
  const api = useApi();
  const reportError = useErrorReporter();
  const [state, setState] = React.useState<DashboardState>({ kind: "loading" });
  const [refreshTick, setRefreshTick] = React.useState(0);

  const refresh = React.useCallback((): void => {
    setRefreshTick((t) => t + 1);
  }, []);

  React.useEffect(() => {
    let alive = true;
    setState({ kind: "loading" });
    void (async () => {
      try {
        const data = await loadDashboardData(api);
        if (!alive) return;
        setState({ kind: "ready", data });
      } catch (err) {
        if (!alive) return;
        reportError(err, {
          title: "Dashboard couldn't load",
          context: { step: "load-dashboard" },
        });
        setState({ kind: "error" });
      }
    })();
    return (): void => {
      alive = false;
    };
  }, [api, reportError, refreshTick]);

  return (
    <div className="eh-page">
      <Hero />
      {state.kind === "loading" && <LoadingPanel />}
      {state.kind === "error" && <ErrorPanel onRetry={refresh} />}
      {state.kind === "ready" && (
        <DashboardBody
          data={state.data}
          onNavigate={props.onNavigate}
          onRefresh={refresh}
        />
      )}
    </div>
  );
}

// ===========================================================================
// Hero (compact)
// ===========================================================================

/** Exported for the render harness alongside {@link DashboardBody}. */
export function Hero(): JSX.Element {
  return (
    <section className="eh-hero eh-hero--compact">
      <span className="eh-hero__logo">
        <EventHorizonMark size={104} />
      </span>
      <h1 className="eh-hero__title">
        <span className="eh-text-gradient">Event Horizon</span>
      </h1>
      <span className="eh-hero__tagline">A Vortex collection installer</span>
    </section>
  );
}

// ===========================================================================
// Loading / error
// ===========================================================================

function LoadingPanel(): JSX.Element {
  return (
    <Card>
      <div className="eh-row eh-row--xl">
        <ProgressRing size={48} />
        <span className="eh-secondary">
          Reading receipts and configs...
        </span>
      </div>
    </Card>
  );
}

function ErrorPanel(props: { onRetry: () => void }): JSX.Element {
  return (
    <Callout
      tone="danger"
      title="Couldn't load dashboard"
      actions={
        <Button intent="primary" onClick={props.onRetry}>
          Retry
        </Button>
      }
    >
      The error report should already be open. Once you've inspected
      it you can retry.
    </Callout>
  );
}

// ===========================================================================
// Body
// ===========================================================================

interface DashboardBodyProps {
  data: DashboardData;
  onNavigate: (route: EventHorizonRoute) => void;
  onRefresh: () => void;
}

/** Exported for the render harness (`src/ui/__render__`), which photographs
 *  this screen without the async load Dashboard performs. */
export function DashboardBody(props: DashboardBodyProps): JSX.Element {
  const { data, onNavigate, onRefresh } = props;
  return (
    <div className="eh-stack eh-stack--xl">
      <SystemStatusBar status={data.status} onRefresh={onRefresh} />
      <QuickActionsRow onNavigate={onNavigate} />
      <PlayerCuratorGrid data={data} onNavigate={onNavigate} />
      <FooterRow status={data.status} />
    </div>
  );
}

// ===========================================================================
// System status bar
// ===========================================================================

function SystemStatusBar(props: {
  status: DashboardData["status"];
  onRefresh: () => void;
}): JSX.Element {
  const { status, onRefresh } = props;
  return (
    <Card>
      <div className="eh-row eh-row--xl">
        <StatGrid min={150} className="eh-fill">
          <StatTile
            bare
            label="Active game"
            value={status.gameLabel}
            tone={
              status.gameId === undefined
                ? "warning"
                : status.gameIsSupported
                ? "neutral"
                : "danger"
            }
            sub={status.gameIsSupported ? undefined : "Not supported by Event Horizon"}
            subMono
          />
          <StatTile
            bare
            label="Profile"
            value={status.profileName ?? "—"}
            sub={status.profileId}
            subMono
            tone="neutral"
          />
          <StatTile
            bare
            label="Vortex"
            value={`v${status.vortexVersion}`}
            tone="neutral"
          />
        </StatGrid>
        <Button intent="ghost" onClick={onRefresh}>
          Refresh
        </Button>
      </div>
    </Card>
  );
}

// ===========================================================================
// Quick actions
// ===========================================================================

function QuickActionsRow(props: {
  onNavigate: (route: EventHorizonRoute) => void;
}): JSX.Element {
  const { onNavigate } = props;
  return (
    <section className="eh-cta-grid eh-stagger" aria-label="Quick actions">
      <Card
        icon={<span>↓</span>}
        title="Install a collection"
        onClick={(): void => onNavigate("install")}
        footer={
          <>
            <Pill intent="info" withDot>
              Player
            </Pill>
            <span>Pick an .ehcoll →</span>
          </>
        }
      >
        Pick a package and watch it install reliably into a fresh,
        isolated profile (or upgrade an existing one).
      </Card>
      <Card
        icon={<span>◎</span>}
        title="My collections"
        onClick={(): void => onNavigate("collections")}
        footer={
          <>
            <Pill intent="info" withDot>
              Player
            </Pill>
            <span>Browse receipts →</span>
          </>
        }
      >
        See every collection installed on this machine. Switch profiles,
        inspect mods, or uninstall in one click.
      </Card>
      <Card
        icon={<span>↑</span>}
        title="Build a collection"
        onClick={(): void => onNavigate("build")}
        footer={
          <>
            <Pill intent="info" withDot>
              Curator
            </Pill>
            <span>Workshop →</span>
          </>
        }
      >
        Snapshot your current Vortex state into an .ehcoll archive.
        Capture every fomod, mod rule, INI tweak, and load order.
      </Card>
    </section>
  );
}

// ===========================================================================
// Player + Curator grid
// ===========================================================================

function PlayerCuratorGrid(props: {
  data: DashboardData;
  onNavigate: (route: EventHorizonRoute) => void;
}): JSX.Element {
  return (
    // Without eh-grid--start the grid stretches both panels to the taller
    // one's height, so the shorter panel ends in a large empty box that
    // looks like content failed to load. --eh-grid-min is the documented
    // custom-property passthrough, not an inline style.
    <section
      className="eh-grid eh-grid--start"
      style={{ ["--eh-grid-min" as string]: "360px" }}
    >
      <PlayerPanel
        receipts={props.data.receipts}
        receiptErrors={props.data.receiptErrors}
        onNavigate={props.onNavigate}
      />
      <CuratorPanel
        configs={props.data.curatorConfigs}
        builtPackages={props.data.builtPackages}
        onNavigate={props.onNavigate}
      />
    </section>
  );
}

function PlayerPanel(props: {
  receipts: DashboardData["receipts"];
  receiptErrors: DashboardData["receiptErrors"];
  onNavigate: (route: EventHorizonRoute) => void;
}): JSX.Element {
  const { receipts, receiptErrors, onNavigate } = props;
  const top = receipts.slice(0, 3);

  return (
    <Card title="Player — installed collections">
      <div className="eh-stack">
        <div className="eh-row eh-row--split eh-row--baseline">
          <span className="eh-secondary">
            {receipts.length === 0
              ? "No collections installed yet."
              : `${receipts.length} collection${receipts.length === 1 ? "" : "s"} on this machine.`}
          </span>
          {receipts.length > 0 && (
            <Button intent="ghost" onClick={(): void => onNavigate("collections")}>
              View all →
            </Button>
          )}
        </div>

        {receipts.length === 0 && (
          <div className="eh-empty-box">
            <div className="eh-stack eh-stack--sm">
              <p className="eh-body">
                Install your first .ehcoll to start tracking receipts here.
              </p>
              <Button intent="primary" onClick={(): void => onNavigate("install")}>
                Install a collection
              </Button>
            </div>
          </div>
        )}

        {top.length > 0 && (
          <ul className="eh-list eh-list--plain eh-stack eh-stack--sm">
            {top.map((receipt) => (
              <li
                key={receipt.packageId}
                onClick={(): void => onNavigate("collections")}
                className="eh-inset eh-row eh-row--split eh-clickable"
              >
                <div className="eh-fill">
                  <div className="eh-strong eh-truncate">
                    {receipt.packageName}
                  </div>
                  <div className="eh-small">
                    v{receipt.packageVersion} · {receipt.gameId} ·{" "}
                    {receipt.mods.length} mods · {formatRelativeTime(
                      new Date(receipt.installedAt).getTime(),
                    )}
                  </div>
                </div>
                <div className="eh-row">
                  <Pill
                    intent={
                      receipt.installTargetMode === "fresh-profile"
                        ? "info"
                        : "warning"
                    }
                  >
                    {receipt.installTargetMode === "fresh-profile"
                      ? "fresh profile"
                      : "current profile"}
                  </Pill>
                  <PlayGameButton gameId={receipt.gameId} size="sm" />
                </div>
              </li>
            ))}
          </ul>
        )}

        {receiptErrors.length > 0 && (
          <Callout tone="danger">
            {receiptErrors.length} receipt{receiptErrors.length === 1 ? "" : "s"} couldn't be parsed.
          </Callout>
        )}
      </div>
    </Card>
  );
}

function CuratorPanel(props: {
  configs: DashboardData["curatorConfigs"];
  builtPackages: DashboardData["builtPackages"];
  onNavigate: (route: EventHorizonRoute) => void;
}): JSX.Element {
  const { configs, builtPackages, onNavigate } = props;
  const topConfigs = configs.slice(0, 3);
  const topPackages = builtPackages.slice(0, 3);

  return (
    <Card title="Curator — workshop">
      <div className="eh-stack">
        <div className="eh-row eh-row--lg eh-row--split eh-row--baseline">
          <span className="eh-secondary">
            {configs.length} config{configs.length === 1 ? "" : "s"} ·{" "}
            {builtPackages.length} built package
            {builtPackages.length === 1 ? "" : "s"}
          </span>
          <Button intent="ghost" onClick={(): void => onNavigate("build")}>
            Open workshop →
          </Button>
        </div>

        {configs.length === 0 && builtPackages.length === 0 && (
          <div className="eh-empty-box">
            <div className="eh-stack eh-stack--sm">
              <p className="eh-body">
                You haven't built any collections yet. Snapshot your active
                profile into an .ehcoll to start a curator lineage.
              </p>
              <Button intent="primary" onClick={(): void => onNavigate("build")}>
                Build a collection
              </Button>
            </div>
          </div>
        )}

        {topConfigs.length > 0 && (
          <Section title="Recent configs" size="sm">
            <ul className="eh-list eh-list--plain eh-stack eh-stack--sm">
              {topConfigs.map((c) => (
                <li
                  key={c.slug}
                  className="eh-inset eh-row eh-row--split eh-clickable"
                  onClick={(): void => onNavigate("build")}
                >
                  <div className="eh-fill">
                    <div className="eh-strong eh-truncate">
                      {c.slug}
                    </div>
                    <div className="eh-small">
                      {c.error !== undefined
                        ? "parse error"
                        : c.config !== undefined
                        ? `${Object.keys(c.config.externalMods ?? {}).length} external mods · edited ${formatRelativeTime(c.modifiedAt)}`
                        : "—"}
                    </div>
                  </div>
                  {c.error !== undefined && (
                    <Pill intent="danger">error</Pill>
                  )}
                </li>
              ))}
            </ul>
          </Section>
        )}

        {topPackages.length > 0 && (
          <Section title="Recent builds" size="sm">
            <ul className="eh-list eh-list--plain eh-stack eh-stack--sm">
              {topPackages.map((pkg) => (
                <li key={pkg.packagePath} className="eh-inset eh-row eh-row--split">
                  <div className="eh-fill">
                    <div className="eh-strong eh-truncate">
                      {pkg.fileName}
                    </div>
                    <div className="eh-small">
                      {formatBytes(pkg.sizeBytes)} ·{" "}
                      {formatRelativeTime(pkg.modifiedAt)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </Card>
  );
}

// ===========================================================================
// Footer
// ===========================================================================

function FooterRow(props: { status: DashboardData["status"] }): JSX.Element {
  return (
    <footer className="eh-small eh-centred">
      <div className="eh-label">
        Skyrim SE / AE · Fallout 3 · New Vegas · Fallout 4 · Starfield
      </div>
      <div
        className="eh-mono eh-muted"
        // appDataPath is already %APPDATA%\Vortex (util.getVortexPath("userData")),
        // so this used to render ...\Vortex\Vortex\event-horizon\ - a path that does
        // not exist, under a tooltip saying that is where the user's data lives.
        // Keep in step with getEventHorizonRoot() in core/paths.ts.
        title="Where Event Horizon stores receipts and configs"
      >
        {props.status.appDataPath}\event-horizon\
      </div>
    </footer>
  );
}
