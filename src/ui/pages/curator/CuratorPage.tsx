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
import { livePluginList, readPluginList } from "../../../core/curator/pluginPool";
import { buildPluginRows } from "../../../core/curator/pluginView";
import { isBaseGameMaster } from "../../../core/manifest/pluginMasters";
import { knownGameIds, loadRequirements, nexusDomainForVortexGame, nexusExtOf, pluginCapabilityForGame } from "./requirementsIo";
import { isPremium, useCuratorActions } from "./useCuratorActions";
import { setPluginLightFlag } from "../../../core/manifest/pluginFlags";
import { installRootFor, stagingRootFromFolder } from "../../../core/stagingPath";
import type { PluginRow } from "../../../core/curator/pluginView";
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

/**
 * The mods hive, throttled: an install finishing elsewhere in Vortex, an
 * attribute Vortex wrote, a mod removed from its own tab. The page re-reads
 * on the next quiet moment; while one of OUR runs is busy the run bumps
 * `tick` itself, so this stays out of the way.
 */
const modsListeners = new Set<() => void>();
let modsWatched = false;
function watchModsHive(api: { onStateChange?: (path: string[], cb: () => void) => void }, fn: () => void): () => void {
  modsListeners.add(fn);
  if (!modsWatched && typeof api.onStateChange === "function") {
    modsWatched = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    api.onStateChange(["persistent", "mods"], () => {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        for (const l of modsListeners) l();
      }, 2000);
    });
  }
  return () => {
    modsListeners.delete(fn);
  };
}



/** Which runs honour Stop. The others are single Vortex calls with no checkpoint. */
const STOPPABLE = new Set<string>([
  "requirements",
  "endorse",
  "update",
  "reinstall",
  "cleanup",
  "remove",
  "install-download",
  "install-requirement",
]);

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

  // Downloads with no installed version: what Disk cleanup refuses to
  // touch, and what this page can install.
  const notInstalled = React.useMemo<DownloadEntry[]>(
    () => planCleanup({ mods, downloads }).unclearOrphans.map((o) => o.entry),
    [mods, downloads],
  );

  // The plugin list is Vortex's, re-read on every tick so an enable or disable
  // shows at once; the requirements pass adds only the headers and the
  // plugins of disabled mods, which Vortex does not list.
  const plugins = React.useMemo(() => {
    const enabledIds = new Set(mods.filter((m) => m.enabled).map((m) => m.id));
    return livePluginList(readPluginList(api.getState()), requirements?.load.plugins, (id) => enabledIds.has(id));
  }, [api, tick, requirements, mods]);
  // What this game's plugin system allows: light plugins or not, and its limit.
  const pluginCapability = React.useMemo(() => (gameId === undefined ? undefined : pluginCapabilityForGame(gameId)), [gameId]);
  const pluginRows = React.useMemo(
    () =>
      gameId === undefined
        ? []
        : buildPluginRows({
            plugins,
            headers: requirements?.load.headers ?? new Map(),
            mods,
            isBaseGame: (m) => isBaseGameMaster(m, gameId),
            ...(pluginCapability === undefined ? {} : { capability: pluginCapability }),
          }),
    [plugins, requirements, mods, gameId, pluginCapability],
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

  // Live: re-read when Vortex's mods hive settles, unless one of our runs is
  // on (it re-reads when it finishes).
  const busyRef = React.useRef(busy);
  busyRef.current = busy;
  React.useEffect(
    () =>
      watchModsHive(api as never, () => {
        if (busyRef.current === undefined) setTick((t) => t + 1);
      }),
    [api],
  );

  const actions = useCuratorActions({ api, session, busy, gameId, mods, report, requirements, endorsable, focusMod, setTick, setNote, setProgress, confirm, setSelected, setFocusId });
  const {
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
  } = actions;

  // Every hook sits above the early return below: React keys hook state by
  // call order, so a hook after it would make the page throw "Rendered fewer
  // hooks than expected" the moment the active game toggles while it is open.
  const hiddenTicked = React.useMemo(() => {
    const visibleIds = new Set(visibleRows.map((r) => r.mod.id));
    return chosen.filter((m) => !visibleIds.has(m.id)).length;
  }, [visibleRows, chosen]);

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
          {...(pluginCapability === undefined ? {} : { capability: pluginCapability })}
          onFocus={setFocusId}
          busy={!idle}
          onSetEnabled={(r, enabled): void => setPluginEnabled(r.plugin.name, enabled)}
          onSetLight={(r, light): void => void setLight(r, light)}
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
          {reqSummary !== undefined && reqSummary.truncated > 0 && (
            <p className="eh-note">
              {num(reqSummary.truncated)} mod page(s) list more requirements than Nexus returned (Vortex asks for ten), so
              their Requires cell says &ldquo;incomplete&rdquo; rather than &ldquo;ok&rdquo;: open the page for the rest.
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
            {hiddenTicked > 0 && (
              <span className="eh-muted">
                {" "}
                · {num(hiddenTicked)} not in this view
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
                onClick={(): void =>
                  void guard("Endorsing", async (): Promise<void> => {
                    const signal = session.begin("endorse", { keepReport: true });
                    if (signal === undefined) return;
                    const outcome = await endorseEach(endorsableChosen, signal);
                    setTick((t) => t + 1);
                    session.finish(undefined, describeEndorse(outcome, endorsableChosen.length, signal.aborted));
                  })()
                }
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
        guided={!isPremium(api.getState())}
        onClose={(): void => {
          // While the chain is being read, Cancel stops the read; once it is
          // running, Stop after this one is the way out.
          if (busy === "install-requirement") session.cancel();
          else setPlanState(undefined);
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
