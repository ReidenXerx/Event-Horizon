/**
 * One mod, in full: what it requires, what requires it, and the action for
 * each line — the panel the table's "Details" opens.
 *
 * Every requirement gets the one action that fits its state and no other:
 *   installed-disabled → Enable (a state write, instant)
 *   missing            → Install (fetches the file list; installs only when
 *                        the choice is not a judgement — see pickInstallFile)
 *   external / dlc     → Open (a link is all there is)
 *   satisfied          → nothing; it says which mod provides it
 */

import * as React from "react";

import type { CuratorMod } from "../../../core/curator/profileActions";
import type {
  ModRequirement,
  ModRequirementReport,
  RequirementsReport,
} from "../../../core/curator/requirements";
import { Button, Callout, Card, LinkButton, Pill, Section, Textarea, type PillIntent } from "../../components";

const STATUS_PILL: Record<ModRequirement["status"], { label: string; intent: PillIntent }> = {
  satisfied: { label: "ok", intent: "success" },
  "installed-disabled": { label: "installed, disabled", intent: "warning" },
  missing: { label: "missing", intent: "danger" },
  external: { label: "off Nexus", intent: "neutral" },
  dlc: { label: "DLC", intent: "neutral" },
  "unknown-game": { label: "other game", intent: "neutral" },
};

