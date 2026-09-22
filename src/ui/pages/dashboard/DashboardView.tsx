/**
 * The home dashboard.
 *
 * Presentational on purpose: every Vortex read, every file read and every
 * Nexus call happens in the container, and this takes a finished view model.
 * That is what lets the render harness photograph each state — a collection
 * with art, one without, a machine with nothing installed, a curator's
 * cockpit — without a running Vortex.
 *
 * ─── WHAT IT REFUSES TO DO ──────────────────────────────────────────────
 * Every figure here is read off a record, never estimated, and a number that
 * could not be established renders as "—" rather than as 0. A dashboard is
 * the most believable surface in the app: it is large, it is the first thing
 * opened, and nobody cross-checks it. A zero that means "not measured" would
 * be taken as a measurement.
 */
import * as React from "react";

import { Button, Callout, Card, Pill, Section } from "../../components";
import { Ring, Sparkline, SliceMap, StackBar, CHART_COLORS } from "../../components/charts";
import { since } from "./summary";
import type { HealthRollup, CollectionFigures } from "./summary";
import type { CollectionStats } from "../../../core/nexus/collectionStats";

export type DashboardMode = "player" | "curator";

export interface DashboardHeroView {
  packageId: string;
  name: string;
  version: string;
  revision: number | undefined;
  /** The curator's header image, as a URL the page can load. */
  artUrl: string | undefined;
  gameLabel: string;
  gameVersion: string | undefined;
  store: string | undefined;
  profileName: string | undefined;
  lastPlayed: string | undefined;
  installedWhen: string | undefined;
  health: HealthRollup;
  figures: CollectionFigures;
  /** The revision Nexus has, when it is newer than the installed one. */
  updateToRevision: number | undefined;
}

export interface CollectionTileView {
  packageId: string;
  name: string;
  version: string;
  gameLabel: string;
  artUrl: string | undefined;
  lastPlayed: string | undefined;
  updateToRevision: number | undefined;
}

export interface CuratorCollectionView {
  slug: string;
  name: string;
  gameLabel: string;
  stats: CollectionStats | undefined;
  /** Built packages for this collection, oldest first. */
  builds: { label: string; megabytes: number }[];
}

export interface DashboardViewModel {
  mode: DashboardMode;
  gameLabel: string;
  /** Whether Vortex has a game active at all — a normal state to be without. */
  hasGame: boolean;
  gameVersion: string | undefined;
  vortexVersion: string;
  profileName: string | undefined;
  hero: DashboardHeroView | undefined;
  tiles: CollectionTileView[];
  /** Absent until the player asks for it: measuring means walking the disk. */
  disk:
    | {
        parts: { label: string; gigabytes: number }[];
        /** When it was measured, so the card can age the label honestly. */
        measuredAtIso: string;
        /** Folders the walk could not read: the total is then a floor. */
        unreadable: string[];
      }
    | undefined;
  diskBusy: boolean;
  curator: CuratorCollectionView[];
  curatorBusy: boolean;
  /** Set when this machine has curated nothing, so the tab explains itself. */
  curatorEmpty: boolean;
}

export interface DashboardSlots {
  /**
   * Rendered in the hero, beside Play.
   *
   * The load-order badge lives here: it watches Vortex's own state, works
   * out whether THIS receipt's order is even the one to judge, and offers a
   * one-click re-apply. LOOT silently re-sorting between install and launch
   * is how a curated order drifts, and this is the moment a player can act
   * on it. It is a slot rather than a field on the view model because it is
   * a live component — the harness photographs the screen without it.
   */
  loadOrder?: React.ReactNode;
}

export interface DashboardActions {
  onMode: (mode: DashboardMode) => void;
  onPlay: () => void;
  onOpenDoctor: () => void;
  onOpenCollections: () => void;
  onOpenInstall: () => void;
  onOpenBuild: () => void;
  onMeasureDisk: () => void;
  onRefreshCurator: () => void;
  onOpenCollectionPage: (slug: string) => void;
}

const n = (v: number): string => v.toLocaleString("en-US");

/** The four counts are a partition; every figure about them uses the sum. */
const nativeTotal = (p: NonNullable<CollectionFigures["nativePlugins"]>): number =>
  p.loads + p.unverified + p.cannotLoad + p.unknown;

