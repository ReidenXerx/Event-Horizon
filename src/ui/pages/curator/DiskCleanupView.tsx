/**
 * Disk cleanup: orphaned archives and superseded installs.
 *
 * Moved out of the page whole, with its copy intact — every sentence here
 * was written against a specific mistake (see cleanupPlan.ts and the
 * curator-tools memory: the planner once deleted patches installed on
 * purpose, so NOTHING is pre-ticked). This is a view of the workbench, not
 * a separate feature, so it shares the page's confirmer and session.
 */

import * as React from "react";

import {
  archivesFreedByRemoval,
  cleanupSubset,
  describeEvidence,
  findSupersededMods,
  formatSize,
  orphanArchives,
  planCleanup,
  provenSupersedes,
  tickedArchives,
  unprovenSupersedes,
  type CleanupPlan,
  type DownloadEntry,
} from "../../../core/curator/cleanupPlan";
import type { CuratorMod } from "../../../core/curator/profileActions";
import { Button, Callout, Card, DataTable, Pill, type Column } from "../../components";

const num = (n: number): string => n.toLocaleString();

type RetireRow = ReturnType<typeof findSupersededMods>[number];
type ArchiveRow = CleanupPlan["deleteArchives"][number];

const shownVersion = (v: string | undefined): string => v ?? "unknown";
const stateOf = (mod: CuratorMod): string => (mod.enabled ? "enabled" : "disabled");

