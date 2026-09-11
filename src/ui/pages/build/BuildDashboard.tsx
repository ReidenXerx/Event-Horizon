/**
 * BuildDashboard — Track 1 (parallel drafts).
 *
 * Curator-side landing view for the Build tab. Shows two flavours
 * of collection in one unified, filterable list:
 *
 *   • Drafts        — in-progress build forms persisted on disk
 *                     (`core/draftStorage`) plus any live sessions
 *                     in the `BuildSessionRegistry`.
 *   • Published     — collections the curator has built before,
 *                     identified by the per-collection config files
 *                     under `<appData>/event-horizon/collections/.config/`.
 *
 * Why one list with a filter pill instead of two tabs:
 *   - The two views answer the same question ("what am I working
 *     on?") at different points in time. A draft is "soon-to-be a
 *     published collection"; a published collection is "edited via
 *     a fresh draft". Tabs would force users to mentally context-
 *     switch when they're really doing one workflow.
 *   - Single list lets us show update-tracing inline: "Editing
 *     v1.2 → ..." badge on a draft linked to its source published
 *     collection.
 *
 * Actions per item:
 *   - Draft           → Open (enters wizard for that draftId)
 *                     → Discard (removes session + on-disk file)
 *   - Published       → Update (creates fresh draft pre-linked to
 *                       this slug+packageId, opens wizard)
 *                     → New variant (creates fresh draft NOT linked
 *                       — same workflow as "+ New draft", but seeded
 *                       from this published one's metadata defaults)
 *
 * Game pinning: drafts are pinned to a gameId at creation. The
 * dashboard surfaces drafts for the active game first; non-active-
 * game drafts render with a hint pill so the curator knows they
 * have to switch profiles to edit.
 */

import { selectors } from "@nexusmods/vortex-api";

import {
  describeCollectionDiff,
  diffCollectionAgainstProfile,
  isUnchanged,
} from "../../../core/curator/collectionDiff";
import { useApiOptional } from "../../state";
import * as React from "react";
import { util } from "@nexusmods/vortex-api";
import * as path from "path";
import { randomUUID } from "crypto";

import {
  deleteDraft,
  getAppDataPath,
  getDraftsRoot,
  listDrafts,
  type DraftEnvelope,
} from "../../../core/draftStorage";
import {
  deleteCollectionConfig,
  deletePublishedCollection,
  listNeverBuiltConfigs,
  listPublishedCollections,
  type PublishedCollectionSummary,
  type UnbuiltCollectionConfig,
} from "../../../core/manifest/collectionConfig";
import {
  profileFingerprint,
  scopeCollectionMods,
} from "../../../core/manifest/collectionScope";
import {
  getActiveGameId,
  getActiveProfileIdFromState,
  getModsForProfile,
} from "../../../core/getModsListForProfile";
import {
  Button,
  Callout,
  Card,
  Chip,
  EmptyState,
  LinkButton,
  Pill,
  ProgressRing,
  Section,
  useToast,
} from "../../components";
import { useApi } from "../../state";
import type { BuildDraftPayload } from "./buildSession";
import { getBuildSessionRegistry } from "./buildSessionRegistry";
import { slugify } from "./engine";
import {
  describeProfileDrift,
  isProfileUnmoved,
  profileDriftSince,
  type DriftMod,
} from "../../../core/curator/profileDrift";
import { formatRelativeTime } from "../dashboard/data";
import { getCollectionsDir, getVortexUserDataPath } from "../../../core/paths";
import {
  loadPublishedDetails,
  type PublishedDetails,
} from "./publishedDetails";
import { revealInFileManager } from "../../../core/revealPath";
import { ehLog } from "../../../core/logging/ehLog";

// ───────────────────────────────────────────────────────────────────────
// Public surface
// ───────────────────────────────────────────────────────────────────────

export interface BuildDashboardProps {
  /**
   * Open the wizard for the given draftId. The page is responsible
   * for ensuring the draft's session exists in the registry before
   * mounting the wizard (the dashboard does that here so the wizard
   * can `registry.get(draftId)` synchronously).
   */
  onOpenDraft: (draftId: string) => void;
}

type FilterKey = "all" | "drafts" | "published";

interface DashboardState {
  loading: boolean;
  drafts: Array<DraftEnvelope<BuildDraftPayload>>;
  published: PublishedCollectionSummary[];
  /** Configs that never produced a package. Invisible above; cleanable below. */
  unbuilt: UnbuiltCollectionConfig[];
  errors: string[];
}

// ───────────────────────────────────────────────────────────────────────
// Component
// ───────────────────────────────────────────────────────────────────────

/**
 * A build that finished during this session, offered back.
 *
 * Not a draft card. A finished build has no draft file — it deletes its own
 * on success — so wearing a draft's clothes gave it a phantom title and a
 * "discard" button for something that no longer existed. It is a different
 * thing and says so: what was built, when, and whether the profile it was
 * measured against still looks the same.
 *
 * "Open" costs nothing. The session still holds the mods, the hashes and
 * every divergence the done screen shows; rebuilding to see them again is
 * minutes of hashing for a result already in memory.
 */
