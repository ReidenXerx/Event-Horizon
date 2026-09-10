/**
 * Event Horizon's Play button — the script extender, never the bare game.
 * See core/environment/launchGame.ts for why Vortex's own Play is not used.
 */

import * as React from "react";

import { Button, Card, useToast, type ButtonIntent, type ButtonSize } from "../components";
import { useErrorReporter } from "../errors";
import { useApi } from "../state";
import { VORTEX_PLAY_WARNING } from "../../core/environment/launchGame";
import { basenameOf } from "../../core/paths";

/**
 * One launch at a time across every Play button on every page: two loaders
 * started a second apart start two games.
 */
let launchInFlight = false;

export function PlayGameButton(props: {
  gameId: string;
  intent?: ButtonIntent;
  size?: ButtonSize;
}): JSX.Element {
  const api = useApi();
  const toast = useToast();
  const reportError = useErrorReporter();
  const [busy, setBusy] = React.useState(false);

  const play = (event?: React.MouseEvent): void => {
    // Rows that host this button navigate on click; Play is not a navigation.
    event?.stopPropagation();
    if (busy || launchInFlight) return;
    launchInFlight = true;
    setBusy(true);
    void (async (): Promise<void> => {
      try {
        const { launchGame } = await import("../../core/environment/launchGame");
        const outcome = await launchGame(api, props.gameId);
        if (outcome.kind === "started") {
          const exe = basenameOf(outcome.executable);
          toast({ intent: "success", message: `Starting the game through ${exe}.` });
        } else if (outcome.kind === "refused") {
          await api.showDialog?.(
            "error",
            outcome.title,
            {
              text: "Event Horizon did not start the game.",
              message: [
                ...outcome.lines,
                ...(outcome.steps.length > 0
                  ? ["", "What to do:", ...outcome.steps.map((s, i) => `${i + 1}. ${s}`)]
                  : []),
              ].join("\n"),
            },
            [{ label: "Close" }],
          );
        }
      } catch (err) {
        reportError(err, { title: "Couldn't start the game", context: { step: "play", gameId: props.gameId } });
      } finally {
        launchInFlight = false;
        setBusy(false);
      }
    })();
  };

  return (
    <Button
      intent={props.intent ?? "primary"}
      {...(props.size !== undefined ? { size: props.size } : {})}
      disabled={busy}
      onClick={play}
      title={VORTEX_PLAY_WARNING}
    >
      {busy ? "Starting…" : "▶ Play"}
    </Button>
  );
}

/** Play, with the one sentence every player of a collection needs to read. */
export function PlayGameCard(props: { gameId: string }): JSX.Element {
  return (
    <Card title="Play" inert>
      <div className="eh-stack eh-stack--sm">
        <div>
          <PlayGameButton gameId={props.gameId} />
        </div>
        <span className="eh-secondary">
          Start the game from here. {VORTEX_PLAY_WARNING}
        </span>
      </div>
    </Card>
  );
}
