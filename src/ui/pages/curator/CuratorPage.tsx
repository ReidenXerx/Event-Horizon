/**
 * Curator Tools — the profile-wide actions Vortex does badly or never built.
 *
 * Read-first by construction: the page opens showing what it FOUND, and every
 * action is a separate deliberate click. Vortex's own bulk update is a single
 * button that starts dozens of concurrent installs and loses files while doing
 * it, and the shape of that UI is part of why — there is no moment where the
 * curator sees what is about to happen.
 *
 * The lists are the product. The buttons are what you do after reading them.
 */

import * as fsp from "fs/promises";

import * as React from "react";
import { actions as vortexActions, selectors } from "@nexusmods/vortex-api";

import {
  findDuplicates,
  findEndorsable,
  findFrozen,
  findUpdatable,
  findManualUpdates,
  findUpdateShadowed,
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
import {
  archivesFreedByRemoval,
  cleanupSubset,
  describeEvidence,
  findSupersededMods,
  provenSupersedes,
  unprovenSupersedes,
  formatSize,
  orphanArchives,
  planCleanup,
  tickedArchives,
  type CleanupPlan,
  type DownloadEntry,
} from "../../../core/curator/cleanupPlan";
import {
  describeCleanupOutcome,
  readDownloads,
  runCleanup,
} from "../../../core/curator/runCleanup";
import { FROZEN_ATTRIBUTE } from "../../../core/curator/readProfile";
import {
  installedIdentityReader,
  updateOneAndWait,
} from "../../../core/curator/updateOneMod";
import { verifyUpdatedMod } from "../../../core/curator/verifyAfterUpdate";
import {
  Button,
  Card,
  DataTable,
  Page,
  Pill,
  describeTarget,
  type Column,
  type TargetSet,
} from "../../components";
import { useApi } from "../../state";
import { ErrorBoundary } from "../../errors";
import { ehLog } from "../../../core/logging/ehLog";
import { getCuratorSession, type CuratorSnapshot } from "./curatorSession";

/**
 * How Vortex's Nexus integration is ACTUALLY reached.
 *
 * Not as methods on the api. `INexusAPIExtension` exists in the typings but is
 * referenced by nothing, and calling `api.nexusCheckModsVersion` found
 * `undefined` — which this page reported, correctly, as "not available".
 *
 * Vortex drives its own buttons through events, and this is copied from what
 * its mod-update toolbar and endorse control actually do:
 *
 *   api.emitAndAwait("check-mods-version", gameId, mods, force)
 *   api.events.emit("endorse-mod", gameId, vortexModId, status)
 *   api.events.emit("mod-update", gameId, nexusModId, newestFileId, source)
 *
 * Note the endorse id: Vortex passes `mod.id` — its OWN mod id — while the
 * update passes `attributes.modId`, the NEXUS one. Two ids, adjacent calls,
 * and the wrong one endorses nothing.
 */
type EmitAndAwait = {
  emitAndAwait?: (event: string, ...args: unknown[]) => PromiseLike<unknown>;
};

const num = (n: number): string => n.toLocaleString();

/**
 * ─── EVERY IRREVERSIBLE ACT ON THIS PAGE ASKS FIRST ────────────────────
 * Three buttons here permanently delete files or uninstall mods, and each was
 * a single unconfirmed click — the archive one defaulting to EVERY orphan it
 * found, which on the profile this was built for is tens of gigabytes gone on
 * a misclick with no undo anywhere in Vortex.
 *
 * Shaped as a function rather than repeated inline so all three say the same
 * kind of thing: what happens, how much of it, and that it cannot be undone.
 *
 * A Vortex build with no `showDialog` REFUSES rather than proceeds. It is core
 * API and present everywhere in practice; if it ever is not, silently doing
 * the destructive thing unconfirmed is the wrong way to fail.
 */
type Confirmer = (args: {
  title: string;
  text: string;
  confirmLabel: string;
}) => Promise<boolean>;

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

function Tile(props: {
  label: string;
  value: number;
  intent?: "warning" | "danger";
}): JSX.Element {
  return (
    <div
      style={{
        padding: "var(--eh-sp-3)",
        background: "var(--eh-bg-raised)",
        border: "1px solid var(--eh-border-default)",
        borderRadius: "var(--eh-radius-md)",
        minWidth: 120,
      }}
    >
      <div
        style={{
          fontSize: "var(--eh-text-xs)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--eh-text-muted)",
        }}
      >
        {props.label}
      </div>
      <div
        style={{
          fontSize: "var(--eh-text-xl)",
          color:
            props.value === 0
              ? "var(--eh-text-secondary)"
              : props.intent === "danger"
                ? "var(--eh-danger)"
                : props.intent === "warning"
                  ? "var(--eh-warning)"
                  : "var(--eh-text-primary)",
        }}
      >
        {num(props.value)}
      </div>
    </div>
  );
}

function Section(props: {
  title: string;
  note: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <Card title={props.title}>
      <p
        style={{
          margin: "0 0 var(--eh-sp-2)",
          color: "var(--eh-text-secondary)",
          fontSize: "var(--eh-text-sm)",
        }}
      >
        {props.note}
      </p>
      {props.children}
    </Card>
  );
}

/**
 * ─── COLUMN DEFINITIONS LIVE AT MODULE LEVEL, DELIBERATELY ─────────────
 * `DataTable` projects every row through its columns inside a `useMemo` keyed
 * on the column array's identity. An array literal written inside the
 * component is a new array on every render, so that memo would never hit and
 * a 1,900-mod profile would be re-projected on every keystroke in a filter
 * box. Defined once here, they are stable for the life of the module.
 *
 * The types are read off the finders rather than imported by name, so a
 * change to what a finder returns is a compile error here rather than a
 * column quietly rendering `undefined`.
 */
type UpdateRow = ReturnType<typeof findUpdatable>[number];
type FrozenRow = ReturnType<typeof findFrozen>[number];
type ShadowRow = ReturnType<typeof findUpdateShadowed>[number];
type ManualRow = ReturnType<typeof findManualUpdates>[number];
type RetireRow = ReturnType<typeof findSupersededMods>[number];
type DuplicateRow = ReturnType<typeof findDuplicates>[number];
type RemovalRow = CleanupPlan["removeMods"][number];
type ArchiveRow = CleanupPlan["deleteArchives"][number];

/** Vortex's empty modType is the default one. Say so rather than showing "". */
const kindOf = (mod: CuratorMod): string =>
  mod.modType === "" ? "default" : mod.modType;
const stateOf = (mod: CuratorMod): string =>
  mod.enabled ? "enabled" : "disabled";

const UPDATE_COLUMNS: Column<UpdateRow>[] = [
  { key: "name", header: "Mod", value: (c) => c.mod.name },
  { key: "from", header: "Installed", value: (c) => c.fromVersion, width: 130 },
  { key: "to", header: "Available", value: (c) => c.toVersion, width: 130 },
  {
    key: "state",
    header: "State",
    match: "exact",
    width: 110,
    value: (c) => stateOf(c.mod),
  },
];

const FROZEN_COLUMNS: Column<FrozenRow>[] = [
  { key: "name", header: "Mod", value: (f) => f.mod.name },
  { key: "at", header: "Frozen at", value: (f) => f.frozenAtVersion, width: 130 },
  {
    key: "status",
    header: "Status",
    match: "exact",
    width: 180,
    value: (f) =>
      f.driftedTo !== undefined
        ? "drifted"
        : f.updateWithheld
          ? "holding an update"
          : "holding",
    render: (f) =>
      f.driftedTo !== undefined ? (
        <Pill intent="danger">now {f.driftedTo}</Pill>
      ) : (
        <Pill intent={f.updateWithheld ? "warning" : "neutral"}>
          {f.updateWithheld ? "holding an update" : "holding"}
        </Pill>
      ),
  },
];

const SHADOW_COLUMNS: Column<ShadowRow>[] = [
  { key: "name", header: "Older install", value: (r) => r.mod.name },
  { key: "version", header: "Version", value: (r) => r.mod.version, width: 130 },
  {
    key: "newer",
    header: "Newer copy already installed",
    value: (r) => r.newerInstall.name,
  },
];

const MANUAL_COLUMNS: Column<ManualRow>[] = [
  { key: "name", header: "Mod", value: (r) => r.mod.name },
  { key: "from", header: "You have", value: (r) => r.fromVersion, width: 130 },
  { key: "to", header: "Nexus has", value: (r) => r.toVersion, width: 130 },
  {
    key: "page",
    header: "Mod page",
    width: 220,
    value: (r) => r.url ?? "",
    render: (r) =>
      r.url === undefined ? (
        <span style={{ color: "var(--eh-text-muted)" }}>no page recorded</span>
      ) : (
        <a href={r.url} target="_blank" rel="noreferrer">
          open on Nexus
        </a>
      ),
  },
];

const MOD_COLUMNS: Column<CuratorMod>[] = [
  { key: "name", header: "Mod", value: (m) => m.name },
  { key: "version", header: "Version", value: (m) => m.version, width: 130 },
  { key: "kind", header: "Kind", match: "exact", width: 120, value: kindOf },
  { key: "state", header: "State", match: "exact", width: 110, value: stateOf },
];

const shownVersion = (v: string | undefined): string => v ?? "unknown";

const RETIRE_COLUMNS: Column<RetireRow>[] = [
  { key: "name", header: "Older install", value: (c) => c.mod.name },
  {
    key: "version",
    header: "Version",
    width: 190,
    // The transition, not just the installed side. "1.0" alone says nothing
    // about what would replace it, which is the fact being decided here.
    value: (c) =>
      `${shownVersion(c.mod.version)} → ${shownVersion(c.supersededBy.version)}`,
  },
  {
    key: "newer",
    header: "Replaced by",
    value: (c) => c.supersededBy.name,
  },
  {
    key: "evidence",
    header: "Why",
    match: "exact",
    width: 200,
    // On the row, because this card deletes things. A curator should not have
    // to remember which rule put a line here.
    value: (c) => describeEvidence(c.evidence),
    render: (c) => (
      <Pill intent={c.evidence === "same-page-only" ? "warning" : "neutral"}>
        {describeEvidence(c.evidence)}
      </Pill>
    ),
  },
  {
    key: "state",
    header: "State",
    match: "exact",
    width: 110,
    value: (c) => stateOf(c.mod),
  },
];

const DUPLICATE_COLUMNS: Column<DuplicateRow>[] = [
  {
    key: "names",
    header: "Installs sharing a Nexus page",
    value: (g) => g.mods.map((m) => m.name).join("  ·  "),
  },
  {
    key: "kind",
    header: "Verdict",
    match: "exact",
    width: 220,
    value: (g) =>
      g.kind === "same-file" ? "same file twice" : "same page, different files",
    render: (g) => (
      <Pill intent={g.kind === "same-file" ? "danger" : "warning"}>
        {g.kind === "same-file"
          ? "same file twice"
          : "same page, different files"}
      </Pill>
    ),
  },
];

const REMOVAL_COLUMNS: Column<RemovalRow>[] = [
  { key: "name", header: "Install to remove", value: (r) => r.mod.name },
  { key: "newer", header: "Superseded by", value: (r) => r.supersededBy.name },
];

const ARCHIVE_COLUMNS: Column<ArchiveRow>[] = [
  { key: "file", header: "Archive to delete", value: (a) => a.entry.fileName },
  {
    key: "bytes",
    header: "Size",
    numeric: true,
    align: "right",
    width: 120,
    value: (a) => a.entry.bytes,
    render: (a) => formatSize(a.entry.bytes),
  },
];

/** Stable row identities, for the same memo reason as the columns above. */
const updateId = (c: UpdateRow): string => c.mod.id;
const frozenId = (f: FrozenRow): string => f.mod.id;
const shadowId = (r: ShadowRow): string => r.mod.id;
const manualId = (r: ManualRow): string => r.mod.id;
const curatorModId = (m: CuratorMod): string => m.id;
const retireId = (c: RetireRow): string => c.mod.id;
const duplicateId = (g: DuplicateRow): string => String(g.nexusModId);
const removalId = (r: RemovalRow): string => r.mod.id;
const archiveId = (a: ArchiveRow): string => a.entry.id;

function CuratorBody(): JSX.Element {
  const api = useApi();
  const [tick, setTick] = React.useState(0);

  /**
   * ─── THE RUNNING STATE LIVES OUTSIDE THIS COMPONENT ─────────────────
   * `RouteOutlet` keys every page on its route, so clicking another tab
   * UNMOUNTS this one. `busy`, `progress` and the report were `useState`
   * here, and a bulk update over forty mods runs for many minutes.
   *
   * Tab away mid-run and all three died with the component: the report was
   * gone — including the LOST lines that are the entire product of verifying
   * each mod — the buttons came back enabled, so a SECOND bulk update could
   * start on top of the live one, and the first kept running invisibly
   * against staging folders a build might be about to hash. The expected bug
   * report is "I clicked Update, looked at something else, came back, and it
   * said nothing happened."
   *
   * `buildSession` and `installSession` already solved this; this is the same
   * shape. Only what must OUTLIVE the component moved — the effects stay
   * here, where they can read `api` and the profile.
   */
  const session = React.useMemo(() => getCuratorSession(), []);
  const [run, setRun] = React.useState<CuratorSnapshot>(() =>
    session.getSnapshot(),
  );
  React.useEffect(() => {
    // Re-read on mount as well as subscribing: a run that finished while this
    // page was unmounted has already published its final state to nobody.
    setRun(session.getSnapshot());
    return session.subscribe(setRun);
  }, [session]);
  const busy = run.busy;
  const progress = run.progress;
  const lines = run.lines;
  const note = run.note;
  const setNote = (message: string | undefined): void => session.say(message);
  const setProgress = (message: string | undefined): void =>
    session.progress(message);
  const confirm = React.useMemo(
    () => makeConfirmer(api as never, (why) => session.say(why)),
    [api, session],
  );

  const gameId = React.useMemo(() => {
    const state = api.getState();
    try {
      const fromSelector = selectors.activeGameId(state);
      if (typeof fromSelector === "string" && fromSelector !== "") {
        return fromSelector;
      }
    } catch {
      // Selector unavailable or a partial state. Fall through rather than
      // rendering "no active game" over a machine that plainly has one.
    }
    // The active profile knows its own game, and a page that shows nothing is
    // indistinguishable from a page that found nothing — the worse of the two,
    // because only one of them makes the curator go looking.
    const settings = (
      state as unknown as {
        settings?: { profiles?: { activeProfileId?: string } };
        persistent?: { profiles?: Record<string, { gameId?: string }> };
      }
    );
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
  const updatable = React.useMemo(() => findUpdatable(mods), [mods]);
  const frozen = React.useMemo(() => findFrozen(mods), [mods]);
  const duplicates = React.useMemo(() => findDuplicates(mods), [mods]);
  /**
   * Older installs of a mod that already has a newer copy installed.
   *
   * They are deliberately NOT offered an update — updating both would install
   * the new file twice and leave four copies where there were two, which is
   * the exact mess this page exists to clean up. Shown so the omission is
   * something the curator reads rather than something they notice missing.
   */
  const shadowed = React.useMemo(() => findUpdateShadowed(mods), [mods]);
  /**
   * Out of date, but not automatable.
   *
   * Vortex sets `newestVersion` and `newestFileId` from two different parts
   * of its update check, and the file id — the one `mod-update` actually
   * needs — is missing for plenty of real mods. Those used to appear
   * NOWHERE, so a curator with a hundred out-of-date mods saw a handful and
   * concluded the check was broken.
   */
  const manualUpdates = React.useMemo(() => findManualUpdates(mods), [mods]);
  const endorsable = React.useMemo(() => findEndorsable(mods), [mods]);

  const ext = api as unknown as EmitAndAwait;
  /**
   * Vortex gives an updated mod a NEW id; verification must use that one.
   *
   * Built fresh per run rather than kept in a ref. A ref outlives every run,
   * and Vortex derives a mod id from its archive name — so a later install can
   * be handed an id an earlier run already mapped, and verification would then
   * check a mod that no longer exists.
   */
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const chosen = React.useMemo(
    () => mods.filter((m) => selected.has(m.id)),
    [mods, selected],
  );
  const [typeValue, setTypeValue] = React.useState("");
  /**
   * ─── ONE TICK SET PER TABLE ────────────────────────────────────────
   * Each table answers a different question, so a tick in one must not mean
   * anything in another. Held here rather than inside `DataTable` so the
   * buttons above each table can act on them.
   */
  const [updateSel, setUpdateSel] = React.useState<ReadonlySet<string>>(new Set());
  const [frozenSel, setFrozenSel] = React.useState<ReadonlySet<string>>(new Set());
  const [dupSel, setDupSel] = React.useState<ReadonlySet<string>>(new Set());
  const [archiveSel, setArchiveSel] = React.useState<ReadonlySet<string>>(new Set());

  /**
   * What each table's button acts on: ticks if any, else the filtered rows.
   *
   * `undefined` until the table has reported once, and the fallback below is
   * "everything" — so the label is right on the very first render instead of
   * flashing zero before the effect lands.
   */
  const [updateAim, setUpdateAim] = React.useState<TargetSet | undefined>();
  const [frozenAim, setFrozenAim] = React.useState<TargetSet | undefined>();
  const [dupAim, setDupAim] = React.useState<TargetSet | undefined>();

  /**
   * Every finished download, read straight from Vortex's state.
   *
   * There used to be a "Scan for old versions" button in front of this, and
   * it protected nothing: `readDownloads` reads Redux, touches no disk and
   * deletes nothing. All the button did was hide both lists behind a step
   * whose purpose nobody could see — which is most of why this section was
   * unreadable. The gate that matters is Apply, and that one is still here.
   *
   * Keyed on `tick` like `mods`, so both cleanup questions and the profile
   * always describe the same moment.
   */
  const downloads = React.useMemo<readonly DownloadEntry[]>(
    () => (gameId === undefined ? [] : readDownloads(api.getState(), gameId)),
    [api, gameId, tick],
  );
  /**
   * Old installs the curator has TICKED for removal.
   *
   * Never pre-filled. A lower Nexus file id does not prove an older version —
   * a page ships a main file and its optional patches under one mod id — and
   * the planner used to act on that guess.
   */
  const [retire, setRetire] = React.useState<ReadonlySet<string>>(new Set());
  const retireCandidates = React.useMemo(
    () => findSupersededMods(mods),
    [mods],
  );
  /**
   * Backed by evidence versus merely sharing a mod page.
   *
   * Kept apart because they are different claims. "Same page" produced plain
   * false positives on the real profile — a bodypaint's CBBE variant offered
   * for deletion because a Male variant had a higher file id — so those are
   * shown separately, below, and never mixed in with the ones Nexus or the
   * file's own name actually vouches for.
   */
  const provenRetire = React.useMemo(
    () => provenSupersedes(retireCandidates),
    [retireCandidates],
  );
  const unprovenRetire = React.useMemo(
    () => unprovenSupersedes(retireCandidates),
    [retireCandidates],
  );

  /**
   * Two plans from one scan, because they are two different acts.
   *
   * `orphanPlan` assumes NO removals, so its orphans are archives that are
   * already free — deletable on their own. `retirePlan` assumes the ticked
   * removals, and the archives it frees are only free AFTER those happen.
   * Deriving both from the same `downloads` is what stops the two cards
   * describing different disks.
   */
  const orphanPlan = React.useMemo(
    () => planCleanup({ mods, downloads }),
    [mods, downloads],
  );
  const retirePlan = React.useMemo(
    () => planCleanup({ mods, downloads, removeModIds: retire }),
    [mods, downloads, retire],
  );
  const orphans = React.useMemo(() => orphanArchives(orphanPlan), [orphanPlan]);

  /** The duplicate groups the button will really add: ticks, else filtered. */
  const dupGroups = React.useMemo(() => {
    const ids = new Set(dupAim?.ids ?? duplicates.map((g) => String(g.nexusModId)));
    return duplicates.filter((g) => ids.has(String(g.nexusModId)));
  }, [duplicates, dupAim]);

  /**
   * ─── THE ARCHIVES THE DELETE BUTTON WILL REMOVE — TICKED ONLY ────────
   * Deliberately NOT `effectiveTarget`'s ticks-else-filtered default, which
   * every other button on this page uses. That default means "no ticks = all
   * of them", and here "all of them" was every orphan found: on the profile
   * this was built for, one unconfirmed click on a freshly opened page
   * permanently deleted tens of gigabytes of archives.
   *
   * Ticks-else-filtered is right for an action you can redo. This one you
   * cannot: Vortex has no undo and the files do not go to the recycle bin.
   * Card 2 below already worked this way ("nothing is pre-ticked"), and the
   * two cards being inconsistent about it was itself part of the trap.
   */
  const archiveRemovals = React.useMemo(
    () => tickedArchives(orphans, archiveSel),
    [orphans, archiveSel],
  );
  const archiveBytes = React.useMemo(
    () => archiveRemovals.reduce((n, a) => n + a.entry.bytes, 0),
    [archiveRemovals],
  );
  /** What retiring the ticked installs frees, once they are gone. */
  const freedByRetiring = React.useMemo(
    () =>
      archivesFreedByRemoval(retirePlan).reduce((n, a) => n + a.entry.bytes, 0),
    [retirePlan],
  );

  /** The rows each button will really act on. */
  const updateRows = React.useMemo(() => {
    const ids = new Set(updateAim?.ids ?? updatable.map((c) => c.mod.id));
    return updatable.filter((c) => ids.has(c.mod.id));
  }, [updatable, updateAim]);
  const frozenRows = React.useMemo(() => {
    const ids = new Set(frozenAim?.ids ?? frozen.map((f) => f.mod.id));
    return frozen.filter((f) => ids.has(f.mod.id));
  }, [frozen, frozenAim]);

  const setFrozen = (mod: CuratorMod, version: string | undefined): void => {
    const { key, value } = freezeAttribute(version);
    api.store?.dispatch(
      vortexActions.setModAttribute(gameId!, mod.id, key, value) as never,
    );
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
      // Read-only: this asks Vortex to refresh what Nexus says. Nothing is
      // installed and nothing on disk changes. Same call Vortex's own
      // "check for updates" toolbar button makes.
      ehLog("info", "curator.recheck.start", {
        gameId,
        mods: Object.keys(byId).length,
      });
      await ext.emitAndAwait("check-mods-version", gameId, byId, true);
      ehLog("info", "curator.recheck.ok", { gameId });
    } catch (err) {
      ehLog("error", "curator.recheck.fail", { err });
      session.finish(
        undefined,
        `Vortex could not check for updates: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      setTick((t) => t + 1);
      return;
    }
    session.finish(undefined, "Nexus re-checked. The counts below are current.");
    setTick((t) => t + 1);
  };

  const endorseAll = async (): Promise<void> => {
    const game = gameId;
    if (game === undefined) return;
    const signal = session.begin("endorse", { keepReport: true });
    if (signal === undefined) return;
    let done = 0;
    // Paced, not parallel. `endorse-mod` is fire-and-forget — Vortex gives no
    // promise to await — so the only way to avoid firing 1,500 requests at
    // Nexus in one tick is to space them. A ban is not a faster result.
    for (const mod of endorsable) {
      // Endorsing cannot be undone one at a time, but it CAN be stopped
      // part-way — which is the difference between a curator who changed
      // their mind at mod 30 of 1,500 and one who has to close Vortex.
      if (signal.aborted) break;
      if (mod.nexusModId === undefined) continue;
      // Vortex's OWN mod id here, not the Nexus one: that is what its endorse
      // control passes, and the other id endorses nothing.
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
  };

  /**
   * Update every candidate, one at a time, verifying each before the next.
   *
   * The awaiting is the feature. `updateOneAndWait` resolves only when Vortex
   * reports finishing THIS mod — matched on its Nexus ids, not on "some
   * install finished" — and `runBulkUpdate` cannot begin the next until it
   * has. Vortex's own bulk update starts them together, which is why it loses
   * files.
   */
  const updateAll = async (candidates: UpdateRow[]): Promise<void> => {
    // Narrowed here rather than relied on from the guard below: this function
    // is defined above it, so the compiler cannot see that check — the same
    // shape as the closure bugs that crashed two releases of the build page.
    const game = gameId;
    if (game === undefined) return;
    // The session owns the signal, so the Cancel button below can reach it.
    // It used to be a local `AbortController` that nothing ever aborted.
    const signal = session.begin("update");
    if (signal === undefined) return;
    const installedIds = new Map<string, string>();
    // This flow logged nothing at all, so an update that did literally
    // nothing looked exactly like one that was working — and the only way to
    // tell them apart was to read Vortex's log and find it empty too.
    ehLog("info", "curator.bulk-update.start", {
      candidates: candidates.length,
      gameId: game,
    });
    const startedAt = Date.now();
    const report = await runBulkUpdate({
      candidates,
      signal,
      onProgress: (n, total, m) =>
        setProgress(`Updating ${n + 1} of ${total} — ${m.name}`),
      update: async (candidate) => {
        const newModId = await updateOneAndWait({
          events: api.events as never,
          gameId: game,
          nexusModId: candidate.mod.nexusModId!,
          toFileId: candidate.toFileId,
          // The getter, never a snapshot: the mod being waited for does
          // not exist in any state captured before the update started.
          readInstalled: installedIdentityReader(() => api.getState(), game),
          start: () => {
            /**
             * ─── THE LAST ARGUMENT IS A DISCRIMINATOR, NOT A LABEL ──────
             * Vortex's `onModUpdate` opens with:
             *
             *     if (source !== "nexus") {
             *       // not a mod from nexus mods
             *       return;
             *     }
             *
             * It was passed "event-horizon-curator-tools", read as an
             * attribution tag because Vortex's own caller passes
             * `mod.attributes.source` there. The handler returned
             * immediately — no download, no error, and not one line in
             * Vortex's log or ours — and the page sat on "Updating 1 of 4"
             * until the fifteen-minute timeout. Vortex's own bulk update
             * hardcodes "nexus" at this exact call; so does this.
             */
            const source = "nexus";
            // Differs from the active game for a compatible download — a
            // Skyrim LE file installed under SSE — and Vortex reads it here
            // for exactly that case.
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
    // Clear the ticks, as every other action on this page does. Vortex gives
    // an updated mod a NEW id, so these ids are stale the moment the run
    // finishes: the button would keep reading "Update 12 ticked mods" while
    // acting on the 7 that still exist, and `from: "ticked"` would pin the
    // target there — leaving the remaining updates unreachable by filtering.
    setUpdateSel(new Set());
    setTick((t) => t + 1);
  };

  /**
   * Reinstall the mods that lost files, one at a time.
   *
   * The repair for what the update check finds. Everything the uninstall
   * would destroy — FOMOD answers, modType, enabled state, the freeze — is
   * read BEFORE it happens and put back after, or the mod returns as a
   * default install of the same archive: silently different from what the
   * curator had.
   */
  const reinstall = async (targets: readonly CuratorMod[]): Promise<void> => {
    const game = gameId;
    if (game === undefined || targets.length === 0) return;
    /**
     * Reinstalling UNINSTALLS first, so this is destructive before it is
     * restorative. Said plainly, with the count, before anything is removed.
     */
    const ok = await confirm({
      title: `Reinstall ${num(targets.length)} mod(s)?`,
      text:
        `Each one is UNINSTALLED and then installed again from its archive, ` +
        `one at a time. Everything Vortex would otherwise lose — the FOMOD ` +
        `answers, the mod type, whether it is enabled, any freeze — is read ` +
        `first and put back after.\n\n` +
        `If an install fails after the removal, that mod is gone from your ` +
        `setup until you install it again from Downloads. The report says ` +
        `exactly which, if any.`,
      confirmLabel: "Reinstall",
    });
    if (!ok) return;
    const signal = session.begin("reinstall");
    if (signal === undefined) return;
    const installedIds = new Map<string, string>();
    /**
     * Mods whose UNINSTALL succeeded.
     *
     * The report cannot tell "the reinstall failed and the mod is untouched"
     * from "the reinstall failed and the mod is gone" without this — and
     * those two sentences ask the curator to do opposite things.
     */
    const removed = new Set<string>();
    const state0 = api.getState();
    const enabledNow = readEnabledModIds(state0, game);

    const report = await runSequentially<CuratorMod>({
      items: targets,
      onProgress: (n, total, m) =>
        setProgress(`Reinstalling ${n + 1} of ${total} — ${m.name}`),
      act: async (m) => {
        const preserved = captureForReinstall(
          api.getState(),
          game,
          m.id,
          enabledNow,
          FROZEN_ATTRIBUTE,
        );
        await uninstallMod(api, { gameId: game, modId: m.id });
        // Past this line the mod is NOT in the setup. Anything that throws
        // from here on leaves it that way.
        removed.add(m.id);
        const { vortexModId } = await installFromExistingDownload(api, {
          gameId: game,
          ...reinstallArgs(preserved),
        } as never);
        installedIds.set(m.id, vortexModId);

        const fresh = readCuratorMods(
          api.getState(),
          game,
          new Set(),
        ).find((x) => x.id === vortexModId);
        const restore = restorationFor(preserved, {
          modType: fresh?.modType ?? "",
        });
        if (restore.setModType !== undefined) {
          api.store?.dispatch(
            vortexActions.setModType(game, vortexModId, restore.setModType) as never,
          );
        }
        if (restore.setFrozenAtVersion !== undefined) {
          api.store?.dispatch(
            vortexActions.setModAttribute(
              game,
              vortexModId,
              FROZEN_ATTRIBUTE,
              restore.setFrozenAtVersion,
            ) as never,
          );
        }
        const profileId = (
          api.getState() as unknown as {
            settings?: { profiles?: { activeProfileId?: string } };
          }
        )?.settings?.profiles?.activeProfileId;
        if (profileId !== undefined) {
          api.store?.dispatch(
            vortexActions.setModEnabled(
              profileId,
              vortexModId,
              restore.enable,
            ) as never,
          );
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
                  // the mod has left the setup and nothing will bring it back.
                  removed.has(o.item.id)
                  ? {
                      kind: "removed-not-reinstalled" as const,
                      mod: o.item,
                      why: o.why,
                    }
                  : { kind: "failed" as const, mod: o.item, why: o.why }
                : { kind: "unverified" as const, mod: o.item, why: o.why },
        ),
      }),
    );
    setTick((t) => t + 1);
  };

  const setEnabledFor = (targets: readonly CuratorMod[], to: boolean): void => {
    const profileId = (
      api.getState() as unknown as {
        settings?: { profiles?: { activeProfileId?: string } };
      }
    )?.settings?.profiles?.activeProfileId;
    const changes = planEnableChanges(targets, to);
    setNote(describeEnableChanges(changes));
    if (profileId === undefined) return;
    for (const change of changes) {
      api.store?.dispatch(
        vortexActions.setModEnabled(profileId, change.mod.id, change.to) as never,
      );
    }
    setTick((t) => t + 1);
  };

  const setTypeFor = (targets: readonly CuratorMod[], to: string): void => {
    const game = gameId;
    if (game === undefined) return;
    const changes = planTypeChanges(targets, to);
    setNote(describeTypeChanges(changes));
    for (const change of changes) {
      api.store?.dispatch(
        vortexActions.setModType(game, change.mod.id, change.to) as never,
      );
    }
    setTick((t) => t + 1);
  };



  /**
   * Apply the plan that is on screen — never a freshly computed one.
   *
   * The caller passes the very object the table rendered from, so what runs
   * is what was read. Re-planning here would act on something the curator
   * never saw, which is the whole point of the dry run.
   */
  const applyCleanup = async (plan: CleanupPlan): Promise<void> => {
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
        /**
         * ─── CONFIRM THE FILE IS THERE BEFORE CLAIMING TO FREE IT ───────
         * `rm(force: true)` swallows ENOENT, so a path that resolved to the
         * WRONG place — the compatible-download case puts a Skyrim LE file
         * under a different game's folder than the active one — succeeded
         * silently. The run then counted the archive's bytes as freed, told
         * the curator the disk was that much emptier, and dropped Vortex's
         * download record for a file still sitting on disk: the archive
         * becomes invisible to Vortex AND to this page, so nothing can
         * clean it up afterwards.
         *
         * Throwing instead puts it in `archivesFailed` with the path we
         * looked at, which is both honest about the bytes and the one piece
         * of information a bug report needs.
         */
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
        // Outside the throwing path on purpose. The file IS gone by here, so a
        // failed dispatch must not be reported as a failed deletion — that
        // would understate what was freed and describe a success as an error.
        // The worst case is a download entry Vortex still lists, which shows
        // up as "missing" rather than as lost disk.
        try {
          api.store?.dispatch(vortexActions.removeDownload(dlEntry.id) as never);
        } catch {
          /* the bytes are freed either way */
        }
      },
    });
    session.finish(describeCleanupOutcome(outcome));
    setRetire(new Set());
    setArchiveSel(new Set());
    setTick((t) => t + 1);
  };

  if (gameId === undefined) {
    return (
      <Card title="No active game">
        <p style={{ color: "var(--eh-text-secondary)" }}>
          Vortex is not managing a game right now, so there is no profile to act
          on.
        </p>
      </Card>
    );
  }

  return (
    <div className="eh-stack eh-stack--md">
      <div style={{ display: "flex", gap: "var(--eh-sp-3)", flexWrap: "wrap" }}>
        <Tile label="Mods" value={summary.total} />
        <Tile label="Enabled" value={summary.enabled} />
        <Tile label="Updatable" value={summary.updatable} intent="warning" />
        <Tile label="Frozen" value={summary.frozen} />
        <Tile
          label="Freeze broken"
          value={summary.frozenDrifted}
          intent="danger"
        />
        <Tile label="Unendorsed" value={summary.endorsable} />
        <Tile label="Duplicate groups" value={summary.duplicateGroups} />
      </div>

      <div style={{ display: "flex", gap: "var(--eh-sp-2)", flexWrap: "wrap" }}>
        <Button intent="ghost" onClick={(): void => void refreshUpdates()}>
          Re-check Nexus for updates
        </Button>
        <Button
          intent="ghost"
          onClick={(): void => {
            setTick((t) => t + 1);
            /**
             * Reload re-reads Vortex; it does not ask Nexus anything. When
             * nothing has changed on the machine, nothing on screen moves —
             * so with no feedback at all it was indistinguishable from a dead
             * button, and got reported as one. Say what was read.
             */
            setNote(
              `Re-read ${num(mods.length)} mod(s) from Vortex: ` +
                `${num(updatable.length)} updatable, ` +
                `${num(manualUpdates.length)} need a manual update, ` +
                `${num(frozen.length)} frozen. This reads Vortex only — use ` +
                `"Re-check Nexus for updates" to ask Nexus itself.`,
            );
          }}
        >
          Reload
        </Button>
        <Button
          intent="primary"
          disabled={busy !== undefined || updateRows.length === 0}
          onClick={(): void => void updateAll(updateRows)}
        >
          {busy === "update"
            ? "Updating..."
            : `Update ${describeTarget(
                updateAim ?? { ids: updatable.map((c) => c.mod.id), from: "all" },
                "mod",
              )}, one at a time`}
        </Button>
        <Button
          intent="ghost"
          disabled={busy !== undefined || endorsable.length === 0}
          onClick={(): void => void endorseAll()}
        >
          {busy === "endorse"
            ? "Endorsing..."
            : `Endorse ${num(endorsable.length)} mod(s)` +
              (endorseIsLong(endorsable.length)
                ? ` — ${describeEndorseDuration(endorsable.length)}`
                : "")}
        </Button>
      </div>

      {endorseIsLong(endorsable.length) && busy === undefined && (
        <p
          style={{
            margin: 0,
            padding: "var(--eh-sp-2)",
            borderLeft: "3px solid var(--eh-warning)",
            color: "var(--eh-text-secondary)",
            fontSize: "var(--eh-text-sm)",
          }}
        >
          Endorsing {num(endorsable.length)} mods takes{" "}
          {describeEndorseDuration(endorsable.length)} and cannot be stopped
          once it starts. Vortex gives no way to confirm an endorsement
          finished, so they are spaced {ENDORSE_PACE_MS}ms apart — sending
          them all at once is a rate-limit, not a faster result. Leave the page
          open while it runs.
        </p>
      )}

      {progress !== undefined && (
        <div
          style={{
            display: "flex",
            gap: "var(--eh-sp-2)",
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <p style={{ margin: 0, color: "var(--eh-text-primary)" }}>{progress}</p>
          {/*
            The stop this page has always claimed to have.

            `runSequentially` and `runCleanup` both check their signal between
            items and report `cancelled`; nothing ever aborted one, so the
            "Stopped early" line was unreachable code and a curator who
            started a 900-mod run had no way out but closing Vortex.

            It stops BETWEEN mods, never mid-install — interrupting Vortex
            halfway through writing a mod is how files get lost, which is the
            thing this whole page exists to avoid.
          */}
          {busy !== undefined && (
            <Button intent="ghost" onClick={(): void => session.cancel()}>
              Stop after this one
            </Button>
          )}
        </div>
      )}

      {lines.length > 0 && (
        <Card title="Update report">
          {lines.map((l) => (
            <p
              key={l}
              style={{
                margin: "0 0 var(--eh-sp-2)",
                color: l.includes("LOST")
                  ? "var(--eh-danger)"
                  : "var(--eh-text-secondary)",
              }}
            >
              {l}
            </p>
          ))}
          {/*
            The report OUTLIVES the run and the page now, so it needs a way
            to be put down — otherwise the last run's lines sit above the next
            one's forever, and a curator cannot tell which run they describe.
          */}
          {busy === undefined && (
            <Button intent="ghost" onClick={(): void => session.dismiss()}>
              Dismiss report
            </Button>
          )}
        </Card>
      )}

      {note !== undefined && (
        <p
          style={{
            margin: 0,
            padding: "var(--eh-sp-2)",
            borderLeft: "3px solid var(--eh-info)",
            color: "var(--eh-text-secondary)",
          }}
        >
          {note}
        </p>
      )}

      <Section
        title={`Updates available (${updatable.length})`}
        note={
          "Frozen mods are not listed here. Installing these is a separate " +
          "step and runs one mod at a time — Vortex's own bulk update runs " +
          "them concurrently, which is why it loses files."
        }
      >
        <DataTable
          rows={updatable}
          idOf={updateId}
          columns={UPDATE_COLUMNS}
          noun="update"
          limit={200}
          selection={{ selected: updateSel, onChange: setUpdateSel }}
          onTarget={setUpdateAim}
          empty={
            <p style={{ color: "var(--eh-text-secondary)", margin: 0 }}>
              Nothing to update, as far as Vortex currently knows. Re-check
              Nexus if that looks wrong.
            </p>
          }
          actions={(c): JSX.Element => (
            <Button
              size="sm"
              intent="ghost"
              onClick={(): void => setFrozen(c.mod, c.mod.version ?? "")}
            >
              Freeze here
            </Button>
          )}
        />

        {shadowed.length > 0 && (
          <div style={{ marginTop: "var(--eh-sp-3)" }}>
            <p
              style={{
                margin: "0 0 var(--eh-sp-1)",
                color: "var(--eh-text-secondary)",
                fontSize: "var(--eh-text-sm)",
              }}
            >
              {shadowed.length} older install(s) also have a newer file on
              Nexus and are deliberately NOT listed above — you already have a
              newer copy of each installed, so updating both would install the
              new file twice. Retire them under Disk cleanup instead.
            </p>
            <DataTable
              rows={shadowed}
              idOf={shadowId}
              columns={SHADOW_COLUMNS}
              noun="older install"
              limit={100}
              maxHeight={240}
            />
          </div>
        )}

        {manualUpdates.length > 0 && (
          <div style={{ marginTop: "var(--eh-sp-3)" }}>
            <p
              style={{
                margin: "0 0 var(--eh-sp-1)",
                padding: "var(--eh-sp-2)",
                borderLeft: "3px solid var(--eh-warning)",
                color: "var(--eh-text-secondary)",
                fontSize: "var(--eh-text-sm)",
              }}
            >
              {num(manualUpdates.length)} mod(s) have a newer version on Nexus
              that Event Horizon CANNOT update for you. Vortex knows the new
              version number but not which file it is — the update button
              needs a file id, and Nexus did not give it one. These are real
              updates; they just have to be done from the mod page. Nothing
              above is missing them, and nothing here is a duplicate of it.
            </p>
            <DataTable
              rows={manualUpdates}
              idOf={manualId}
              columns={MANUAL_COLUMNS}
              noun="manual update"
              limit={200}
              maxHeight={320}
            />
          </div>
        )}
      </Section>

      <Section
        title={`Frozen (${frozen.length})`}
        note={
          "A freeze keeps a mod out of this page's bulk update. It cannot stop " +
          "Vortex's own update button — Vortex has no such concept — so if the " +
          "version moves anyway, it is reported here rather than hidden."
        }
      >
        {frozen.length > 0 && (
          <div style={{ marginBottom: "var(--eh-sp-2)" }}>
            <Button
              size="sm"
              intent="ghost"
              disabled={busy !== undefined || frozenRows.length === 0}
              onClick={(): void => {
                for (const f of frozenRows) setFrozen(f.mod, undefined);
                setFrozenSel(new Set());
              }}
            >
              Unfreeze {describeTarget(
                frozenAim ?? { ids: frozen.map((f) => f.mod.id), from: "all" },
                "mod",
              )}
            </Button>
          </div>
        )}
        <DataTable
          rows={frozen}
          idOf={frozenId}
          columns={FROZEN_COLUMNS}
          noun="frozen mod"
          limit={200}
          maxHeight={320}
          selection={{ selected: frozenSel, onChange: setFrozenSel }}
          onTarget={setFrozenAim}
          empty={
            <p style={{ color: "var(--eh-text-secondary)", margin: 0 }}>
              Nothing frozen. Freeze a mod when its current version is the one
              your setup depends on.
            </p>
          }
          actions={(f): JSX.Element => (
            <Button
              size="sm"
              intent="ghost"
              onClick={(): void => setFrozen(f.mod, undefined)}
            >
              Unfreeze
            </Button>
          )}
        />
      </Section>

      <Section
        title={`Selected (${chosen.length} of ${mods.length})`}
        note={
          "Tick mods below, then act on all of them at once. Enabling and " +
          "setting a kind are state writes — Vortex re-deploys once at the " +
          "end. Reinstalling moves files, so it runs one mod at a time and " +
          "checks each against its archive before starting the next."
        }
      >
        <div
          style={{ display: "flex", gap: "var(--eh-sp-2)", flexWrap: "wrap" }}
        >
          <Button
            size="sm"
            intent="ghost"
            disabled={busy !== undefined || chosen.length === 0}
            onClick={(): void => setEnabledFor(chosen, true)}
          >
            Enable
          </Button>
          <Button
            size="sm"
            intent="ghost"
            disabled={busy !== undefined || chosen.length === 0}
            onClick={(): void => setEnabledFor(chosen, false)}
          >
            Disable
          </Button>
          <Button
            size="sm"
            intent="ghost"
            disabled={busy !== undefined || chosen.length === 0}
            onClick={(): void => void reinstall(chosen)}
          >
            {busy === "reinstall"
              ? "Reinstalling..."
              : `Reinstall ${chosen.length}`}
          </Button>
          <input
            aria-label="Mod kind"
            placeholder="mod kind, e.g. dinput"
            value={typeValue}
            onChange={(e): void => setTypeValue(e.target.value)}
            style={{
              background: "var(--eh-bg-deep)",
              border: "1px solid var(--eh-border-default)",
              borderRadius: "var(--eh-radius-sm)",
              color: "var(--eh-text-primary)",
              padding: "var(--eh-sp-1) var(--eh-sp-2)",
              fontFamily: "var(--eh-font-mono)",
              fontSize: "var(--eh-text-xs)",
            }}
          />
          <Button
            size="sm"
            intent="ghost"
            disabled={busy !== undefined || chosen.length === 0}
            onClick={(): void => setTypeFor(chosen, typeValue)}
          >
            Set kind
          </Button>
          <Button
            size="sm"
            intent="ghost"
            disabled={selected.size === 0}
            onClick={(): void => setSelected(new Set())}
          >
            Clear
          </Button>
        </div>

        <div style={{ marginTop: "var(--eh-sp-2)" }}>
          <DataTable
            rows={mods}
            idOf={curatorModId}
            columns={MOD_COLUMNS}
            noun="mod"
            limit={200}
            maxHeight={420}
            selection={{ selected, onChange: setSelected }}
          />
        </div>
      </Section>

      <Section
        title="Disk cleanup — 1. Orphaned archives"
        note={
          "Downloaded files that no installed mod points at, where a NEWER " +
          "version of that same file is installed — the same file, not merely " +
          "the same mod page, so an addon you never installed is never read " +
          "as an old version of the main file. Deleting these changes nothing " +
          "about your setup — it is only disk, and this is where almost all " +
          "the space is. Nothing is pre-ticked: the files are deleted " +
          "permanently, so you choose which."
        }
      >
        {orphans.length === 0 ? (
          <p style={{ color: "var(--eh-text-secondary)", margin: 0 }}>
            No orphaned archives. Every download is either in use by an
            installed mod, or is something with no installed version at all.
          </p>
        ) : (
          <>
            <div
              style={{
                display: "flex",
                gap: "var(--eh-sp-2)",
                flexWrap: "wrap",
                marginBottom: "var(--eh-sp-2)",
              }}
            >
              <Button
                intent="danger"
                disabled={busy !== undefined || archiveRemovals.length === 0}
                onClick={(): void =>
                  void (async (): Promise<void> => {
                    const ok = await confirm({
                      title: `Permanently delete ${num(
                        archiveRemovals.length,
                      )} archive(s)?`,
                      text:
                        `This frees ${formatSize(archiveBytes)} and cannot be ` +
                        `undone — the files are removed from disk, not sent ` +
                        `to the recycle bin, and Vortex has no undo.\n\n` +
                        `No mod is uninstalled and your profile does not ` +
                        `change. What you lose is the ability to reinstall ` +
                        `these exact files offline: each one would have to be ` +
                        `downloaded from Nexus again.`,
                      confirmLabel: "Delete",
                    });
                    if (!ok) return;
                    await applyCleanup(
                      cleanupSubset({
                        plan: orphanPlan,
                        removeMods: [],
                        deleteArchives: archiveRemovals,
                      }),
                    );
                  })()
                }
              >
                {busy === "cleanup"
                  ? "Deleting..."
                  : archiveRemovals.length === 0
                    ? "Tick the archives you want deleted"
                    : `Delete ${num(archiveRemovals.length)} ticked ` +
                      `archive(s) — frees ${formatSize(archiveBytes)}`}
              </Button>
              <span
                style={{
                  alignSelf: "center",
                  color: "var(--eh-text-secondary)",
                  fontSize: "var(--eh-text-sm)",
                }}
              >
                Deleted permanently, not recycled. Nothing is uninstalled.
              </span>
            </div>
            <DataTable
              rows={orphans}
              idOf={archiveId}
              columns={ARCHIVE_COLUMNS}
              noun="archive"
              limit={200}
              maxHeight={320}
              selection={{ selected: archiveSel, onChange: setArchiveSel }}
            />
          </>
        )}

        {orphanPlan.keptReferenced > 0 && (
          <p
            style={{
              margin: "var(--eh-sp-2) 0 0",
              color: "var(--eh-text-muted)",
              fontSize: "var(--eh-text-sm)",
            }}
          >
            {num(orphanPlan.keptReferenced)} archive(s) are not listed because
            an installed mod still points at them. Event Horizon hashes those
            when you build, so they are never candidates here.
          </p>
        )}

        {orphanPlan.staleLinked.length > 0 && (
          <p
            style={{
              margin: "var(--eh-sp-2) 0 0",
              padding: "var(--eh-sp-2)",
              borderLeft: "3px solid var(--eh-warning)",
              color: "var(--eh-text-secondary)",
              fontSize: "var(--eh-text-sm)",
            }}
          >
            {num(orphanPlan.staleLinked.length)} download(s) worth{" "}
            {formatSize(orphanPlan.staleLinkedBytes)} ARE the archives of mods
            you have installed, but Vortex has lost the link to them — which is
            what an in-place mod update leaves behind. They are kept and can
            never be deleted from here. The same broken link stops a build
            examining those mods{"'"} installers, so re-scanning the Downloads
            tab is worth doing before your next build.
          </p>
        )}

        {orphanPlan.unclearOrphans.length > 0 && (
          <p
            style={{
              margin: "var(--eh-sp-2) 0 0",
              padding: "var(--eh-sp-2)",
              borderLeft: "3px solid var(--eh-info)",
              color: "var(--eh-text-secondary)",
              fontSize: "var(--eh-text-sm)",
            }}
          >
            {num(orphanPlan.unclearOrphans.length)} more download(s) worth{" "}
            {formatSize(orphanPlan.unclearBytes)} have NO version of that mod
            installed. Those are not listed above and never selected: a file
            you downloaded on purpose and have not installed yet looks exactly
            like a leftover from here.
          </p>
        )}
      </Section>

      <Section
        title="Disk cleanup — 2. Old mod installs"
        note={
          "This one changes your setup, so nothing is pre-ticked. An install " +
          "is only listed here when Nexus's own update chain says it was " +
          "replaced, or when the same FILE is installed at a lower version — " +
          "sharing a mod page proves nothing on its own. Removing an install " +
          "frees its archive too."
        }
      >
        {retireCandidates.length === 0 ? (
          <p style={{ color: "var(--eh-text-secondary)", margin: 0 }}>
            No install has been replaced by another one you have installed.
          </p>
        ) : (
          <>
            <div
              style={{
                display: "flex",
                gap: "var(--eh-sp-2)",
                flexWrap: "wrap",
                marginBottom: "var(--eh-sp-2)",
              }}
            >
              <Button
                intent="danger"
                disabled={busy !== undefined || retirePlan.removeMods.length === 0}
                onClick={(): void =>
                  void (async (): Promise<void> => {
                    const alsoDeleted = archivesFreedByRemoval(retirePlan);
                    const ok = await confirm({
                      title: `Remove ${num(
                        retirePlan.removeMods.length,
                      )} install(s) from your setup?`,
                      text:
                        `Each is uninstalled from this profile, and the ` +
                        `${num(alsoDeleted.length)} archive(s) that frees are ` +
                        `then deleted from disk — ${formatSize(
                          freedByRetiring,
                        )} in total. Neither step can be undone.\n\n` +
                        `This CHANGES your setup. If any of these is not ` +
                        `really an old version — a patch or a variant from the ` +
                        `same mod page, say — you lose it and would have to ` +
                        `download it again. Removals happen first, and an ` +
                        `archive is only deleted once its install is gone.`,
                      confirmLabel: "Remove",
                    });
                    if (!ok) return;
                    await applyCleanup(
                      cleanupSubset({
                        plan: retirePlan,
                        removeMods: retirePlan.removeMods,
                        deleteArchives: alsoDeleted,
                      }),
                    );
                  })()
                }
              >
                {busy === "cleanup"
                  ? "Removing..."
                  : retirePlan.removeMods.length === 0
                    ? "Tick the installs you want removed"
                    : `Remove ${num(retirePlan.removeMods.length)} ticked ` +
                      `install(s) — frees ${formatSize(freedByRetiring)}`}
              </Button>
              {retire.size > 0 && (
                <Button
                  intent="ghost"
                  disabled={busy !== undefined}
                  onClick={(): void => setRetire(new Set())}
                >
                  Clear ticks
                </Button>
              )}
            </div>
            {provenRetire.length === 0 ? (
              <p style={{ color: "var(--eh-text-secondary)", margin: 0 }}>
                Nothing here is backed by evidence. Everything found only
                shares a mod page, and is listed below.
              </p>
            ) : (
              <DataTable
                rows={provenRetire}
                idOf={retireId}
                columns={RETIRE_COLUMNS}
                noun="older install"
                limit={200}
                maxHeight={320}
                selection={{ selected: retire, onChange: setRetire }}
              />
            )}

            {unprovenRetire.length > 0 && (
              <div style={{ marginTop: "var(--eh-sp-3)" }}>
                <p
                  style={{
                    margin: "0 0 var(--eh-sp-1)",
                    padding: "var(--eh-sp-2)",
                    borderLeft: "3px solid var(--eh-warning)",
                    color: "var(--eh-text-secondary)",
                    fontSize: "var(--eh-text-sm)",
                  }}
                >
                  {num(unprovenRetire.length)} more install(s) share a Nexus
                  page with a newer file and NOTHING ELSE. That is not an old
                  version — one page ships a main file, optional files,
                  variants and patches, so this is where
                  &ldquo;Bodypaints - CBBE&rdquo; sits next to
                  &ldquo;Bodypaints - Male&rdquo;. Listed so nothing is hidden;
                  tick one only if you know it yourself.
                </p>
                <DataTable
                  rows={unprovenRetire}
                  idOf={retireId}
                  columns={RETIRE_COLUMNS}
                  noun="unproven install"
                  limit={200}
                  maxHeight={280}
                  selection={{ selected: retire, onChange: setRetire }}
                />
              </div>
            )}
          </>
        )}
      </Section>

      <Section
        title={`Installed more than once (${duplicates.length})`}
        note={
          "Mods sharing a Nexus page. The same FILE twice is always redundant; " +
          "two different files from one page might be a main plus an optional, " +
          "so those are shown as something to look at rather than a verdict."
        }
      >
        {duplicates.length > 0 && (
          <div style={{ marginBottom: "var(--eh-sp-2)" }}>
            <Button
              size="sm"
              intent="ghost"
              disabled={dupGroups.length === 0}
              onClick={(): void => {
                // Into the main selection, where Disable / Reinstall / Set
                // kind already live. Deliberately NOT "delete the older one":
                // two files from one page can be a main plus an optional, and
                // this page does not guess which of those it is looking at.
                const next = new Set(selected);
                for (const group of dupGroups) {
                  for (const m of group.mods) next.add(m.id);
                }
                setSelected(next);
                setDupSel(new Set());
              }}
            >
              Add {describeTarget(
                dupAim ?? { ids: duplicates.map((g) => String(g.nexusModId)), from: "all" },
                "group",
              )} to the selection above
            </Button>
          </div>
        )}
        <DataTable
          rows={duplicates}
          idOf={duplicateId}
          columns={DUPLICATE_COLUMNS}
          noun="group"
          limit={200}
          maxHeight={320}
          selection={{ selected: dupSel, onChange: setDupSel }}
          onTarget={setDupAim}
          empty={
            <p style={{ color: "var(--eh-text-secondary)", margin: 0 }}>
              No mod is installed twice.
            </p>
          }
        />
      </Section>
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
      subtitle="Profile-wide actions, done one mod at a time."
    >
      <ErrorBoundary where="Curator Tools">
        <CuratorBody />
      </ErrorBoundary>
    </Page>
  );
}
