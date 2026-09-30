/**
 * ──────────────────────────────────────────────────────────────────────
 * "Did this collection work for you?" — after they have played it.
 *
 * Nexus keeps a success rate per revision, and Vortex asks for it when its
 * own collection installer finishes. Event Horizon replaces that installer,
 * so an Event Horizon install has never voted: the curator's success rate is
 * built entirely out of installs that did not use the tool their collection
 * ships with.
 *
 * ─── IT ASKS AFTER A LAUNCH, NOT AFTER AN INSTALL ──────────────────────
 * The moment an install finishes, "did it work?" has no honest answer —
 * nobody has loaded a save. Somebody pressing "no" there is reporting on the
 * install, which Event Horizon already checks itself and reports on the Done
 * screen, and that vote is public, permanent and about the curator's
 * collection. So the question waits for the Play button to have actually
 * started the game (`notePlayedCollection`).
 *
 * ─── AND IT ONLY OFFERS ENDORSING AFTER A YES ──────────────────────────
 * The rating and the endorsement are different things on Nexus: one is a
 * per-revision worked/didn't, the other is approval of the collection. Asking
 * somebody who just said "it did not work" to endorse it is the wrong
 * question — they get the log bundle instead, which is the thing that
 * actually helps the curator fix it.
 *
 * "Did it work?" is asked once per revision, and a dismissal counts as an
 * answer.
 *
 * ─── ENDORSING COMES BACK, ON A SCHEDULE (owner poll, 2026-09-30) ──────
 * Endorsing is approval of the whole collection, it counts toward its rating
 * on Nexus, and curators keep improving collections for months. So it is
 * asked again after "Not now", further apart each time, sooner after a new
 * revision, never once endorsed, and "Don't ask again" holds until the next
 * revision (core/feedback/endorsePrompts.ts). The same for endorsing the
 * collection's mods, on a slower clock. One question per visit.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as React from "react";

import { Button, Callout } from "../../components";
import type { FeedbackEntry } from "../../../core/feedback/collectionFeedback";
import type { CollectionPlay } from "../../../core/feedback/endorsePrompts";

export type DidItWorkState =
  /** Waiting on the answer to the question itself. */
  | { kind: "asking"; entry: FeedbackEntry }
  /** They said yes and the vote went in; endorsing is the follow-up. */
  | { kind: "offer-endorse"; entry: FeedbackEntry; endorsableHere: boolean }
  /** They said no. Nothing more is asked of them. */
  | { kind: "thanks-no"; entry: FeedbackEntry }
  /** The scheduled question: endorse the collection they keep playing. */
  | { kind: "ask-endorse"; play: CollectionPlay }
  /** The scheduled question: endorse its mods that are not endorsed yet. */
  | { kind: "ask-mods"; play: CollectionPlay; count: number }
  /** Endorsing those mods, one at a time. */
  | { kind: "endorsing-mods"; play: CollectionPlay; progress: string }
  /** Everything done, or nothing to ask. */
  | { kind: "idle" };