const describeNativePlugins = (
  p: NonNullable<CollectionFigures["nativePlugins"]>,
  gameVersion: string | undefined,
): string => {
  /*
   * A verdict about a game that is no longer installed is not a verdict
   * about this one. Said plainly rather than silently kept: a Fallout 4
   * player who took the next-gen update changed which script-extender
   * generation reads these plugins.
   */
  const judged = p.judgedFor?.version;
  if (judged !== undefined && gameVersion !== undefined && judged !== gameVersion) {
    return `judged for ${judged}, not your ${gameVersion}`;
  }
  if (p.cannotLoad > 0) return `${n(p.cannotLoad)} will not load`;
  const unsure = p.unverified + p.unknown;
  if (unsure > 0) return `${n(unsure)} could not be checked`;
  return "all load on your game";
};
/** A figure that was never established prints as an em dash, never as 0. */
const orDash = (v: number | undefined): string => (v === undefined ? "—" : n(v));

function Stat(props: { label: string; value: string; sub?: string; small?: boolean }): JSX.Element {
  return (
    <div className="eh-stat">
      <div className="eh-stat__key">{props.label}</div>
      <div className={props.small === true ? "eh-stat__value eh-stat__value--sm" : "eh-stat__value"}>
        {props.value}
      </div>
      {props.sub !== undefined && <div className="eh-stat__sub">{props.sub}</div>}
    </div>
  );
}

function ModeSwitch(props: { mode: DashboardMode; onMode: (m: DashboardMode) => void; curatorEmpty: boolean }): JSX.Element {
  return (
    <div className="eh-modes" role="tablist" aria-label="Dashboard mode">
      {(["player", "curator"] as const).map((m) => (
        <button
          key={m}
          type="button"
          role="tab"
          aria-selected={props.mode === m}
          className={props.mode === m ? "eh-mode eh-mode--on" : "eh-mode"}
          onClick={(): void => props.onMode(m)}
        >
          {m === "player" ? "Player" : "Curator"}
        </button>
      ))}
    </div>
  );
}

/**
 * The hero. With the curator's art behind it when there is art, and the ring
 * carrying the screen when there is not — the layout is identical either way.
 */
function Hero(props: {
  hero: DashboardHeroView;
  actions: DashboardActions;
  slots: DashboardSlots;
}): JSX.Element {
  const { hero } = props;
  const f = hero.figures;
  const health = hero.health;
  return (
    <div className="eh-dash-hero">
      {hero.artUrl !== undefined && <img className="eh-dash-hero__art" src={hero.artUrl} alt="" />}
      {hero.artUrl !== undefined && <div className="eh-dash-hero__scrim" />}
      <div className="eh-dash-hero__inner">
        <div className="eh-stat__key">{hero.lastPlayed !== undefined ? "Continue playing" : "Ready to play"}</div>
        <h2 className="eh-dash-hero__title">{hero.name}</h2>
        <div className="eh-secondary">
          v{hero.version}
          {hero.revision !== undefined ? ` · revision ${hero.revision}` : ""} · {hero.gameLabel}
          {hero.store !== undefined ? ` ${hero.store}` : ""}
          {hero.gameVersion !== undefined ? ` ${hero.gameVersion}` : ""}
          {hero.profileName !== undefined ? ` · profile “${hero.profileName}”` : ""}
          {hero.lastPlayed !== undefined ? ` · last played ${hero.lastPlayed}` : ""}
        </div>

        <div className="eh-dash-hero__stats">
          <button
            type="button"
            className="eh-plain-button"
            onClick={props.actions.onOpenDoctor}
            title="Open the Collection Doctor"
          >
            <Ring
              value={health.percent}
              size={110}
              tone={health.percent === undefined ? "brand" : health.tone}
              label={health.percent === undefined ? "unknown" : "healthy"}
              glow
            />
          </button>
          <Stat label="Mods" value={n(f.mods)} {...(f.failed > 0 ? { sub: `${f.failed} failed` } : {})} />
          <Stat label="Plugins" value={orDash(f.plugins)} {...(f.esl !== undefined ? { sub: `${n(f.esl)} ESL` } : {})} />
          {f.nativePlugins !== undefined && (
            /*
             * ONE denominator, the whole partition.
             *
             * "cannotLoad === 0" is not "all load" — it is "nothing was
             * PROVEN not to load", and the counts also carry plugins that
             * decide at startup and plugins nobody could judge. The old
             * subtitle stated the strong claim, and the card below used the
             * full partition, so one screen showed "236 / 238" at the top
             * and "236 of 242" in the middle for the same quantity.
             */
            <Stat
              label="SKSE plugins"
              value={`${n(f.nativePlugins.loads)} / ${n(nativeTotal(f.nativePlugins))}`}
              sub={describeNativePlugins(f.nativePlugins, hero.gameVersion)}
            />
          )}
          <Stat
            label="Verified"
            value={f.verifiedFiles > 0 ? n(f.verifiedFiles) : "—"}
            sub={f.verifiedFiles > 0 ? `files in ${n(f.verifiedMods)} mods` : "not verified"}
          />
        </div>

        <div className="eh-row eh-row--sm">
          <Button intent="primary" onClick={props.actions.onPlay}>
            ▶ Play
          </Button>
          {props.slots.loadOrder}
          <span className="eh-note">{health.caption}</span>
          {hero.updateToRevision !== undefined && (
            <Pill intent="warning">Update available: revision {hero.updateToRevision}</Pill>
          )}
          {f.versionMismatch !== undefined && (
            <Pill intent="warning">
              Installed on {f.versionMismatch.installed}, built on {f.versionMismatch.required}
            </Pill>
          )}
        </div>
      </div>
    </div>
  );
}