export function RequirementsPanel(props: {
  mod: CuratorMod;
  mods: readonly CuratorMod[];
  report: RequirementsReport | undefined;
  entry: ModRequirementReport | undefined;
  busy: boolean;
  /** Whether Vortex can download from here at all. */
  canInstall: boolean;
  onClose: () => void;
  onEnable: (mods: readonly CuratorMod[]) => void;
  onInstall: (req: ModRequirement) => void;
  /** Plan and run the whole chain: every missing Nexus requirement, recursively, plus enables. */
  onInstallAll: () => void;
  onOpenPage: (req: ModRequirement) => void;
  onFocus: (modId: string) => void;
  /** Save the curator's note on this mod (our attribute; empty clears it). */
  onSaveNote: (mod: CuratorMod, text: string) => void;
}): JSX.Element {
  const { mod, mods, report, entry, busy } = props;
  const [noteText, setNoteText] = React.useState(mod.notes ?? "");
  React.useEffect(() => setNoteText(mod.notes ?? ""), [mod.id, mod.notes]);
  const noteDirty = noteText !== (mod.notes ?? "");
  const byId = React.useMemo(() => new Map(mods.map((m) => [m.id, m])), [mods]);
  const dependants = (report?.requiredBy.get(mod.id) ?? [])
    .map((id) => byId.get(id))
    .filter((m): m is CuratorMod => m !== undefined);
  const requirements = entry?.requirements ?? [];
  const nexusReqs = requirements.filter((q) => q.source === "nexus");
  const masterReqs = requirements.filter((q) => q.source === "master");

  const providerNames = (q: ModRequirement): string =>
    q.satisfiedBy.map((id) => byId.get(id)?.name ?? id).join(", ");

  const line = (q: ModRequirement, i: number): JSX.Element => {
    const pill = STATUS_PILL[q.status];
    const providers = q.satisfiedBy.map((id) => byId.get(id)).filter((m): m is CuratorMod => m !== undefined);
    return (
      <li key={`${q.source}:${q.name}:${i}`} className="eh-row eh-row--top">
        <Pill intent={pill.intent} plain>
          {pill.label}
        </Pill>
        <div className="eh-fill eh-stack eh-stack--xs">
          <span className="eh-strong">
            {q.name}
            {q.source === "master" && q.plugin !== undefined && (
              <span className="eh-small">
                {" "}
                — master of <span className="eh-mono">{q.plugin}</span>
              </span>
            )}
          </span>
          {q.notes !== undefined && <span className="eh-small">{q.notes}</span>}
          {q.status === "satisfied" && q.satisfiedBy.length > 0 && (
            <span className="eh-small">
              provided by{" "}
              {providers.map((p, j) => (
                <React.Fragment key={p.id}>
                  {j > 0 && ", "}
                  <LinkButton variant="xs" onClick={(): void => props.onFocus(p.id)}>
                    {p.name}
                  </LinkButton>
                </React.Fragment>
              ))}
            </span>
          )}
        </div>
        <div className="eh-row eh-row--sm eh-row--nowrap">
          {q.status === "installed-disabled" && (
            <Button size="sm" intent="primary" disabled={busy} onClick={(): void => props.onEnable(providers)}>
              Enable {providers.length > 1 ? `${providers.length} providers` : providerNames(q)}
            </Button>
          )}
          {q.status === "missing" && q.nexusModId !== undefined && q.vortexGameId !== undefined && props.canInstall && (
            <Button size="sm" intent="primary" busy={busy} onClick={(): void => props.onInstall(q)}>
              Install
            </Button>
          )}
          {(q.status === "missing" || q.status === "external" || q.status === "unknown-game") &&
            q.url !== undefined && (
              <Button size="sm" intent="ghost" onClick={(): void => props.onOpenPage(q)}>
                Open page
              </Button>
            )}
        </div>
      </li>
    );
  };

  return (
    <Card
      title={mod.name}
      subtitle={
        <span className="eh-mono eh-muted">
          {mod.id}
          {mod.nexusModId !== undefined ? ` · nexus ${mod.nexusModId}` : ""}
          {mod.version !== undefined ? ` · v${mod.version}` : ""}
        </span>
      }
      actions={
        <Button size="sm" intent="ghost" onClick={props.onClose}>
          Close
        </Button>
      }
    >
      <div className="eh-stack eh-stack--lg">
        <Section
          title="Note"
          size="sm"
          description="Yours, kept on the mod in Vortex. Start it with @users and it ships in the collection, shown to installers on the plan; anything else stays private."
        >
          <div className="eh-stack eh-stack--xs">
            <Textarea
              aria-label="Note"
              rows={2}
              placeholder="Why it is here, what it conflicts with, what to check after an update…"
              value={noteText}
              onChange={(e): void => setNoteText(e.target.value)}
            />
            {noteDirty && (
              <div className="eh-row eh-row--sm">
                <Button size="sm" intent="primary" onClick={(): void => props.onSaveNote(mod, noteText.trim())}>
                  Save note
                </Button>
                <Button size="sm" intent="ghost" onClick={(): void => setNoteText(mod.notes ?? "")}>
                  Discard
                </Button>
              </div>
            )}
          </div>
        </Section>

        {entry === undefined || (entry.unfetched && requirements.length === 0) ? (
          <Callout tone="info">
            {mod.nexusModId === undefined || (mod.source !== undefined && mod.source !== "nexus")
              ? "Not a Nexus download, so there is no page to read requirements from. Plugin masters are still checked when Vortex lists the plugin."
              : "Nexus has not been asked about this mod yet — press Read requirements above."}
          </Callout>
        ) : (
          <>
            <Section
              title="Requires"
              size="sm"
              count={requirements.length}
              countIntent="neutral"
              actions={
                props.canInstall &&
                requirements.some(
                  (q) => (q.status === "missing" && q.nexusModId !== undefined && q.vortexGameId !== undefined) || q.status === "installed-disabled",
                ) ? (
                  <Button size="sm" intent="primary" disabled={busy} onClick={props.onInstallAll} title="Read each requirement's own requirements, show the whole plan, then install and enable in order">
                    Make it work
                  </Button>
                ) : undefined
              }
            >
              {requirements.length === 0 ? (
                <p className="eh-body">Nothing listed on its Nexus page, and its plugins declare no masters beyond the game's own.</p>
              ) : (
                <ul className="eh-list eh-list--plain eh-stack eh-stack--sm">
                  {nexusReqs.map(line)}
                  {masterReqs.map((q, i) => line(q, nexusReqs.length + i))}
                </ul>
              )}
              {entry.truncatedBy > 0 && (
                <p className="eh-note">
                  Nexus lists {entry.truncatedBy} more requirement{entry.truncatedBy === 1 ? "" : "s"} than
                  it returned — the query is capped at ten. Open the page for the full list.
                </p>
              )}
            </Section>

            <Section
              title="Required by"
              size="sm"
              count={dependants.length}
              countIntent="neutral"
              description={
                dependants.length > 0
                  ? "Disabling this mod leaves these without something they list."
                  : undefined
              }
            >
              {dependants.length === 0 ? (
                <p className="eh-body">Nothing in this profile lists it.</p>
              ) : (
                <ul className="eh-list eh-list--plain eh-stack eh-stack--xs">
                  {dependants.map((d) => (
                    <li key={d.id} className="eh-row eh-row--sm">
                      <LinkButton onClick={(): void => props.onFocus(d.id)}>{d.name}</LinkButton>
                      {!d.enabled && <Pill>disabled</Pill>}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </>
        )}
      </div>
    </Card>
  );
}
