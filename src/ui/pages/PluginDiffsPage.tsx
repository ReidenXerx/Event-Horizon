/**
 * PluginDiffsPage — viewer for plugin comparison reports.
 *
 * Reads all `event-horizon-plugins-diff-*.json` files from
 * `<appData>/event-horizon/plugin-diffs/`, lets the user pick one via a
 * dropdown (default: latest), and renders the four diff categories in
 * collapsible `DiffSectionBlock` panels.
 *
 * Future: `onPluginClick` prop per row → navigate to the Vortex plugins
 * tab when that API surface is available.
 */

import * as React from "react";
import { util } from "@nexusmods/vortex-api";

import {
  listPluginDiffFiles,
  readPluginDiffReport,
  type PluginDiffFileEntry,
} from "../../core/pluginDiffStorage";
import type {
  PluginsTxtDiffReport,
  PluginEntry,
  PluginEnabledDiff,
  PluginPositionDiff,
} from "../../core/comparePlugins";
import { Callout, DiffSectionBlock, EmptyState, Field, Page, Pill, Select } from "../components";
import { ErrorBoundary, useErrorReporter, useErrorReporterFormatted } from "../errors";
import type { EventHorizonRoute } from "../routes";
import { getVortexUserDataPath } from "../../core/paths";

// ---------------------------------------------------------------------------
// Page types
// ---------------------------------------------------------------------------

type FileListState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "loaded"; files: PluginDiffFileEntry[] };

type ReportState =
  | { kind: "loading" }
  | { kind: "loaded"; report: PluginsTxtDiffReport }
  | { kind: "error"; message: string };

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

export interface PluginDiffsPageProps {
  onNavigate: (route: EventHorizonRoute) => void;
}

export function PluginDiffsPage(props: PluginDiffsPageProps): JSX.Element {
  const reportFormatted = useErrorReporterFormatted();
  return (
    <ErrorBoundary
      where="PluginDiffsPage"
      variant="page"
      onReport={reportFormatted}
    >
      <PluginDiffsView />
    </ErrorBoundary>
  );
}

// ---------------------------------------------------------------------------
// Inner view (needs hooks, so split from the boundary wrapper)
// ---------------------------------------------------------------------------

