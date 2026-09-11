/**
 * The Plugins view: Vortex's plugin list, with what Vortex's tab leaves out.
 *
 * Read-only in this version. Enabling and reordering stay in Vortex's own
 * tab until the dispatch shape has been verified against the deployed
 * plugin-management extension — a wrong action there silently reorders a
 * load order, and the user cannot see that from here.
 */

import * as React from "react";

import {
  PLUGIN_VIEWS,
  describeMastersCell,
  describePluginKind,
  pluginRowsForView,
  pluginViewCounts,
  summarizePlugins,
  type PluginRow,
  type PluginViewId,
} from "../../../core/curator/pluginView";
import { Button, Callout, Chip, DataTable, EmptyState, LinkButton, Pill, StatGrid, StatTile, type Column } from "../../components";

const num = (n: number): string => n.toLocaleString();

const rowId = (r: PluginRow): string => r.plugin.name;

const stateOf = (r: PluginRow): string =>
  r.plugin.fromDisabledMod === true ? "mod disabled" : r.plugin.enabled ? "enabled" : "disabled";

function makeColumns(onFocus: (modId: string) => void): Column<PluginRow>[] {
  void onFocus;
  return makeColumnsWith(onFocus);
}

function makeColumnsWith(onFocus: (modId: string) => void): Column<PluginRow>[] {
  return [
    {
      key: "order",
      header: "Order",
      numeric: true,
      align: "right",
      width: 90,
      value: (r) => r.plugin.loadOrder ?? Number.MAX_SAFE_INTEGER,
      render: (r) => (r.plugin.loadOrder === undefined ? <span className="eh-muted">—</span> : r.plugin.loadOrder),
    },
    {
      key: "name",
      header: "Plugin",
      value: (r) => r.plugin.name,
      render: (r) => <span className="eh-mono">{r.plugin.name}</span>,
    },
    {
      key: "state",
      header: "State",
      match: "exact",
      width: 150,
      value: stateOf,
      render: (r) => (
        <Pill intent={r.plugin.enabled ? "success" : "neutral"} plain>
          {stateOf(r)}
        </Pill>
      ),
    },
    { key: "kind", header: "Kind", match: "exact", width: 120, value: describePluginKind },
    {
      key: "owner",
      header: "Mod",
      value: (r) => r.owner?.name ?? (r.plugin.isNative ? "" : r.plugin.modId ?? ""),
      render: (r) =>
        r.owner !== undefined ? (
          <LinkButton onClick={(): void => onFocus(r.owner!.id)}>{r.owner.name}</LinkButton>
        ) : r.plugin.isNative ? (
          <span className="eh-muted">—</span>
        ) : (
          <span className="eh-muted" title="Not deployed by any mod Vortex manages">
            {r.plugin.modId ?? "loose file"}
          </span>
        ),
    },
    {
      key: "masters",
      header: "Masters",
      match: "exact",
      width: 170,
      value: describeMastersCell,
      render: (r) => {
        const text = describeMastersCell(r);
        const title = r.masters.map((m) => `${m.name} (${m.state})`).join("\n");
        if (text === "") return <span className="eh-muted">—</span>;
        if (r.unreadable !== undefined) return <span className="eh-tone--warning" title={r.unreadable}>{text}</span>;
        if (r.missing.length > 0) return <span className="eh-tone--danger" title={title}>{text}</span>;
        // A disabled master under an ENABLED plugin is a game that will not
        // load, not a warning; under a disabled plugin it is merely off.
        if (r.disabled.length > 0) {
          return <span className={r.plugin.enabled ? "eh-tone--danger" : "eh-tone--warning"} title={title}>{text}</span>;
        }
        return <span className="eh-tone--success" title={title}>{text}</span>;
      },
    },
  ];
}