function CompositionCard(props: { figures: CollectionFigures }): JSX.Element {
  const f = props.figures;
  const parts = [
    { label: "From Nexus", value: f.fromNexus },
    { label: "You supplied", value: f.supplied },
  ];
  return (
    <Card title="What your game is made of">
      <div className="eh-stack eh-stack--sm">
        <div className="eh-stat__value">
          {n(f.mods)} <span className="eh-secondary">mods</span>
        </div>
        <StackBar parts={parts} />
        <div className="eh-legend">
          {parts.map((p, i) => (
            <span key={p.label} className="eh-legend__item">
              <i className="eh-legend__dot" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
              {p.label} {n(p.value)}
            </span>
          ))}
        </div>
        {f.plugins !== undefined && f.esl !== undefined && (
          <>
            <div className="eh-row eh-row--between">
              <span className="eh-secondary">ESL-flagged plugins</span>
              <span className="eh-secondary">
                {n(f.esl)} of {n(f.plugins)}
              </span>
            </div>
            <div className="eh-meter">
              <i style={{ width: `${Math.round((f.esl / Math.max(f.plugins, 1)) * 100)}%` }} />
            </div>
          </>
        )}
        {f.nativePlugins !== undefined && (
          <>
            <div className="eh-row eh-row--between">
              <span className="eh-secondary">Script-extender plugins that load</span>
              <span className="eh-secondary">
                {n(f.nativePlugins.loads)} of {n(nativeTotal(f.nativePlugins))}
              </span>
            </div>
            <div className="eh-meter">
              <i
                style={{
                  width: `${Math.round((f.nativePlugins.loads / Math.max(nativeTotal(f.nativePlugins), 1)) * 100)}%`,
                }}
              />
            </div>
            {f.nativePlugins.unverified > 0 && (
              <span className="eh-note">
                {n(f.nativePlugins.unverified)} decide at startup — the script extender's log names any that refuse.
              </span>
            )}
          </>
        )}
        <div className="eh-row eh-row--between">
          <span className="eh-secondary">Mod rules applied</span>
          <span className="eh-secondary">{orDash(f.rules)}</span>
        </div>
        <div className="eh-row eh-row--between">
          <span className="eh-secondary">LOOT rules applied</span>
          <span className="eh-secondary">{orDash(f.userlist)}</span>
        </div>
      </div>
    </Card>
  );
}