export function RecentlyBuiltCard(props: {
  built: {
    name: string;
    version: string;
    modCount: number;
    outputBytes: number;
    builtAt: number;
    drift: ReturnType<typeof profileDriftSince>;
  };
  onOpen: () => void;
  onDismiss: () => void;
}): JSX.Element {
  const { built } = props;
  const moved = !isProfileUnmoved(built.drift);
  return (
    <div className="eh-card eh-stack eh-stack--sm">
      <div className="eh-row eh-row--baseline">
        <strong className="eh-strong">{built.name}</strong>
        <span className="eh-muted">v{built.version}</span>
        <Pill intent="success">built</Pill>
      </div>

      <div className="eh-muted">
        {built.modCount.toLocaleString()} mods ·{" "}
        {formatBytes(built.outputBytes)} · {formatRelativeTime(built.builtAt)}
      </div>

      <p className={moved ? "eh-body eh-tone--warning" : "eh-body"}>
        {describeProfileDrift(built.drift)}
        {moved
          ? " Reopening still works — the package is a record of what was built."
          : ""}
      </p>

      <div className="eh-row">
        <Button intent="primary" size="sm" onClick={props.onOpen}>
          Open build result
        </Button>
        <Button intent="ghost" size="sm" onClick={props.onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

export function BuildDashboard(props: BuildDashboardProps): JSX.Element {
  const api = useApi();
  const showToast = useToast();
  const registry = React.useMemo(() => getBuildSessionRegistry(), []);

  const [state, setState] = React.useState<DashboardState>({
    loading: true,
    drafts: [],
    published: [],
    unbuilt: [],
    errors: [],
  });
  const [filter, setFilter] = React.useState<FilterKey>("all");
  const [refreshTick, setRefreshTick] = React.useState(0);

  const refresh = React.useCallback((): void => {
    setRefreshTick((t) => t + 1);
  }, []);


  // Re-render whenever the registry mutates (a session changes state,
  // is added, removed). Keeps "Building..." pills live AND drives the
  // `items` useMemo below to re-merge unsaved sessions, so a brand-new
  // draft created via "+ New draft" appears immediately even before
  // its first autosave hits disk.
  const [registryTick, setRegistryTick] = React.useState(0);
  React.useEffect(() => {
    return registry.subscribe(() => {
      setRegistryTick((t) => t + 1);
    });
  }, [registry]);

  // Re-render when Vortex's own mod state moves, so "no mod changes" cannot
  // sit on screen after the curator installs or updates something in another
  // tab. The memo below is keyed on the state slices, but a memo only
  // re-evaluates during a render — without this, nothing schedules one.
  //
  // `onStateChange` returns no unsubscribe handle, so the callback is fenced
  // with an alive flag rather than removed. It goes inert on unmount; a
  // remount registers another. Small and bounded, and the alternative is a
  // dashboard that lies about whether there is anything to build.
  React.useEffect(() => {
    let alive = true;
    const bump = (): void => {
      if (alive) setRegistryTick((t) => t + 1);
    };
    try {
      api.onStateChange?.(["persistent", "mods"], bump);
      api.onStateChange?.(["persistent", "profiles"], bump);
    } catch {
      /* older Vortex without the hook — Refresh still works */
    }
    return (): void => {
      alive = false;
    };
  }, [api]);



  React.useEffect(() => {
    let alive = true;
    void (async (): Promise<void> => {
      setState((s) => ({ ...s, loading: true, errors: [] }));
      const errors: string[] = [];
      const appData = getAppDataPath();
      let drafts: Array<DraftEnvelope<BuildDraftPayload>> = [];
      try {
        drafts = await listDrafts<BuildDraftPayload>(appData, "build");
      } catch (err) {
        errors.push(
          `Couldn't list drafts: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const configDir = path.join(collectionsOutputDir(), ".config");
      const published = await listPublishedCollections(configDir, {
        onError: (filename, err) => {
          errors.push(
            `Couldn't read ${filename}: ${err instanceof Error ? err.message : String(err)}`,
          );
        },
      });

      const unbuilt = await listNeverBuiltConfigs(configDir, {
        onError: (filename, err) => {
          errors.push(
            `Couldn't read ${filename}: ${err instanceof Error ? err.message : String(err)}`,
          );
        },
      });

      if (!alive) return;
      setState({
        loading: false,
        drafts,
        published,
        unbuilt,
        errors,
      });
    })();
    return (): void => {
      alive = false;
    };
  }, [refreshTick]);

  const activeGameId = getActiveGameId(api.getState());

  // What the profile looks like RIGHT NOW, so a published collection can say
  // whether there is anything to update.
  //
  // Keyed on the STATE SLICES, not on a refresh counter. Keying it on ticks
  // read live Redux state inside a memo that only recomputed when something
  // unrelated changed, so updating three mods left the card still reading
  // "no mod changes" — the exact staleness this feature exists to report.
  // Vortex's store is immutable, so these two references change identity on
  // any install, removal or enable/disable, and nothing else does it.
  const liveState = api.getState();
  const activeProfileId =
    typeof activeGameId === "string" && activeGameId.length > 0
      ? getActiveProfileIdFromState(liveState, activeGameId)
      : undefined;
  const modsSlice = (liveState as unknown as {
    persistent?: { mods?: Record<string, unknown> };
  }).persistent?.mods?.[activeGameId ?? ""];
  const modStateSlice = (liveState as unknown as {
    persistent?: { profiles?: Record<string, { modState?: unknown }> };
  }).persistent?.profiles?.[activeProfileId ?? ""]?.modState;

  const currentFingerprint = React.useMemo<string | undefined>(() => {
    if (typeof activeGameId !== "string" || activeGameId.length === 0) return undefined;
    if (!activeProfileId) return undefined;
    try {
      const all = getModsForProfile(api.getState(), activeGameId, activeProfileId);
      const scope = scopeCollectionMods(all);
      const fp = profileFingerprint(scope.included);
      // Logged because this decides whether the curator is offered an Update,
      // and a wrong answer here is invisible — the card looks equally
      // confident either way. Cheap: one line per recompute, and recomputes
      // only happen when Vortex's mod state actually moves.
      ehLog("debug", "dashboard.profile-fingerprint", {
        gameId: activeGameId,
        profileId: activeProfileId,
        inProfile: all.length,
        enabled: scope.included.length,
        excludedDisabled: scope.excludedDisabled.length,
        excludedCollections: scope.excludedCollections.length,
        fingerprint: fp.slice(0, 16),
      });
      return fp;
    } catch {
      // Unknown beats wrong: without a fingerprint the card offers Update,
      // which is the safe default.
      return undefined;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, activeGameId, activeProfileId, modsSlice, modStateSlice]);

  // Both halves of the comparison, together. Either one alone is unfalsifiable
  // — a matching pair and a stale pair look identical from the outside.
  React.useEffect(() => {
    for (const pub of state.published) {
      ehLog("debug", "dashboard.update-check", {
        slug: pub.slug,
        builtVersion: pub.lastBuiltVersion,
        storedFingerprint: (pub.lastBuiltProfileFingerprint ?? "none").slice(0, 16),
        currentFingerprint: (currentFingerprint ?? "unknown").slice(0, 16),
        upToDate:
          currentFingerprint !== undefined &&
          pub.lastBuiltProfileFingerprint === currentFingerprint,
      });
    }
  }, [state.published, currentFingerprint]);

  // Slugs an open draft is relying on. Its config holds bundle ticks and
  // instructions the curator has not shipped yet, so cleanup must not touch
  // it — a tidy-up that eats unsaved work is worse than the clutter.
  const slugsInUse = React.useMemo<Set<string>>(() => {
    const used = new Set<string>();
    for (const env of state.drafts) {
      const linked = env.payload.linkedSlug;
      if (typeof linked === "string" && linked.length > 0) used.add(linked);
      const name = env.payload.curator?.name;
      if (typeof name === "string" && name.length > 0) used.add(slugify(name));
      const title = env.payload.title;
      if (typeof title === "string" && title.length > 0) used.add(slugify(title));
    }
    for (const session of registry.list()) {
      const st = session.getState();
      if (st.kind === "form" || st.kind === "queued" || st.kind === "building") {
        if (st.curator.name.length > 0) used.add(slugify(st.curator.name));
      }
    }
    return used;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.drafts, registry, registryTick]);

  const cleanable = React.useMemo(
    () => state.unbuilt.filter((c) => !slugsInUse.has(c.slug)),
    [state.unbuilt, slugsInUse],
  );

  const handleCleanupUnbuilt = async (): Promise<void> => {
    if (cleanable.length === 0) return;
    const names = cleanable.map((c) => c.slug).join(", ");
    const result = await api.showDialog?.(
      "question",
      `Remove ${cleanable.length} unused collection config${cleanable.length === 1 ? "" : "s"}?`,
      {
        text:
          `These were created by opening the Build page and never produced a ` +
          `package: ${names}.

They are not harmless clutter — a collection's ` +
          `name is its identity, so building under one of these names later ` +
          `would silently adopt its package id and release lineage instead of ` +
          `starting fresh. Removing them means such a build starts clean.

` +
          `Nothing you have built is affected, and any collection a draft is ` +
          `currently using has been left out.`,
      },
      [{ label: "Cancel" }, { label: "Remove" }],
    );
    if (result?.action !== "Remove") return;

    let removed = 0;
    for (const c of cleanable) {
      try {
        await deleteCollectionConfig(c.configPath);
        removed += 1;
      } catch {
        /* counted by omission; the toast reports what actually went */
      }
    }
    showToast({
      intent: removed === cleanable.length ? "success" : "warning",
      title: "Cleaned up",
      message:
        removed === cleanable.length
          ? `Removed ${removed} unused config${removed === 1 ? "" : "s"}.`
          : `Removed ${removed} of ${cleanable.length}; the rest could not be deleted.`,
    });
    refresh();
  };

  const publishedSlugs = React.useMemo(
    () => state.published.map((p) => p.slug),
    [state.published],
  );

  // ── Actions ────────────────────────────────────────────────────────

  const handleNewDraft = (): void => {
    if (typeof activeGameId !== "string" || activeGameId.length === 0) {
      showToast({
        intent: "warning",
        title: "No active game",
        message:
          "Switch to a Creation Engine game in Vortex first, then create a new draft.",
      });
      return;
    }
    const draftId = randomUUID();
    registry.ensure({ draftId, gameId: activeGameId });
    props.onOpenDraft(draftId);
  };

  const handleOpenDraft = (env: DraftEnvelope<BuildDraftPayload>): void => {
    const draftId = env.payload.draftId ?? env.key;
    const gameId = env.payload.gameId ?? activeGameId ?? "";
    if (gameId.length === 0) {
      showToast({
        intent: "warning",
        title: "No active game",
        message:
          "This draft predates game-pinning and Vortex has no active game. Switch to your game first.",
      });
      return;
    }
    registry.ensure({ draftId, gameId });
    props.onOpenDraft(draftId);
  };

  const handleDiscardDraft = async (
    env: DraftEnvelope<BuildDraftPayload>,
  ): Promise<void> => {
    const draftId = env.payload.draftId ?? env.key;
    const label =
      env.payload.title ??
      env.payload.curator?.name ??
      "Untitled draft";
    // Confirm before deleting — discard is destructive (the on-disk
    // payload is unrecoverable) and drafts can take real effort to
    // assemble (mod overrides, README, instructions). One stray
    // click on a 20-mod draft is a bad day.
    const result = await api.showDialog?.(
      "question",
      "Discard draft?",
      {
        text:
          `"${label}" will be permanently deleted from disk. This cannot ` +
          `be undone.`,
      },
      [
        { label: "Keep", default: true },
        { label: "Discard" },
      ],
    );
    if (result === undefined) return;
    if (result.action !== "Discard") return;
    // Drop the live session if any — there's nothing to come back to
    // since the disk file is being deleted.
    //
    // CANCEL FIRST. A session paused on the decisions gate is suspended on a
    // promise only that session can resolve; removing it from the registry
    // without cancelling strands the pipeline AND the global build slot, so
    // every later build queues behind a session nothing can reach. Restarting
    // Vortex was the only way out.
    registry.get(draftId)?.cancelBuilding();
    registry.remove(draftId);
    await deleteDraft(getAppDataPath(), "build", draftId);
    showToast({
      intent: "info",
      title: "Draft deleted",
      message: label,
    });
    refresh();
  };

  const handleDeletePublished = async (
    summary: PublishedCollectionSummary,
  ): Promise<void> => {
    const label = summary.lastBuiltName ?? summary.slug;
    // Deleting the config ends the release lineage — the packageId goes with
    // it, and a later build under the same name is a NEW collection as far as
    // any installer is concerned. That is not recoverable by rebuilding, so it
    // is worth a sentence and a confirmation rather than a bare "are you sure".
    const result = await api.showDialog?.(
      "question",
      `Delete "${label}"?`,
      {
        text:
          `This removes Event Horizon's record of this collection, including ` +
          `the package id that ties its releases together. Building "${label}" ` +
          `again afterwards starts a fresh lineage, and people who installed ` +
          `the old one will not be offered it as an update.\n\n` +
          `Any .ehcoll files you already built stay on disk — this does not ` +
          `delete them.`,
      },
      [{ label: "Cancel" }, { label: "Delete" }],
    );
    if (result?.action !== "Delete") return;

    try {
      await deletePublishedCollection(summary.configPath);
      showToast({
        intent: "success",
        title: "Collection deleted",
        message: `"${label}" is no longer tracked. Built files were left alone.`,
      });
    } catch (err) {
      showToast({
        intent: "danger",
        title: "Couldn't delete",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    refresh();
  };

  const handleUpdatePublished = (
    summary: PublishedCollectionSummary,
  ): void => {
    if (typeof activeGameId !== "string" || activeGameId.length === 0) {
      showToast({
        intent: "warning",
        title: "No active game",
        message:
          "Switch to the game this collection targets in Vortex, then click Update.",
      });
      return;
    }
    // Cross-game guard: the build pipeline derives `manifest.gameId`
    // from the active Vortex profile, so updating from the wrong
    // game would silently rewrite the manifest with a different
    // `gameId` than the published collection's previous releases —
    // breaking install-side compatibility. Refuse with a clear
    // message instead.
    //
    // Skip the gate when `summary.gameId === undefined` (legacy
    // configs that pre-date this field): we can't enforce something
    // we don't know. The PublishedCard renders a "legacy" hint in
    // that case so the curator sees what they're committing to.
    if (
      summary.gameId !== undefined &&
      summary.gameId.length > 0 &&
      summary.gameId !== activeGameId
    ) {
      showToast({
        intent: "warning",
        title: "Wrong active game",
        message:
          `"${summary.lastBuiltName ?? summary.slug}" was last built for ` +
          `${summary.gameId}, but Vortex's active game is ${activeGameId}. ` +
          `Switch profiles to ${summary.gameId} before clicking Update.`,
      });
      return;
    }
    const draftId = randomUUID();
    const session = registry.ensure({ draftId, gameId: activeGameId });
    // Pre-stage a draft envelope on disk so the wizard's begin() pass
    // restores `linkedSlug` / `linkedPackageId` and the autosave layer
    // keeps them. We can't push these into the session directly
    // because the session is in `idle` and has no `form` state yet.
    //
    // Caller-side autosave on the wizard's first form-state will
    // overwrite this with the full payload — but our linked fields
    // are only known here, so we seed them up front.
    void session; // we just need it created in the registry
    void (async (): Promise<void> => {
      const { saveDraft } = await import("../../../core/draftStorage");
      await saveDraft<BuildDraftPayload>(getAppDataPath(), "build", draftId, {
        draftId,
        gameId: activeGameId,
        title: summary.lastBuiltName ?? summary.slug,
        linkedSlug: summary.slug,
        linkedPackageId: summary.packageId,
        curator: {
          name: summary.lastBuiltName ?? "",
          version: bumpPatch(summary.lastBuiltVersion),
          // Carried from the last build. Blanking it here is what made the
          // author look like it never saved.
          author: summary.lastBuiltAuthor ?? "",
          description: "",
          // Left blank on purpose: the dashboard cannot read the installed
          // game version. The wizard fills it from detection on open.
          gameVersion: "",
          gameVersionPolicy: "exact",
        },
        overrides: {},
        readme: "",
        changelog: "",
      });
      // Refresh BEFORE navigating so a back-button trip lands on a
      // dashboard that already shows the new draft (and elides the
      // published row, since they're now linked). Otherwise the user
      // sees a stale list for ~one render after returning.
      refresh();
      props.onOpenDraft(draftId);
    })();
  };

  /**
   * Builds that finished this session and have not been dismissed.
   *
   * The result is already in memory — mods, hashes, divergences, every
   * decision the done screen offers. Recomputing it means re-hashing the
   * whole profile, so the only thing missing was a door back to it.
   *
   * Drift is measured against what Vortex reports NOW, and only reported:
   * the package on disk does not become wrong because a mod was enabled
   * afterwards, so this never blocks reopening.
   */
  const recentlyBuilt = React.useMemo(() => {
    const out: {
      draftId: string;
      gameId: string;
      name: string;
      version: string;
      modCount: number;
      outputBytes: number;
      builtAt: number;
      drift: ReturnType<typeof profileDriftSince>;
    }[] = [];
    for (const session of registry.list()) {
      const st = session.getState();
      if (st.kind !== "done") continue;

      let live: DriftMod[] = [];
      try {
        const vortexState = api.getState();
        const profileId = getActiveProfileIdFromState(vortexState, session.gameId);
        if (profileId !== undefined) {
          live = getModsForProfile(vortexState, session.gameId, profileId);
        }
      } catch {
        // No profile to compare against. The build is still reopenable —
        // it is a record of what happened, not a claim about now.
      }

      out.push({
        draftId: session.draftId,
        gameId: session.gameId,
        name: st.curator.name,
        version: st.curator.version,
        modCount: st.result.modCount,
        outputBytes: st.result.outputBytes,
        builtAt: st.builtAt,
        drift: profileDriftSince(st.ctx.mods as DriftMod[], live),
      });
    }
    return out.sort((a, b) => b.builtAt - a.builtAt);
    // `registryTick` is the handle: a build finishing must make this appear,
    // and Vortex's own mod-state watcher bumps the same tick, so drift is
    // re-measured when the curator changes something in another tab.
  }, [registry, registryTick, api]);

  const handleOpenBuilt = (draftId: string, gameId: string): void => {
    registry.ensure({ draftId, gameId });
    props.onOpenDraft(draftId);
  };

  const handleDismissBuilt = (draftId: string): void => {
    const session = registry.list().find((s) => s.draftId === draftId);
    session?.reset();
    registry.remove(draftId);
  };

  // ── Filtering / merging ────────────────────────────────────────────

  const items = React.useMemo<DashboardItem[]>(() => {
    // 1. Start with the on-disk drafts (envelope shape).
    const draftEnvelopes: Array<DraftEnvelope<BuildDraftPayload>> = [
      ...state.drafts,
    ];
    const seenDraftIds = new Set<string>(
      draftEnvelopes.map((d) => d.payload.draftId ?? d.key),
    );

    // 2. Merge in any registry sessions that haven't yet autosaved
    //    to disk. Without this, brand-new drafts ("+ New draft" →
    //    user navigates back before the first autosave fires) are
    //    invisible on the dashboard until they save, which makes
    //    the registry feel unreliable.
    //
    //    Synthesise a minimal envelope so the renderer can treat
    //    them uniformly. We use `now` as `savedAt` so they sort to
    //    the top (which is correct: the user just opened them).
    const now = new Date().toISOString();
    for (const session of registry.list()) {
      if (seenDraftIds.has(session.draftId)) continue;
      seenDraftIds.add(session.draftId);
      // Pull whatever the session already knows. For a fresh draft
      // this is just gameId; for a draft that's loaded its form
      // state we surface the title + version too so the placeholder
      // doesn't read "Untitled".
      const sessionState = session.getState();
      // A finished build deletes its own draft file on purpose — the
      // collection it produced is the published card. The session lingers in
      // the registry, though, and synthesising an envelope for it conjured a
      // card reading "Untitled draft · autosaved just now" seconds after a
      // successful build: no title (a `done` session exposes no form state),
      // no file behind it, and a "discard" button for a draft that no longer
      // exists. It looked exactly like a second collection nobody created.
      // Still skipped HERE — a finished build is not a draft and must not
      // wear a draft's card. It gets its own section instead; see
      // `recentlyBuilt` below.
      if (sessionState.kind === "done") continue;
      const formish: Partial<BuildDraftPayload> = {};
      if (
        sessionState.kind === "form" ||
        sessionState.kind === "queued" ||
        sessionState.kind === "building"
      ) {
        formish.curator = {
          name: sessionState.curator.name,
          version: sessionState.curator.version,
          author: sessionState.curator.author,
          description: sessionState.curator.description,
          gameVersion: sessionState.curator.gameVersion,
          gameVersionPolicy: sessionState.curator.gameVersionPolicy,
        };
      }
      draftEnvelopes.unshift({
        version: 2,
        savedAt: now,
        scope: "build",
        key: session.draftId,
        payload: {
          draftId: session.draftId,
          gameId: session.gameId,
          ...formish,
        } as BuildDraftPayload,
      });
    }
    // Re-sort by savedAt desc so freshly-merged sessions land first
    // but real disk drafts retain their relative order.
    draftEnvelopes.sort((a, b) =>
      a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0,
    );

    return pairDraftsWithPublished(draftEnvelopes, state.published, filter);
    // `registry` is a stable singleton; `registryTick` is the
    // observable surface that flips on session add/remove/state
    // change and forces the merge to re-evaluate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.drafts, state.published, filter, registryTick]);

  // ── Render ─────────────────────────────────────────────────────────

  if (state.loading) {
    return (
      <div className="eh-page">
        <DashboardHeader
          activeGameId={activeGameId}
          counts={{ drafts: 0, published: 0 }}
          filter={filter}
          onFilter={setFilter}
          onNewDraft={handleNewDraft}
          onRefresh={refresh}
          newDraftDisabled={true}
          loading={true}
        />
        <div className="eh-card eh-centred">
          <ProgressRing size={48} />
          <span className="eh-secondary">
            Listing drafts and published collections...
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="eh-page">
      <DashboardHeader
        activeGameId={activeGameId}
        counts={{
          drafts: state.drafts.length,
          published: state.published.length,
        }}
        filter={filter}
        onFilter={setFilter}
        onNewDraft={handleNewDraft}
        onRefresh={refresh}
        newDraftDisabled={
          typeof activeGameId !== "string" || activeGameId.length === 0
        }
      />

      <div className="eh-stack eh-stack--lg">
        {state.errors.length > 0 && (
          <Callout
            tone="danger"
            title={`${state.errors.length} item${state.errors.length === 1 ? "" : "s"} failed to load.`}
          >
            <ul className="eh-list">
              {state.errors.slice(0, 5).map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </Callout>
        )}

        {recentlyBuilt.length > 0 && (
          <Section title="Built this session" size="sm">
            <div className="eh-grid" style={{ ["--eh-grid-min" as string]: "320px" }}>
              {recentlyBuilt.map((b) => (
                <RecentlyBuiltCard
                  key={b.draftId}
                  built={b}
                  onOpen={(): void => handleOpenBuilt(b.draftId, b.gameId)}
                  onDismiss={(): void => handleDismissBuilt(b.draftId)}
                />
              ))}
            </div>
          </Section>
        )}

        {items.length === 0 && recentlyBuilt.length === 0 ? (
          <EmptyState
            title="No drafts or published collections yet"
            actions={
              <Button intent="primary" size="lg" onClick={handleNewDraft}>
                + New draft
              </Button>
            }
          >
            Start a new draft to capture your active profile as an Event
            Horizon collection. Drafts autosave while you edit, and you
            can keep several in flight at once — one per collection
            you're working on.
          </EmptyState>
        ) : items.length === 0 ? (
          <></>
        ) : (
          <div className="eh-grid" style={{ ["--eh-grid-min" as string]: "320px" }}>
            {items.map((item) =>
              item.kind === "draft" ? (
                <DraftCard
                  key={`draft:${item.env.key}`}
                  env={item.env}
                  activeGameId={activeGameId}
                  registrySessionStateKind={
                    registry
                      .get(item.env.payload.draftId ?? item.env.key)
                      ?.getState().kind
                  }
                  {...(item.superseded !== undefined
                    ? {
                        linkedPublished: {
                          builtVersion: item.superseded.lastBuiltVersion,
                          profileChanged:
                            currentFingerprint !== undefined &&
                            item.superseded.lastBuiltProfileFingerprint !==
                              currentFingerprint,
                        },
                      }
                    : {})}
                  onOpen={(): void => handleOpenDraft(item.env)}
                  onDiscard={(): void => {
                    void handleDiscardDraft(item.env);
                  }}
                />
              ) : (
                <PublishedCard
                  key={`pub:${item.summary.slug}`}
                  summary={item.summary}
                  upToDate={
                    currentFingerprint !== undefined &&
                    item.summary.lastBuiltProfileFingerprint === currentFingerprint
                  }
                  knownSlugs={publishedSlugs}
                  onUpdate={(): void => handleUpdatePublished(item.summary)}
                  onDelete={(): void => {
                    void handleDeletePublished(item.summary);
                  }}
                />
              ),
            )}
          </div>
        )}

        {cleanable.length > 0 && (
          <div className="eh-row">
            <span className="eh-muted">
              {cleanable.length} unused collection config
              {cleanable.length === 1 ? "" : "s"} ({cleanable.map((c) => c.slug).join(", ")})
              — created by opening the Build page, never built.
            </span>
            <Button
              intent="ghost"
              size="sm"
              onClick={(): void => {
                void handleCleanupUnbuilt();
              }}
            >
              Clean up
            </Button>
          </div>
        )}
        <DraftsRootHint />
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Sub-components
// ───────────────────────────────────────────────────────────────────────

function DashboardHeader(props: {
  activeGameId: string | undefined;
  counts: { drafts: number; published: number };
  filter: FilterKey;
  onFilter: (k: FilterKey) => void;
  onNewDraft: () => void;
  onRefresh: () => void;
  newDraftDisabled?: boolean;
  loading?: boolean;
}): JSX.Element {
  return (
    <header className="eh-page__header">
      <div className="eh-page__heading">
        <h2 className="eh-page__title">Build a collection</h2>
        <p className="eh-page__subtitle">
          {props.loading
            ? "Loading..."
            : `${props.counts.drafts} draft${
                props.counts.drafts === 1 ? "" : "s"
              } · ${props.counts.published} published`}
          {props.activeGameId !== undefined && (
            <>
              {" · active game: "}
              <strong className="eh-strong">
                {props.activeGameId}
              </strong>
            </>
          )}
        </p>
      </div>
      <div className="eh-stack eh-stack--sm eh-stack--end">
        <div className="eh-row">
          <Button intent="ghost" onClick={props.onRefresh}>
            Refresh
          </Button>
          <Button
            intent="primary"
            onClick={props.onNewDraft}
            disabled={props.newDraftDisabled}
            title={
              props.newDraftDisabled
                ? "Switch to a supported game in Vortex first."
                : undefined
            }
          >
            + New draft
          </Button>
        </div>
        <div className="eh-row">
          {(["all", "drafts", "published"] as FilterKey[]).map((k) => (
            <Chip
              key={k}
              active={props.filter === k}
              onClick={(): void => props.onFilter(k)}
            >
              {k === "all" ? "All" : k === "drafts" ? "Drafts" : "Published"}
            </Chip>
          ))}
        </div>
      </div>
    </header>
  );
}

type DashboardItem =
  | {
      kind: "draft";
      env: DraftEnvelope<BuildDraftPayload>;
      /** Set when this draft hides a published collection's card. */
      superseded?: PublishedCollectionSummary;
    }
  | { kind: "published"; summary: PublishedCollectionSummary };

/**
 * Pair drafts with the published collections they update, and decide what the
 * list shows.
 *
 * Pure, exported and tested because this small rule has produced two separate
 * user-visible bugs:
 *
 *  1. A draft linked to a published collection HIDES that collection's card —
 *     reasonable, the draft is its in-flight update. But the published card
 *     was the only thing that ever said "your mods have changed since this was
 *     built", so hiding it took the answer away along with the question. The
 *     dashboard knew (its own log said `upToDate: false`) and showed a card
 *     that mentioned none of it. Hence `superseded` on the draft.
 *
 *  2. The hiding also applied to the "Published" FILTER, so the header counted
 *     a collection ("1 draft · 1 published") that the tab then refused to
 *     render — and Edit / Details / Show files / Delete were unreachable for
 *     as long as any draft existed. De-duplication belongs to the combined
 *     view; a filter is an explicit request for exactly that thing.
 */
export function pairDraftsWithPublished(
  drafts: ReadonlyArray<DraftEnvelope<BuildDraftPayload>>,
  published: readonly PublishedCollectionSummary[],
  filter: FilterKey,
): DashboardItem[] {
  const supersededByDraftKey = new Map<string, PublishedCollectionSummary>();
  for (const pub of published) {
    const linked = drafts.find(
      (d) => d.payload.linkedPackageId === pub.packageId,
    );
    if (linked !== undefined) supersededByDraftKey.set(linked.key, pub);
  }

  const out: DashboardItem[] = [];
  for (const env of drafts) {
    const superseded = supersededByDraftKey.get(env.key);
    out.push({
      kind: "draft",
      env,
      ...(superseded !== undefined ? { superseded } : {}),
    });
  }
  for (const pub of published) {
    const hidden =
      filter === "all" &&
      drafts.some((d) => d.payload.linkedPackageId === pub.packageId);
    if (hidden) continue;
    out.push({ kind: "published", summary: pub });
  }

  if (filter === "drafts") return out.filter((i) => i.kind === "draft");
  if (filter === "published") return out.filter((i) => i.kind === "published");
  return out;
}

/** Exported for the render harness only — see {@link PublishedCard}. */
export function DraftCard(props: {
  env: DraftEnvelope<BuildDraftPayload>;
  activeGameId: string | undefined;
  registrySessionStateKind: string | undefined;
  /**
   * The published collection this draft supersedes on the dashboard.
   *
   * When a draft is linked to a published collection, that collection's card
   * is HIDDEN — the draft is its in-flight update, and showing both is noise.
   * But the published card is also the only thing that ever said "your profile
   * has changed since this was built", so hiding it silently took the answer
   * away with the question: the dashboard knew the profile had moved, said
   * `upToDate: false` in its own log, and showed a card that mentioned none of
   * it. Passing the fact here is what keeps the signal alive.
   */
  linkedPublished?: {
    builtVersion: string | undefined;
    /** Profile differs from the one that produced the published build. */
    profileChanged: boolean;
  };
  onOpen: () => void;
  onDiscard: () => void;
}): JSX.Element {
  const { env, activeGameId, registrySessionStateKind } = props;
  const payload = env.payload;
  const title =
    payload.title ??
    payload.curator?.name ??
    "Untitled draft";
  const gameId = payload.gameId ?? env.key;
  // The same fact the published card branches on, read from the same prop,
  // so the two cards cannot start disagreeing about whether there is
  // anything to do.
  const hasUnbuiltChanges = props.linkedPublished?.profileChanged === true;
  const draftMatchesGame = activeGameId === gameId;
  const liveStatus = registrySessionStateKind ?? "idle";
  return (
    <Card
      title={title}
      footer={
        <span className="eh-muted">
          autosaved {relativeTime(env.savedAt)}
        </span>
      }
    >
      <div className="eh-stack eh-stack--sm">
        <div className="eh-row">
          <Pill intent="info">draft</Pill>
          <Pill intent="neutral">{gameId}</Pill>
          {!draftMatchesGame && (
            <Pill intent="warning">switch to {gameId}</Pill>
          )}
          {liveStatus === "loading" && <Pill intent="info">loading</Pill>}
          {liveStatus === "queued" && <Pill intent="info">queued</Pill>}
          {liveStatus === "building" && (
            <Pill intent="info" withDot>
              building
            </Pill>
          )}
          {liveStatus === "error" && <Pill intent="danger">error</Pill>}
          {liveStatus === "done" && <Pill intent="success">built</Pill>}
        </div>
        {payload.linkedSlug !== undefined && (
          <div className="eh-muted">
            <strong>Updates:</strong> {payload.linkedSlug}
            {props.linkedPublished?.builtVersion !== undefined && (
              <> v{props.linkedPublished.builtVersion}</>
            )}
            {payload.curator?.version !== undefined && (
              <> → v{payload.curator.version}</>
            )}
          </div>
        )}
        {props.linkedPublished?.profileChanged === true && (
          // The whole reason this prop exists. Said on the draft card because
          // the published card that used to say it is not on screen.
          <div className="eh-tone--warning">
            Your mods have changed since{" "}
            {props.linkedPublished.builtVersion !== undefined
              ? `v${props.linkedPublished.builtVersion}`
              : "the last build"}{" "}
            — press Update and build to include them.
          </div>
        )}
        {payload.curator?.version !== undefined &&
          payload.linkedSlug === undefined && (
            <div>
              <strong>Version:</strong> v{payload.curator.version || "—"}
            </div>
          )}
        {/* One vocabulary across both card kinds.

            These were full-size amber buttons beside a published card using
            small ghost ones, so two cards in the same list shouted at
            different volumes for equivalent actions — and said different words
            for the same act. "Open" is what the button did; "Edit" is what the
            published card calls the identical thing, and a dashboard that
            names one act two ways makes the reader check whether they are
            actually different.

            The amber is not decoration and is not spent on "there is a draft
            here". It marks that there is something to ACT on — mods moved
            since the last build — which is exactly when the published card
            turns its Edit into an amber Update. Nothing changed, nothing
            loud. */}
        <div className="eh-row">
          <Button
            intent={hasUnbuiltChanges ? "primary" : "ghost"}
            size="sm"
            onClick={props.onOpen}
            disabled={!draftMatchesGame}
            title={
              draftMatchesGame
                ? undefined
                : `Switch Vortex to ${gameId} to open this draft.`
            }
          >
            {hasUnbuiltChanges ? "Update" : "Edit"}
          </Button>
          {/* Kept away from Open — the two are one careless click apart
              otherwise, and a discarded draft is unrecoverable. Named for its
              object so it cannot be confused with "Delete collection" on a
              published card, which ends a release lineage rather than losing
              an afternoon's typing. */}
          <span className="eh-row__spacer" />
          <Button intent="ghost" size="sm" onClick={props.onDiscard}>
            Discard draft
          </Button>
        </div>
      </div>
    </Card>
  );
}

function DetailRow(props: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="eh-kv">
      <span className="eh-kv__label">{props.label}</span>
      <span className="eh-fill">{props.children}</span>
    </div>
  );
}

const formatBytes = (n: number): string =>
  n >= 1024 ** 3
    ? `${(n / 1024 ** 3).toFixed(2)} GB`
    : `${(n / 1024 ** 2).toFixed(1)} MB`;

/**
 * Read-only view of a published collection. Loads on first open, not on
 * render — reading a package means unzipping its manifest, which is not
 * something every card on the dashboard should do unasked.
 */
/**
 * Where builds land: `<VortexUserData>/event-horizon/collections`.
 *
 * The same three segments are joined in five places across the codebase. This
 * is not the fix for that, but the reveal button must not become the sixth
 * independent copy — if the output directory ever moves, a button that opens
 * the old one is worse than no button.
 */
function collectionsOutputDir(): string {
  return getCollectionsDir();
}

/**
 * Open the folder a collection's packages are in, highlighting the newest one
 * when we can find it.
 *
 * The lookup is best-effort and the button works without it: revealing the
 * folder is the promise, and pointing at the exact file is the bonus. Failing
 * to read the directory should not turn "open my builds folder" into an error.
 */
async function revealPublished(
  summary: PublishedCollectionSummary,
  knownSlugs: readonly string[],
): Promise<ReturnType<typeof revealInFileManager>> {
  const folderPath = collectionsOutputDir();
  let filePath: string | undefined;
  try {
    const { findBuiltPackages } = await import("./publishedDetails");
    const packages = await findBuiltPackages(folderPath, summary.slug, knownSlugs);
    filePath = packages[0]?.fullPath;
  } catch {
    /* no highlight, still open the folder */
  }
  return revealInFileManager({ filePath, folderPath });
}

function PublishedDetailsPanel(props: {
  summary: PublishedCollectionSummary;
  /** Every published slug, so a shared prefix cannot mis-claim a build. */
  knownSlugs: readonly string[];
}): JSX.Element {
  const [details, setDetails] = React.useState<PublishedDetails | undefined>();
  const [error, setError] = React.useState<string | undefined>();
  const api = useApiOptional();

  /**
   * What a rebuild would ship, against what the last one did.
   *
   * The card already knew the profile had MOVED — `upToDate` is a boolean —
   * and could say nothing about how. This is the how, computed only while the
   * details are open so a dashboard listing ten collections does not diff ten
   * manifests against the profile on every render.
   */
  const diff = React.useMemo(() => {
    const shippedMods = details?.shippedMods;
    if (shippedMods === undefined || api === undefined) return undefined;
    try {
      const state = api.getState();
      const gameId = selectors.activeGameId(state);
      if (typeof gameId !== "string" || gameId === "") return undefined;
      const profileId = getActiveProfileIdFromState(state, gameId);
      if (profileId === undefined) return undefined;
      return diffCollectionAgainstProfile({
        built: shippedMods,
        current: getModsForProfile(state, gameId, profileId),
      });
    } catch {
      // A diff that cannot be computed is simply not shown. It is context for
      // a decision, never a gate on making one.
      return undefined;
    }
  }, [details, api]);

  React.useEffect(() => {
    let alive = true;
    void (async (): Promise<void> => {
      try {
        const { loadOrCreateCollectionConfig } = await import(
          "../../../core/manifest/collectionConfig"
        );
        const outputDir = collectionsOutputDir();
        const { config } = await loadOrCreateCollectionConfig({
          configDir: path.join(outputDir, ".config"),
          slug: props.summary.slug,
        });
        const loaded = await loadPublishedDetails({
          summary: props.summary,
          config,
          outputDir,
          knownSlugs: props.knownSlugs,
        });
        if (alive) setDetails(loaded);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return (): void => {
      alive = false;
    };
  }, [props.summary, props.knownSlugs]);

  if (error !== undefined) {
    return <div className="eh-tone--warning">Couldn't read details: {error}</div>;
  }
  if (details === undefined) {
    return <div className="eh-muted">Reading...</div>;
  }

  const s = details.shipped;
  return (
    <div className="eh-stack eh-stack--sm eh-divider-top">
      {/* What the last package actually contains. */}
      {s !== undefined ? (
        <>
          <DetailRow label="Shipped">
            v{s.version} — {s.mods} mods, {s.plugins} plugins
            {s.bundledArchives > 0 ? `, ${s.bundledArchives} bundled archives` : ""}
          </DetailRow>
          {diff !== undefined && (
            <div className="eh-inset eh-inset--deep eh-stack eh-stack--sm">
              <div className={isUnchanged(diff) ? undefined : "eh-tone--warning"}>
                {describeCollectionDiff(diff)}
              </div>
              {!isUnchanged(diff) && (
                <div className="eh-mono eh-scroll">
                  {diff.added.slice(0, 40).map((e) => (
                    <div key={`+${e.name}`} className="eh-tone--success">
                      + {e.name}
                      {e.version !== undefined ? ` ${e.version}` : ""}
                    </div>
                  ))}
                  {diff.removed.slice(0, 40).map((e) => (
                    <div key={`-${e.name}`} className="eh-tone--danger">
                      &minus; {e.name}
                      {e.version !== undefined ? ` ${e.version}` : ""}
                    </div>
                  ))}
                  {diff.updated.slice(0, 40).map((e) => (
                    <div key={`~${e.name}`} className="eh-tone--warning">
                      ~ {e.name} {e.fromVersion} &rarr; {e.toVersion}
                    </div>
                  ))}
                  {diff.reconfigured.slice(0, 40).map((e) => (
                    <div key={`r${e.name}`} className="eh-tone--warning">
                      ! {e.name}{" "}
                      {e.reason === "installer-options"
                        ? "installer options changed"
                        : "staged files changed"}
                    </div>
                  ))}
                  {diff.toggled.slice(0, 40).map((e) => (
                    <div key={`t${e.name}`} className="eh-secondary">
                      {e.nowEnabled ? "on " : "off"} {e.name}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <DetailRow label="Requires">
            {s.gameId} {s.gameVersion === "unknown" ? "(no version recorded)" : s.gameVersion}
            {s.gameVersion !== "unknown" &&
              ` (${s.gameVersionPolicy === "exact" ? "exactly" : "or newer"})`}
          </DetailRow>
          <DetailRow label="Verification">{s.verificationLevel}</DetailRow>
          <DetailRow label="Author">{s.author.length > 0 ? s.author : "not set"}</DetailRow>
        </>
      ) : (
        <div className="eh-muted">{details.shippedNote}</div>
      )}

      {/* What the config will do on the NEXT build — not always the same thing. */}
      <DetailRow label="External mods">
        {details.externalModCount} known
        {details.bundledMods.length > 0
          ? `, ${details.bundledMods.length} set to bundle (${details.bundledMods
              .slice(0, 3)
              .join(", ")}${details.bundledMods.length > 3 ? ", ..." : ""})`
          : ", none set to bundle"}
      </DetailRow>
      {details.modsWithInstructions.length > 0 && (
        <DetailRow label="Instructions on">
          {details.modsWithInstructions.slice(0, 3).join(", ")}
          {details.modsWithInstructions.length > 3 ? ", ..." : ""}
        </DetailRow>
      )}
      <DetailRow label="Prerequisites">
        {details.prerequisites.length > 0 ? details.prerequisites.join(", ") : "none declared"}
      </DetailRow>
      <DetailRow label="Docs">
        {[details.hasReadme ? "README" : undefined, details.hasChangelog ? "CHANGELOG" : undefined]
          .filter(Boolean)
          .join(" + ") || "none"}
      </DetailRow>

      <DetailRow label="Slug">{props.summary.slug}</DetailRow>
      <DetailRow label="Identity">
        <code className="eh-mono">{props.summary.packageId}</code>
      </DetailRow>
      <DetailRow label="Builds on disk">
        {details.packages.length === 0
          ? "none"
          : details.packages
              .slice(0, 4)
              .map((pkg) => `${pkg.fileName} (${formatBytes(pkg.bytes)})`)
              .join(", ")}
        {details.packages.length > 4 ? `, +${details.packages.length - 4} more` : ""}
      </DetailRow>
    </div>
  );
}

/**
 * Exported for the render harness only — nothing else imports it.
 *
 * The dashboard itself cannot be screenshotted: it mounts in a loading state
 * and fills in from an effect, which static rendering never runs, so a capture
 * of the whole page shows a skeleton. The cards ARE the dashboard's content,
 * and they take their data as props, so rendering them directly shows the real
 * screen without needing a DOM environment.
 */
export function PublishedCard(props: {
  summary: PublishedCollectionSummary;
  /**
   * `true` only when we KNOW the enabled-mod set is the same as the one this
   * collection last shipped. `undefined` fingerprints mean unknown, and
   * unknown offers Update — never suppress an action on a guess.
   */
  upToDate: boolean;
  /** Every published slug, so a shared prefix cannot mis-claim a build. */
  knownSlugs: readonly string[];
  onUpdate: () => void;
  onDelete: () => void;
}): JSX.Element {
  const { summary, upToDate } = props;
  const title = summary.lastBuiltName ?? summary.slug;
  const [showDetails, setShowDetails] = React.useState(false);
  const [revealError, setRevealError] = React.useState<string | undefined>();
  return (
    <Card
      title={title}
      footer={
        <span className="eh-muted">
          {summary.lastBuiltAt !== undefined
            ? `last built ${relativeTime(summary.lastBuiltAt)}`
            : "never built"}
        </span>
      }
    >
      <div className="eh-stack eh-stack--sm">
        <div className="eh-row">
          <Pill intent="success">published</Pill>
          {summary.lastBuiltVersion !== undefined && (
            <Pill intent="info">v{summary.lastBuiltVersion}</Pill>
          )}
          {upToDate && <Pill intent="neutral">no mod changes</Pill>}
        </div>
        {upToDate && (
          // Kept, not dropped: the check is membership-only, so a curator who
          // edited a file inside a mod is looking at "no mod changes" while
          // holding a real change. Saying what was compared is the difference
          // between a helpful default and a wrong one — it is just said in one
          // line now instead of four, because a paragraph on every up-to-date
          // card is what made this view feel heavy.
          <div className="eh-note">
            Same mods as when v{summary.lastBuiltVersion} was built. Edits to
            files inside a mod are not detected — rebuild if you made any.
          </div>
        )}
        {/*
          The other branch said NOTHING, and it covers two situations that
          deserve different answers. "Update" appearing bare left the curator
          unable to tell "your mods changed" from "we have no idea" — and the
          second is the case for any collection built before fingerprints were
          recorded.

          The distinction is available right here: an absent fingerprint IS the
          unknown case. Offering Update either way stays as it was, per this
          component's own rule that unknown must never suppress an action; only
          the silence is fixed.
        */}
        {!upToDate && (
          <div className="eh-note">
            {summary.lastBuiltProfileFingerprint === undefined
              ? "This collection was built before Event Horizon recorded which mods were enabled, so it cannot tell whether anything changed since. Update rebuilds it from your profile as it is now."
              : `Your enabled mods differ from when v${summary.lastBuiltVersion ?? "?"} was built. Update rebuilds the collection from your profile as it is now.`}
          </div>
        )}
        {/* Slug moved into Details: it is the on-disk identity, useful when
            something goes wrong and noise the rest of the time. */}
        {/* Two GROUPS, not four buttons and a spacer.
            A spacer works by margin-left:auto, which only pushes to the end of
            the line the element lands on — so as soon as four buttons stopped
            fitting on one line, "Show files" was carried down next to Delete
            and the row read as an arbitrary 2x2. Grouping makes the wrap
            meaningful: the routine actions stay together and Delete drops as
            its own unit, still at the far edge, still separated. */}
        <div className="eh-row eh-row--split">
          <div className="eh-row">
            {/* Both of these OPEN THE EDITOR — `handleUpdatePublished` creates
                a draft and navigates; nothing is built until the curator
                presses Build inside it. "Rebuild anyway" said otherwise, which
                is why this card looked like it had no way to just open the
                collection: the button that opens it was named after a step it
                does not take. "Update" survives because it names the WORKFLOW
                the curator is starting, and the card already says whether
                there is anything to update. */}
            {upToDate ? (
              <Button intent="ghost" size="sm" onClick={props.onUpdate}>
                Edit
              </Button>
            ) : (
              <Button intent="primary" size="sm" onClick={props.onUpdate}>
                Update
              </Button>
            )}
            <Button
              intent="ghost"
              size="sm"
              onClick={(): void => setShowDetails((v) => !v)}
            >
              {showDetails ? "Hide details" : "Details"}
            </Button>
            {/* The package is the thing the curator hands to someone else, and
                until now there was no way to reach it from here — you had to
                know the path. */}
            <Button
              intent="ghost"
              size="sm"
              onClick={(): void => {
                void (async (): Promise<void> => {
                  const outcome = await revealPublished(
                    summary,
                    props.knownSlugs,
                  );
                  if (outcome.kind === "failed") setRevealError(outcome.why);
                })();
              }}
            >
              Show files
            </Button>
          </div>
          {/* Names its OBJECT, and is the only danger-styled BUTTON on this
              page — deliberately. (An error Pill also uses the danger intent;
              that is a status, not an action.)

              "Delete" here and "Discard" on a draft card were two identical
              ghost buttons for very different blast radii. This one ends the
              release lineage: the packageId goes with it, so a later build
              under the same name is a new collection and everyone who
              installed the old one stops being offered updates. That reaches
              other people's machines and cannot be undone by rebuilding.
              Discarding a draft loses typing, on one computer, recoverable by
              retyping.
              
              Danger is an OUTLINE here, not a filled red block: loud enough to
              read differently at a glance, quiet enough not to shout on a card
              that is otherwise calm. */}
          <Button intent="danger" size="sm" onClick={props.onDelete}>
            Delete collection
          </Button>
        </div>
        {revealError !== undefined && (
          <div className="eh-note" role="alert">
            Could not open the folder: {revealError}. The packages are in{" "}
            <span className="eh-mono">{collectionsOutputDir()}</span>.
          </div>
        )}
        {showDetails && (
          <PublishedDetailsPanel summary={summary} knownSlugs={props.knownSlugs} />
        )}
      </div>
    </Card>
  );
}

function DraftsRootHint(): JSX.Element {
  const [shown, setShown] = React.useState(false);
  return (
    <div className="eh-stack eh-stack--xs eh-small">
      <LinkButton variant="xs" tone="muted" onClick={(): void => setShown((s) => !s)}>
        {shown ? "Hide" : "Show"} draft folder location
      </LinkButton>
      {shown && (
        <div className="eh-mono">{getDraftsRoot(getAppDataPath())}</div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────

/**
 * Best-effort patch-bump for "Update from published" pre-fill.
 *
 *   "1.2.3"          → "1.2.4"
 *   "1.2.3-rc.1"     → "1.2.4"   (drops the pre-release suffix —
 *                                  the curator is shipping a new
 *                                  release, not iterating the rc)
 *   "1.2.3+build.7"  → "1.2.4"   (drops build metadata too)
 *   "1.2.3.4"        → "1.2.4"   (truncates to semver)
 *
 * Curators can edit the version anyway, so we just nudge them in
 * the right direction on open. Returns "1.0.0" for missing or
 * unparseable versions; if the regex doesn't match a leading
 * `MAJOR.MINOR.PATCH` we hand back the original string untouched
 * so we don't overwrite a hand-rolled scheme with a meaningless
 * default.
 */
function bumpPatch(version: string | undefined): string {
  if (typeof version !== "string" || version.length === 0) return "1.0.0";
  // Anchor at start; allow `-prerelease` and `+build` suffixes
  // (semver-ish) to follow without polluting the bumped output.
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (m === null) {
    // Fallback for "1.2.3.4" or other non-semver shapes — match a
    // leading triple and bump it, leaving the user to clean up.
    const loose = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
    if (loose === null) return version;
    const patch = Number.parseInt(loose[3], 10);
    if (!Number.isFinite(patch)) return version;
    return `${loose[1]}.${loose[2]}.${patch + 1}`;
  }
  const major = m[1];
  const minor = m[2];
  const patch = Number.parseInt(m[3], 10);
  if (!Number.isFinite(patch)) return version;
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * Compact relative time for autosave / build timestamps. Avoids
 * pulling in Intl.RelativeTimeFormat (Vortex-host quirks) in favour
 * of a deterministic tiny formatter — accuracy beyond "a few hours
 * ago" doesn't matter for this UI.
 */
function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const ms = Date.now() - t;
  const sec = Math.round(ms / 1000);
  if (sec < 30) return "just now";
  if (sec < 90) return "a minute ago";
  const min = Math.round(sec / 60);
  if (min < 45) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  // Beyond a month, fall back to a date string — no point pretending
  // we know "3 months ago" precisely.
  return new Date(t).toLocaleDateString();
}
