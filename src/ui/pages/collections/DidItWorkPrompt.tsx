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
 * Asked once per revision, and a dismissal counts as an answer. A prompt that
 * returns every time is one people learn to close without reading, and the
 * next one that matters gets closed with it.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as React from "react";

import { Button, Callout } from "../../components";
import type { FeedbackEntry } from "../../../core/feedback/collectionFeedback";

export type DidItWorkState =
  /** Waiting on the answer to the question itself. */
  | { kind: "asking"; entry: FeedbackEntry }
  /** They said yes and the vote went in; endorsing is the follow-up. */
  | { kind: "offer-endorse"; entry: FeedbackEntry; endorsableHere: boolean }
  /** They said no. Nothing more is asked of them. */
  | { kind: "thanks-no"; entry: FeedbackEntry }
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
}): JSX.Element | null {
  const { state } = props;
  if (state.kind === "idle") return null;

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
          ? `An endorsement is a separate thing from the rating: it is for the collection rather than this one revision, and it is what shows up as a number on ${state.entry.packageName}'s page.`
          : `Endorsing needs the collection's own entry in Vortex, which this install does not have — the page takes one click.`}
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
