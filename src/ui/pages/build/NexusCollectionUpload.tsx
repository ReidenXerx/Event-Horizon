/**
 * Upload a finished package to a Nexus collection, from the Build page.
 *
 * The upload itself belongs to Vortex (see core/nexus/collectionUpload.ts);
 * this is the part the curator sees: which collection it goes to, how far the
 * transfer is, and what Nexus said. What lands on Nexus is a DRAFT revision.
 * Publishing it stays the curator's click on the website, and the panel says
 * so before anything is sent, because "upload" on its own reads like "release".
 *
 * Only `.zip` packages are offered. Pressing Install on a collection page makes
 * Vortex download the file and hand it to its installers, and a name Vortex
 * does not know as an archive never gets that far.
 */

import * as React from "react";

import { Button, Callout, ChoiceCard, Field, Input, Modal, ProgressRing, Section } from "../../components";
import { useApi } from "../../state";
import { writeToClipboard } from "../../clipboard";
import { readEhcoll } from "../../../core/manifest/readEhcoll";
import { packageFormatOf } from "../../../core/manifest/packageFileName";
import {
  findNexusCollectionLink,
  rememberNexusCollectionLink,
} from "../../../core/manifest/collectionConfig";
import { getCollectionsConfigDir } from "../../../core/paths/appDataPaths";
import { openExternalUrl } from "../../../core/revealPath";
import { ehLog } from "../../../core/logging/ehLog";
import {
  NEXUS_COLLECTION_NAME_MAX,
  NEXUS_COLLECTION_NAME_MIN,
  countNexusCollectionMods,
  nexusCollectionProblems,
  toNexusCollectionInfo,
  type NexusCollectionInfo,
} from "../../../core/nexus/collectionPayload";
import {
  canUploadCollections,
  isLoggedInToNexus,
  listOwnNexusCollections,
  nexusCollectionUrl,
  resolveNexusCollection,
  uploadToNexusCollection,
  type NexusCollectionLink,
  type NexusUploadFailure,
  type OwnNexusCollection,
} from "../../../core/nexus/collectionUpload";

/** The choice meaning "let Nexus create a new collection". */
const NEW_COLLECTION = "";

const PROGRESS_NOTIFICATION = "eh-nexus-collection-upload-progress";

export type NexusUploadLoaded = {
  info: NexusCollectionInfo;
  packageId: string;
  gameId: string;
  own: OwnNexusCollection[];
  remembered?: NexusCollectionLink;
};

export type NexusUploadPhase =
  | { kind: "loading" }
  | { kind: "blocked"; title: string; details: string[] }
  | { kind: "choose"; note?: string }
  | { kind: "uploading"; transferred: number; total: number }
  | { kind: "processing" }
  | { kind: "done"; link: NexusCollectionLink; revisionNumber?: number; remembered: boolean }
  | { kind: "failed"; failure: NexusUploadFailure };

export function NexusCollectionUpload(props: {
  outputPath: string;
  outputBytes: number;
  /** This version's changelog as BBCode, for the revision notes on Nexus. */
  changelogBbcode?: string;
}): JSX.Element {
  const [open, setOpen] = React.useState(false);
  const isZip = packageFormatOf(props.outputPath) === "zip";

  return (
    <Section title="Nexus collection" size="sm">
      <div className="eh-stack eh-stack--sm">
        {isZip ? (
          <>
            <p className="eh-note">
              Upload this package to your collection on Nexus. The page lists the
              collection&apos;s mods, and the upload arrives as a draft: nothing is
              public until you publish it on Nexus.
            </p>
            <div className="eh-row">
              <Button intent="primary" size="sm" onClick={(): void => setOpen(true)}>
                Upload to Nexus…
              </Button>
            </div>
          </>
        ) : (
          <p className="eh-note">
            Nexus collections take the <code>.zip</code> build. Build this
            collection as <code>.zip</code> to upload it from here.
          </p>
        )}
      </div>
      {open && (
        <UploadModal
          outputPath={props.outputPath}
          outputBytes={props.outputBytes}
          changelogBbcode={props.changelogBbcode}
          onClose={(): void => setOpen(false)}
        />
      )}
    </Section>
  );
}

