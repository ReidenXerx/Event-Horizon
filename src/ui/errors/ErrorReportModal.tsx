/**
 * ErrorReportModal — the visible face of any error that reaches the
 * UI (whether by `reportError(...)`, by an ErrorBoundary catch, or by
 * an action wrap-and-rethrow).
 *
 * Layout:
 *   - Title (from FormattedError.title)
 *   - Severity pill + class name
 *   - Message paragraph
 *   - Details list (bulleted, only if there are any)
 *   - Hints list ("What to try", green-tinted)
 *   - Collapsible "Technical details" (raw message, context bag,
 *     structured payload, stack trace) — closed by default; testers
 *     and devs open it as needed.
 *   - Footer:
 *       [ Copy report ]  [ Save report... ]    [ Dismiss ]
 *
 * The "Copy report" and "Save report" buttons emit the same plain
 * text bundle (built by `buildErrorReport`) so testers can paste
 * what they captured into Discord / GitHub issues / our triage doc
 * without any formatting drift.
 */

import * as React from "react";

import type { types } from "@nexusmods/vortex-api";

import { Button, Pill, Section, LinkButton } from "../components";
import { useApiOptional } from "../state";
import { Modal } from "../components/Modal";
import { FormattedError, buildErrorReport } from "./formatError";

export interface ErrorReportModalProps {
  open: boolean;
  error: FormattedError | undefined;
  onClose: () => void;
}

export function ErrorReportModal(props: ErrorReportModalProps): JSX.Element {
  const { open, error, onClose } = props;
  // Optional: this modal renders error states, and one of those is "the
  // extension tree failed to mount". Throwing here for a missing provider
  // would replace the error report with a second error.
  const api = useApiOptional();

  const [copyState, setCopyState] = React.useState<"idle" | "ok" | "fail">(
    "idle",
  );
  const [saveState, setSaveState] = React.useState<"idle" | "ok" | "fail">(
    "idle",
  );
  const [techExpanded, setTechExpanded] = React.useState(false);

  React.useEffect(() => {
    if (!open) {
      setCopyState("idle");
      setSaveState("idle");
      setTechExpanded(false);
    }
  }, [open]);

  if (error === undefined) {
    return <Modal open={false} onClose={onClose} />;
  }

  const reportText = buildErrorReport(error);

  const handleCopy = async (): Promise<void> => {
    try {
      await copyToClipboard(reportText);
      setCopyState("ok");
      window.setTimeout(() => setCopyState("idle"), 2000);
    } catch {
      setCopyState("fail");
      window.setTimeout(() => setCopyState("idle"), 3000);
    }
  };

  const handleSave = async (): Promise<void> => {
    try {
      if (api === undefined) throw new Error("No file picker available.");
      const saved = await saveReportToFile(api, error.title, reportText);
      setSaveState(saved ? "ok" : "idle");
      if (saved) {
        window.setTimeout(() => setSaveState("idle"), 2500);
      }
    } catch {
      setSaveState("fail");
      window.setTimeout(() => setSaveState("idle"), 3000);
    }
  };

  const copyLabel =
    copyState === "ok"
      ? "Copied!"
      : copyState === "fail"
        ? "Copy failed"
        : "Copy report";
  const saveLabel =
    saveState === "ok"
      ? "Saved!"
      : saveState === "fail"
        ? "Save failed"
        : "Save report...";

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={error.title}
      subtitle={`${error.className} · ${error.severity}`}
      footer={
        <>
          <Button
            intent="ghost"
            onClick={(): void => {
              void handleCopy();
            }}
          >
            {copyLabel}
          </Button>
          <Button
            intent="ghost"
            onClick={(): void => {
              void handleSave();
            }}
          >
            {saveLabel}
          </Button>
          <Button intent="primary" onClick={onClose}>
            Dismiss
          </Button>
        </>
      }
    >
      <div
        className="eh-stack eh-stack--lg"
      >
        <div
          className="eh-row"
        >
          <Pill
            intent={error.severity === "warning" ? "warning" : "danger"}
            withDot
          >
            {error.severity}
          </Pill>
          <Pill intent="info">{error.className}</Pill>
        </div>

        <p className="eh-strong">{error.message}</p>

        {error.details.length > 0 && (
          <Section title="Details" size="sm">
            <BulletList items={error.details} />
          </Section>
        )}

        {error.hints.length > 0 && (
          <Section title="What to try" size="sm" tone="success">
            <BulletList items={error.hints} />
          </Section>
        )}

        <Section title="Technical details" size="sm">
          {techExpanded ? (
            <TechnicalPanel error={error} reportText={reportText} />
          ) : (
            <LinkButton
              variant="caps"
              onClick={(): void => setTechExpanded(true)}
            >
              Show stack trace + context
            </LinkButton>
          )}
        </Section>
      </div>
    </Modal>
  );
}

// ===========================================================================
// Sub-components
// ===========================================================================

function BulletList(props: { items: string[] }): JSX.Element {
  return (
    <ul className="eh-list eh-stack eh-stack--xs">
      {props.items.map((item, idx) => (
        <li key={idx}>{item}</li>
      ))}
    </ul>
  );
}

function TechnicalPanel(props: {
  error: FormattedError;
  reportText: string;
}): JSX.Element {
  const { error, reportText } = props;
  return (
    <pre
      className="eh-inset eh-inset--deep eh-mono eh-pre-wrap eh-scroll"
      title={`${error.className}: ${error.rawMessage}`}
    >
      {reportText}
    </pre>
  );
}

// ===========================================================================
// Clipboard + file IO
// ===========================================================================

interface MinimalElectronClipboard {
  writeText: (s: string) => void;
}
interface MinimalElectronDialog {
  showSaveDialog: (
    opts: Record<string, unknown>,
  ) => Promise<{ canceled: boolean; filePath?: string }>;
}
interface MinimalElectronModule {
  clipboard?: MinimalElectronClipboard;
  remote?: { dialog?: MinimalElectronDialog };
  dialog?: MinimalElectronDialog;
}

function tryRequireElectron(): MinimalElectronModule | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("electron") as MinimalElectronModule;
  } catch {
    return undefined;
  }
}

async function copyToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const electron = tryRequireElectron();
  const clipboard = electron?.clipboard;
  if (clipboard?.writeText) {
    clipboard.writeText(text);
    return;
  }
  throw new Error("No clipboard API available");
}

/**
 * Save the report through Vortex's own picker, not Electron's.
 *
 * `electron.remote` was removed in Electron 14 and `dialog` is a main-process
 * module a renderer never has — so this threw "Electron dialog API not
 * available" instead of saving. Which made it useless in precisely the moment
 * it exists for: a user under Proton hit an error dialog, and the button for
 * getting that error to somebody who could read it was broken by the same
 * class of bug the dialog was reporting.
 */
async function saveReportToFile(
  api: types.IExtensionApi,
  title: string,
  text: string,
): Promise<boolean> {

  const sanitized = title
    .replace(/[<>:"\\/|?*\x00-\x1f]/g, "_")
    .slice(0, 80)
    .trim();
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  const defaultPath = `event-horizon-error-${stamp}-${sanitized}.txt`;

  const filePath = await api.saveFile({
    title: "Save Event Horizon error report",
    defaultPath,
    filters: [
      { name: "Text file", extensions: ["txt"] },
      { name: "All files", extensions: ["*"] },
    ],
  });

  if (filePath === undefined || filePath.length === 0) return false;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fsp = require("fs/promises") as typeof import("fs/promises");
  await fsp.writeFile(filePath, text, { encoding: "utf-8" });
  return true;
}
