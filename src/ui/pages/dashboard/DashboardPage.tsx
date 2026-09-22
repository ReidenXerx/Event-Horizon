/**
 * The home dashboard's container: state, Vortex, disk and Nexus.
 *
 * The view next door is presentational and photographed by the render
 * harness; everything that can fail lives here, and each failure is local.
 * A Nexus call that never answers leaves the curator panel saying so while
 * every figure read off this machine still renders.
 */
import * as React from "react";

import { Button, Callout, Card, ProgressRing } from "../../components";
import { useApi } from "../../state";
import { ehLog } from "../../../core/logging/ehLog";
import { openExternalUrl } from "../../../core/revealPath";
import { DashboardView, type DashboardMode, type DashboardViewModel } from "./DashboardView";
import { toViewModel, useDashboardView } from "./useDashboardView";
import { collectionStats, type CollectionStats } from "../../../core/nexus/collectionStats";
import { since } from "./summary";
import type { EventHorizonRoute } from "../../routes";

export interface DashboardPageProps {
  onNavigate: (route: EventHorizonRoute) => void;
}

export function DashboardPage(props: DashboardPageProps): JSX.Element {
  const api = useApi();
  const { sources, error, reload } = useDashboardView(api);

  const [mode, setMode] = React.useState<DashboardMode>("player");
  const [disk, setDisk] = React.useState<DashboardViewModel["disk"]>(undefined);
  const [diskBusy, setDiskBusy] = React.useState(false);
  const [curatorBusy, setCuratorBusy] = React.useState(false);
  const [stats, setStats] = React.useState<Map<string, CollectionStats>>(new Map());

  /**
   * Nexus is asked only when the curator tab is actually opened, and then
   * once: these numbers change when the curator publishes or a player votes,
   * and an extension that polls a public API on a timer is how it gets rate
   * limited. "Refresh" is the button that asks again.
   */
  const loadStats = React.useCallback(
    (refresh: boolean): void => {
      if (sources === undefined) return;
      const links = sources.data.curatorConfigs
        .map((c) => c.config?.nexusCollection)
        .filter((l): l is NonNullable<typeof l> => l !== undefined);
      if (links.length === 0) return;
      setCuratorBusy(true);
      void (async (): Promise<void> => {
        const found = new Map<string, CollectionStats>();
        for (const link of links) {
          const s = await collectionStats({
            api,
            slug: link.slug,
            gameDomain: link.gameDomain,
            refresh,
          });
          if (s !== undefined) found.set(link.slug, s);
        }
        setStats(found);
        setCuratorBusy(false);
        ehLog("debug", "dashboard.curator-stats", { asked: links.length, answered: found.size });
      })();
    },
    [api, sources],
  );

  React.useEffect(() => {
    if (mode === "curator") loadStats(false);
  }, [mode, loadStats]);

  const measureDisk = React.useCallback((): void => {
    setDiskBusy(true);
    void (async (): Promise<void> => {
      try {
        const { measureModdingFootprint } = await import("./diskFootprint");
        const measured = await measureModdingFootprint(api);
        setDisk({
          parts: measured.parts,
          measuredWhen: since(new Date().toISOString()) ?? "just now",
        });
      } catch (err) {
        ehLog("warn", "dashboard.disk-measure-failed", { err });
      } finally {
        setDiskBusy(false);
      }
    })();
  }, [api]);

  if (error) {
    return (
      <div className="eh-page">
        <Callout
          tone="danger"
          title="Couldn't load the dashboard"
          actions={
            <Button intent="primary" onClick={reload}>
              Retry
            </Button>
          }
        >
          Nothing was changed. The log has the details.
        </Callout>
      </div>
    );
  }

  if (sources === undefined) {
    return (
      <div className="eh-page">
        <Card>
          <div className="eh-row eh-row--xl">
            <ProgressRing size={48} />
            <span className="eh-secondary">Reading your collections…</span>
          </div>
        </Card>
      </div>
    );
  }

  const vm = toViewModel({ sources, mode, disk, diskBusy, curatorBusy, curatorStats: stats });

  return (
    <div className="eh-page">
      <DashboardView
        vm={vm}
        actions={{
          onMode: setMode,
          onPlay: (): void => props.onNavigate("collections"),
          onOpenDoctor: (): void => props.onNavigate("doctor"),
          onOpenCollections: (): void => props.onNavigate("collections"),
          onOpenInstall: (): void => props.onNavigate("install"),
          onOpenBuild: (): void => props.onNavigate("build"),
          onMeasureDisk: measureDisk,
          onRefreshCurator: (): void => loadStats(true),
          onOpenCollectionPage: (slug): void => {
            const link = sources.data.curatorConfigs
              .map((c) => c.config?.nexusCollection)
              .find((l) => l?.slug === slug);
            if (link === undefined) return;
            void openExternalUrl(
              `https://www.nexusmods.com/games/${link.gameDomain}/collections/${link.slug}`,
            );
          },
        }}
      />
    </div>
  );
}
