/**
 * ModDiffsPage — viewer for mod comparison reports.
 *
 * Reads all `event-horizon-mod-diff-*.json` files from
 * `<appData>/event-horizon/diffs/`, lets the user pick one via a
 * dropdown (default: latest), and renders the three diff categories in
 * collapsible `DiffSectionBlock` panels — mirroring PluginDiffsPage.
 *
 * Sections:
 *   1. Only in Reference — mods that were in the reference but not current
 *   2. Only in Current   — mods that are new since the reference
 *   3. Changed           — mods present in both but with field-level diffs
 *
 * Future: `onPluginClick`-style hook to focus a mod in Vortex's mod list.
 */

import * as React from "react";
import { util } from "@nexusmods/vortex-api";

import {
  listModDiffFiles,
  readModDiffReport,
  type ModDiffFileEntry,
} from "../../core/modDiffStorage";
import type {
  ModsDiffReport,
  ChangedModReport,
  ModFieldDifference,
  MatchedModSummary,
  DiffCategory,
} from "../../utils/utils";
import type { AuditorMod } from "../../core/getModsListForProfile";
import {
  TIER_LABEL,
  type MatchTier,
} from "../../core/identity/modIdentity";
import { Callout, DiffSectionBlock, EmptyState, Field, Page, Pill, Select } from "../components";
import {
  ErrorBoundary,
  useErrorReporter,
  useErrorReporterFormatted,
} from "../errors";
import type { EventHorizonRoute } from "../routes";
import { getVortexUserDataPath } from "../../core/paths";

// ---------------------------------------------------------------------------
// Page state types
// ---------------------------------------------------------------------------

type FileListState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "loaded"; files: ModDiffFileEntry[] };

type ReportState =
  | { kind: "loading" }
  | { kind: "loaded"; report: ModsDiffReport }
  | { kind: "error"; message: string };

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

export interface ModDiffsPageProps {
  onNavigate: (route: EventHorizonRoute) => void;
}

export function ModDiffsPage(props: ModDiffsPageProps): JSX.Element {
  const reportFormatted = useErrorReporterFormatted();
  return (
    <ErrorBoundary
      where="ModDiffsPage"
      variant="page"
      onReport={reportFormatted}
    >
      <ModDiffsView />
    </ErrorBoundary>
  );
}

// ---------------------------------------------------------------------------
// Inner view
// ---------------------------------------------------------------------------