export function PluginsView(props: {
  rows: readonly PluginRow[];
  /** Whether plugin headers have been read (they come with "Read requirements"). */
  headersRead: boolean;
  onFocus: (modId: string) => void;
  /** Absent when the page cannot dispatch (no store): the view stays read-only. */
  onSetEnabled?: (plugin: PluginRow, enabled: boolean) => void;
  busy?: boolean;
}): JSX.Element {
  const { rows, headersRead, onFocus } = props;
  const [view, setView] = React.useState<PluginViewId>("all");
  const counts = React.useMemo(() => pluginViewCounts(rows), [rows]);
  const summary = React.useMemo(() => summarizePlugins(rows, headersRead), [rows, headersRead]);
  const visible = React.useMemo(() => pluginRowsForView(rows, view), [rows, view]);
  const columns = React.useMemo(() => makeColumns(onFocus), [onFocus]);
  const spec = PLUGIN_VIEWS.find((v) => v.id === view);
  React.useEffect(() => {
    if (view !== "all" && counts[view] === 0) setView("all");
  }, [view, counts]);

  if (rows.length === 0) {
    return (
      <EmptyState title="No plugins listed">
        Vortex&rsquo;s plugin management has not listed anything for this game — either the game has no plugins, or its
        Plugins tab has not been opened since Vortex started.
      </EmptyState>
    );
  }

  const slotsTone = summary.slotsUsed >= summary.slotLimit ? "danger" : summary.slotsUsed >= summary.slotLimit - 10 ? "warning" : "neutral";

  return (
    <div className="eh-stack eh-stack--lg">
      <StatGrid min={150}>
        <StatTile label="Plugins" value={num(summary.total)} />
        <StatTile label="Enabled" value={num(summary.enabled)} />
        <StatTile
          label="Regular slots"
          value={headersRead ? `${num(summary.slotsUsed)} / ${summary.slotLimit}` : "?"}
          tone={headersRead ? slotsTone : "quiet"}
          title={`Enabled plugins without the light flag. The game stops loading at ${summary.slotLimit}.`}
        />
        <StatTile label="Light" value={headersRead ? num(summary.light) : "?"} tone={headersRead ? "neutral" : "quiet"} />
        <StatTile
          label="Missing masters"
          value={headersRead ? num(summary.withMissing) : "?"}
          tone={!headersRead ? "quiet" : summary.withMissing === 0 ? "success" : "danger"}
        />
        <StatTile
          label="Disabled masters"
          value={headersRead ? num(summary.withDisabled) : "?"}
          tone={!headersRead ? "quiet" : summary.withDisabled === 0 ? "quiet" : "warning"}
        />
      </StatGrid>

      {!headersRead && (
        <Callout tone="info">
          Plugin headers have not been read yet, so masters and the light flag are unknown. Press Read requirements above:
          it reads every plugin&rsquo;s header along with the Nexus pages.
        </Callout>
      )}
      {headersRead && summary.unreadable > 0 && (
        <Callout tone="warning">
          {num(summary.unreadable)} plugin header(s) could not be read. Each says why in its Masters cell; a locked file is
          usually the game or a tool holding it open.
        </Callout>
      )}
      {headersRead && summary.slotsUsed >= summary.slotLimit - 10 && (
        <Callout tone={summary.slotsUsed >= summary.slotLimit ? "danger" : "warning"}>
          {num(summary.slotsUsed)} of {summary.slotLimit} regular plugin slots are used. Past the limit the game does not
          start; the usual fix is flagging eligible plugins light, which Vortex&rsquo;s own Plugins tab can do per plugin.
        </Callout>
      )}

      <p className="eh-note">
        Enable and disable here; reordering and the light flag stay in Vortex&rsquo;s Plugins tab for now. Plugins of
        disabled mods are listed too (state &ldquo;mod disabled&rdquo;), which Vortex&rsquo;s tab does not show.
      </p>

      <div className="eh-row eh-row--sm" role="tablist" aria-label="Plugin views">
        {PLUGIN_VIEWS.filter((v) => v.id === "all" || counts[v.id] > 0).map((v) => (
          <Chip key={v.id} active={view === v.id} onClick={(): void => setView(v.id)} title={v.description}>
            {v.label}
            {v.id !== "all" && <span className="eh-muted"> {num(counts[v.id])}</span>}
          </Chip>
        ))}
      </div>
      {spec !== undefined && spec.id !== "all" && <p className="eh-note eh-prose">{spec.description}</p>}

      <DataTable
        rows={visible}
        idOf={rowId}
        columns={columns}
        noun="plugin"
        maxHeight={520}
        actionsWidth={110}
        actions={
          props.onSetEnabled === undefined
            ? undefined
            : (r): JSX.Element => (
                <div className="eh-row eh-row--sm eh-row--nowrap">
                  {!r.plugin.isNative && r.plugin.fromDisabledMod !== true && (
                    <Button
                      size="sm"
                      intent="ghost"
                      disabled={props.busy === true}
                      title={
                        !r.plugin.enabled && r.disabled.length > 0
                          ? `Its master(s) ${r.disabled.join(", ")} are disabled; the game will not load it until they are on`
                          : undefined
                      }
                      onClick={(): void => props.onSetEnabled!(r, !r.plugin.enabled)}
                    >
                      {r.plugin.enabled ? "Disable" : "Enable"}
                    </Button>
                  )}
                </div>
              )
        }
      />
    </div>
  );
}
