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
  Card,
  EventHorizonMark,
  Pill,
  ProgressRing,
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
    <section
      className="eh-hero"
      style={{ paddingTop: "var(--eh-sp-3)", paddingBottom: "var(--eh-sp-3)" }}
    >
      <span className="eh-hero__logo">
        <EventHorizonMark size={104} />
      </span>
      <h1 className="eh-hero__title" style={{ fontSize: "var(--eh-text-2xl)" }}>
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
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--eh-sp-4)",
          padding: "var(--eh-sp-3)",
        }}
      >
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
    <Card>
      <div style={{ padding: "var(--eh-sp-3)" }}>
        <h3 style={{ margin: 0, color: "var(--eh-danger)" }}>
          Couldn't load dashboard
        </h3>
        <p
          style={{
            margin: "var(--eh-sp-2) 0 var(--eh-sp-3) 0",
            color: "var(--eh-text-secondary)",
            fontSize: "var(--eh-text-sm)",
          }}
        >
          The error report should already be open. Once you've inspected
          it you can retry.
        </p>
        <Button intent="primary" onClick={props.onRetry}>
          Retry
        </Button>
      </div>
    </Card>
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
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr)",
        gap: "var(--eh-sp-5)",
      }}
    >
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
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--eh-sp-5)",
          flexWrap: "wrap",
          padding: "var(--eh-sp-1) var(--eh-sp-2)",
        }}
      >
        <StatusTile
          label="Active game"
          value={status.gameLabel}
          intent={
            status.gameId === undefined
              ? "warning"
              : status.gameIsSupported
              ? "neutral"
              : "danger"
          }
          sub={status.gameIsSupported ? undefined : "Not supported by Event Horizon"}
        />
        <StatusTile
          label="Profile"
          value={status.profileName ?? "—"}
          sub={status.profileId}
          intent="neutral"
        />
        <StatusTile
          label="Vortex"
          value={`v${status.vortexVersion}`}
          intent="neutral"
        />
        <Button intent="ghost" onClick={onRefresh}>
          Refresh
        </Button>
      </div>
    </Card>
  );
}