function DiskCard(props: { vm: DashboardViewModel; actions: DashboardActions }): JSX.Element {
  const { disk } = props.vm;
  return (
    <Card
      title="Disk"
      actions={
        <Button size="sm" intent="ghost" disabled={props.vm.diskBusy} onClick={props.actions.onMeasureDisk}>
          {props.vm.diskBusy ? "Measuring…" : disk === undefined ? "Measure" : "Measure again"}
        </Button>
      }
    >
      {disk === undefined ? (
        <p className="eh-note eh-prose">
          Nothing here is measured yet. Working out what modding uses means walking every staged file —
          hundreds of thousands of them on a large collection — so Event Horizon does it when you ask,
          not every time this page opens.
        </p>
      ) : (
        <div className="eh-stack eh-stack--sm">
          <div className="eh-stat__value">
            {/* "at least", when part of the disk could not be read. */}
            {disk.unreadable.length > 0 ? "at least " : ""}
            {disk.parts.reduce((a, p) => a + p.gigabytes, 0).toFixed(1)} GB{" "}
            <span className="eh-secondary">used by modding</span>
          </div>
          <SliceMap
            parts={disk.parts.map((p) => ({ label: p.label, value: p.gigabytes }))}
            format={(v) => `${v.toFixed(1)} GB`}
          />
          <span className="eh-note">
            Measured {since(disk.measuredAtIso) ?? "just now"}.
            {disk.unreadable.length > 0
              ? ` ${disk.unreadable.join(", ")} could not be read, so the real figure is higher.`
              : ""}
          </span>
        </div>
      )}
    </Card>
  );
}

function Tiles(props: { vm: DashboardViewModel; actions: DashboardActions }): JSX.Element | null {
  const { tiles } = props.vm;
  if (tiles.length === 0) return null;
  return (
    <div className="eh-dash-tiles">
      {tiles.map((t) => (
        <button key={t.packageId} type="button" className="eh-dash-tile" onClick={props.actions.onOpenCollections}>
          {t.artUrl !== undefined && <img className="eh-dash-tile__art" src={t.artUrl} alt="" />}
          <div className="eh-dash-tile__body">
            <div className="eh-strong">{t.name}</div>
            <div className="eh-note">
              v{t.version} · {t.gameLabel}
              {t.lastPlayed !== undefined ? ` · ${t.lastPlayed}` : ""}
            </div>
            {t.updateToRevision !== undefined && <Pill intent="warning">Revision {t.updateToRevision} available</Pill>}
          </div>
        </button>
      ))}
    </div>
  );
}

/**
 * The screen before there is anything to show.
 *
 * It is the first thing a new user sees, so it says what this page becomes
 * rather than only that it is empty — and it distinguishes the two reasons
 * it can be empty, because they need different actions. "No game selected"
 * is a normal Vortex state (every profile switch passes through it), and
 * telling that user to install a collection is advice they cannot take.
 */
function FirstRun(props: { vm: DashboardViewModel; actions: DashboardActions }): JSX.Element {
  const { vm, actions } = props;
  // The fact, not the label: a wording change must not silently flip this.
  const noGame = !vm.hasGame;
  return (
    <div className="eh-stack eh-stack--lg">
      <Callout
        tone="info"
        title={noGame ? "Pick a game in Vortex first" : "Nothing installed for this game yet"}
      >
        <div className="eh-stack eh-stack--sm">
          <p className="eh-body eh-prose">
            {noGame
              ? "Event Horizon works on the game Vortex has active — it reads that game's mods, " +
                "plugins and profiles. Choose one in Vortex and this page fills in."
              : `This is where your ${vm.gameLabel} collection will live: what it is made of, ` +
                "whether every file still checks out, whether its load order still matches, " +
                "and one button to play it."}
          </p>
          {!noGame && (
            <div className="eh-row eh-row--sm">
              <Button intent="primary" onClick={actions.onOpenInstall}>
                Install a collection
              </Button>
              <Button intent="ghost" onClick={actions.onOpenBuild}>
                Build one from this setup
              </Button>
            </div>
          )}
        </div>
      </Callout>

      {/*
        Shown rather than described: the same three panels this page will
        have, with what each will answer. An empty screen that only says
        "empty" teaches nothing about what the tool is for.
      */}
      <div className="eh-dash-grid">
        <Card title="What your game is made of">
          <p className="eh-note eh-prose">
            Every mod, where it came from, how many plugins are ESL-flagged, and which
            script-extender plugins actually load on your build of the game.
          </p>
        </Card>
        <Card title="Whether it is still whole">
          <p className="eh-note eh-prose">
            Files checked against what was installed, the load order against the one the curator
            tested, and a way into the Doctor for anything that has drifted.
          </p>
        </Card>
        <Card title="Disk">
          <p className="eh-note eh-prose">
            What modding uses on this machine — staged mods, downloads and built packages —
            measured when you ask for it.
          </p>
        </Card>
      </div>
    </div>
  );
}

