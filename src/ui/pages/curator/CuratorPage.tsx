/**
 * ──────────────────────────────────────────────────────────────────────
 * Curator Tools: the workbench.
 *
 * One list of mods, one selection, one row of actions that follows it.
 *
 * The first version of this page was six cards, each with its own table,
 * its own tick set and its own buttons — the same mod could be ticked in
 * three places meaning three different things, and the action for a row sat
 * a screen away from the row. The user's words: counter-intuitive, not
 * friendly. Now:
 *
 *   - the STATUS STRIP says what needs doing;
 *   - a row of VIEW chips filters the same rows (updates, frozen, missing
 *     requirements, duplicates …) — a chip only appears when it has
 *     something;
 *   - the TABLE is the same table in every view, so a tick means the same
 *     thing everywhere;
 *   - the ACTION BAR sticks to the bottom while something is ticked and
 *     offers only what applies;
 *   - DETAILS opens a mod's requirements and dependants in a panel with the
 *     one right action per line.
 *
 * Every long action still runs one mod at a time and survives a tab switch
 * (`curatorSession`). Nothing here deletes without a confirmation dialog.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fsp from "fs/promises";

import * as React from "react";
import { actions as vortexActions, selectors, util } from "@nexusmods/vortex-api";

import {
  findEndorsable,
  summarizeProfile,
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
import { getModArchivePath } from "../../../core/archiveHashing";
import { describeBulkUpdate, runBulkUpdate } from "../../../core/curator/bulkUpdate";
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
import { runSequentially } from "../../../core/curator/runSequentially";
import {
  ENDORSE_PACE_MS,
  describeEndorseDuration,
  endorseIsLong,
} from "../../../core/curator/endorsePace";
import { planCleanup, type CleanupPlan, type DownloadEntry } from "../../../core/curator/cleanupPlan";
import {
  describeCleanupOutcome,
  readDownloads,
  runCleanup,
} from "../../../core/curator/runCleanup";
import { FROZEN_ATTRIBUTE, NOTES_ATTRIBUTE } from "../../../core/curator/readProfile";
import {
  installedIdentityReader,
  updateOneAndWait,
} from "../../../core/curator/updateOneMod";
import { verifyUpdatedMod } from "../../../core/curator/verifyAfterUpdate";
import {
  dependantsOf,
  disabledProvidersFor,
  pickInstallFile,
  requirementCellCategory,
  summarizeRequirements,
  type ModRequirement,
  type NexusFileInfo,
} from "../../../core/curator/requirements";
import {
  Button,
  Callout,
  Card,
  Checkbox,
  Chip,
  DataTable,
  Field,
  Input,
  LinkButton,
  Menu,
  Modal,
  Page,
  Pill,
  Radio,
  Select,
  StatGrid,
  StatTile,
  type Column,
} from "../../components";
import { useApi } from "../../state";
import { ErrorBoundary } from "../../errors";
import { ehLog } from "../../../core/logging/ehLog";
import { getCuratorSession, type CuratorSnapshot } from "./curatorSession";
import { DiskCleanupView, type Confirmer } from "./DiskCleanupView";
import { DownloadsView } from "./DownloadsView";
import { RequirementsPanel } from "./RequirementsPanel";
import { PluginsView } from "./PluginsView";
import { InstallPlanModal } from "./InstallPlanModal";
import {
  fileForStep,
  planRequirementClosure,
  resolveInstallFiles,
  type InstallPlan,
  type PlannedFile,
  type PlannedInstall,
} from "../../../core/curator/installPlan";
import { readPluginList } from "../../../core/curator/pluginPool";
import { buildPluginRows } from "../../../core/curator/pluginView";
import { isBaseGameMaster } from "../../../core/manifest/pluginMasters";
import { knownGameIds, loadRequirements, nexusDomainForVortexGame, nexusExtOf } from "./requirementsIo";
import {
  VIEWS,
  buildRows,
  describeRowState,
  matchesSearch,
  rowsForViews,
  viewCounts,
  visibleViews,
  type ViewId,
  type ViewOptions,
  type WorkRow,
} from "./workbench";

type EmitAndAwait = {
  emitAndAwait?: (event: string, ...args: unknown[]) => PromiseLike<unknown>;
};

/**
 * One store subscription for the page, however often it mounts.
 *
 * The page reads Vortex only when `tick` changes, so a profile switch made
 * from Vortex's own toolbar while this page is open would leave it acting on
 * the OLD game's mods. `api.onStateChange` has no unsubscribe, so it is
 * registered once per process and fanned out to whichever page is mounted.
 */
