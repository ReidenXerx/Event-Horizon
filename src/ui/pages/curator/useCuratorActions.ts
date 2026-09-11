/**
 * ──────────────────────────────────────────────────────────────────────
 * Every action the curator workbench can take, in one hook.
 *
 * The page grew past 1,800 lines with the handlers and the render
 * interleaved; two review lenses said so. The handlers moved here
 * VERBATIM — the `mod-update` emit that modUpdateWiring.test.ts pins is
 * in this file now — and the page keeps its state and its render. The
 * hook receives what the handlers read and returns what the render calls.
 *
 * Every long action still runs one mod at a time through
 * `curatorSession`, and nothing here deletes without a confirm dialog.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fsp from "fs/promises";
import * as React from "react";
import {
  actions as vortexActions,
} from "@nexusmods/vortex-api";
import {
  type CuratorMod,
} from "../../../core/curator/profileActions";
import {
  freezeAttribute,
  readCuratorMods,
  readEnabledModIds,
} from "../../../core/curator/readProfile";
import {
  installFromExistingDownload,
  uninstallMod,
} from "../../../core/installer/modInstall";
import {
  getModArchivePath,
} from "../../../core/archiveHashing";
import {
  installRequirementStep,
  type RequirementStepResult,
} from "../../../core/curator/requirementStep";
import {
  downloadIdsForPage,
  existingArchiveFor,
  readDownloadRecords,
} from "../../../core/curator/existingDownload";
import {
  runRequirementPlan,
} from "../../../core/curator/runRequirementPlan";
import {
  describeBulkUpdate,
  runBulkUpdate,
} from "../../../core/curator/bulkUpdate";
import {
  describeEnableChanges,
  describeTypeChanges,
  planEnableChanges,
  planTypeChanges,
} from "../../../core/curator/bulkToggles";
import {
  captureForReinstall,
  reinstallArgs,
  restorationFor,
} from "../../../core/curator/reinstallMod";
import {
  runSequentially,
} from "../../../core/curator/runSequentially";
import {
  ENDORSE_PACE_MS,
  describeEndorseDuration,
  endorseIsLong,
} from "../../../core/curator/endorsePace";
import {
  type CleanupPlan,
  type DownloadEntry,
} from "../../../core/curator/cleanupPlan";
import {
  describeCleanupOutcome,
  runCleanup,
} from "../../../core/curator/runCleanup";
import {
  FROZEN_ATTRIBUTE,
  NOTES_ATTRIBUTE,
} from "../../../core/curator/readProfile";
import {
  installedIdentityReader,
  updateOneAndWait,
} from "../../../core/curator/updateOneMod";
import {
  verifyUpdatedMod,
} from "../../../core/curator/verifyAfterUpdate";
import {
  dependantsOf,
  disabledProvidersFor,
  summarizeRequirements,
  type ModRequirement,
  type NexusFileInfo,
} from "../../../core/curator/requirements";
import {
  ehLog,
} from "../../../core/logging/ehLog";
import {
  fileForStep,
  planRequirementClosure,
  resolveInstallFiles,
  type InstallPlan,
  type PlannedFile,
  type PlannedInstall,
} from "../../../core/curator/installPlan";
import {
  knownGameIds,
  loadRequirements,
  nexusDomainForVortexGame,
  nexusExtOf,
} from "./requirementsIo";
import {
  statusToSend,
  waitForEndorseOutcome,
} from "../../../core/curator/endorseOutcome";
import {
  setPluginLightFlag,
} from "../../../core/manifest/pluginFlags";
import {
  installRootFor,
  stagingRootFromFolder,
} from "../../../core/stagingPath";
import {
  PluginRow,
} from "../../../core/curator/pluginView";
import {
  type WorkRow,
} from "./workbench";
import { getCuratorSession } from "./curatorSession";

type CuratorSession = ReturnType<typeof getCuratorSession>;
import type { RequirementsReport } from "../../../core/curator/requirements";
import type { RequirementsCache } from "./curatorSession";
import type { Confirmer } from "./DiskCleanupView";

const num = (n: number): string => n.toLocaleString();

type EmitAndAwait = {
  emitAndAwait?: (event: string, ...args: unknown[]) => PromiseLike<unknown>;
};

/** Nexus Premium: the only accounts Vortex will download for directly. */
export function isPremium(state: unknown): boolean {
  return (state as { persistent?: { nexus?: { userInfo?: { isPremium?: unknown } } } })?.persistent?.nexus?.userInfo?.isPremium === true;
}

/** How long a requirements read stays fresh enough to reuse after an install. */
const REUSE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type CuratorActionsContext = {
  api: ReturnType<typeof import("../../state").useApi>;
  session: CuratorSession;
  /** The session's current run, for the once-per-game auto-read. */
  busy: ReturnType<CuratorSession["getSnapshot"]>["busy"];
  gameId: string | undefined;
  mods: readonly CuratorMod[];
  report: RequirementsReport | undefined;
  requirements: RequirementsCache | undefined;
  endorsable: readonly CuratorMod[];
  focusMod: CuratorMod | undefined;
  setTick: React.Dispatch<React.SetStateAction<number>>;
  setNote: (message: string | undefined) => void;
  setProgress: (message: string | undefined) => void;
  confirm: Confirmer;
  setSelected: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>;
  setFocusId: React.Dispatch<React.SetStateAction<string | undefined>>;
};

