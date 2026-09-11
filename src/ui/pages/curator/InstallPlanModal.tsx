/**
 * The preview of "make this mod work": everything the closure will
 * download, enable, or cannot do, before the first byte moves.
 *
 * Every "choose" (a page with several current main files) is a Select
 * here — the wrong file installs cleanly and is wrong forever, so nothing
 * is picked for the curator. A step with no current file is shown and
 * skipped; its page is one click away.
 *
 * Whatever keeps the plan from covering the chain — a step with no file, a
 * page for an unmanaged game, a page Nexus did not answer for, a chain cut
 * at its depth cap — is said here, before the run: the mod the plan was
 * opened for stays disabled while any of it stands.
 */

import * as React from "react";

import { describePlan, type InstallPlan, type PlannedFile } from "../../../core/curator/installPlan";
import { planBlockers } from "../../../core/curator/runRequirementPlan";
import type { CuratorMod } from "../../../core/curator/profileActions";
import { Button, Callout, Modal, Pill, Section, Select } from "../../components";

const num = (n: number): string => n.toLocaleString();

export function InstallPlanModal(props: {
  open: boolean;
  rootName: string;
  plan: InstallPlan | undefined;
  files: readonly PlannedFile[];
  picked: Readonly<Record<string, number | undefined>>;
  onPick: (key: string, fileId: number | undefined) => void;
  onOpenPage: (url: string | undefined, gameDomain: string, nexusModId: number) => void;
  onConfirm: () => void;
  onClose: () => void;
  /** Not a Premium account: each page is opened for a hand download, one at a time. */
  guided?: boolean;
  /**
   * The mods this plan was opened to switch on (Enable → "Make it work").
   * Named in the warning when something will keep them off.
   */
  enablesAfter?: readonly string[];
}): JSX.Element {
  const { plan, files, picked } = props;
  const counts = plan === undefined ? undefined : describePlan(plan, files, picked);
  const blockers = plan === undefined ? [] : planBlockers(plan, files, picked);
  const enablesAfter = props.enablesAfter ?? [];
  const canRun = counts !== undefined && counts.undecided === 0 && (counts.installable > 0 || (plan?.toEnable.length ?? 0) > 0);

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      size="lg"
      title={`Make ${props.rootName} work`}
      subtitle="The whole chain, before anything downloads: each requirement's own requirements were read too. Nothing is picked for you where a page ships several current files."
      footer={
        <>
          <Button intent="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button intent="primary" disabled={!canRun} onClick={props.onConfirm}>
            {counts === undefined
              ? "…"
              : counts.undecided > 0
                ? `Choose ${num(counts.undecided)} file(s) first`
                : `Install ${num(counts.installable)}` + ((plan?.toEnable.length ?? 0) > 0 ? ` and enable ${num(plan!.toEnable.length)}` : "")}
          </Button>
        </>
      }
    >
      {plan === undefined ? (
        <p className="eh-body">Reading the chain…</p>
      ) : (
        <div className="eh-stack eh-stack--lg">
          {props.guided === true && files.length > 0 && (
            <Callout tone="info">
              Nexus lets Vortex download directly for Premium accounts only, so this runs guided: each page opens in
              turn, you press &ldquo;Mod manager download&rdquo; on the file you want, Vortex installs it, and the next
              page opens. Whatever file you pick on the page is the one used.
            </Callout>
          )}
          {plan.steps.length === 0 && plan.toEnable.length === 0 && (
            <Callout tone="info">Nothing to install: every Nexus requirement in the chain is already in the pool and enabled.</Callout>
          )}

          {files.length > 0 && (
            <Section title="Download and install, in this order" size="sm" count={files.length} countIntent="neutral">
              <ol className="eh-list eh-stack eh-stack--sm">
                {files.map((pf) => {
                  const s = pf.step;
                  const notHere = s.vortexGameId === undefined;
                  return (
                    <li key={s.key} className="eh-row eh-row--top">
                      <div className="eh-fill eh-stack eh-stack--xs">
                        <span className="eh-strong">
                          {s.name}
                          <span className="eh-small eh-muted"> — needed by {s.neededBy.join(", ")}</span>
                        </span>
                        {s.notes !== undefined && <span className="eh-small">{s.notes}</span>}
                        {notHere ? (
                          <span className="eh-small eh-tone--warning">
                            A {s.gameDomain} page: this Vortex is not managing that game, so it cannot download it. Open the page.
                          </span>
                        ) : pf.choice.kind === "one" ? (
                          <span className="eh-small">{pf.choice.file.name ?? pf.choice.file.file_name ?? `file ${pf.choice.file.file_id}`}</span>
                        ) : pf.choice.kind === "choose" ? (
                          <Select
                            small
                            aria-label={`File for ${s.name}`}
                            value={picked[s.key] === undefined ? "" : String(picked[s.key])}
                            onChange={(e): void => props.onPick(s.key, e.target.value === "" ? undefined : Number(e.target.value))}
                          >
                            <option value="">choose a file…</option>
                            {pf.choice.candidates.map((f) => (
                              <option key={f.file_id} value={String(f.file_id)}>
                                {[f.name ?? f.file_name ?? `file ${f.file_id}`, f.version !== undefined ? `v${f.version}` : undefined]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </option>
                            ))}
                          </Select>
                        ) : (
                          <span className="eh-small eh-tone--warning">No current file on its Nexus page: skipped. Its page may explain.</span>
                        )}
                      </div>
                      <div className="eh-row eh-row--sm eh-row--nowrap">
                        {pf.choice.kind === "one" && !notHere && <Pill intent="success" plain>ready</Pill>}
                        {pf.choice.kind === "choose" && !notHere && (
                          <Pill intent={picked[s.key] === undefined ? "warning" : "success"} plain>
                            {picked[s.key] === undefined ? "your choice" : "ready"}
                          </Pill>
                        )}
                        <Button size="sm" intent="ghost" onClick={(): void => props.onOpenPage(s.url, s.gameDomain, s.nexusModId)}>
                          Open page
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </Section>
          )}

          {plan.toEnable.length > 0 && (
            <Section
              title="Enable"
              size="sm"
              count={plan.toEnable.length}
              countIntent="neutral"
              description="Already in the pool, switched off. Enabling is the whole fix."
            >
              <ul className="eh-list eh-list--plain eh-stack eh-stack--xs">
                {plan.toEnable.map((m: CuratorMod) => (
                  <li key={m.id}>{m.name}</li>
                ))}
              </ul>
            </Section>
          )}

          {plan.external.length > 0 && (
            <Section
              title="Not on Nexus"
              size="sm"
              count={plan.external.length}
              countIntent="neutral"
              description="Links and DLC the chain mentions. Nothing here can be downloaded for you."
            >
              <ul className="eh-list eh-list--plain eh-stack eh-stack--xs">
                {plan.external.map((q, i) => (
                  <li key={`${q.name}:${i}`} className="eh-row eh-row--sm">
                    <span>{q.name}</span>
                    {q.status === "dlc" && <Pill plain>DLC</Pill>}
                    {q.url !== undefined && (
                      <Button size="sm" intent="ghost" onClick={(): void => props.onOpenPage(q.url, q.gameDomain ?? "", q.nexusModId ?? 0)}>
                        Open
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {blockers.length > 0 && (
            <Callout tone="warning">
              {enablesAfter.length > 0
                ? `${enablesAfter.join(", ")} will stay disabled after this runs, because `
                : "This plan leaves gaps: "}
              {blockers.join("; ")}.
              {plan.truncated && <> Re-read requirements after this plan runs.</>}
            </Callout>
          )}
        </div>
      )}
    </Modal>
  );
}