const RETIRE_COLUMNS: Column<RetireRow>[] = [
  { key: "name", header: "Older install", value: (c) => c.mod.name },
  {
    key: "version",
    header: "Version",
    width: 190,
    value: (c) => `${shownVersion(c.mod.version)} → ${shownVersion(c.supersededBy.version)}`,
  },
  { key: "newer", header: "Replaced by", value: (c) => c.supersededBy.name },
  {
    key: "evidence",
    header: "Why",
    match: "exact",
    width: 200,
    value: (c) => describeEvidence(c.evidence),
    render: (c) => (
      <Pill intent={c.evidence === "same-page-only" ? "warning" : "neutral"}>
        {describeEvidence(c.evidence)}
      </Pill>
    ),
  },
  { key: "state", header: "State", match: "exact", width: 110, value: (c) => stateOf(c.mod) },
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

const retireId = (c: RetireRow): string => c.mod.id;
const archiveId = (a: ArchiveRow): string => a.entry.id;

export type Confirmer = (args: { title: string; text: string; confirmLabel: string }) => Promise<boolean>;

export function DiskCleanupView(props: {
  mods: readonly CuratorMod[];
  downloads: readonly DownloadEntry[];
  busy: boolean;
  confirm: Confirmer;
  applyCleanup: (plan: CleanupPlan) => Promise<void>;
}): JSX.Element {
  const { mods, downloads, busy, confirm, applyCleanup } = props;
  const [retire, setRetire] = React.useState<ReadonlySet<string>>(new Set());
  const [archiveSel, setArchiveSel] = React.useState<ReadonlySet<string>>(new Set());

  const retireCandidates = React.useMemo(() => findSupersededMods(mods), [mods]);
  const provenRetire = React.useMemo(() => provenSupersedes(retireCandidates), [retireCandidates]);
  const unprovenRetire = React.useMemo(() => unprovenSupersedes(retireCandidates), [retireCandidates]);
  const orphanPlan = React.useMemo(() => planCleanup({ mods, downloads }), [mods, downloads]);
  const retirePlan = React.useMemo(
    () => planCleanup({ mods, downloads, removeModIds: retire }),
    [mods, downloads, retire],
  );
  const orphans = React.useMemo(() => orphanArchives(orphanPlan), [orphanPlan]);
  const archiveRemovals = React.useMemo(() => tickedArchives(orphans, archiveSel), [orphans, archiveSel]);
  const archiveBytes = React.useMemo(
    () => archiveRemovals.reduce((n, a) => n + a.entry.bytes, 0),
    [archiveRemovals],
  );
  const freedByRetiring = React.useMemo(
    () => archivesFreedByRemoval(retirePlan).reduce((n, a) => n + a.entry.bytes, 0),
    [retirePlan],
  );

  const run = async (plan: CleanupPlan): Promise<void> => {
    await applyCleanup(plan);
    setRetire(new Set());
    setArchiveSel(new Set());
  };

  return (
    <div className="eh-stack eh-stack--lg">
      <Card
        title="Orphaned archives"
        subtitle={
          "Downloaded files that no installed mod points at, where a NEWER " +
          "version of that same file is installed — the same file, not merely " +
          "the same mod page, so an addon you never installed is never read " +
          "as an old version of the main file. Deleting these changes nothing " +
          "about your setup — it is only disk, and this is where almost all " +
          "the space is. Nothing is pre-ticked: the files are deleted " +
          "permanently, so you choose which."
        }
      >
        <div className="eh-stack eh-stack--sm">
          {orphans.length === 0 ? (
            <p className="eh-body">
              No orphaned archives. Every download is either in use by an installed mod, or is
              something with no installed version at all.
            </p>
          ) : (
            <>
              <div className="eh-row">
                <Button
                  intent="danger"
                  disabled={busy || archiveRemovals.length === 0}
                  onClick={(): void =>
                    void (async (): Promise<void> => {
                      const ok = await confirm({
                        title: `Permanently delete ${num(archiveRemovals.length)} archive(s)?`,
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
                      await run(
                        cleanupSubset({ plan: orphanPlan, removeMods: [], deleteArchives: archiveRemovals }),
                      );
                    })()
                  }
                >
                  {busy
                    ? "Working…"
                    : archiveRemovals.length === 0
                      ? "Tick the archives you want deleted"
                      : `Delete ${num(archiveRemovals.length)} ticked archive(s) — frees ${formatSize(archiveBytes)}`}
                </Button>
                <span className="eh-note">Deleted permanently, not recycled. Nothing is uninstalled.</span>
              </div>
              <DataTable
                rows={orphans}
                idOf={archiveId}
                columns={ARCHIVE_COLUMNS}
                tableId="curator.cleanup.archives"
                noun="archive"
                limit={200}
                maxHeight={320}
                selection={{ selected: archiveSel, onChange: setArchiveSel }}
              />
            </>
          )}

          {orphanPlan.keptReferenced > 0 && (
            <span className="eh-note">
              {num(orphanPlan.keptReferenced)} archive(s) are not listed because an installed mod
              still points at them. Event Horizon hashes those when you build, so they are never
              candidates here.
            </span>
          )}

          {orphanPlan.staleLinked.length > 0 && (
            <Callout tone="warning">
              {num(orphanPlan.staleLinked.length)} download(s) worth{" "}
              {formatSize(orphanPlan.staleLinkedBytes)} ARE the archives of mods you have
              installed, but Vortex has lost the link to them — which is what an in-place mod
              update leaves behind. They are kept and can never be deleted from here. The same
              broken link stops a build examining those mods{"'"} installers, so re-scanning the
              Downloads tab is worth doing before your next build.
            </Callout>
          )}

          {orphanPlan.unclearOrphans.length > 0 && (
            <Callout tone="info">
              {num(orphanPlan.unclearOrphans.length)} more download(s) worth{" "}
              {formatSize(orphanPlan.unclearBytes)} have NO version of that mod installed. Those
              are not listed above and never selected: a file you downloaded on purpose and have
              not installed yet looks exactly like a leftover from here.
            </Callout>
          )}
        </div>
      </Card>

      <Card
        title="Old mod installs"
        subtitle={
          "This one changes your setup, so nothing is pre-ticked. An install " +
          "is only listed here when Nexus's own update chain says it was " +
          "replaced, or when the same FILE is installed at a lower version — " +
          "sharing a mod page proves nothing on its own. Removing an install " +
          "frees its archive too."
        }
      >
        <div className="eh-stack eh-stack--sm">
          {retireCandidates.length === 0 ? (
            <p className="eh-body">No install has been replaced by another one you have installed.</p>
          ) : (
            <>
              <div className="eh-row">
                <Button
                  intent="danger"
                  disabled={busy || retirePlan.removeMods.length === 0}
                  onClick={(): void =>
                    void (async (): Promise<void> => {
                      const alsoDeleted = archivesFreedByRemoval(retirePlan);
                      const ok = await confirm({
                        title: `Remove ${num(retirePlan.removeMods.length)} install(s) from your setup?`,
                        text:
                          `Each is uninstalled from this profile, and the ` +
                          `${num(alsoDeleted.length)} archive(s) that frees are ` +
                          `then deleted from disk — ${formatSize(freedByRetiring)} in total. Neither step can be undone.\n\n` +
                          `This CHANGES your setup. If any of these is not ` +
                          `really an old version — a patch or a variant from the ` +
                          `same mod page, say — you lose it and would have to ` +
                          `download it again. Removals happen first, and an ` +
                          `archive is only deleted once its install is gone.`,
                        confirmLabel: "Remove",
                      });
                      if (!ok) return;
                      await run(
                        cleanupSubset({
                          plan: retirePlan,
                          removeMods: retirePlan.removeMods,
                          deleteArchives: alsoDeleted,
                        }),
                      );
                    })()
                  }
                >
                  {busy
                    ? "Working…"
                    : retirePlan.removeMods.length === 0
                      ? "Tick the installs you want removed"
                      : `Remove ${num(retirePlan.removeMods.length)} ticked install(s) — frees ${formatSize(freedByRetiring)}`}
                </Button>
                {retire.size > 0 && (
                  <Button intent="ghost" disabled={busy} onClick={(): void => setRetire(new Set())}>
                    Clear ticks
                  </Button>
                )}
              </div>
              {provenRetire.length === 0 ? (
                <p className="eh-body">
                  Nothing here is backed by evidence. Everything found only shares a mod page, and
                  is listed below.
                </p>
              ) : (
                <DataTable
                  rows={provenRetire}
                  idOf={retireId}
                  columns={RETIRE_COLUMNS}
                  tableId="curator.cleanup.installs"
                  noun="older install"
                  limit={200}
                  maxHeight={320}
                  selection={{ selected: retire, onChange: setRetire }}
                />
              )}

              {unprovenRetire.length > 0 && (
                <div className="eh-stack eh-stack--xs">
                  <Callout tone="warning">
                    {num(unprovenRetire.length)} more install(s) share a Nexus page with a newer
                    file and NOTHING ELSE. That is not an old version — one page ships a main
                    file, optional files, variants and patches, so this is where &ldquo;Bodypaints
                    - CBBE&rdquo; sits next to &ldquo;Bodypaints - Male&rdquo;. Listed so nothing
                    is hidden; tick one only if you know it yourself.
                  </Callout>
                  <DataTable
                    rows={unprovenRetire}
                    idOf={retireId}
                    columns={RETIRE_COLUMNS}
                    tableId="curator.cleanup.installs"
                    noun="unproven install"
                    limit={200}
                    maxHeight={280}
                    selection={{ selected: retire, onChange: setRetire }}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