const profileListeners = new Set<() => void>();
let profileWatched = false;
function watchActiveProfile(api: { onStateChange?: (path: string[], cb: () => void) => void }, fn: () => void): () => void {
  profileListeners.add(fn);
  if (!profileWatched && typeof api.onStateChange === "function") {
    profileWatched = true;
    api.onStateChange(["settings", "profiles", "activeProfileId"], () => {
      for (const l of profileListeners) l();
    });
  }
  return () => {
    profileListeners.delete(fn);
  };
}

/** Which runs honour Stop. The others are single Vortex calls with no checkpoint. */
const STOPPABLE = new Set<string>(["requirements", "endorse", "update", "reinstall", "cleanup", "remove", "install-download"]);

/** Mod types the game registers, for the kind selector. Empty when Vortex cannot say. */
function registeredModTypes(gameId: string): string[] {
  try {
    const getGame = (util as unknown as { getGame?: (id: string) => { modTypes?: Array<{ typeId?: unknown }> } | undefined }).getGame;
    const types = typeof getGame === "function" ? getGame(gameId)?.modTypes ?? [] : [];
    return types.map((t) => t.typeId).filter((t): t is string => typeof t === "string" && t !== "").sort();
  } catch {
    return [];
  }
}

const num = (n: number): string => n.toLocaleString();

function makeConfirmer(
  api: { showDialog?: (...args: never[]) => PromiseLike<unknown> },
  onRefused: (why: string) => void,
): Confirmer {
  return async ({ title, text, confirmLabel }) => {
    if (typeof api.showDialog !== "function") {
      ehLog("error", "curator.confirm.unavailable", { title });
      onRefused(
        "This Vortex build does not expose showDialog, so this cannot be " +
          "confirmed — and nothing that deletes files runs here unconfirmed. " +
          "Do it from Vortex's own Mods and Downloads tabs instead.",
      );
      return false;
    }
    ehLog("info", "curator.confirm.ask", { title });
    const result = (await (
      api.showDialog as unknown as (
        type: string,
        title: string,
        content: { text: string },
        actions: { label: string }[],
      ) => PromiseLike<{ action?: string } | undefined>
    )("question", title, { text }, [
      { label: "Cancel" },
      { label: confirmLabel },
    ])) as { action?: string } | undefined;
    const said = result?.action === confirmLabel;
    ehLog("info", "curator.confirm.answer", { title, confirmed: said });
    return said;
  };
}

// ── The one table ──────────────────────────────────────────────────────

const kindOf = (mod: CuratorMod): string => (mod.modType === "" ? "default" : mod.modType);

const rowId = (r: WorkRow): string => r.mod.id;

const WORK_COLUMNS: Column<WorkRow>[] = [
  {
    key: "name",
    header: "Mod",
    value: (r) => r.mod.name,
    render: (r) => (
      <span title={r.mod.notes}>
        {r.mod.name}
        {r.mod.notes !== undefined && r.mod.notes !== "" && (
          <span className="eh-muted eh-small"> · note</span>
        )}
      </span>
    ),
  },
  {
    key: "version",
    header: "Version",
    width: 170,
    value: (r) => r.mod.version ?? "",
    render: (r) => (
      <span>
        {r.mod.version ?? <span className="eh-muted">unknown</span>}
        {r.update !== undefined && (
          <span className="eh-tone--warning"> → {r.update.to}</span>
        )}
        {r.manual !== undefined && (
          <span className="eh-tone--warning" title="Newer on Nexus; update from the mod page">
            {" "}
            → {r.manual.to} (manual)
          </span>
        )}
      </span>
    ),
  },
  {
    key: "state",
    header: "State",
    match: "exact",
    width: 200,
    value: describeRowState,
    render: (r) => {
      const s = describeRowState(r);
      const intent =
        r.frozen?.driftedTo !== undefined
          ? "danger"
          : r.frozen !== undefined
            ? "info"
            : r.update !== undefined || r.manual !== undefined
              ? "warning"
              : r.mod.enabled
                ? "success"
                : "neutral";
      return (
        <Pill intent={intent} plain>
          {s}
        </Pill>
      );
    },
  },
  { key: "kind", header: "Kind", match: "exact", width: 110, value: (r) => kindOf(r.mod) },
  {
    key: "requirements",
    header: "Requires",
    match: "exact",
    width: 150,
    // The filter is a category ("missing", "disabled", "ok", "not checked");
    // the cell shows the counts.
    value: (r) => requirementCellCategory(r.requirements),
    render: (r) =>
      r.requirementCell === "" ? (
        <span className="eh-muted">—</span>
      ) : r.requirementCell === "ok" ? (
        <span className="eh-tone--success">ok</span>
      ) : r.requirementCell === "not checked" ? (
        <span className="eh-muted">not checked</span>
      ) : (
        <span className="eh-tone--warning">{r.requirementCell}</span>
      ),
  },
];