function ModDiffsView(): JSX.Element {
  const reportError = useErrorReporter();

  const [fileListState, setFileListState] = React.useState<FileListState>({
    kind: "loading",
  });
  const [selectedFilePath, setSelectedFilePath] = React.useState<string>("");
  const [reportState, setReportState] = React.useState<ReportState>({
    kind: "loading",
  });

  React.useEffect(() => {
    let alive = true;
    void (async (): Promise<void> => {
      try {
        const appData = getVortexUserDataPath() as string;
        const files = await listModDiffFiles(appData);
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
          title: "Couldn't list mod diff files",
          context: { step: "mod-diffs-list" },
        });
        setFileListState({ kind: "empty" });
      }
    })();
    return (): void => {
      alive = false;
    };
  }, [reportError]);

  React.useEffect(() => {
    if (!selectedFilePath) return;
    let alive = true;
    setReportState({ kind: "loading" });
    void (async (): Promise<void> => {
      try {
        const report = await readModDiffReport(selectedFilePath);
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

  if (fileListState.kind === "empty") {
    return (
      <Page
        title="Mod Diffs"
        subtitle="Compare two mod snapshots to generate a diff report."
      >
        <EmptyState title="No mod diff files found.">
          Use the <strong>Compare Current Mods With JSON</strong> toolbar
          action to generate one.
        </EmptyState>
      </Page>
    );
  }

  if (fileListState.kind === "loading") {
    return (
      <Page title="Mod Diffs">
        <p className="eh-note">Loading diff files…</p>
      </Page>
    );
  }

  const { files } = fileListState;
  const selectedEntry = files.find((f) => f.filePath === selectedFilePath);

  return (
    <Page
      title="Mod Diffs"
      subtitle="Review differences between two mod profile snapshots."
    >
      <div className="eh-mod-diffs">
        <FileSelector
          files={files}
          selectedFilePath={selectedFilePath}
          onSelect={setSelectedFilePath}
          selectedEntry={selectedEntry}
        />

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
  files: ModDiffFileEntry[];
  selectedFilePath: string;
  onSelect: (filePath: string) => void;
  selectedEntry: ModDiffFileEntry | undefined;
}

function FileSelector(props: FileSelectorProps): JSX.Element {
  const { files, selectedFilePath, onSelect, selectedEntry } = props;

  const displayDate = selectedEntry
    ? new Date(selectedEntry.timestampMs).toLocaleString()
    : "";

  return (
    <div className="eh-mod-diffs__selector-row">
      <Field inline label="Diff file" id="eh-mod-diff-file-select">
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
  report: ModsDiffReport;
}

function ReportView(props: ReportViewProps): JSX.Element {
  const { report } = props;

  return (
    <div className="eh-mod-diffs__report">
      {/* Snapshot metadata */}
      <div className="eh-mod-diffs__meta">
        <SnapshotMeta label="Reference" info={report.reference} />
        <span className="eh-mod-diffs__meta-separator" aria-hidden="true">
          vs
        </span>
        <SnapshotMeta label="Current" info={report.current} />
      </div>

      {/* Diff section blocks */}
      <div className="eh-mod-diffs__blocks">
        <DiffSectionBlock
          title="Only in Reference"
          count={report.onlyInReference.length}
        >
          <ModEntryList mods={report.onlyInReference} />
        </DiffSectionBlock>

        <DiffSectionBlock
          title="Only in Current"
          count={report.onlyInCurrent.length}
        >
          <ModEntryList mods={report.onlyInCurrent} />
        </DiffSectionBlock>

        <DiffSectionBlock
          title="Changed"
          count={report.changed.length}
          intent={report.changed.length > 0 ? "info" : "neutral"}
        >
          <ChangedModList entries={report.changed} />
        </DiffSectionBlock>

        <DiffSectionBlock
          title="Matched (no meaningful change)"
          count={(report.unchanged ?? []).length}
          intent="neutral"
          defaultExpanded={false}
        >
          <MatchedModList entries={report.unchanged ?? []} />
        </DiffSectionBlock>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Match tier badge
// ---------------------------------------------------------------------------

const EXACT_TIERS: ReadonlySet<MatchTier> = new Set<MatchTier>([
  "nexus-file",
  "archive-sha",
  "staging-set",
]);

function TierBadge(props: {
  tier: MatchTier;
  confidence: number;
}): JSX.Element {
  const { tier, confidence } = props;
  const isExact = EXACT_TIERS.has(tier);
  const cls = isExact
    ? "eh-mod-diffs__tier-badge"
    : "eh-mod-diffs__tier-badge eh-mod-diffs__tier-badge--fuzzy";
  return (
    <span className={cls} title={`Matched by ${TIER_LABEL[tier]}`}>
      {TIER_LABEL[tier]}
      {!isExact && (
        <span className="eh-mod-diffs__confidence">
          {Math.round(confidence * 100)}%
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Snapshot metadata strip
// ---------------------------------------------------------------------------

interface SnapshotMetaProps {
  label: string;
  info: ModsDiffReport["reference"];
}

function SnapshotMeta(props: SnapshotMetaProps): JSX.Element {
  const { label, info } = props;

  return (
    <span className="eh-mod-diffs__meta-item">
      <span className="eh-label">{label}</span>
      <span className="eh-mono">
        {info.gameId ?? "—"}
        {info.profileId ? ` / ${info.profileId}` : ""}
      </span>
      <Pill plain>{info.count} mods</Pill>
      {info.exportedAt && (
        <span className="eh-mod-diffs__meta-date">
          {new Date(info.exportedAt).toLocaleString()}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Simple mod list (only-in-reference / only-in-current)
// ---------------------------------------------------------------------------

interface ModEntryListProps {
  mods: AuditorMod[];
}

function ModEntryList(props: ModEntryListProps): JSX.Element {
  const { mods } = props;
  return (
    <ul className="eh-mod-diffs__mod-list">
      {mods.map((mod) => (
        <li key={mod.id} className="eh-mod-diffs__mod-row">
          <span className="eh-mod-diffs__mod-name" title={mod.id}>
            {mod.name}
          </span>
          {mod.version !== undefined && (
            <span className="eh-mod-diffs__mod-version">v{mod.version}</span>
          )}
          <Pill intent={mod.enabled ? "success" : "neutral"}>
            {mod.enabled ? "enabled" : "disabled"}
          </Pill>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Changed mod list
// ---------------------------------------------------------------------------

interface ChangedModListProps {
  entries: ChangedModReport[];
}

function ChangedModList(props: ChangedModListProps): JSX.Element {
  const { entries } = props;
  return (
    <ul className="eh-mod-diffs__mod-list">
      {entries.map((entry, idx) => (
        <ChangedModRow key={`${entry.compareKey}-${idx}`} entry={entry} />
      ))}
    </ul>
  );
}

interface ChangedModRowProps {
  entry: ChangedModReport;
}

const CATEGORY_LABEL: Record<DiffCategory, string> = {
  content: "Content",
  cosmetic: "Display",
  metadata: "Metadata",
};

function partitionDiffs(diffs: ModFieldDifference[]): {
  content: ModFieldDifference[];
  secondary: ModFieldDifference[];
} {
  const content: ModFieldDifference[] = [];
  const secondary: ModFieldDifference[] = [];
  for (const d of diffs) {
    if (d.category === "content") content.push(d);
    else secondary.push(d);
  }
  return { content, secondary };
}

function ChangedModRow(props: ChangedModRowProps): JSX.Element {
  const { entry } = props;
  const [expanded, setExpanded] = React.useState(false);
  const [showSecondary, setShowSecondary] = React.useState(false);

  const { content, secondary } = partitionDiffs(entry.differences);

  // Lead with the count that matters: real content drift if any, else the
  // count of display/metadata-only changes.
  const primaryCount = content.length > 0 ? content.length : secondary.length;
  const primaryLabel =
    content.length > 0
      ? `${primaryCount} ${primaryCount === 1 ? "change" : "changes"}`
      : `${primaryCount} minor`;

  return (
    <li className="eh-mod-diffs__mod-row eh-mod-diffs__mod-row--changed">
      <button
        type="button"
        className="eh-mod-diffs__changed-header"
        onClick={(): void => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="eh-mod-diffs__changed-chevron" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="eh-mod-diffs__mod-name">
          {entry.current.name}
        </span>
        {entry.current.version !== undefined && (
          <span className="eh-mod-diffs__mod-version">
            v{entry.current.version}
          </span>
        )}
        <TierBadge tier={entry.matchTier} confidence={entry.confidence} />
        <span className="eh-mod-diffs__changed-count">{primaryLabel}</span>
      </button>

      {expanded && (
        <ul className="eh-mod-diffs__field-list">
          {content.map((diff) => (
            <FieldDiffRow key={diff.field} diff={diff} />
          ))}

          {secondary.length > 0 && (
            <li>
              <button
                type="button"
                className="eh-mod-diffs__more-toggle"
                onClick={(): void => setShowSecondary((v) => !v)}
                aria-expanded={showSecondary}
              >
                {showSecondary ? "▾" : "▸"} {showSecondary ? "Hide" : "Show"}{" "}
                {secondary.length} display/metadata{" "}
                {secondary.length === 1 ? "change" : "changes"}
              </button>
            </li>
          )}

          {showSecondary &&
            (["cosmetic", "metadata"] as DiffCategory[]).map((cat) => {
              const rows = secondary.filter((d) => d.category === cat);
              if (rows.length === 0) return null;
              return (
                <React.Fragment key={cat}>
                  <li
                    className="eh-mod-diffs__field-cat"
                    aria-hidden="true"
                  >
                    {CATEGORY_LABEL[cat]}
                  </li>
                  {rows.map((diff) => (
                    <FieldDiffRow key={diff.field} diff={diff} />
                  ))}
                </React.Fragment>
              );
            })}
        </ul>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Matched (no meaningful change) list
// ---------------------------------------------------------------------------

interface MatchedModListProps {
  entries: MatchedModSummary[];
}

function MatchedModList(props: MatchedModListProps): JSX.Element {
  const { entries } = props;
  return (
    <ul className="eh-mod-diffs__mod-list">
      {entries.map((entry, idx) => (
        <li
          key={`${entry.compareKey}-${idx}`}
          className="eh-mod-diffs__mod-row"
        >
          <span className="eh-mod-diffs__mod-name">{entry.name}</span>
          {entry.version !== undefined && (
            <span className="eh-mod-diffs__mod-version">v{entry.version}</span>
          )}
          <Pill intent={entry.enabled ? "success" : "neutral"}>
            {entry.enabled ? "enabled" : "disabled"}
          </Pill>
          <span className="eh-mod-diffs__mod-tier">
            {TIER_LABEL[entry.matchTier]}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Field-level diff row (inside a changed mod)
// ---------------------------------------------------------------------------

interface FieldDiffRowProps {
  diff: ModFieldDifference;
}

function FieldDiffRow(props: FieldDiffRowProps): JSX.Element {
  const { diff } = props;

  return (
    <li className="eh-mod-diffs__field-row">
      <span className="eh-mod-diffs__field-name">{diff.field}</span>
      <span className="eh-mod-diffs__field-values">
        <span className="eh-mod-diffs__field-value eh-mod-diffs__field-value--ref">
          {formatFieldValue(diff.field, diff.referenceValue)}
        </span>
        <span className="eh-mod-diffs__arrow" aria-hidden="true">→</span>
        <span className="eh-mod-diffs__field-value eh-mod-diffs__field-value--cur">
          {formatFieldValue(diff.field, diff.currentValue)}
        </span>
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Field value formatter
// ---------------------------------------------------------------------------

function formatFieldValue(field: string, value: unknown): string {
  if (value === undefined || value === null) return "—";

  if (field === "enabled") {
    return value === true ? "enabled" : "disabled";
  }

  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return String(value);

  if (typeof value === "string") {
    return value.length > 60 ? `${value.slice(0, 57)}…` : value;
  }

  if (Array.isArray(value)) {
    return value.length === 0 ? "(empty)" : `[${value.length} items]`;
  }

  if (typeof value === "object") {
    const keys = Object.keys(value as object);
    return keys.length === 0 ? "{}" : `{${keys.slice(0, 3).join(", ")}…}`;
  }

  return String(value);
}