function PluginDiffsView(): JSX.Element {
  const reportError = useErrorReporter();

  const [fileListState, setFileListState] = React.useState<FileListState>({
    kind: "loading",
  });
  const [selectedFilePath, setSelectedFilePath] = React.useState<string>("");
  const [reportState, setReportState] = React.useState<ReportState>({
    kind: "loading",
  });

  // Load the file list once on mount.
  React.useEffect(() => {
    let alive = true;
    void (async (): Promise<void> => {
      try {
        const appData = getVortexUserDataPath() as string;
        const files = await listPluginDiffFiles(appData);
        if (!alive) return;
        if (files.length === 0) {
          setFileListState({ kind: "empty" });
        } else {
          setFileListState({ kind: "loaded", files });
          setSelectedFilePath(files[0].filePath);
        }
      } catch (err) {
        if (!alive) return;
        reportError(err, {
          title: "Couldn't list plugin diff files",
          context: { step: "plugin-diffs-list" },
        });
        setFileListState({ kind: "empty" });
      }
    })();
    return (): void => {
      alive = false;
    };
  }, [reportError]);

  // Load the selected report whenever `selectedFilePath` changes.
  React.useEffect(() => {
    if (!selectedFilePath) return;
    let alive = true;
    setReportState({ kind: "loading" });
    void (async (): Promise<void> => {
      try {
        const report = await readPluginDiffReport(selectedFilePath);
        if (!alive) return;
        if (!report) {
          setReportState({ kind: "error", message: "File not found." });
        } else {
          setReportState({ kind: "loaded", report });
        }
      } catch (err) {
        if (!alive) return;
        setReportState({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return (): void => {
      alive = false;
    };
  }, [selectedFilePath]);

  // --- Empty state ---
  if (fileListState.kind === "empty") {
    return (
      <Page
        title="Plugin Diffs"
        subtitle="Compare two plugins.txt files to generate a diff report."
      >
        <EmptyState title="No plugin diff files found.">
          Use the <strong>Compare Plugins</strong> toolbar action to generate
          one.
        </EmptyState>
      </Page>
    );
  }

  // --- Loading state (file list not ready yet) ---
  if (fileListState.kind === "loading") {
    return (
      <Page title="Plugin Diffs">
        <p className="eh-note">Loading diff files…</p>
      </Page>
    );
  }

  // --- Loaded state ---
  const { files } = fileListState;
  const selectedEntry = files.find((f) => f.filePath === selectedFilePath);

  return (
    <Page title="Plugin Diffs" subtitle="Review mismatches between two plugins.txt snapshots.">
      <div className="eh-plugin-diffs">
        {/* File selector row */}
        <FileSelector
          files={files}
          selectedFilePath={selectedFilePath}
          onSelect={setSelectedFilePath}
          selectedEntry={selectedEntry}
        />

        {/* Report body */}
        {reportState.kind === "loading" && (
          <p className="eh-note">Loading report…</p>
        )}

        {reportState.kind === "error" && (
          <Callout tone="danger">
            Failed to load report: {reportState.message}
          </Callout>
        )}

        {reportState.kind === "loaded" && (
          <ReportView report={reportState.report} />
        )}
      </div>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// File selector
// ---------------------------------------------------------------------------

interface FileSelectorProps {
  files: PluginDiffFileEntry[];
  selectedFilePath: string;
  onSelect: (filePath: string) => void;
  selectedEntry: PluginDiffFileEntry | undefined;
}

function FileSelector(props: FileSelectorProps): JSX.Element {
  const { files, selectedFilePath, onSelect, selectedEntry } = props;

  const displayDate = selectedEntry
    ? new Date(selectedEntry.timestampMs).toLocaleString()
    : "";

  return (
    <div className="eh-plugin-diffs__selector-row">
      <Field inline label="Diff file" id="eh-diff-file-select">
        {(id) => (
          <Select
            id={id}
            auto
            value={selectedFilePath}
            onChange={(e): void => onSelect(e.target.value)}
          >
            {files.map((f) => (
              <option key={f.filePath} value={f.filePath}>
                {f.gameId} — {new Date(f.timestampMs).toLocaleString()}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {displayDate && (
        <Pill plain ariaLabel="Selected file date">
          {displayDate}
        </Pill>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Report view
// ---------------------------------------------------------------------------

interface ReportViewProps {
  report: PluginsTxtDiffReport;
}

function ReportView(props: ReportViewProps): JSX.Element {
  const { report } = props;

  return (
    <div className="eh-plugin-diffs__report">
      {/* Source paths info */}
      <div className="eh-plugin-diffs__meta">
        <span className="eh-plugin-diffs__meta-item">
          <span className="eh-label">Reference:</span>
          <span
            className="eh-mono eh-fill"
            title={report.referenceFilePath}
          >
            {report.referenceFilePath}
          </span>
        </span>
        <span className="eh-plugin-diffs__meta-separator" aria-hidden="true">vs</span>
        <span className="eh-plugin-diffs__meta-item">
          <span className="eh-label">Current:</span>
          <span
            className="eh-mono eh-fill"
            title={report.currentFilePath}
          >
            {report.currentFilePath}
          </span>
        </span>
      </div>

      {/* Diff section blocks */}
      <div className="eh-plugin-diffs__blocks">
        <DiffSectionBlock
          title="Only in Reference"
          count={report.onlyInReference.length}
        >
          <PluginEntryList entries={report.onlyInReference} />
        </DiffSectionBlock>

        <DiffSectionBlock
          title="Only in Current"
          count={report.onlyInCurrent.length}
        >
          <PluginEntryList entries={report.onlyInCurrent} />
        </DiffSectionBlock>

        <DiffSectionBlock
          title="Enabled State Mismatch"
          count={report.enabledMismatch.length}
        >
          <EnabledMismatchList entries={report.enabledMismatch} />
        </DiffSectionBlock>

        <DiffSectionBlock
          title="Load Order Changed"
          count={report.positionChanged.length}
        >
          <PositionChangedList entries={report.positionChanged} />
        </DiffSectionBlock>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row renderers
// ---------------------------------------------------------------------------

interface PluginEntryListProps {
  entries: PluginEntry[];
  /** Reserved for future: navigate to the plugin in the Vortex plugins tab. */
  onPluginClick?: (name: string) => void;
}

function PluginEntryList(props: PluginEntryListProps): JSX.Element {
  const { entries, onPluginClick } = props;
  return (
    <ul className="eh-plugin-diffs__plugin-list">
      {entries.map((entry) => (
        <li key={entry.normalizedName} className="eh-plugin-diffs__plugin-row">
          <PluginNameCell
            name={entry.name}
            onClick={onPluginClick ? (): void => onPluginClick(entry.name) : undefined}
          />
          <Pill intent={entry.enabled ? "success" : "neutral"}>
            {entry.enabled ? "enabled" : "disabled"}
          </Pill>
        </li>
      ))}
    </ul>
  );
}

interface EnabledMismatchListProps {
  entries: PluginEnabledDiff[];
  onPluginClick?: (name: string) => void;
}

function EnabledMismatchList(props: EnabledMismatchListProps): JSX.Element {
  const { entries, onPluginClick } = props;
  return (
    <ul className="eh-plugin-diffs__plugin-list">
      {entries.map((entry) => (
        <li key={entry.name.toLowerCase()} className="eh-plugin-diffs__plugin-row">
          <PluginNameCell
            name={entry.name}
            onClick={onPluginClick ? (): void => onPluginClick(entry.name) : undefined}
          />
          <span className="eh-plugin-diffs__change-detail">
            <Pill intent={entry.referenceEnabled ? "success" : "neutral"}>
              {entry.referenceEnabled ? "enabled" : "disabled"}
            </Pill>
            <span className="eh-plugin-diffs__arrow" aria-hidden="true">→</span>
            <Pill intent={entry.currentEnabled ? "success" : "neutral"}>
              {entry.currentEnabled ? "enabled" : "disabled"}
            </Pill>
          </span>
        </li>
      ))}
    </ul>
  );
}

interface PositionChangedListProps {
  entries: PluginPositionDiff[];
  onPluginClick?: (name: string) => void;
}

function PositionChangedList(props: PositionChangedListProps): JSX.Element {
  const { entries, onPluginClick } = props;
  return (
    <ul className="eh-plugin-diffs__plugin-list">
      {entries.map((entry) => (
        <li key={entry.name.toLowerCase()} className="eh-plugin-diffs__plugin-row">
          <PluginNameCell
            name={entry.name}
            onClick={onPluginClick ? (): void => onPluginClick(entry.name) : undefined}
          />
          <span className="eh-plugin-diffs__change-detail">
            <span className="eh-plugin-diffs__position">#{entry.referenceIndex + 1}</span>
            <span className="eh-plugin-diffs__arrow" aria-hidden="true">→</span>
            <span className="eh-plugin-diffs__position">#{entry.currentIndex + 1}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

interface PluginNameCellProps {
  name: string;
  onClick?: () => void;
}

function PluginNameCell(props: PluginNameCellProps): JSX.Element {
  const { name, onClick } = props;

  if (onClick) {
    return (
      <button
        type="button"
        className="eh-plugin-diffs__plugin-name eh-plugin-diffs__plugin-name--clickable"
        onClick={onClick}
        title={`Open ${name} in Vortex`}
      >
        {name}
      </button>
    );
  }

  return (
    <span className="eh-plugin-diffs__plugin-name">{name}</span>
  );
}