function StatusTile(props: {
  label: string;
  value: string;
  sub?: string;
  intent: "success" | "warning" | "danger" | "info" | "neutral";
}): JSX.Element {
  const accent = {
    success: "var(--eh-success)",
    warning: "var(--eh-warning)",
    danger: "var(--eh-danger)",
    info: "var(--eh-cyan)",
    // Was text-muted, which made every ordinary fact look de-emphasised while
    // the coloured ones looked urgent. Neutral is the DEFAULT state and should
    // read as plain text; colour is reserved for something needing attention.
    neutral: "var(--eh-text-primary)",
  }[props.intent];
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        // flex-grow so the three tiles spread across the bar. They used to be
        // fixed-width and left-hugging, with a flex:1 spacer shoving Refresh to
        // the far edge - which read as an unfinished row rather than a layout.
        flex: "1 1 0",
        minWidth: 150,
      }}
    >
      <span
        className="eh-label"
      >
        {props.label}
      </span>
      <span
        style={{
          color: accent,
          fontSize: "var(--eh-text-md)",
          fontWeight: 600,
        }}
      >
        {props.value}
      </span>
      {props.sub !== undefined && (
        <span
          style={{
            color: "var(--eh-text-muted)",
            fontSize: "var(--eh-text-xs)",
            fontFamily: "var(--eh-font-mono)",
            wordBreak: "break-all",
          }}
        >
          {props.sub}
        </span>
      )}
    </div>
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
    <section
      className="eh-cta-grid eh-stagger"
      aria-label="Quick actions"
      style={{ marginTop: 0 }}
    >
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
    <section
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
        gap: "var(--eh-sp-4)",
        // Without this the grid stretches both panels to the taller one's
        // height, so the shorter panel ends in a large empty box that looks
        // like content failed to load.
        alignItems: "start",
      }}
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
      <div
        className="eh-stack"
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
          }}
        >
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
          <div
            style={{
              padding: "var(--eh-sp-4)",
              border: "1px dashed var(--eh-border-default)",
              borderRadius: "var(--eh-radius-sm)",
              textAlign: "center",
            }}
          >
            <p
              style={{
                margin: "0 0 var(--eh-sp-3) 0",
                color: "var(--eh-text-secondary)",
                fontSize: "var(--eh-text-sm)",
              }}
            >
              Install your first .ehcoll to start tracking receipts here.
            </p>
            <Button intent="primary" onClick={(): void => onNavigate("install")}>
              Install a collection
            </Button>
          </div>
        )}

        {top.length > 0 && (
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: "var(--eh-sp-2)",
            }}
          >
            {top.map((receipt) => (
              <li
                key={receipt.packageId}
                onClick={(): void => onNavigate("collections")}
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1fr) auto",
                  gap: "var(--eh-sp-3)",
                  padding: "var(--eh-sp-2) var(--eh-sp-3)",
                  background: "var(--eh-bg-base)",
                  border: "1px solid var(--eh-border-subtle)",
                  borderRadius: "var(--eh-radius-sm)",
                  cursor: "pointer",
                  alignItems: "center",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      color: "var(--eh-text-primary)",
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {receipt.packageName}
                  </div>
                  <div
                    style={{
                      color: "var(--eh-text-muted)",
                      fontSize: "var(--eh-text-xs)",
                    }}
                  >
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
          <div
            style={{
              color: "var(--eh-danger)",
              fontSize: "var(--eh-text-sm)",
            }}
          >
            {receiptErrors.length} receipt{receiptErrors.length === 1 ? "" : "s"} couldn't be parsed.
          </div>
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
      <div
        className="eh-stack"
      >
        <div
          style={{
            display: "flex",
            gap: "var(--eh-sp-3)",
            flexWrap: "wrap",
            alignItems: "baseline",
          }}
        >
          <span className="eh-secondary">
            {configs.length} config{configs.length === 1 ? "" : "s"} ·{" "}
            {builtPackages.length} built package
            {builtPackages.length === 1 ? "" : "s"}
          </span>
          <div style={{ flex: 1 }} />
          <Button intent="ghost" onClick={(): void => onNavigate("build")}>
            Open workshop →
          </Button>
        </div>

        {configs.length === 0 && builtPackages.length === 0 && (
          <div
            style={{
              padding: "var(--eh-sp-4)",
              border: "1px dashed var(--eh-border-default)",
              borderRadius: "var(--eh-radius-sm)",
              textAlign: "center",
            }}
          >
            <p
              style={{
                margin: "0 0 var(--eh-sp-3) 0",
                color: "var(--eh-text-secondary)",
                fontSize: "var(--eh-text-sm)",
              }}
            >
              You haven't built any collections yet. Snapshot your active
              profile into an .ehcoll to start a curator lineage.
            </p>
            <Button intent="primary" onClick={(): void => onNavigate("build")}>
              Build a collection
            </Button>
          </div>
        )}

        {topConfigs.length > 0 && (
          <section>
            <h4 style={sectionHeadingStyle}>Recent configs</h4>
            <ul style={listStyle}>
              {topConfigs.map((c) => (
                <li
                  key={c.slug}
                  style={rowStyle}
                  onClick={(): void => onNavigate("build")}
                >
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        color: "var(--eh-text-primary)",
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {c.slug}
                    </div>
                    <div
                      style={{
                        color: "var(--eh-text-muted)",
                        fontSize: "var(--eh-text-xs)",
                      }}
                    >
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
          </section>
        )}

        {topPackages.length > 0 && (
          <section>
            <h4 style={sectionHeadingStyle}>Recent builds</h4>
            <ul style={listStyle}>
              {topPackages.map((pkg) => (
                <li key={pkg.packagePath} style={rowStyle}>
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        color: "var(--eh-text-primary)",
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {pkg.fileName}
                    </div>
                    <div
                      style={{
                        color: "var(--eh-text-muted)",
                        fontSize: "var(--eh-text-xs)",
                      }}
                    >
                      {formatBytes(pkg.sizeBytes)} ·{" "}
                      {formatRelativeTime(pkg.modifiedAt)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
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
    <section
      style={{
        marginTop: "var(--eh-sp-3)",
        padding: "var(--eh-sp-3) var(--eh-sp-4)",
        textAlign: "center",
        color: "var(--eh-text-muted)",
        fontSize: "var(--eh-text-xs)",
        animation:
          "eh-fade-in var(--eh-dur-deliberate) var(--eh-easing) 800ms both",
      }}
    >
      <div
        style={{
          letterSpacing: "var(--eh-tracking-widest)",
          textTransform: "uppercase",
        }}
      >
        Skyrim SE / AE · Fallout 3 · New Vegas · Fallout 4 · Starfield
      </div>
      <div
        style={{
          marginTop: 4,
          fontFamily: "var(--eh-font-mono)",
          opacity: 0.7,
          wordBreak: "break-all",
        }}
        // appDataPath is already %APPDATA%\Vortex (util.getVortexPath("userData")),
        // so this used to render ...\Vortex\Vortex\event-horizon\ - a path that does
        // not exist, under a tooltip saying that is where the user's data lives.
        // Keep in step with getEventHorizonRoot() in core/paths.ts.
        title="Where Event Horizon stores receipts and configs"
      >
        {props.status.appDataPath}\event-horizon\
      </div>
    </section>
  );
}

// ===========================================================================
// Shared inline styles
// ===========================================================================

const sectionHeadingStyle: React.CSSProperties = {
  margin: "0 0 var(--eh-sp-2) 0",
  color: "var(--eh-text-secondary)",
  fontSize: "var(--eh-text-xs)",
  textTransform: "uppercase",
  letterSpacing: "var(--eh-tracking-widest)",
};

const listStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "var(--eh-sp-2)",
};

const rowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  gap: "var(--eh-sp-3)",
  padding: "var(--eh-sp-2) var(--eh-sp-3)",
  background: "var(--eh-bg-base)",
  border: "1px solid var(--eh-border-subtle)",
  borderRadius: "var(--eh-radius-sm)",
  cursor: "pointer",
  alignItems: "center",
};
