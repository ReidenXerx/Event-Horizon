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
 *  - Moved-aside files  every quarantine the installer made, read from disk
 *                       (a crash mid-move still shows), with Restore
 *
 * The active game is followed live: Vortex can switch games without leaving
 * this page, and a check or snapshot of the previous game would be a quiet lie.
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
import type { RuntimeFinding } from "../../../core/runtime/detectRuntimes";
import { PlayGameButton } from "../../play/PlayGameButton";
import { EnvironmentCard } from "../install/EnvironmentCard";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function activeGame(api: ReturnType<typeof useApi>): string | undefined {
  try {
    return getActiveGameId(api.getState());
  } catch {
    return undefined;
  }
}

export function EnvironmentTools(): JSX.Element {
  const api = useApi();
  const toast = useToast();
  const reportError = useErrorReporter();

  const [gameId, setGameId] = React.useState<string | undefined>(() => activeGame(api));
  const [report, setReport] = React.useState<EnvironmentReport | undefined>(undefined);
  const [checking, setChecking] = React.useState(false);
  const [snapshot, setSnapshot] = React.useState<SnapshotProgress | undefined>(undefined);
  const snapshotAbort = React.useRef<AbortController | undefined>(undefined);
  const [quarantines, setQuarantines] = React.useState<QuarantineSummary[] | undefined>(undefined);
  const [busyRecord, setBusyRecord] = React.useState<string | undefined>(undefined);
  const [tick, setTick] = React.useState(0);
  const [savingLogs, setSavingLogs] = React.useState(false);
  /** Microsoft runtimes: what the machine has, and the repair in progress. */
  const [runtimes, setRuntimes] = React.useState<RuntimeFinding[] | undefined>(undefined);
  const [runtimeBusy, setRuntimeBusy] = React.useState<string | undefined>(undefined);

  // Follow Vortex's active game.
  React.useEffect(() => {
    const onGame = (id: unknown): void => {
      setGameId(typeof id === "string" && id.length > 0 ? id : activeGame(api));
      setReport(undefined);
    };
    api.events?.on?.("gamemode-activated", onGame);
  return (): void => {
      api.events?.removeListener?.("gamemode-activated", onGame);
    };
  }, [api]);

  // Leaving the page must not orphan a running snapshot.
  React.useEffect(
    () => (): void => {
      snapshotAbort.current?.abort();
    },
    [],
  );

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
        const result = await runEnvironmentPreflight(facts, { scanFolder: true, context: "doctor" });
        if (activeGame(api) === gameId) setReport(result);
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

  const saveLogs = (): void => {
    if (savingLogs) return;
    void (async (): Promise<void> => {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filePath = await api.saveFile({
        title: "Save Event Horizon logs",
        defaultPath: `event-horizon-logs-${stamp}.zip`,
        filters: [
          { name: "ZIP archive", extensions: ["zip"] },
          { name: "All files", extensions: ["*"] },
        ],
      });
      if (filePath === undefined || filePath.length === 0) return;
      setSavingLogs(true);
      try {
        const { collectLogSources, logBundleDirs, writeLogBundle } = await import("../../../core/diagnostics/logBundle");
        const sources = await collectLogSources(logBundleDirs());
        const result = await writeLogBundle({ filePath, extensionVersion: EXTENSION_VERSION, sources });
        toast({
          intent: result.skipped.length === 0 ? "success" : "warning",
          message:
            `Logs saved: ${result.files} files, ${formatBytes(result.bytes)}` +
            (result.skipped.length > 0 ? ` (${result.skipped.length} could not be read — listed inside)` : "") +
            ". Send this file to whoever asked for it.",
        });
      } catch (err) {
        reportError(err, { title: "Couldn't save the logs", context: { step: "doctor-save-logs" } });
      } finally {
        setSavingLogs(false);
      }
    })();
  };

  const restore = (q: QuarantineSummary): void => {
    if (busyRecord !== undefined) return;
    void (async (): Promise<void> => {
      const answer = await api.showDialog?.(
        "question",
        "Put these files back?",
        {
          text:
            `${q.held} file(s) go back to where they were in the game folder. A file whose original place is now taken stays in quarantine — nothing is overwritten. ` +
            "Once they are back, the folder is no longer clean for a collection, and the next install will offer to move them aside again.",
          message: `${q.record.reason}\n${q.record.folder}`,
        },
        [{ label: "Cancel" }, { label: "Restore" }],
      );
      if (answer?.action !== "Restore") return;
      setBusyRecord(q.recordPath);
      try {
        const { restoreQuarantine } = await import("../../../core/environment/quarantine");
        const result = await restoreQuarantine(q.recordPath);
        if (result.conflicts.length > 0 || result.failed.length > 0 || result.absent.length > 0) {
          await api.showDialog?.(
            "info",
            `${result.restored} file(s) restored — not everything could be`,
            {
              text:
                "Files in the way stay in quarantine until their place is free. Failed moves can be retried. Missing files were removed from the quarantine folder by something else and cannot come back.",
              message: [
                ...result.conflicts.map((c) => `in the way: ${c}`),
                ...result.failed.map((f) => `failed: ${f.path} — ${f.error}`),
                ...result.absent.map((a) => `missing from quarantine: ${a}`),
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
        setBusyRecord(undefined);
        setTick((n) => n + 1);
      }
    })();
  };

  const dismiss = (q: QuarantineSummary): void => {
    if (busyRecord !== undefined) return;
    setBusyRecord(q.recordPath);
    void (async (): Promise<void> => {
      try {
        const { dismissQuarantine } = await import("../../../core/environment/quarantine");
        await dismissQuarantine(q.recordPath);
      } catch (err) {
        reportError(err, { title: "Couldn't dismiss the record", context: { step: "doctor-dismiss", recordPath: q.recordPath } });
      } finally {
        setBusyRecord(undefined);
        setTick((n) => n + 1);
      }
    })();
  };

  const shown = (quarantines ?? []).filter(
    (q) => q.held > 0 || (q.absent > 0 && q.record.restoredAt === undefined && q.record.dismissedAt === undefined),
  );

    /**
   * ─── THE CHECK A PLAYER REACHES FOR AFTER THE INSTALL ────────────────
   * The install preview has detected these since `detectRuntimes` existed,
   * but a missing runtime does not announce itself at install time — it
   * announces itself weeks later as a script-extender plugin that silently
   * never loads. Fallout 4 body physics is the case that prompted this: the
   * bodies are there, the physics is not, and nothing is printed anywhere a
   * player would look.
   *
   * So the same probe lives here, where someone goes when the game is already
   * wrong, and the older VC++ runtimes are included — a 14.x redistributable
   * does not provide msvcr120/msvcr110, and asking for them explicitly is not
   * crying wolf.
   */
  const checkRuntimes = React.useCallback((): void => {
    setRuntimeBusy("Checking…");
    void (async (): Promise<void> => {
      try {
        const [{ detectRuntimes }, { readRegistryValue, fileExists }] = await Promise.all([
          import("../../../core/runtime/detectRuntimes"),
          import("../../../core/runtime/nodePrereqDeps"),
        ]);
        const findings = await detectRuntimes(
          {
            readRegistryValue,
            fileExists,
            systemDir: `${process.env.WINDIR ?? "C:\Windows"}\System32`,
          },
          [
            "vcredist-x64",
            "vcredist-x86",
            "vcredist2013-x64",
            "vcredist2013-x86",
            "vcredist2012-x86",
            "dotnet48",
            "dotnet8-desktop-x64",
            "directx9",
          ],
        );
        setRuntimes(findings);
      } catch (err) {
        reportError(err, {
          title: "Couldn't check the system runtimes",
          context: { step: "doctor-runtimes" },
        });
      } finally {
        setRuntimeBusy(undefined);
      }
    })();
  }, [reportError]);

  const installMissingRuntimes = React.useCallback((): void => {
    void (async (): Promise<void> => {
      const [{ repairRuntimes, missingRuntimeIds }] = await Promise.all([
        import("../../runtime/runtimeRepair"),
      ]);
      const ids = missingRuntimeIds(runtimes ?? []);
      if (ids.length === 0) return;
      setRuntimeBusy("Downloading…");
      try {
        const outcome = await repairRuntimes({
          api,
          ids,
          onStep: (message) => setRuntimeBusy(message),
        });
        setRuntimes(outcome.after.length > 0 ? outcome.after : runtimes);
        toast({
          intent: outcome.fixed ? "success" : "warning",
          message: outcome.lines.join(" "),
        });
        // Re-read regardless: the repair's own probe is the authority, and a
        // partial result should still refresh what the card shows.
        checkRuntimes();
      } finally {
        setRuntimeBusy(undefined);
      }
    })();
  }, [api, checkRuntimes, runtimes, toast]);

  return (
    <>
      <Card title="Game setup" inert>
        {gameId === undefined ? (
          <p className="eh-body">
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
              <span className="eh-secondary eh-pre-wrap">
                {snapshot.phase}
                {snapshot.total !== undefined ? ` ${snapshot.done} / ${snapshot.total}` : ""}
                {snapshot.current !== undefined ? ` — ${snapshot.current}` : ""}
              </span>
            )}
          </div>
        )}
      </Card>

      <Card title="System runtimes" inert>
        <div className="eh-stack eh-stack--sm">
          <span className="eh-secondary">
            The Microsoft runtimes that script-extender plugins, xEdit and ENB link against. A missing one does
            not announce itself: the collection installs perfectly, every file verifies, and a plugin silently
            never loads — broken body physics in Fallout 4 is the usual way people notice.
          </span>
          <div className="eh-row">
            <Button intent="ghost" disabled={runtimeBusy !== undefined} onClick={checkRuntimes}>
              {runtimeBusy ?? "Check system runtimes"}
            </Button>
            {runtimes !== undefined && runtimes.some((r) => r.status === "absent") && (
              <Button
                intent="primary"
                disabled={runtimeBusy !== undefined}
                onClick={installMissingRuntimes}
              >
                Install the missing ones
              </Button>
            )}
          </div>
          {runtimes !== undefined && (
            <ul className="eh-list">
              {runtimes.map((r) => (
                <li key={r.id} className="eh-secondary eh-pre-wrap">
                  {r.status === "present" ? "OK" : r.status === "absent" ? "MISSING" : "could not check"}
                  {" — "}
                  {r.name}
                  {r.version !== undefined ? ` (${r.version})` : ""}
                  {r.detail !== undefined ? ` — ${r.detail}` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <Card title="Logs" inert>
        <div className="eh-stack eh-stack--sm">
          <span className="eh-secondary">
            Saves every Event Horizon log, Vortex&apos;s own logs and Event Horizon&apos;s install records into one zip.
            Send that file when someone asks what happened — it is everything needed to find out.
          </span>
          <div className="eh-row">
            <Button intent="ghost" disabled={savingLogs} onClick={saveLogs}>
              {savingLogs ? "Saving…" : "Save logs…"}
            </Button>
          </div>
        </div>
      </Card>

      <EnvironmentCard report={report} showOk />

      {shown.length > 0 && (
        <Card title="Moved-aside files" inert>
          <div className="eh-stack">
            {shown.map((q) => (
              <div key={q.recordPath} className="eh-stack eh-stack--sm">
                <div className="eh-row">
                  <strong className="eh-strong">
                    {q.held > 0 ? `${q.held} file(s) held` : "Nothing left to restore"}
                    {q.absent > 0 ? `, ${q.absent} missing from quarantine` : ""} —{" "}
                    {new Date(q.record.createdAt).toLocaleString()} ({q.record.gameId})
                  </strong>
                  {q.held > 0 ? (
                    <Button intent="ghost" size="sm" disabled={busyRecord !== undefined} onClick={(): void => restore(q)}>
                      {busyRecord === q.recordPath ? "Restoring…" : "Restore"}
                    </Button>
                  ) : (
                    <Button intent="ghost" size="sm" disabled={busyRecord !== undefined} onClick={(): void => dismiss(q)}>
                      Dismiss
                    </Button>
                  )}
                </div>
                <span className="eh-secondary">{q.record.reason}</span>
                <span className="eh-secondary eh-pre-wrap">
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