/** The Required-by column opens the mod's panel; it needs the page's focus setter. */
function requiredByColumn(onFocus: (modId: string) => void): Column<WorkRow> {
  return {
    key: "requiredBy",
    header: "Needed by",
    numeric: true,
    align: "right",
    width: 110,
    value: (r) => r.requiredBy.length,
    render: (r) =>
      r.requiredBy.length === 0 ? (
        <span className="eh-muted">—</span>
      ) : (
        <LinkButton onClick={(): void => onFocus(r.mod.id)} title="Open the list of mods that need this one">
          {r.requiredBy.length}
        </LinkButton>
      ),
  };
}

// ── The page ───────────────────────────────────────────────────────────

function CuratorBody(): JSX.Element {
  const api = useApi();
  const [tick, setTick] = React.useState(0);

  const session = React.useMemo(() => getCuratorSession(), []);
  const [run, setRun] = React.useState<CuratorSnapshot>(() => session.getSnapshot());
  React.useEffect(() => {
    setRun(session.getSnapshot());
    return session.subscribe(setRun);
  }, [session]);
  const busy = run.busy;
  const progress = run.progress;
  const lines = run.lines;
  const note = run.note;
  const setNote = (message: string | undefined): void => session.say(message);
  const setProgress = (message: string | undefined): void => session.progress(message);
  const confirm = React.useMemo(
    () => makeConfirmer(api as never, (why) => session.say(why)),
    [api, session],
  );

  const gameId = React.useMemo(() => {
    const state = api.getState();
    try {
      const fromSelector = selectors.activeGameId(state);
      if (typeof fromSelector === "string" && fromSelector !== "") return fromSelector;
    } catch {
      /* fall through to the profile's own game */
    }
    const settings = state as unknown as {
      settings?: { profiles?: { activeProfileId?: string } };
      persistent?: { profiles?: Record<string, { gameId?: string }> };
    };
    const activeProfileId = settings?.settings?.profiles?.activeProfileId;
    if (activeProfileId === undefined) return undefined;
    return settings?.persistent?.profiles?.[activeProfileId]?.gameId;
  }, [api, tick]);

  const mods = React.useMemo<CuratorMod[]>(() => {
    if (gameId === undefined) return [];
    const state = api.getState();
    return readCuratorMods(state, gameId, readEnabledModIds(state, gameId));
    // `tick` is the refresh handle: every action bumps it so the view re-reads
    // Vortex rather than trusting a copy it mutated itself.
  }, [api, gameId, tick]);

  const summary = React.useMemo(() => summarizeProfile(mods), [mods]);
  const endorsable = React.useMemo(() => findEndorsable(mods), [mods]);
  const downloads = React.useMemo<readonly DownloadEntry[]>(
    () => (gameId === undefined ? [] : readDownloads(api.getState(), gameId)),
    [api, gameId, tick],
  );

  // The requirements report is the session's: it outlives this component.
  const requirements =
    run.requirements !== undefined && run.requirements.gameId === gameId ? run.requirements : undefined;
  const report = requirements?.load.report;
  // Settled with the user: a disabled mod's missing requirement is not
  // tonight's problem. The toggle brings them in.
  const [includeDisabledReqs, setIncludeDisabledReqs] = React.useState(false);
  const viewOpts = React.useMemo<ViewOptions>(() => ({ includeDisabled: includeDisabledReqs }), [includeDisabledReqs]);
  const reqSummary = React.useMemo(
    () =>
      report === undefined
        ? undefined
        : summarizeRequirements(
            report,
            includeDisabledReqs ? {} : { onlyModIds: new Set(mods.filter((m) => m.enabled).map((m) => m.id)) },
          ),
    [report, mods, includeDisabledReqs],
  );

  const rows = React.useMemo(() => buildRows(mods, report), [mods, report]);
  const counts = React.useMemo(() => viewCounts(rows, viewOpts), [rows, viewOpts]);
  const chips = React.useMemo(() => visibleViews(counts), [counts]);

  // Views compose: every active chip is another filter over the same rows
  // ("updatable AND frozen"). An empty set is All mods. The other modes
  // (plugins, downloads, disk) show different rows altogether.
  const [mode, setMode] = React.useState<"table" | "disk" | "plugins" | "downloads">("table");
  const [views, setViews] = React.useState<ReadonlySet<ViewId>>(new Set());
  const tableView = mode === "table";
  const [query, setQuery] = React.useState("");
  const modNameById = React.useMemo(() => new Map(mods.map((m) => [m.id, m.name])), [mods]);
  const searched = React.useMemo(
    () => (query.trim() === "" ? rows : rows.filter((r) => matchesSearch(r, query, modNameById))),
    [rows, query, modNameById],
  );
  const visibleRows = React.useMemo(
    () => (tableView ? rowsForViews(searched, views, viewOpts) : []),
    [searched, views, tableView, viewOpts],
  );
  const activeSpecs = React.useMemo(() => VIEWS.filter((v) => views.has(v.id)), [views]);
  const toggleView = (id: ViewId): void => {
    setMode("table");
    setViews((prev) => {
      if (id === "all") return new Set();
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  // A view that emptied under the user (every update taken) drops out.
  React.useEffect(() => {
    const gone = [...views].filter((v) => counts[v] === 0);
    if (gone.length > 0) setViews((prev) => new Set([...prev].filter((v) => counts[v] > 0)));
  }, [views, counts]);
  const view = mode === "table" ? (views.size === 1 ? [...views][0]! : views.size === 0 ? "all" : "several") : mode;
  void view;

  // Downloads with no installed version: what Disk cleanup refuses to
  // touch, and what this page can install.
  const notInstalled = React.useMemo<DownloadEntry[]>(
    () => planCleanup({ mods, downloads }).unclearOrphans.map((o) => o.entry),
    [mods, downloads],
  );

  // The plugin list is Vortex's; the headers come with the requirements pass.
  const plugins = React.useMemo(
    () => (requirements?.load.plugins ?? readPluginList(api.getState())),
    [api, tick, requirements],
  );
  const pluginRows = React.useMemo(
    () =>
      gameId === undefined
        ? []
        : buildPluginRows({
            plugins,
            headers: requirements?.load.headers ?? new Map(),
            mods,
            isBaseGame: (m) => isBaseGameMaster(m, gameId),
          }),
    [plugins, requirements, mods, gameId],
  );

  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const chosen = React.useMemo(() => mods.filter((m) => selected.has(m.id)), [mods, selected]);
  const chosenRows = React.useMemo(() => rows.filter((r) => selected.has(r.mod.id)), [rows, selected]);
  const [typeValue, setTypeValue] = React.useState("");
  const [focusId, setFocusId] = React.useState<string | undefined>(undefined);
  const focusMod = focusId === undefined ? undefined : mods.find((m) => m.id === focusId);
  const columns = React.useMemo(() => [...WORK_COLUMNS, requiredByColumn(setFocusId)], []);
  const modTypes = React.useMemo(() => (gameId === undefined ? [] : registeredModTypes(gameId)), [gameId]);

  // A profile switch from Vortex's toolbar: re-read, and drop what pointed at
  // the old game's mods.
  React.useEffect(
    () =>
      watchActiveProfile(api as never, () => {
        setTick((t) => t + 1);
        setSelected(new Set());
        setFocusId(undefined);
      }),
    [api],
  );

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
      const previous = incremental === true && requirements !== undefined ? requirements.load : undefined;
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
   * Download one planned page and wait for Vortex to finish INSTALLING it.
   *
   * `nexusDownload` wants the VORTEX game id (it resolves with gameById) and
   * resolves when the download lands — Vortex installs after that, so the
   * wait is on `did-install-mod`, or a sequential update could start on top
   * of a live install. Vortex swallows its own refusals (not Premium, not
   * logged in) into a notification and resolves undefined.
   */
  const installOne = async (
    step: PlannedInstall,
    file: NexusFileInfo,
    signal: AbortSignal,
  ): Promise<{ ok: true; newModId: string } | { ok: false; why: string; refused: boolean }> => {
    const game = gameId;
    const download = nexus.download;
    if (game === undefined || download === undefined || step.vortexGameId === undefined) {
      return { ok: false, why: "this Vortex cannot download for that game", refused: true };
    }
    const vortexGame = step.vortexGameId;
    ehLog("info", "curator.requirement.install.start", { mod: step.name, nexusModId: step.nexusModId, fileId: file.file_id, game: vortexGame });
    const stop = new AbortController();
    const onAbort = (): void => stop.abort();
    signal.addEventListener("abort", onAbort);
    let refused = false;
    try {
      const newModId = await updateOneAndWait({
        events: api.events as never,
        gameId: game,
        nexusModId: step.nexusModId,
        toFileId: file.file_id,
        readInstalled: installedIdentityReader(() => api.getState(), game),
        signal: stop.signal,
        start: () => {
          void download(vortexGame, step.nexusModId, file.file_id, file.file_name, true).then(
            (dlId) => {
              ehLog("info", "curator.requirement.install.downloaded", { mod: step.name, dlId });
              if (dlId === undefined) {
                refused = true;
                stop.abort();
              }
            },
            (err) => {
              ehLog("error", "curator.requirement.install.fail", { mod: step.name, err });
              refused = true;
              stop.abort();
            },
          );
        },
      });
      ehLog("info", "curator.requirement.install.done", { mod: step.name, newModId });
      return { ok: true, newModId };
    } catch (err) {
      return { ok: false, why: err instanceof Error ? err.message : String(err), refused };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  };

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
          signal,
        });
        setProgress(`Asking Nexus which file each of ${num(plan.steps.length)} page(s) ships…`);
        const files = await resolveInstallFiles(plan.steps, nexus.getModFiles, signal);
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
    const lines: string[] = [];
    let n = 0;
    const todo = st.files.filter((pf) => pf.step.vortexGameId !== undefined && fileForStep(pf, st.picked) !== undefined);
    ehLog("info", "curator.requirement.plan.start", { root: st.rootName, installs: todo.length, enables: st.plan.toEnable.length });
    for (const pf of todo) {
      if (signal.aborted) {
        lines.push(`Stopped before ${pf.step.name}.`);
        break;
      }
      n += 1;
      setProgress(`Installing ${n} of ${todo.length} — ${pf.step.name}`);
      const file = fileForStep(pf, st.picked)!;
      const result = await installOne(pf.step, file, signal);
      if (result.ok) {
        lines.push(`Installed ${pf.step.name} (${file.name ?? file.file_name ?? `file ${file.file_id}`}).`);
      } else if (result.refused) {
        lines.push(
          `${pf.step.name}: Vortex did not download it — its own notification says why. Nexus only lets Vortex fetch files ` +
            `directly for Premium members; otherwise open the page and use "Mod manager download", which lands in Vortex.`,
        );
      } else {
        lines.push(`${pf.step.name}: did not finish installing — ${result.why}.`);
      }
    }
    const toEnable = [...st.plan.toEnable, ...st.thenEnable.filter((m) => !st.plan!.toEnable.some((p) => p.id === m.id))];
    if (toEnable.length > 0 && !signal.aborted) {
      setEnabledFor(toEnable, true);
      lines.push(`Enabled ${toEnable.map((m) => m.name).join(", ")}.`);
    }
    const skipped = st.files.filter((pf) => !todo.includes(pf));
    if (skipped.length > 0) lines.push(`Not installed (no file chosen, no current file, or another game): ${skipped.map((pf) => pf.step.name).join(", ")}.`);
    ehLog("info", "curator.requirement.plan.done", { root: st.rootName, lines: lines.length, stopped: signal.aborted });
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
        const { vortexModId } = await installFromExistingDownload(api, { gameId: game, archiveId: d.id, signal });
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
          `Vortex gives no way to confirm an endorsement finished, so they are sent ` +
          `${ENDORSE_PACE_MS}ms apart — sending them all at once is a rate limit, not a ` +
          `faster result. Leave the page open while it runs; "Stop after this one" ` +
          `stops between mods.`,
        confirmLabel: "Endorse",
      });
      if (!ok) return;
    }
    const signal = session.begin("endorse", { keepReport: true });
    if (signal === undefined) return;
    let done = 0;
    for (const mod of endorsable) {
      if (signal.aborted) break;
      if (mod.nexusModId === undefined) continue;
      api.events.emit("endorse-mod", game, mod.id, "Endorsed");
      done += 1;
      setProgress(
        `Endorsing ${done} of ${endorsable.length} — ${mod.name} ` +
          `(${describeEndorseDuration(endorsable.length - done)} left)`,
      );
      await new Promise((r) => setTimeout(r, ENDORSE_PACE_MS));
    }
    setTick((t) => t + 1);
    ehLog("info", "curator.endorse.done", { asked: done, stopped: signal.aborted });
    session.finish(
      undefined,
      `Asked Vortex to endorse ${done} of ${endorsable.length} mod(s)` +
        (signal.aborted ? " before you stopped it" : "") +
        `. Vortex reports each result in its own notifications; press Reload ` +
        `to see the counts settle.`,
    );
  });

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

  // ── Render ───────────────────────────────────────────────────────────

  if (gameId === undefined) {
    return (
      <Card title="No active game">
        <p className="eh-body">Vortex is not managing a game right now, so there is no profile to act on.</p>
      </Card>
    );
  }

  const updatableChosen = chosenRows.filter((r) => r.update !== undefined);
  const frozenChosen = chosen.filter((m) => m.frozenAtVersion !== undefined);
  const unfrozenChosen = chosen.filter((m) => m.frozenAtVersion === undefined);
  const enabledChosen = chosen.filter((m) => m.enabled);
  const disabledChosen = chosen.filter((m) => !m.enabled);
  const endorsableChosen = chosen.filter((m) => endorsable.some((e) => e.id === m.id));
  const idle = busy === undefined;

  return (
    <div className="eh-stack eh-stack--lg">
      <StatGrid min={150}>
        <StatTile label="Mods" value={num(summary.total)} tone={summary.total === 0 ? "quiet" : "neutral"} />
        <StatTile label="Enabled" value={num(summary.enabled)} tone={summary.enabled === 0 ? "quiet" : "neutral"} />
        <StatTile label="Updatable" value={num(summary.updatable)} tone={summary.updatable === 0 ? "quiet" : "warning"} />
        <StatTile
          label="Needs install"
          value={reqSummary === undefined ? "?" : num(reqSummary.modsWithMissing)}
          tone={reqSummary === undefined ? "quiet" : reqSummary.modsWithMissing === 0 ? "success" : "danger"}
          title={reqSummary === undefined ? "Not read yet" : `${num(reqSummary.missing)} requirement(s) across ${num(reqSummary.modsWithMissing)} mod(s)`}
        />
        <StatTile
          label="Needs enabling"
          value={reqSummary === undefined ? "?" : num(reqSummary.installedDisabled)}
          tone={reqSummary === undefined ? "quiet" : reqSummary.installedDisabled === 0 ? "quiet" : "warning"}
          title="Requirements that are in the pool but not enabled"
        />
        <StatTile label="Frozen" value={num(summary.frozen)} tone={summary.frozen === 0 ? "quiet" : "info"} />
        <StatTile label="Frozen, drifted" value={num(summary.frozenDrifted)} tone={summary.frozenDrifted === 0 ? "quiet" : "danger"} />
        <StatTile label="Unendorsed" value={num(summary.endorsable)} tone={summary.endorsable === 0 ? "quiet" : "neutral"} />
      </StatGrid>

      <div className="eh-row">
        <Button intent="ghost" busy={busy === "refresh"} onClick={(): void => void refreshUpdates()}>
          Re-check Nexus for updates
        </Button>
        <Button
          intent="ghost"
          busy={busy === "requirements"}
          onClick={(): void => void readRequirements()}
          title="Read every mod page's Requirements section and every plugin's masters"
        >
          {requirements === undefined ? "Read requirements" : "Re-read requirements"}
        </Button>
        <Menu
          label="More"
          items={[
            {
              label: `Endorse ${num(endorsable.length)} mod(s)`,
              hint: endorseIsLong(endorsable.length)
                ? `${describeEndorseDuration(endorsable.length)}, paced; stops between mods`
                : "Asks Vortex to endorse each unendorsed Nexus mod",
              disabled: !idle || endorsable.length === 0,
              onSelect: (): void => void endorseAll(),
            },
            {
              label: "Reload from Vortex",
              hint: "Re-reads the mod list without asking Nexus",
              onSelect: (): void => {
                setTick((t) => t + 1);
                setNote(
                  `Re-read ${num(mods.length)} mod(s) from Vortex: ${num(counts.updates)} updatable, ` +
                    `${num(counts.manual)} need a manual update, ${num(counts.frozen)} frozen.`,
                );
              },
            },
          ]}
        />
        {busy !== undefined && STOPPABLE.has(busy) && (
          <Button intent="ghost" onClick={(): void => session.cancel()}>
            Stop after this one
          </Button>
        )}
      </div>

      {progress !== undefined && (
        <Callout tone="info" icon={null}>
          <span className="eh-strong">{progress}</span>
        </Callout>
      )}

      {lines.length > 0 && (
        <Card
          title="Report"
          actions={
            idle ? (
              <Button size="sm" intent="ghost" onClick={(): void => session.dismiss()}>
                Dismiss
              </Button>
            ) : undefined
          }
        >
          <div className="eh-stack eh-stack--sm">
            {lines.map((l) => (
              <span key={l} className={l.includes("LOST") ? "eh-tone--danger" : "eh-secondary"}>
                {l}
              </span>
            ))}
          </div>
        </Card>
      )}

      {note !== undefined && <Callout tone="info">{note}</Callout>}

      {requirements?.load.unavailable !== undefined && (
        <Callout tone="warning">{requirements.load.unavailable}</Callout>
      )}

      {/* Views: the same rows; every active chip is one more filter. */}
      <div className="eh-row eh-row--sm" role="tablist" aria-label="Views">
        {chips.map((v) => (
          <Chip
            key={v.id}
            active={tableView && (v.id === "all" ? views.size === 0 : views.has(v.id))}
            onClick={(): void => toggleView(v.id)}
            title={v.id === "all" ? v.description : `${v.description} Click again to remove; chips combine.`}
          >
            {v.label}
            {v.id !== "all" && <span className="eh-muted"> {num(counts[v.id])}</span>}
          </Chip>
        ))}
        {plugins.length > 0 && (
          <Chip active={mode === "plugins"} onClick={(): void => setMode("plugins")} title="Load order, masters, light flags and owning mods">
            Plugins <span className="eh-muted">{num(plugins.length)}</span>
          </Chip>
        )}
        {notInstalled.length > 0 && (
          <Chip active={mode === "downloads"} onClick={(): void => setMode("downloads")} title="Downloaded archives with no installed version">
            Downloads <span className="eh-muted">{num(notInstalled.length)}</span>
          </Chip>
        )}
        <Chip active={mode === "disk"} onClick={(): void => setMode("disk")} title="Orphaned archives and superseded installs">
          Disk cleanup
        </Chip>
        {tableView && (
          <Input
            small
            aria-label="Search mods and requirements"
            placeholder="search: a mod, a requirement, a plugin…"
            value={query}
            onChange={(e): void => setQuery(e.target.value)}
            className="eh-fill"
          />
        )}
      </div>

      {views.has("requirements") && (
        <Checkbox
          label="Include disabled mods"
          description="Off by default: a disabled mod's missing requirement is not tonight's problem."
          checked={includeDisabledReqs}
          onChange={(e): void => setIncludeDisabledReqs(e.target.checked)}
        />
      )}

      <div className={focusMod !== undefined ? "eh-split" : undefined}>
      <div className="eh-stack">
      {mode === "disk" ? (
        <DiskCleanupView mods={mods} downloads={downloads} busy={!idle} confirm={confirm} applyCleanup={applyCleanup} />
      ) : mode === "plugins" ? (
        <PluginsView
          rows={pluginRows}
          headersRead={requirements !== undefined}
          onFocus={setFocusId}
          busy={!idle}
          onSetEnabled={(r, enabled): void => setPluginEnabled(r.plugin.name, enabled)}
        />
      ) : mode === "downloads" ? (
        <DownloadsView downloads={notInstalled} busy={!idle} onInstall={(entries): void => void installDownloads(entries)} />
      ) : (
        <div className="eh-stack">
          {activeSpecs.map((v) => (
            <p key={v.id} className="eh-note eh-prose">
              <span className="eh-strong">{v.label}:</span> {v.description}
            </p>
          ))}
          {views.has("requirements") && reqSummary !== undefined && reqSummary.unfetched > 0 && (
            <p className="eh-note">
              {num(reqSummary.unfetched)} Nexus mod(s) were not answered for; their requirements are unknown, not empty.
            </p>
          )}
          <DataTable
            rows={visibleRows}
            idOf={rowId}
            columns={columns}
            noun="mod"
            limit={200}
            maxHeight={520}
            actionsWidth={290}
            minWidth={1180}
            selection={{ selected, onChange: setSelected }}
            empty={<p className="eh-body">Nothing in this view.</p>}
            actions={(r): JSX.Element => (
              <div className="eh-row eh-row--sm eh-row--nowrap">
                <Button
                  size="sm"
                  intent="ghost"
                  disabled={!idle}
                  title={r.mod.enabled ? "Disable in the active profile" : "Enable in the active profile"}
                  onClick={(e): void => {
                    e.stopPropagation();
                    void (r.mod.enabled ? disableWithDependants([r.mod]) : enableWithProviders([r.mod]));
                  }}
                >
                  {r.mod.enabled ? "Disable" : "Enable"}
                </Button>
                {r.update !== undefined && (
                  <Button size="sm" intent="ghost" disabled={!idle} onClick={(): void => void updateAll([r])}>
                    Update
                  </Button>
                )}
                {r.manual?.url !== undefined && (
                  <Button
                    size="sm"
                    intent="ghost"
                    title="Nexus has a newer version but did not say which file: update from the page"
                    onClick={(): void => openPage({ source: "nexus", status: "missing", name: r.mod.name, url: r.manual!.url, satisfiedBy: [] })}
                  >
                    Open page
                  </Button>
                )}
                <Button
                  size="sm"
                  intent={focusId === r.mod.id ? "primary" : "ghost"}
                  onClick={(e): void => {
                    e.stopPropagation();
                    setFocusId(focusId === r.mod.id ? undefined : r.mod.id);
                  }}
                >
                  Requirements
                </Button>
              </div>
            )}
          />
        </div>
      )}

      </div>
      {focusMod !== undefined && (
        <aside className="eh-split__aside">
          <RequirementsPanel
            mod={focusMod}
            mods={mods}
            report={report}
            entry={report?.byMod.get(focusMod.id)}
            busy={!idle}
            canInstall={nexus.download !== undefined && nexus.getModFiles !== undefined}
            onClose={(): void => setFocusId(undefined)}
            onEnable={(providers): void => setEnabledFor(providers, true)}
            onInstall={installRequirement}
            onInstallAll={(): void => void openPlan(focusMod.name, linesOf(focusMod))}
            onOpenPage={openPage}
            onFocus={setFocusId}
            onSaveNote={saveNote}
          />
        </aside>
      )}
      </div>

      {/* The action bar: only while something is ticked, only what applies. */}
      {chosen.length > 0 && tableView && (
        <div className="eh-actions eh-actions--sticky eh-row--split">
          <span className="eh-strong">
            {num(chosen.length)} ticked
            {chosen.length > chosenRows.filter((r) => visibleRows.includes(r)).length && (
              <span className="eh-muted">
                {" "}
                · {num(chosen.length - chosenRows.filter((r) => visibleRows.includes(r)).length)} not in this view
              </span>
            )}
            <LinkButton variant="xs" tone="muted" className="eh-actions__clear" onClick={(): void => setSelected(new Set())}>
              clear
            </LinkButton>
          </span>
          <div className="eh-row eh-row--sm">
            {disabledChosen.length > 0 && (
              <Button size="sm" intent="ghost" disabled={!idle} onClick={(): void => void enableWithProviders(disabledChosen)}>
                Enable {num(disabledChosen.length)}
              </Button>
            )}
            {enabledChosen.length > 0 && (
              <Button size="sm" intent="ghost" disabled={!idle} onClick={(): void => void disableWithDependants(enabledChosen)}>
                Disable {num(enabledChosen.length)}
              </Button>
            )}
            {updatableChosen.length > 0 && (
              <Button size="sm" intent="primary" disabled={!idle} busy={busy === "update"} onClick={(): void => void updateAll(updatableChosen)}>
                Update {num(updatableChosen.length)}
              </Button>
            )}
            {unfrozenChosen.length > 0 && (
              <Button
                size="sm"
                intent="ghost"
                disabled={!idle}
                title="Keep these out of bulk update at their current version"
                onClick={(): void => {
                  for (const m of unfrozenChosen) setFrozen(m, m.version ?? "");
                }}
              >
                Freeze {num(unfrozenChosen.length)}
              </Button>
            )}
            {frozenChosen.length > 0 && (
              <Button
                size="sm"
                intent="ghost"
                disabled={!idle}
                onClick={(): void => {
                  for (const m of frozenChosen) setFrozen(m, undefined);
                }}
              >
                Unfreeze {num(frozenChosen.length)}
              </Button>
            )}
            {endorsableChosen.length > 0 && (
              <Button
                size="sm"
                intent="ghost"
                disabled={!idle}
                onClick={(): void => {
                  for (const m of endorsableChosen) api.events.emit("endorse-mod", gameId, m.id, "Endorsed");
                  setNote(`Asked Vortex to endorse ${num(endorsableChosen.length)} mod(s). Press Reload to see the counts settle.`);
                }}
              >
                Endorse {num(endorsableChosen.length)}
              </Button>
            )}
            <Button size="sm" intent="ghost" disabled={!idle} busy={busy === "reinstall"} onClick={(): void => void reinstall(chosen)}>
              Reinstall {num(chosen.length)}
            </Button>
            <Button
              size="sm"
              intent="danger"
              disabled={!idle}
              busy={busy === "remove"}
              title="Uninstall from this game; archives stay in Downloads"
              onClick={(): void => void removeMods(chosen)}
            >
              Remove {num(chosen.length)}
            </Button>
            <Field label="Kind" inline>
              {(id): JSX.Element =>
                modTypes.length > 0 ? (
                  <Select id={id} small auto value={typeValue} onChange={(e): void => setTypeValue(e.target.value)}>
                    <option value="">default</option>
                    {modTypes.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    id={id}
                    mono
                    small
                    placeholder="e.g. dinput"
                    value={typeValue}
                    onChange={(e): void => setTypeValue(e.target.value)}
                  />
                )
              }
            </Field>
            <Button
              size="sm"
              intent="ghost"
              disabled={!idle}
              title="Where Vortex deploys the mod. A mistyped kind cannot be re-derived, so the list is what the game registers."
              onClick={(): void => setTypeFor(chosen, typeValue)}
            >
              Set kind
            </Button>
          </div>
        </div>
      )}

      <InstallPlanModal
        open={planState !== undefined}
        rootName={planState?.rootName ?? ""}
        plan={planState?.plan}
        files={planState?.files ?? []}
        picked={planState?.picked ?? {}}
        onPick={(key, fileId): void =>
          setPlanState((st) => (st === undefined ? st : { ...st, picked: { ...st.picked, [key]: fileId } }))
        }
        onOpenPage={(url, domain, modId): void =>
          openPage({ source: "nexus", status: "missing", name: "", satisfiedBy: [], ...(url === undefined ? {} : { url }), gameDomain: domain, nexusModId: modId })
        }
        onConfirm={(): void => void runPlan()}
        onClose={(): void => {
          if (busy === undefined) setPlanState(undefined);
        }}
      />
    </div>
  );
}

/** Exported for the render harness; the route renders {@link CuratorPage}. */
export function CuratorPanel(): JSX.Element {
  return <CuratorBody />;
}

export function CuratorPage(): JSX.Element {
  return (
    <Page
      title="Curator Tools"
      subtitle="Your whole profile, one table: updates, freezes, requirements and cleanup — every action one mod at a time."
    >
      <ErrorBoundary where="curator tools">
        <CuratorBody />
      </ErrorBoundary>
    </Page>
  );
}