export function useCuratorActions(ctx: CuratorActionsContext) {
  const { api, session, busy, gameId, mods, report, requirements, endorsable, focusMod, setTick, setNote, setProgress, confirm, setSelected, setFocusId } = ctx;
  /** A question with two real answers besides Cancel. Returns the chosen label, or undefined. */
  const askThree = async (title: string, text: string, labels: [string, string]): Promise<string | undefined> => {
    const showDialog = (api as unknown as { showDialog?: unknown }).showDialog;
    if (typeof showDialog !== "function") return undefined;
    const result = (await (
      showDialog as (
        type: string,
        title: string,
        content: { text: string },
        actions: { label: string }[],
      ) => PromiseLike<{ action?: string } | undefined>
    )("question", title, { text }, [{ label: "Cancel" }, { label: labels[0] }, { label: labels[1] }])) as
      | { action?: string }
      | undefined;
    return result?.action === "Cancel" ? undefined : result?.action;
  };

  /** A run that throws outside its runner must not leave the session busy forever. */
  const guard = <A extends unknown[]>(label: string, fn: (...a: A) => Promise<void>) =>
    async (...a: A): Promise<void> => {
      try {
        await fn(...a);
      } catch (err) {
        ehLog("error", "curator.run.crash", { label, err });
        if (session.getSnapshot().busy !== undefined) {
          session.finish(undefined, `${label} stopped with an error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };

  const ext = api as unknown as EmitAndAwait;
  const nexus = React.useMemo(() => nexusExtOf(api), [api]);

  // ── Requirements ─────────────────────────────────────────────────────

  const readRequirements = guard("Reading requirements", async (incremental?: boolean): Promise<void> => {
    const game = gameId;
    if (game === undefined) return;
    const signal = session.begin("requirements", { keepReport: true });
    if (signal === undefined) return;
    try {
      // After an install only the NEW mods' pages are asked for; the button
      // re-reads everything.
      const previous =
        incremental === true && requirements !== undefined && Date.now() - requirements.fetchedAt < REUSE_MAX_AGE_MS
          ? requirements.load
          : undefined;
      const load = await loadRequirements({
        api,
        gameId: game,
        mods: readCuratorMods(api.getState(), game, readEnabledModIds(api.getState(), game)),
        signal,
        onProgress: setProgress,
        ...(previous === undefined ? {} : { previous }),
      });
      if (load.stopped) {
        // A partial report would show "0 missing" and "headers read" for
        // everything it never reached. Keep whatever was there before.
        session.finish(undefined, "Stopped before the requirements were fully read; the previous report, if any, is kept.");
        return;
      }
      session.setRequirements({ gameId: game, fetchedAt: Date.now(), load });
      const s = summarizeRequirements(load.report);
      session.finish(
        undefined,
        load.unavailable ??
          `Read requirements: ${num(load.answered)} of ${num(load.asked)} Nexus pages answered, ` +
            `${num(load.mastersRead)} plugin header(s) read. ` +
            `${num(s.modsWithMissing)} mod(s) are missing something; ` +
            `${num(s.installedDisabled)} requirement(s) are installed but disabled.`,
      );
    } catch (err) {
      ehLog("error", "curator.requirements.fail", { err });
      session.finish(
        undefined,
        `Could not read requirements: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  // Once per game, unasked: one batched call per fifty mods, and the column
  // is blank without it. A re-read is a button.
  const autoReadRef = React.useRef<string | undefined>(undefined);
  React.useEffect(() => {
    if (gameId === undefined || mods.length === 0) return;
    if (requirements !== undefined || autoReadRef.current === gameId) return;
    if (busy !== undefined) return;
    if (nexus.getModRequirements === undefined) return;
    autoReadRef.current = gameId;
    void readRequirements();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, mods.length, requirements, busy]);

  // ── "Make it work": the closure plan ─────────────────────────────────
  const [planState, setPlanState] = React.useState<
    | {
        rootName: string;
        plan: InstallPlan | undefined;
        files: PlannedFile[];
        picked: Record<string, number | undefined>;
        /** Mods to enable once the plan has run (the "enable, but make it work first" path). */
        thenEnable: CuratorMod[];
      }
    | undefined
  >(undefined);

  /**
   * Install one planned page and wait for Vortex to finish INSTALLING it.
   *
   * The step — the direct download, the guided fallback a refusal turns into,
   * and what Stop does while an install runs — is `installRequirementStep`;
   * this wires it to Vortex. `nexusDownload` wants the VORTEX game id (it
   * resolves with gameById).
   */
  const installOne = async (
    step: PlannedInstall,
    file: NexusFileInfo,
    signal: AbortSignal,
  ): Promise<RequirementStepResult> => {
    const game = gameId;
    const download = nexus.download;
    if (game === undefined || download === undefined || step.vortexGameId === undefined) {
      ehLog("warn", "curator.requirement.install.unavailable", {
        mod: step.name,
        nexusModId: step.nexusModId,
        game: game ?? null,
        vortexGameId: step.vortexGameId ?? null,
        downloadSurface: download !== undefined,
      });
      return { ok: false, why: "this Vortex cannot download for that game", refused: true, stopped: false, via: "download" };
    }
    const vortexGame = step.vortexGameId;
    return installRequirementStep({
      events: api.events as never,
      gameId: game,
      vortexGameId: vortexGame,
      name: step.name,
      nexusModId: step.nexusModId,
      file,
      premium: isPremium(api.getState()),
      readInstalled: installedIdentityReader(() => api.getState(), game),
      existingArchive: async () => {
        const probe = await existingArchiveFor(api.getState(), vortexGame, step.nexusModId, file.file_id, (p) =>
          fsp.stat(p).then(
            () => true,
            () => false,
          ),
        );
        if (probe.found !== undefined) {
          ehLog("info", "curator.requirement.install.existing-archive", {
            mod: step.name,
            nexusModId: step.nexusModId,
            fileId: file.file_id,
            dlId: probe.found.id,
            state: probe.found.state ?? null,
            onDisk: probe.onDisk,
            installable: probe.installable !== undefined,
          });
        }
        return probe.installable;
      },
      download,
      openPage: () => {
        if (nexus.openModPage !== undefined) nexus.openModPage(vortexGame, step.nexusModId, "nexus");
        setProgress(
          `Waiting for ${step.name}: its page is open — press "Mod manager download" on the file you want, and Vortex ` +
            `will install it. Stop ends the wait only while nothing has started downloading.`,
        );
      },
      pageDownloadIds: () => downloadIdsForPage(readDownloadRecords(api.getState()), step.nexusModId),
      signal,
    });
  };

  /**
   * Flip the ESL bit in a plugin's files: the staging copy (what the build
   * reads and what a purge restores from) and the deployed copy when it is a
   * different file. Under hardlink deployment they are one file.
   */
  const setLight = guard("Flagging a plugin", async (row: PluginRow, light: boolean): Promise<void> => {
    const game = gameId;
    if (game === undefined) return;
    const ok = await confirm({
      title: `${light ? "Set" : "Clear"} the ESL flag on ${row.plugin.name}?`,
      text:
        (light
          ? `This writes the light flag into the plugin file itself. It is only safe when every record the plugin adds ` +
            `fits the light range (FormIDs up to 0xFFF, one file's worth); Event Horizon cannot check that — xEdit can ` +
            `("Check for ESL support"). A plugin flagged light that does not qualify breaks in game silently.\n\n`
          : `This clears the light flag; the plugin takes one of the ${254} regular slots again.\n\n`) +
        `The change is written to the staging copy and to the deployed copy, and the build records it.`,
      confirmLabel: light ? "Flag light" : "Clear flag",
    });
    if (!ok) return;
    const paths = new Set<string>();
    if (row.plugin.filePath !== undefined) paths.add(row.plugin.filePath);
    const owner = row.owner;
    if (owner?.installationPath !== undefined) {
      const dir = stagingRootFromFolder(installRootFor(api.getState(), game), owner.installationPath);
      if (dir !== undefined) paths.add(`${dir}\\${row.plugin.name}`);
    }
    let changed = 0;
    const errors: string[] = [];
    for (const p of paths) {
      try {
        if (await setPluginLightFlag(p, light)) changed += 1;
      } catch (err) {
        errors.push(`${p}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    ehLog("info", "curator.plugin.set-light", { plugin: row.plugin.name, light, changed, errors: errors.length });
    setNote(
      `${row.plugin.name}: ${light ? "flagged light" : "flag cleared"} in ${num(changed)} file(s)` +
        (errors.length > 0 ? `; could not write ${errors.join("; ")}` : "") +
        `. Headers are re-read now.`,
    );
    void readRequirements(true);
  });

  /** Read the chain for a mod (or for one of its lines) and open the preview. */
  const openPlan = guard(
    "Planning an install",
    async (rootName: string, lines: readonly ModRequirement[], thenEnable: readonly CuratorMod[] = []): Promise<void> => {
      const game = gameId;
      const cache = requirements;
      if (game === undefined || cache === undefined) return;
      if (nexus.getModRequirements === undefined || nexus.getModFiles === undefined || nexus.download === undefined) {
        setNote("This Vortex build does not expose the Nexus download surface, so requirements have to be fetched from their mod pages.");
        return;
      }
      const signal = session.begin("install-requirement", { keepReport: true });
      if (signal === undefined) {
        setNote("Something else is still running — try again when it finishes.");
        return;
      }
      setPlanState({ rootName, plan: undefined, files: [], picked: {}, thenEnable: [...thenEnable] });
      setProgress(`Reading what ${rootName}'s requirements need themselves…`);
      try {
        const plan = await planRequirementClosure({
          rootName,
          roots: lines,
          mods,
          activeGame: game,
          games: cache.load.games,
          toDomain: nexusDomainForVortexGame,
          knownGameIds: knownGameIds(api.getState()),
          fetch: nexus.getModRequirements,
          report: cache.load.report,
          signal,
        });
        setProgress(`Asking Nexus which file each of ${num(plan.steps.length)} page(s) ships…`);
        const files = await resolveInstallFiles(plan.steps, nexus.getModFiles, signal);
        if (signal.aborted) {
          session.finish(undefined, "Stopped reading the chain; nothing was installed.");
          setPlanState(undefined);
          return;
        }
        session.finish(undefined);
        setPlanState({ rootName, plan, files, picked: {}, thenEnable: [...thenEnable] });
      } catch (err) {
        session.finish(undefined, `Could not plan the install: ${err instanceof Error ? err.message : String(err)}`);
        setPlanState(undefined);
      }
    },
  );

  /** The lines a plan for a mod starts from: its own report entry. */
  const linesOf = (m: CuratorMod): ModRequirement[] => requirements?.load.report.byMod.get(m.id)?.requirements ?? [];

  /** Run the previewed plan: downloads in order, each waited for, then the enables. */
  const runPlan = guard("Installing requirements", async (): Promise<void> => {
    const st = planState;
    if (st === undefined || st.plan === undefined) return;
    const signal = session.begin("install-requirement", { keepReport: false });
    if (signal === undefined) {
      setNote("Something else is still running — try again when it finishes.");
      return;
    }
    setPlanState(undefined);
    // The loop, and the rule for when the mod the plan is for comes on, live
    // in runRequirementPlan: a step skipped, a page unread or a chain cut
    // keeps it off, exactly like a step that failed.
    const { lines } = await runRequirementPlan({
      rootName: st.rootName,
      plan: st.plan,
      files: st.files,
      picked: st.picked,
      thenEnable: st.thenEnable,
      signal,
      installStep: (step, file) => installOne(step, file, signal),
      enableMods: (targets) => setEnabledFor(targets, true),
      onProgress: setProgress,
    });
    session.finish(lines);
    setTick((t) => t + 1);
    // The pool changed; only the new mods' pages are asked for.
    if (!signal.aborted) void readRequirements(true);
  });

  const installRequirement = (req: ModRequirement): void => {
    if (focusMod === undefined) return;
    void openPlan(focusMod.name, [req]);
  };

  /** Uninstall from the pool. The user's explicit choice, confirmed; archives stay (Disk cleanup lists them). */
  const removeMods = guard("Removing", async (targets: readonly CuratorMod[]): Promise<void> => {
    const game = gameId;
    if (game === undefined || targets.length === 0) return;
    const ids = new Set(targets.map((m) => m.id));
    const broken = report === undefined ? [] : dependantsOf(report, mods, ids);
    const ok = await confirm({
      title: `Remove ${num(targets.length)} mod(s) from this game?`,
      text:
        `Each is uninstalled from Vortex — its staging folder is deleted and it leaves every profile. ` +
        `Its archive stays in Downloads, so it can be installed again; Disk cleanup lists such archives.\n\n` +
        targets
          .slice(0, 10)
          .map((m) => `  • ${m.name}`)
          .join("\n") +
        (targets.length > 10 ? `\n  … and ${targets.length - 10} more` : "") +
        (broken.length > 0
          ? `\n\nSTILL NEEDED: ` +
            broken
              .slice(0, 6)
              .map((b) => `${b.provider.name} by ${b.dependants.map((d) => d.name).join(", ")}`)
              .join("; ") +
            `.`
          : ""),
      confirmLabel: "Remove",
    });
    if (!ok) return;
    const signal = session.begin("remove");
    if (signal === undefined) return;
    const lines: string[] = [];
    let n = 0;
    for (const m of targets) {
      if (signal.aborted) {
        lines.push(`Stopped before ${m.name}.`);
        break;
      }
      n += 1;
      setProgress(`Removing ${n} of ${targets.length} — ${m.name}`);
      try {
        await uninstallMod(api, { gameId: game, modId: m.id });
        lines.push(`Removed ${m.name}.`);
      } catch (err) {
        lines.push(`${m.name}: not removed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    ehLog("info", "curator.remove.done", { asked: targets.length, lines: lines.length, stopped: signal.aborted });
    session.finish(lines);
    setSelected((prev) => new Set([...prev].filter((id) => !ids.has(id))));
    setFocusId((f) => (f !== undefined && ids.has(f) ? undefined : f));
    setTick((t) => t + 1);
  });

  /** Install downloaded archives nothing was made from, one at a time, through Vortex's installer. */
  const installDownloads = guard("Installing downloads", async (entries: readonly DownloadEntry[]): Promise<void> => {
    const game = gameId;
    if (game === undefined || entries.length === 0) return;
    const signal = session.begin("install-download");
    if (signal === undefined) {
      setNote("Something else is still running — try again when it finishes.");
      return;
    }
    const lines: string[] = [];
    let n = 0;
    for (const d of entries) {
      if (signal.aborted) {
        lines.push(`Stopped before ${d.fileName}.`);
        break;
      }
      n += 1;
      setProgress(`Installing ${n} of ${entries.length} — ${d.fileName}`);
      try {
        // Stop means after this one. Vortex cannot cancel an install from
        // outside, so abandoning the wait would free the page while Vortex is
        // still writing — and let the next install start on top of it.
        const { vortexModId } = await installFromExistingDownload(api, { gameId: game, archiveId: d.id });
        lines.push(`Installed ${d.fileName} as ${vortexModId}.`);
      } catch (err) {
        lines.push(`${d.fileName}: not installed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    ehLog("info", "curator.install-download.done", { asked: entries.length, lines: lines.length, stopped: signal.aborted });
    session.finish(lines);
    setTick((t) => t + 1);
    if (!signal.aborted && requirements !== undefined) void readRequirements(true);
  });

  const saveNote = (m: CuratorMod, text: string): void => {
    if (gameId === undefined) return;
    api.store?.dispatch(vortexActions.setModAttribute(gameId, m.id, NOTES_ATTRIBUTE, text === "" ? undefined : text) as never);
    setTick((t) => t + 1);
  };

  /** Plugins: Vortex's own action, dispatched raw (verified against the plugin-management source). */
  const setPluginEnabled = (pluginName: string, enabled: boolean): void => {
    api.store?.dispatch({ type: "SET_PLUGIN_ENABLED", payload: { pluginName, enabled } } as never);
    ehLog("info", "curator.plugin.set-enabled", { pluginName, enabled });
    setTick((t) => t + 1);
  };

  const openPage = (req: ModRequirement): void => {
    if (req.nexusModId !== undefined && req.gameDomain !== undefined && nexus.openModPage !== undefined) {
      nexus.openModPage(req.gameDomain, req.nexusModId, "nexus");
      return;
    }
    if (req.url !== undefined) {
      void import("../../../core/revealPath").then(({ openExternalUrl }) => openExternalUrl(req.url as string));
    }
  };

  // ── Actions kept verbatim from the first version ──────────────────────

  const setFrozen = (mod: CuratorMod, version: string | undefined): void => {
    const { key, value } = freezeAttribute(version);
    api.store?.dispatch(vortexActions.setModAttribute(gameId!, mod.id, key, value) as never);
    setTick((t) => t + 1);
  };

  const refreshUpdates = async (): Promise<void> => {
    if (gameId === undefined) return;
    const byId = api.getState().persistent.mods[gameId] ?? {};
    if (ext.emitAndAwait === undefined) {
      setNote("This Vortex build does not expose emitAndAwait.");
      return;
    }
    if (session.begin("refresh", { keepReport: true }) === undefined) return;
    setNote("Asking Nexus about every mod — this takes a moment.");
    try {
      ehLog("info", "curator.recheck.start", { gameId, mods: Object.keys(byId).length });
      await ext.emitAndAwait("check-mods-version", gameId, byId, true);
      ehLog("info", "curator.recheck.ok", { gameId });
    } catch (err) {
      ehLog("error", "curator.recheck.fail", { err });
      session.finish(
        undefined,
        `Vortex could not check for updates: ${err instanceof Error ? err.message : String(err)}`,
      );
      setTick((t) => t + 1);
      return;
    }
    session.finish(undefined, "Nexus re-checked. The counts are current.");
    setTick((t) => t + 1);
  };

  const endorseAll = guard("Endorsing", async (): Promise<void> => {
    const game = gameId;
    if (game === undefined) return;
    if (endorseIsLong(endorsable.length)) {
      const ok = await confirm({
        title: `Endorse ${num(endorsable.length)} mods — ${describeEndorseDuration(endorsable.length)}?`,
        text:
          `Each one is sent to Nexus through Vortex and its answer is read back before the ` +
          `next is sent. Leave the page open while it runs; "Stop after this one" stops ` +
          `between mods.`,
        confirmLabel: "Endorse",
      });
      if (!ok) return;
    }
    const signal = session.begin("endorse", { keepReport: true });
    if (signal === undefined) return;
    const outcome = await endorseEach(endorsable, signal);
    setTick((t) => t + 1);
    session.finish(undefined, describeEndorse(outcome, endorsable.length, signal.aborted));
  });

  /**
   * Endorse a list, one at a time, reading Vortex's answer off the mod's
   * `endorsed` attribute. The status handed to Vortex is the mod's CURRENT
   * one: its handler toggles, so sending "Endorsed" asks Nexus to abstain.
   */
  const endorseEach = async (
    targets: readonly CuratorMod[],
    signal: AbortSignal,
  ): Promise<{ endorsed: number; failed: string[]; timedOut: string[]; sent: number }> => {
    const game = gameId!;
    let endorsed = 0;
    const failed: string[] = [];
    const timedOut: string[] = [];
    let sent = 0;
    const readStatus = (id: string): string | undefined =>
      (api.getState() as unknown as { persistent?: { mods?: Record<string, Record<string, { attributes?: { endorsed?: unknown } }>> } })
        ?.persistent?.mods?.[game]?.[id]?.attributes?.endorsed as string | undefined;
    for (const mod of targets) {
      if (signal.aborted) break;
      if (mod.nexusModId === undefined) continue;
      const before = readStatus(mod.id);
      api.events.emit("endorse-mod", game, mod.id, statusToSend(before));
      sent += 1;
      setProgress(`Endorsing ${sent} of ${targets.length} — ${mod.name}`);
      const result = await waitForEndorseOutcome({ read: () => readStatus(mod.id), before, timeoutMs: 15_000 });
      if (result === "endorsed") endorsed += 1;
      else if (result === "timeout") timedOut.push(mod.name);
      else failed.push(mod.name);
      // Nexus rate-limits; a short gap between answered requests is enough.
      await new Promise((r) => setTimeout(r, ENDORSE_PACE_MS));
    }
    ehLog("info", "curator.endorse.done", { asked: sent, endorsed, failed: failed.length, timedOut: timedOut.length, stopped: signal.aborted });
    return { endorsed, failed, timedOut, sent };
  };

  const describeEndorse = (o: { endorsed: number; failed: string[]; timedOut: string[]; sent: number }, asked: number, stopped: boolean): string =>
    `Endorsed ${num(o.endorsed)} of ${num(asked)} mod(s)` +
    (stopped ? " before you stopped it" : "") +
    (o.failed.length > 0 ? `; Nexus refused ${num(o.failed.length)} (${o.failed.slice(0, 5).join(", ")}${o.failed.length > 5 ? "…" : ""}) — Vortex's notifications say why` : "") +
    (o.timedOut.length > 0 ? `; ${num(o.timedOut.length)} gave no answer within 15 seconds and may still land` : "") +
    ".";

  const updateAll = guard("Updating", async (candidates: readonly WorkRow[]): Promise<void> => {
    const game = gameId;
    if (game === undefined) return;
    const signal = session.begin("update");
    if (signal === undefined) return;
    const installedIds = new Map<string, string>();
    const list = candidates
      .filter((r) => r.update !== undefined)
      .map((r) => ({
        mod: r.mod,
        fromVersion: r.update!.from,
        toVersion: r.update!.to,
        fromFileId: r.mod.nexusFileId ?? 0,
        toFileId: r.update!.toFileId,
      }));
    ehLog("info", "curator.bulk-update.start", { candidates: list.length, gameId: game });
    const startedAt = Date.now();
    const report = await runBulkUpdate({
      candidates: list,
      signal,
      onProgress: (n, total, m) => setProgress(`Updating ${n + 1} of ${total} — ${m.name}`),
      update: async (candidate) => {
        const newModId = await updateOneAndWait({
          events: api.events as never,
          gameId: game,
          nexusModId: candidate.mod.nexusModId!,
          toFileId: candidate.toFileId,
          readInstalled: installedIdentityReader(() => api.getState(), game),
          start: () => {
            const source = "nexus";
            const downloadGame = candidate.mod.downloadGame ?? game;
            ehLog("info", "curator.update.start", {
              mod: candidate.mod.name,
              nexusModId: candidate.mod.nexusModId,
              fromFileId: candidate.fromFileId,
              toFileId: candidate.toFileId,
              downloadGame,
            });
            api.events.emit(
              "mod-update",
              downloadGame,
              candidate.mod.nexusModId!,
              candidate.toFileId,
              source,
            );
          },
        });
        installedIds.set(candidate.mod.id, newModId);
      },
      verify: async (m) =>
        verifyUpdatedMod({
          state: api.getState(),
          gameId: game,
          vortexModId: installedIds.get(m.id) ?? m.id,
        }),
    });
    ehLog("info", "curator.bulk-update.done", {
      ms: Date.now() - startedAt,
      cancelled: report.cancelled,
      halted: report.halted,
      notAttempted: report.notAttempted,
      outcomes: report.outcomes.reduce<Record<string, number>>((acc, o) => {
        acc[o.kind] = (acc[o.kind] ?? 0) + 1;
        return acc;
      }, {}),
    });
    session.finish(describeBulkUpdate(report));
    const consumed = new Set(list.map((c) => c.mod.id));
    setSelected((prev) => new Set([...prev].filter((id) => !consumed.has(id))));
    setTick((t) => t + 1);
  });

  const reinstall = guard("Reinstalling", async (requested: readonly CuratorMod[]): Promise<void> => {
    const game = gameId;
    if (game === undefined || requested.length === 0) return;
    // Vortex recording an archive id is not the archive being on disk: an
    // in-place update leaves the mod pointing at a dead download record. A
    // reinstall UNINSTALLS first, so a mod whose archive is not actually there
    // is refused here, before anything is removed (NS-2).
    const state0 = api.getState();
    const targets: CuratorMod[] = [];
    const noArchive: CuratorMod[] = [];
    for (const m of requested) {
      const full = getModArchivePath(state0, m.archiveId, game);
      if (full === undefined) {
        noArchive.push(m);
        continue;
      }
      try {
        await fsp.stat(full);
        targets.push(m);
      } catch {
        noArchive.push(m);
      }
    }
    if (targets.length === 0) {
      setNote(
        `None of the ${num(requested.length)} ticked mod(s) has its archive on disk, so none can be reinstalled — ` +
          `re-download them from their mod pages first. Nothing was uninstalled.`,
      );
      return;
    }
    const skippedText =
      noArchive.length === 0
        ? ""
        : `\n\nSKIPPED, archive not on disk (nothing happens to these): ` +
          noArchive
            .slice(0, 8)
            .map((m) => m.name)
            .join(", ") +
          (noArchive.length > 8 ? ` and ${noArchive.length - 8} more` : "") +
          `.`;
    const ok = await confirm({
      title: `Uninstall and reinstall ${num(targets.length)} mod(s)?`,
      text:
        `Each one is UNINSTALLED and then installed again from its archive, ` +
        `one at a time. Everything Vortex would otherwise lose — the FOMOD ` +
        `answers, the mod type, whether it is enabled, any freeze — is read ` +
        `first and put back after.\n\n` +
        `If an install fails after the removal, that mod is gone from your ` +
        `setup until you install it again from Downloads. The report says ` +
        `exactly which, if any.` +
        skippedText,
      confirmLabel: "Reinstall",
    });
    if (!ok) return;
    const signal = session.begin("reinstall");
    if (signal === undefined) return;
    const installedIds = new Map<string, string>();
    const removed = new Set<string>();
    const enabledNow = readEnabledModIds(state0, game);

    const report = await runSequentially<CuratorMod>({
      items: targets,
      onProgress: (n, total, m) => setProgress(`Reinstalling ${n + 1} of ${total} — ${m.name}`),
      act: async (m) => {
        const preserved = captureForReinstall(api.getState(), game, m.id, enabledNow, FROZEN_ATTRIBUTE);
        await uninstallMod(api, { gameId: game, modId: m.id });
        removed.add(m.id);
        const { vortexModId } = await installFromExistingDownload(api, {
          gameId: game,
          ...reinstallArgs(preserved),
        } as never);
        installedIds.set(m.id, vortexModId);

        const fresh = readCuratorMods(api.getState(), game, new Set()).find((x) => x.id === vortexModId);
        const restore = restorationFor(preserved, { modType: fresh?.modType ?? "" });
        if (restore.setModType !== undefined) {
          api.store?.dispatch(vortexActions.setModType(game, vortexModId, restore.setModType) as never);
        }
        if (restore.setFrozenAtVersion !== undefined) {
          api.store?.dispatch(
            vortexActions.setModAttribute(game, vortexModId, FROZEN_ATTRIBUTE, restore.setFrozenAtVersion) as never,
          );
        }
        const profileId = (
          api.getState() as unknown as { settings?: { profiles?: { activeProfileId?: string } } }
        )?.settings?.profiles?.activeProfileId;
        if (profileId !== undefined) {
          api.store?.dispatch(vortexActions.setModEnabled(profileId, vortexModId, restore.enable) as never);
        }
      },
      verify: async (m) =>
        verifyUpdatedMod({
          state: api.getState(),
          gameId: game,
          vortexModId: installedIds.get(m.id) ?? m.id,
        }),
      signal,
    });

    session.finish(
      describeBulkUpdate({
        cancelled: report.cancelled,
        notAttempted: report.notAttempted,
        ...(report.halted === undefined ? {} : { halted: report.halted }),
        outcomes: report.outcomes.map((o) =>
          o.kind === "done"
            ? { kind: "updated" as const, mod: o.item }
            : o.kind === "files-dropped"
              ? { kind: "files-dropped" as const, mod: o.item, missing: o.missing }
              : o.kind === "failed"
                ? // A failure AFTER the uninstall is not "did not update" —
                  removed.has(o.item.id)
                  ? { kind: "removed-not-reinstalled" as const, mod: o.item, why: o.why }
                  : { kind: "failed" as const, mod: o.item, why: o.why }
                : { kind: "unverified" as const, mod: o.item, why: o.why },
        ),
      }),
      noArchive.length === 0
        ? undefined
        : `${num(noArchive.length)} mod(s) were skipped because their archive is not on disk; they were not touched.`,
    );
    const done = new Set(targets.map((m) => m.id));
    setSelected((prev) => new Set([...prev].filter((id) => !done.has(id))));
    setTick((t) => t + 1);
  });

  const setEnabledFor = (targets: readonly CuratorMod[], to: boolean): void => {
    const profileId = (
      api.getState() as unknown as { settings?: { profiles?: { activeProfileId?: string } } }
    )?.settings?.profiles?.activeProfileId;
    const changes = planEnableChanges(targets, to);
    setNote(describeEnableChanges(changes));
    if (profileId === undefined) return;
    for (const change of changes) {
      api.store?.dispatch(vortexActions.setModEnabled(profileId, change.mod.id, change.to) as never);
    }
    setTick((t) => t + 1);
  };

  /**
   * Enable, and offer the requirements that are installed but off.
   *
   * The requirements report knows which providers a mod needs and that they
   * are one click from working; enabling a mod without them reproduces the
   * "everything is enabled and it still does not load" report.
   */
  const enableWithProviders = async (targets: readonly CuratorMod[]): Promise<void> => {
    const ids = new Set(targets.map((m) => m.id));
    const providers = report === undefined ? [] : disabledProvidersFor(report, mods, ids);
    // Settled: a still-missing requirement offers "Make it work" first; the
    // curator can enable anyway.
    const missingLines = targets.flatMap((m) =>
      linesOf(m).filter((q) => q.status === "missing" && q.nexusModId !== undefined && q.vortexGameId !== undefined),
    );
    if (missingLines.length > 0 && nexus.download !== undefined) {
      const names = [...new Set(missingLines.map((q) => q.name))];
      const answer = await askThree(
        `${targets.length === 1 ? targets[0]!.name : `${num(targets.length)} mods`} still need${targets.length === 1 ? "s" : ""} ${num(names.length)} thing(s) that are not installed`,
        names
          .slice(0, 10)
          .map((n) => `  • ${n}`)
          .join("\n") +
          (names.length > 10 ? `\n  … and ${names.length - 10} more` : "") +
          `\n\n"Make it work" reads the whole chain, shows the plan, installs it, then enables. "Enable anyway" enables now and leaves the gaps.`,
        ["Enable anyway", "Make it work"],
      );
      if (answer === undefined) return;
      if (answer === "Make it work") {
        void openPlan(targets.length === 1 ? targets[0]!.name : `${num(targets.length)} mods`, targets.flatMap(linesOf), targets);
        return;
      }
    }
    setEnabledFor([...targets, ...providers], true);
    if (providers.length > 0) {
      setNote(
        `Enabled ${num(targets.length)} mod(s) and ${num(providers.length)} requirement(s) they list that were installed but off: ` +
          providers
            .slice(0, 12)
            .map((p) => p.name)
            .join(", ") +
          (providers.length > 12 ? ` and ${providers.length - 12} more` : "") +
          `.`,
      );
    }
  };

  /** Disable, after saying what depends on it. */
  const disableWithDependants = async (targets: readonly CuratorMod[]): Promise<void> => {
    const ids = new Set(targets.map((m) => m.id));
    const broken = report === undefined ? [] : dependantsOf(report, mods, ids);
    if (broken.length > 0) {
      const dependants = [...new Map(broken.flatMap((b) => b.dependants).map((d) => [d.id, d])).values()];
      const answer = await askThree(
        `${num(broken.length)} of these are needed by ${num(dependants.length)} other mod(s)`,
        broken
          .slice(0, 10)
          .map((b) => `  • ${b.provider.name} — needed by ${b.dependants.map((d) => d.name).join(", ")}`)
          .join("\n") +
          (broken.length > 10 ? `\n  … and ${broken.length - 10} more` : "") +
          `\n\n"Disable only these" leaves the dependants on and missing something. "Disable dependants too" takes the ${num(dependants.length)} down with them.`,
        ["Disable only these", "Disable dependants too"],
      );
      if (answer === undefined) return;
      if (answer === "Disable dependants too") {
        setEnabledFor([...targets, ...dependants.filter((d) => !ids.has(d.id))], false);
        return;
      }
    }
    setEnabledFor(targets, false);
  };

  const setTypeFor = (targets: readonly CuratorMod[], to: string): void => {
    const game = gameId;
    if (game === undefined) return;
    const changes = planTypeChanges(targets, to);
    setNote(describeTypeChanges(changes));
    for (const change of changes) {
      api.store?.dispatch(vortexActions.setModType(game, change.mod.id, change.to) as never);
    }
    setTick((t) => t + 1);
  };

  const applyCleanup = guard("Cleanup", async (plan: CleanupPlan): Promise<void> => {
    const game = gameId;
    if (game === undefined) return;
    const signal = session.begin("cleanup");
    if (signal === undefined) return;
    const outcome = await runCleanup({
      plan,
      signal,
      onProgress: (n, total, what) => setProgress(`${what} (${n + 1}/${total})`),
      removeMod: async (vortexModId) => {
        await uninstallMod(api, { gameId: game, modId: vortexModId });
      },
      deleteArchive: async (dlEntry) => {
        const full = getModArchivePath(api.getState(), dlEntry.id, game);
        if (full === undefined) {
          throw new Error("its path on disk could not be resolved");
        }
        try {
          await fsp.stat(full);
        } catch {
          throw new Error(
            `no file at the path Vortex gives for it (${full}) — the ` +
              `download record was left alone rather than dropped for a ` +
              `file that may still be on disk somewhere else`,
          );
        }
        await fsp.rm(full, { force: true });
        try {
          api.store?.dispatch(vortexActions.removeDownload(dlEntry.id) as never);
        } catch {
          /* the file is gone; a stale download record is the lesser evil */
        }
      },
    });
    session.finish(describeCleanupOutcome(outcome));
    setTick((t) => t + 1);
  });


  return {
    askThree,
    guard,
    nexus,
    readRequirements,
    autoReadRef,
    installOne,
    setLight,
    openPlan,
    linesOf,
    runPlan,
    installRequirement,
    removeMods,
    installDownloads,
    saveNote,
    setPluginEnabled,
    openPage,
    setFrozen,
    refreshUpdates,
    endorseAll,
    endorseEach,
    describeEndorse,
    updateAll,
    reinstall,
    setEnabledFor,
    enableWithProviders,
    disableWithDependants,
    setTypeFor,
    applyCleanup,
    planState,
    setPlanState,
  };
}