function PlayerMode(props: {
  vm: DashboardViewModel;
  actions: DashboardActions;
  slots: DashboardSlots;
}): JSX.Element {
  const { vm, actions } = props;
  if (vm.hero === undefined) return <FirstRun vm={vm} actions={actions} />;
  return (
    <div className="eh-stack eh-stack--lg">
      <Hero hero={vm.hero} actions={actions} slots={props.slots} />
      <Tiles vm={vm} actions={actions} />
      <div className="eh-dash-grid">
        <CompositionCard figures={vm.hero.figures} />
        <DiskCard vm={vm} actions={actions} />
      </div>
    </div>
  );
}

function CuratorMode(props: { vm: DashboardViewModel; actions: DashboardActions }): JSX.Element {
  const { vm, actions } = props;
  if (vm.curatorEmpty) {
    return (
      <Callout tone="info" title="You have not built a collection here">
        <div className="eh-stack eh-stack--sm">
          <p className="eh-body eh-prose">
            Build one and this becomes its cockpit: how each revision was received on Nexus, how the package
            has grown, and what changed between builds.
          </p>
          <Button intent="primary" onClick={actions.onOpenBuild}>
            Build a collection
          </Button>
        </div>
      </Callout>
    );
  }
  return (
    <Section
      title="Your collections on Nexus"
      actions={
        <Button size="sm" intent="ghost" disabled={vm.curatorBusy} onClick={actions.onRefreshCurator}>
          {vm.curatorBusy ? "Refreshing…" : "Refresh"}
        </Button>
      }
    >
      <div className="eh-cockpit">
        {vm.curator.map((c) => (
          <Card key={c.slug} title={c.name}>
            <div className="eh-stack eh-stack--sm">
              <div className="eh-cockpit__stats">
                <Stat
                  label="Downloads"
                  value={orDash(c.stats?.totalDownloads)}
                  sub={c.stats?.totalDownloads === undefined ? "Vortex does not report this" : undefined}
                />
                <Stat label="Endorsements" value={orDash(c.stats?.endorsements)} />
                <Stat
                  label="Success"
                  value={c.stats?.ratingPercent === undefined ? "—" : `${Math.round(c.stats.ratingPercent)}%`}
                  sub={
                    c.stats === undefined
                      ? undefined
                      : c.stats.ratingCount === 0
                        ? "nobody has rated it yet"
                        : `${n(c.stats.ratingCount)} rating${c.stats.ratingCount === 1 ? "" : "s"}`
                  }
                />
                <Stat label="Revision" value={orDash(c.stats?.latestRevision)} />
              </div>

              {c.builds.length > 0 && (
                <>
                  <div className="eh-spark-row">
                    <span className="eh-stat__key">Package size per build</span>
                    <span className="eh-note">
                      {c.builds[0].label} → {c.builds[c.builds.length - 1].label}
                    </span>
                  </div>
                  <Sparkline points={c.builds.map((b) => ({ label: b.label, value: b.megabytes }))} />
                </>
              )}

              {c.stats !== undefined && c.stats.revisions.length > 0 && (
                <>
                  <div className="eh-spark-row">
                    <span className="eh-stat__key">Mods per revision</span>
                    <span className="eh-note">
                      #{c.stats.revisions[0].revisionNumber} → #{c.stats.revisions[c.stats.revisions.length - 1].revisionNumber}
                    </span>
                  </div>
                  <Sparkline
                    points={c.stats.revisions
                      .filter((r) => r.modCount !== undefined)
                      .map((r) => ({ label: `#${r.revisionNumber}`, value: r.modCount ?? 0 }))}
                    color={CHART_COLORS[2]}
                  />
                </>
              )}

              <div className="eh-row eh-row--sm">
                <Button size="sm" intent="ghost" onClick={(): void => actions.onOpenCollectionPage(c.slug)}>
                  Open on Nexus
                </Button>
                <span className="eh-note">{c.gameLabel}</span>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </Section>
  );
}

export function DashboardView(props: {
  vm: DashboardViewModel;
  actions: DashboardActions;
  slots?: DashboardSlots;
}): JSX.Element {
  const { vm, actions } = props;
  const slots = props.slots ?? {};
  return (
    <div className="eh-stack eh-stack--lg">
      <ModeSwitch mode={vm.mode} onMode={actions.onMode} curatorEmpty={vm.curatorEmpty} />
      {vm.mode === "player" ? (
        <PlayerMode vm={vm} actions={actions} slots={slots} />
      ) : (
        <CuratorMode vm={vm} actions={actions} />
      )}
    </div>
  );
}
