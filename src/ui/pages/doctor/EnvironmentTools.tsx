/**
 * ──────────────────────────────────────────────────────────────────────
 * Doctor → game setup: the checks, the snapshot, and the moved-aside files.
 *
 * All three work without an installed collection, on purpose: the tester who
 * most needs a diagnosis is the one whose install never got that far.
 *
 *  - Check game setup   the same preflight the installer runs, every check
 *                       shown, passing ones included
 *  - Save snapshot      everything about the setup in one file
 *                       (core/environment/snapshot.ts) — send it, and the
 *                       problem can be found without a round of questions
 *  - Moved-aside files  every quarantine the installer made, with Restore
 * ──────────────────────────────────────────────────────────────────────
 */

import * as React from "react";

import { Button, Card, useToast } from "../../components";
import { useErrorReporter } from "../../errors";
import { useApi } from "../../state";
import { EXTENSION_VERSION } from "../../version";
import { getActiveGameId } from "../../../core/getModsListForProfile";
import type { EnvironmentReport } from "../../../core/environment/preflight";
import type { QuarantineSummary } from "../../../core/environment/quarantine";
import type { SnapshotProgress } from "../../../core/environment/snapshot";
import { PlayGameButton } from "../../play/PlayGameButton";
import { EnvironmentCard } from "../install/EnvironmentCard";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function EnvironmentTools(): JSX.Element {
  const api = useApi();
  const toast = useToast();
  const reportError = useErrorReporter();

  const gameId = React.useMemo(() => {
    try {
      return getActiveGameId(api.getState());
    } catch {
      return undefined;
    }
  }, [api]);

  const [report, setReport] = React.useState<EnvironmentReport | undefined>(undefined);
  const [checking, setChecking] = React.useState(false);
  const [snapshot, setSnapshot] = React.useState<SnapshotProgress | undefined>(undefined);
  const snapshotAbort = React.useRef<AbortController | undefined>(undefined);
  const [quarantines, setQuarantines] = React.useState<QuarantineSummary[] | undefined>(undefined);
  const [restoring, setRestoring] = React.useState<string | undefined>(undefined);
  const [tick, setTick] = React.useState(0);

  React.useEffect(() => {
    let alive = true;
    void (async (): Promise<void> => {
      try {
        const [{ listQuarantines }, { getEventHorizonDir }] = await Promise.all([
          import("../../../core/environment/quarantine"),
          import("../../../core/paths"),
        ]);
        const found = await listQuarantines(getEventHorizonDir("quarantine"));
        if (alive) setQuarantines(found);
      } catch {
        if (alive) setQuarantines([]);
      }
    })();
    return (): void => {
      alive = false;
    };
  }, [tick]);

  const runCheck = (): void => {
    if (gameId === undefined || checking) return;
    setChecking(true);
    void (async (): Promise<void> => {
      try {
        const [{ gatherPreflightFacts }, { runEnvironmentPreflight }] = await Promise.all([
          import("../../../core/environment/vortexEnvironment"),
          import("../../../core/environment/preflight"),
        ]);
        const facts = gatherPreflightFacts({ state: api.getState(), gameId });
        setReport(await runEnvironmentPreflight(facts, { scanFolder: true, context: "doctor" }));
      } catch (err) {
        reportError(err, { title: "Couldn't check the game setup", context: { step: "doctor-environment", gameId } });
      } finally {
        setChecking(false);
      }
    })();
  };

  const saveSnapshot = (): void => {
    if (gameId === undefined || snapshot !== undefined) return;
    void (async (): Promise<void> => {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filePath = await api.saveFile({
        title: "Save Event Horizon snapshot",
        defaultPath: `event-horizon-snapshot-${gameId}-${stamp}.json`,
        filters: [
          { name: "JSON", extensions: ["json"] },
          { name: "All files", extensions: ["*"] },
        ],
      });
      if (filePath === undefined || filePath.length === 0) return;
      const controller = new AbortController();
      snapshotAbort.current = controller;
      setSnapshot({ phase: "preflight", done: 0 });
      try {
        const { writeEnvironmentSnapshot } = await import("../../../core/environment/snapshot");
        const result = await writeEnvironmentSnapshot({
          api,
          gameId,
          filePath,
          extensionVersion: EXTENSION_VERSION,
          signal: controller.signal,
          onProgress: (p) => setSnapshot(p),
        });
        toast({
          intent: "success",
          message: `Snapshot saved: ${result.gameFiles} game files, ${result.stagingFiles} staging files, ${formatBytes(result.bytes)}.`,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          toast({ intent: "info", message: "Snapshot cancelled." });
        } else {
          reportError(err, { title: "Couldn't save the snapshot", context: { step: "doctor-snapshot", gameId } });
        }
      } finally {
        snapshotAbort.current = undefined;
        setSnapshot(undefined);
      }
    })();
  };

  const restore = (q: QuarantineSummary): void => {
    if (restoring !== undefined) return;
    void (async (): Promise<void> => {
      const answer = await api.showDialog?.(
        "question",
        "Put these files back?",
        {
          text: `${q.held} file(s) go back to where they were in the game folder. A file whose original place is now taken stays in quarantine — nothing is overwritten.`,
          message: `${q.record.reason}\n${q.record.folder}`,
        },
        [{ label: "Cancel" }, { label: "Restore" }],
      );
      if (answer?.action !== "Restore") return;
      setRestoring(q.recordPath);
      try {
        const { restoreQuarantine } = await import("../../../core/environment/quarantine");
        const result = await restoreQuarantine(q.recordPath);
        if (result.conflicts.length > 0 || result.failed.length > 0) {
          await api.showDialog?.(
            "info",
            `${result.restored} file(s) restored — some stayed in quarantine`,
            {
              text: "These files were not moved back, because something now occupies their place or the move failed. They are still in the quarantine folder.",
              message: [
                ...result.conflicts.map((c) => `in the way: ${c}`),
                ...result.failed.map((f) => `failed: ${f.path} — ${f.error}`),
              ].join("\n"),
            },
            [{ label: "Close" }],
          );
        } else {
          toast({ intent: "success", message: `${result.restored} file(s) restored.` });
        }
      } catch (err) {
        reportError(err, { title: "Couldn't restore the files", context: { step: "doctor-restore", recordPath: q.recordPath } });
      } finally {
        setRestoring(undefined);
        setTick((n) => n + 1);
      }
    })();
  };

  const held = (quarantines ?? []).filter((q) => q.held > 0);

  return (
    <>
      <Card title="Game setup" inert>
        {gameId === undefined ? (
          <p className="eh-secondary" style={{ margin: 0 }}>
            No active game in Vortex. Select the game first.
          </p>
        ) : (
          <div className="eh-stack eh-stack--sm">
            <span className="eh-secondary">
              Checks that the game is managed by Vortex, has been started once, can load its own DLLs, is outside
              Program Files, and that its folder is a clean game. A snapshot saves all of it — every file in the
              game and staging folders included — into one file you can send.
            </span>
            <div className="eh-row">
              <Button intent="ghost" disabled={checking} onClick={runCheck}>
                {checking ? "Checking…" : "Check game setup"}
              </Button>
              {snapshot === undefined ? (
                <Button intent="ghost" onClick={saveSnapshot}>
                  Save full snapshot…
                </Button>
              ) : (
                <Button intent="danger" onClick={(): void => snapshotAbort.current?.abort()}>
                  Cancel snapshot
                </Button>
              )}
              <PlayGameButton gameId={gameId} />
            </div>
            {snapshot !== undefined && (
              <span className="eh-secondary" style={{ wordBreak: "break-all" }}>
                {snapshot.phase}
                {snapshot.total !== undefined ? ` ${snapshot.done} / ${snapshot.total}` : ""}
                {snapshot.current !== undefined ? ` — ${snapshot.current}` : ""}
              </span>
            )}
          </div>
        )}
      </Card>

      <EnvironmentCard report={report} showOk />

      {held.length > 0 && (
        <Card title="Moved-aside files" inert>
          <div className="eh-stack">
            {held.map((q) => (
              <div key={q.recordPath} className="eh-stack eh-stack--sm">
                <div className="eh-row">
                  <strong className="eh-strong">
                    {q.held} file(s) — {new Date(q.record.createdAt).toLocaleString()}
                  </strong>
                  <Button
                    intent="ghost"
                    size="sm"
                    disabled={restoring !== undefined}
                    onClick={(): void => restore(q)}
                  >
                    {restoring === q.recordPath ? "Restoring…" : "Restore"}
                  </Button>
                </div>
                <span className="eh-secondary">{q.record.reason}</span>
                <span className="eh-secondary" style={{ wordBreak: "break-all" }}>
                  {q.record.folder}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