export function DidItWorkPrompt(props: {
  state: DidItWorkState;
  busy?: boolean;
  onAnswer: (answer: "worked" | "did-not-work") => void;
  onDismiss: () => void;
  onEndorse: () => void;
  onOpenPage: () => void;
  onSendLogs: () => void;
  /** The scheduled questions: yes, not now, or not until the next revision. */
  onEndorseAnswer?: (which: "endorse" | "mods", answer: "yes" | "not-now" | "never") => void;
  onStopMods?: () => void;
}): JSX.Element | null {
  const { state } = props;
  if (state.kind === "idle") return null;

  if (state.kind === "ask-endorse" || state.kind === "ask-mods") {
    const which = state.kind === "ask-endorse" ? "endorse" : "mods";
    const answer = (a: "yes" | "not-now" | "never") => (): void => props.onEndorseAnswer?.(which, a);
    const name = state.play.packageName;
    return (
      <Callout
        tone="info"
        icon="♥"
        title={
          which === "endorse"
            ? `Enjoying "${name}"? Endorse it`
            : `Endorse the ${state.kind === "ask-mods" ? state.count : ""} mods in "${name}" you have not endorsed yet?`
        }
        actions={
          <span className="eh-row eh-row--sm">
            <Button intent="primary" size="sm" disabled={props.busy === true} onClick={answer("yes")}>
              {which === "endorse" ? "Endorse" : "Endorse them all"}
            </Button>
            <Button size="sm" disabled={props.busy === true} onClick={answer("not-now")}>
              Not now
            </Button>
            <Button size="sm" disabled={props.busy === true} onClick={answer("never")}>
              Don&apos;t ask again
            </Button>
          </span>
        }
      >
        {which === "endorse"
          ? `An endorsement counts toward the collection's rating on Nexus: it is what ranks it and helps other players find it, and it tells the curator the work is worth continuing. You have played revision ${state.play.revisionNumber}; curators keep fixing and improving, so this comes back now and then until you decide. "Don't ask again" holds until the next revision.`
          : `Each endorsement goes to that mod's author, the people whose work the collection is built from. Event Horizon sends them one at a time through your Vortex login and reads each answer back; you can stop at any time.`}
      </Callout>
    );
  }

  if (state.kind === "endorsing-mods") {
    return (
      <Callout
        tone="info"
        icon="♥"
        title={`Endorsing the mods in "${state.play.packageName}"`}
        actions={
          <Button size="sm" onClick={props.onStopMods}>
            Stop after this one
          </Button>
        }
      >
        {state.progress}
      </Callout>
    );
  }

  if (state.kind === "asking") {
    return (
      <Callout
        tone="info"
        icon="★"
        title={`Did "${state.entry.packageName}" work for you?`}
        actions={
          <span className="eh-row eh-row--sm">
            <Button
              intent="primary"
              size="sm"
              disabled={props.busy === true}
              onClick={(): void => props.onAnswer("worked")}
            >
              It worked
            </Button>
            <Button
              size="sm"
              disabled={props.busy === true}
              onClick={(): void => props.onAnswer("did-not-work")}
            >
              It did not
            </Button>
            <Button size="sm" disabled={props.busy === true} onClick={props.onDismiss}>
              Not now
            </Button>
          </span>
        }
      >
        You have played revision {state.entry.revisionNumber}, so you are the
        one who can answer. Your vote is public on the collection&apos;s page
        and is what its success rate is made of — it is about this revision,
        not about Event Horizon.
      </Callout>
    );
  }

  if (state.kind === "offer-endorse") {
    return (
      <Callout
        tone="success"
        icon="♥"
        title="Thank you — that is recorded"
        actions={
          <span className="eh-row eh-row--sm">
            {state.endorsableHere ? (
              <Button
                intent="primary"
                size="sm"
                disabled={props.busy === true}
                onClick={props.onEndorse}
              >
                Endorse it too
              </Button>
            ) : (
              <Button intent="primary" size="sm" onClick={props.onOpenPage}>
                Open the page to endorse
              </Button>
            )}
            <Button size="sm" onClick={props.onDismiss}>
              No thanks
            </Button>
          </span>
        }
      >
        {state.endorsableHere
          ? `An endorsement is for the whole collection rather than this one revision, and it counts toward its rating on Nexus: it is what ranks ${state.entry.packageName} and helps other players find it.`
          : `Endorsing from here was not possible this time; the collection's page takes one click.`}
      </Callout>
    );
  }

  return (
    <Callout
      tone="warning"
      icon="✉"
      title="Recorded — and the curator would want the details"
      actions={
        <span className="eh-row eh-row--sm">
          <Button intent="primary" size="sm" onClick={props.onSendLogs}>
            Save a log bundle
          </Button>
          <Button size="sm" onClick={props.onDismiss}>
            Close
          </Button>
        </span>
      }
    >
      A vote says something is wrong and nothing about what. The log bundle
      names every mod, what verified and what did not, and the script
      extender&apos;s own report — which is what actually gets it fixed.
    </Callout>
  );
}
