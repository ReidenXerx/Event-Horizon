/**
 * Downloads with no installed version: the archives sitting in Vortex's
 * cache that nothing was ever made from.
 *
 * This is the same set Disk cleanup lists as "never selected" — a file
 * downloaded on purpose and not installed yet looks exactly like a
 * leftover, so cleanup will not delete it, and this view is where it gets
 * INSTALLED instead. One at a time, through Vortex's own installer, like
 * every other install here (memory: Vortex loses files in bulk).
 */

import * as React from "react";

import { formatSize, type DownloadEntry } from "../../../core/curator/cleanupPlan";
import { Button, Callout, DataTable, type Column } from "../../components";

const num = (n: number): string => n.toLocaleString();

const COLUMNS: Column<DownloadEntry>[] = [
  { key: "file", header: "Archive", value: (d) => d.fileName },
  { key: "name", header: "Nexus file", value: (d) => d.logicalFileName ?? "" },
  { key: "version", header: "Version", width: 120, value: (d) => d.version ?? "" },
  {
    key: "bytes",
    header: "Size",
    numeric: true,
    align: "right",
    width: 120,
    value: (d) => d.bytes,
    render: (d) => formatSize(d.bytes),
  },
];

const idOf = (d: DownloadEntry): string => d.id;

export function DownloadsView(props: {
  downloads: readonly DownloadEntry[];
  busy: boolean;
  onInstall: (entries: readonly DownloadEntry[]) => void;
}): JSX.Element {
  const { downloads, busy } = props;
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const chosen = React.useMemo(() => downloads.filter((d) => selected.has(d.id)), [downloads, selected]);
  const bytes = chosen.reduce((n, d) => n + d.bytes, 0);

  if (downloads.length === 0) {
    return <p className="eh-body">Every download in Vortex&rsquo;s cache has an installed version. Nothing is waiting.</p>;
  }

  return (
    <div className="eh-stack">
      <Callout tone="info">
        {num(downloads.length)} archive(s) are downloaded and not installed. Installing goes through Vortex&rsquo;s own installer,
        one at a time; a FOMOD asks its questions as it would from the Downloads tab.
      </Callout>
      <div className="eh-row">
        <Button
          intent="primary"
          disabled={busy || chosen.length === 0}
          busy={busy}
          onClick={(): void => {
            props.onInstall(chosen);
            setSelected(new Set());
          }}
        >
          {chosen.length === 0 ? "Tick the archives to install" : `Install ${num(chosen.length)} — ${formatSize(bytes)}`}
        </Button>
      </div>
      <DataTable
        rows={downloads}
        idOf={idOf}
        columns={COLUMNS}
        noun="download"
        maxHeight={520}
        actionsWidth={110}
        selection={{ selected, onChange: setSelected }}
        actions={(d): JSX.Element => (
          <Button size="sm" intent="ghost" disabled={busy} onClick={(): void => props.onInstall([d])}>
            Install
          </Button>
        )}
      />
    </div>
  );
}