function UploadModal(props: {
  outputPath: string;
  outputBytes: number;
  changelogBbcode?: string;
  onClose: () => void;
}): JSX.Element {
  const api = useApi();
  const [phase, setPhase] = React.useState<NexusUploadPhase>({ kind: "loading" });
  const [loaded, setLoaded] = React.useState<NexusUploadLoaded | undefined>();
  const [selected, setSelected] = React.useState<string | undefined>();
  const [pageName, setPageName] = React.useState("");
  const abortRef = React.useRef<AbortController | undefined>();

  React.useEffect(() => {
    let live = true;
    void (async (): Promise<void> => {
      if (!canUploadCollections(api)) {
        setPhase({ kind: "blocked", title: "This Vortex cannot upload collections.", details: ["Update Vortex, then try again."] });
        return;
      }
      if (!isLoggedInToNexus(api.getState())) {
        setPhase({
          kind: "blocked",
          title: "Vortex is not logged in to Nexus.",
          details: ["Log in from Vortex's header, then open this again."],
        });
        return;
      }
      try {
        const read = await readEhcoll(props.outputPath);
        const manifest = read.manifest;
        const info = toNexusCollectionInfo(manifest);
        // The name is checked in the dialog, where the curator can change it.
        const problems = nexusCollectionProblems(withPageName(info, "Name")).filter(Boolean);
        if (problems.length > 0) {
          if (live) setPhase({ kind: "blocked", title: "Nexus would refuse this package.", details: problems });
          return;
        }
        const [own, remembered] = await Promise.all([
          listOwnNexusCollections(api, manifest.game.id),
          findNexusCollectionLink(getCollectionsConfigDir(), manifest.package.id).catch((err: unknown) => {
            ehLog("warn", "nexus-collection.ui.remembered-unreadable", { err });
            return undefined;
          }),
        ]);
        if (!live) return;
        setLoaded({ info, packageId: manifest.package.id, gameId: manifest.game.id, own, remembered });
        setSelected(defaultChoice(remembered));
        setPageName(remembered?.name ?? info.info.name);
        setPhase({ kind: "choose" });
      } catch (err) {
        ehLog("error", "nexus-collection.ui.load-failed", { err });
        if (live) {
          setPhase({
            kind: "blocked",
            title: "Event Horizon could not read this package.",
            details: [err instanceof Error ? err.message : String(err)],
          });
        }
      }
    })();
    return (): void => {
      live = false;
    };
  }, [api, props.outputPath]);

  const busy = phase.kind === "uploading" || phase.kind === "processing";

  const upload = async (): Promise<void> => {
    if (loaded === undefined || selected === undefined) return;
    if (pageNameProblem(pageName) !== undefined) return;
    const info = withPageName(loaded.info, pageName);
    let target: NexusCollectionLink | undefined;
    if (selected !== NEW_COLLECTION) {
      target =
        loaded.remembered?.slug === selected
          ? loaded.remembered
          : await resolveNexusCollection(api, selected);
      if (target === undefined) {
        setPhase({
          kind: "failed",
          failure: {
            kind: "failed",
            title: "Nexus did not say which collection that is.",
            details: ["Check Vortex's notifications, then try again."],
          },
        });
        return;
      }
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase({ kind: "uploading", transferred: 0, total: props.outputBytes });
    // Mirrored into Vortex's notifications: a multi-gigabyte upload runs for a
    // long time, and leaving Event Horizon's page must not make it invisible.
    let lastPercent = -1;
    const outcome = await uploadToNexusCollection(api, {
      info,
      packagePath: props.outputPath,
      target,
      signal: controller.signal,
      onProgress: (transferred, total) => {
        // Once the bytes are across, Nexus checks the file before it makes
        // the revision, which can take minutes and reports no progress.
        setPhase(
          total > 0 && transferred >= total
            ? { kind: "processing" }
            : { kind: "uploading", transferred, total },
        );
        const percent = total > 0 ? Math.floor((transferred / total) * 100) : 0;
        if (percent === lastPercent) return;
        lastPercent = percent;
        api.sendNotification?.({
          id: PROGRESS_NOTIFICATION,
          type: "activity",
          title: "Uploading to Nexus",
          message: `${formatBytes(transferred)} / ${formatBytes(total)}`,
          progress: percent,
        });
      },
    });
    abortRef.current = undefined;
    api.dismissNotification?.(PROGRESS_NOTIFICATION);

    if (!outcome.ok) {
      if (outcome.failure.kind === "cancelled") {
        setPhase({ kind: "choose", note: outcome.failure.title });
        return;
      }
      setPhase({ kind: "failed", failure: outcome.failure });
      api.sendNotification?.({
        id: "eh-nexus-collection-upload",
        type: "error",
        title: "Upload to Nexus failed",
        message: outcome.failure.title,
      });
      return;
    }

    let remembered = false;
    try {
      remembered = await rememberNexusCollectionLink(getCollectionsConfigDir(), loaded.packageId, outcome.link);
    } catch (err) {
      ehLog("warn", "nexus-collection.ui.remember-failed", { err });
    }
    setPhase({ kind: "done", link: outcome.link, revisionNumber: outcome.revisionNumber, remembered });
    const url = nexusCollectionUrl(outcome.link, outcome.revisionNumber);
    // Also outside Event Horizon: a big upload outlives the page it started on.
    api.sendNotification?.({
      id: "eh-nexus-collection-upload",
      type: "success",
      title: "Draft uploaded to Nexus",
      message: `${info.info.name}: publish it on Nexus when it is ready.`,
      actions: [{ title: "Open", action: () => void openExternalUrl(url) }],
    });
  };

  const close = (): void => {
    if (!busy) props.onClose();
  };

  return (
    <NexusUploadDialog
      phase={phase}
      loaded={loaded}
      selected={selected}
      pageName={pageName}
      onPageNameChange={setPageName}
      outputPath={props.outputPath}
      outputBytes={props.outputBytes}
      changelogBbcode={props.changelogBbcode}
      onSelect={setSelected}
      onClose={close}
      onUpload={(): void => void upload()}
      onStop={(): void => abortRef.current?.abort()}
      onBack={(): void => setPhase({ kind: "choose" })}
    />
  );
}

/**
 * The dialog for one moment of an upload, with no state of its own.
 *
 * Exported for the render harness, which photographs each phase: a dialog
 * that reads Vortex and the disk on open can only ever be photographed
 * loading.
 */
export function NexusUploadDialog(props: {
  phase: NexusUploadPhase;
  loaded?: NexusUploadLoaded;
  selected?: string;
  /** What the collection is called ON NEXUS; see {@link pageNameProblem}. */
  pageName: string;
  onPageNameChange: (name: string) => void;
  outputPath: string;
  outputBytes: number;
  changelogBbcode?: string;
  onSelect: (slug: string) => void;
  onClose: () => void;
  onUpload: () => void;
  onStop: () => void;
  onBack: () => void;
}): JSX.Element {
  const busy = props.phase.kind === "uploading" || props.phase.kind === "processing";
  return (
    <Modal
      open
      onClose={props.onClose}
      title="Upload to a Nexus collection"
      subtitle={`${fileName(props.outputPath)} · ${formatBytes(props.outputBytes)}`}
      size="md"
      closeOnBackdropClick={!busy}
      closeOnEsc={!busy}
      hideCloseButton={busy}
      footer={
        <Footer
          phase={props.phase}
          canUpload={props.selected !== undefined && pageNameProblem(props.pageName) === undefined}
          changelogBbcode={props.changelogBbcode}
          onClose={props.onClose}
          onUpload={props.onUpload}
          onStop={props.onStop}
          onBack={props.onBack}
        />
      }
    >
      <Body
        phase={props.phase}
        loaded={props.loaded}
        selected={props.selected}
        onSelect={props.onSelect}
        pageName={props.pageName}
        onPageNameChange={props.onPageNameChange}
      />
    </Modal>
  );
}

function Body(props: {
  phase: NexusUploadPhase;
  loaded?: NexusUploadLoaded;
  selected?: string;
  onSelect: (slug: string) => void;
  pageName: string;
  onPageNameChange: (name: string) => void;
}): JSX.Element {
  const { phase, loaded } = props;
  switch (phase.kind) {
    case "loading":
      return (
        <div className="eh-row">
          <ProgressRing size={32} />
          <span className="eh-note">Reading the package and asking Nexus for your collections…</span>
        </div>
      );
    case "blocked":
      return <Reasons title={phase.title} details={phase.details} />;
    case "uploading":
      return (
        <div className="eh-row">
          <ProgressRing size={48} value={phase.total > 0 ? phase.transferred / phase.total : undefined} />
          <span className="eh-note">
            Uploading: {formatBytes(phase.transferred)} of {formatBytes(phase.total)}. Keep Vortex open.
          </span>
        </div>
      );
    case "processing":
      return (
        <div className="eh-row">
          <ProgressRing size={48} />
          <span className="eh-note">
            Uploaded. Nexus is checking the file and making the draft, which can take a few minutes.
          </span>
        </div>
      );
    case "done":
      return (
        <div className="eh-stack eh-stack--sm">
          <p>
            {phase.revisionNumber !== undefined ? `Draft revision ${phase.revisionNumber}` : "A draft"} of{" "}
            <strong>{phase.link.name ?? phase.link.slug}</strong> is on Nexus.
          </p>
          <p className="eh-note">
            Nobody sees it until you publish it there. Before publishing, check the
            adult-content setting and paste the changelog into the revision notes.
          </p>
          {!phase.remembered && (
            <p className="eh-note">
              Event Horizon could not remember this collection, so the next upload
              will ask again.
            </p>
          )}
        </div>
      );
    case "failed":
      return <Reasons title={phase.failure.title} details={phase.failure.details} />;
    case "choose":
      if (loaded === undefined) return <></>;
      return (
        <Choose
          loaded={loaded}
          selected={props.selected}
          onSelect={props.onSelect}
          note={phase.note}
          pageName={props.pageName}
          onPageNameChange={props.onPageNameChange}
        />
      );
  }
}

function Choose(props: {
  loaded: NexusUploadLoaded;
  selected?: string;
  onSelect: (slug: string) => void;
  note?: string;
  pageName: string;
  onPageNameChange: (name: string) => void;
}): JSX.Element {
  const { loaded } = props;
  const counts = countNexusCollectionMods(loaded.info);
  const options = collectionOptions(loaded.own, loaded.remembered);
  const rename = renameWarning(options, props.selected, props.pageName);
  const nameProblem = pageNameProblem(props.pageName);
  return (
    <div className="eh-stack eh-stack--sm">
      {props.note !== undefined && <p className="eh-note">{props.note}</p>}
      <p className="eh-note">
        The page will list {counts.nexus.toLocaleString()} Nexus{" "}
        {counts.nexus === 1 ? "mod" : "mods"}, {counts.bundled.toLocaleString()} bundled
        {counts.elsewhere > 0 ? ` and ${counts.elsewhere.toLocaleString()} from elsewhere` : ""}.
        Nexus checks every listed file after the upload, so a removed one fails it
        by name.
      </p>
      {options.map((option) => (
        <ChoiceCard
          key={option.slug}
          name="eh-nexus-collection"
          checked={props.selected === option.slug}
          onChange={(): void => props.onSelect(option.slug)}
          label={option.name}
          sub={`nexusmods.com · ${option.slug}${option.latestRevision !== undefined ? ` · revision ${option.latestRevision}` : ""}`}
        />
      ))}
      <ChoiceCard
        name="eh-nexus-collection"
        checked={props.selected === NEW_COLLECTION}
        onChange={(): void => props.onSelect(NEW_COLLECTION)}
        label="A new collection"
        sub="Nexus creates it, as a draft, from this upload."
      />
      <Field
        label="Name on Nexus"
        hint={
          "Vortex renames the page to this on every upload, so rename it here rather than on the site. " +
          "Event Horizon keeps the collection's own name."
        }
        error={nameProblem}
      >
        <Input
          type="text"
          value={props.pageName}
          onChange={(e): void => props.onPageNameChange(e.target.value)}
        />
      </Field>
      {rename !== undefined && (
        <Callout tone="warning" role="silent">
          {rename}
        </Callout>
      )}
      {loaded.own.length === 0 && (
        <p className="eh-note">
          Nexus listed none of your collections for this game. If one is missing,
          check Vortex&apos;s notifications: a failed request shows up there.
        </p>
      )}
    </div>
  );
}

function Footer(props: {
  phase: NexusUploadPhase;
  canUpload: boolean;
  changelogBbcode?: string;
  onClose: () => void;
  onUpload: () => void;
  onStop: () => void;
  onBack: () => void;
}): JSX.Element {
  const { phase } = props;
  switch (phase.kind) {
    case "loading":
    case "blocked":
      return (
        <Button intent="ghost" onClick={props.onClose}>
          Close
        </Button>
      );
    case "choose":
      return (
        <>
          <Button intent="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button intent="primary" disabled={!props.canUpload} onClick={props.onUpload}>
            Upload draft
          </Button>
        </>
      );
    case "uploading":
      return (
        <Button intent="ghost" onClick={props.onStop}>
          Stop upload
        </Button>
      );
    case "processing":
      return (
        <Button intent="ghost" busy disabled>
          Working
        </Button>
      );
    case "done": {
      const url = nexusCollectionUrl(phase.link, phase.revisionNumber);
      return (
        <>
          {props.changelogBbcode !== undefined && (
            <Button intent="ghost" onClick={(): void => void writeToClipboard(props.changelogBbcode as string)}>
              Copy changelog (BBCode)
            </Button>
          )}
          <Button intent="ghost" onClick={props.onClose}>
            Close
          </Button>
          <Button intent="primary" onClick={(): void => void openExternalUrl(url)}>
            Open on Nexus
          </Button>
        </>
      );
    }
    case "failed":
      return (
        <>
          <Button intent="ghost" onClick={props.onClose}>
            Close
          </Button>
          <Button intent="primary" onClick={props.onBack}>
            Back
          </Button>
        </>
      );
  }
}

function Reasons(props: { title: string; details: string[] }): JSX.Element {
  return (
    <div className="eh-stack eh-stack--sm">
      <p>
        <strong>{props.title}</strong>
      </p>
      {props.details.length > 0 && (
        <ul className="eh-list eh-list--spaced">
          {props.details.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The collections to offer: the curator's own, with the remembered one first
 * even when Nexus's list left it out, so a list that failed to load still
 * offers the collection the last upload went to.
 */
export function collectionOptions(
  own: readonly OwnNexusCollection[],
  remembered: NexusCollectionLink | undefined,
): OwnNexusCollection[] {
  const out: OwnNexusCollection[] = [];
  if (remembered !== undefined) {
    const listed = own.find((c) => c.slug === remembered.slug);
    out.push(listed ?? { slug: remembered.slug, name: remembered.name ?? remembered.slug, gameDomain: remembered.gameDomain });
  }
  for (const c of own) {
    if (c.slug !== remembered?.slug) out.push(c);
  }
  return out;
}

/**
 * What the upload will do to a live page before anything is published.
 *
 * Vortex's upload renames an existing collection to the package's name
 * (`editCollection(id, { name })`) the moment the upload succeeds, and a
 * collection's name is public whether or not the new revision ever is. So a
 * name that differs is said out loud before the button is pressed.
 */
export function renameWarning(
  options: readonly OwnNexusCollection[],
  selected: string | undefined,
  pageName: string,
): string | undefined {
  if (selected === undefined || selected === NEW_COLLECTION) return undefined;
  const option = options.find((c) => c.slug === selected);
  const name = pageName.trim();
  if (option === undefined || option.name === name) return undefined;
  return (
    `Uploading renames "${option.name}" on Nexus to "${name}" as soon as ` +
    `the upload finishes. The name is public even while the new revision is a draft.`
  );
}

/**
 * Why a name cannot go to Nexus, or undefined when it can.
 *
 * The name on Nexus is set here, not taken from the package, because Vortex's
 * upload renames an existing collection to whatever name it is sent, on every
 * revision: a page renamed on the website would snap back at the next upload.
 * Remembered with the collection and sent every time, it stays put.
 */
export function pageNameProblem(name: string): string | undefined {
  const length = name.trim().length;
  if (length < NEXUS_COLLECTION_NAME_MIN || length > NEXUS_COLLECTION_NAME_MAX) {
    return `Nexus takes ${NEXUS_COLLECTION_NAME_MIN} to ${NEXUS_COLLECTION_NAME_MAX} characters; this is ${length}.`;
  }
  return undefined;
}

/** The payload with the collection named as it should be on Nexus. */
export function withPageName(info: NexusCollectionInfo, pageName: string): NexusCollectionInfo {
  return { ...info, info: { ...info.info, name: pageName.trim() } };
}

/**
 * Which option starts selected: where the last upload went. Otherwise nothing,
 * so the curator picks — a wrong default makes a stray collection or a draft on
 * the wrong page.
 *
 * A collection that merely shares the package's name is NOT preselected: the
 * first real use was a curator starting over on new pages, and the page with
 * the old name was exactly the one being left behind.
 */
export function defaultChoice(remembered: NexusCollectionLink | undefined): string | undefined {
  return remembered?.slug;
}

function fileName(p: string): string {
  return p.replace(/^.*[\\/]/, "");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
