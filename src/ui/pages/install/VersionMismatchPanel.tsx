/**
 * The player's game is not the version the collection was built on.
 *
 * Owner poll, 2026-09-22: warn, and hold Continue until ONE box is ticked.
 * The panel gives both honest roads — change the game, or keep it and swap
 * the named mods — because which is easier depends on the player, not on us.
 *
 * The list is the precise one from `versionMismatch.ts`: what each shipped
 * script-extender DLL declared at build time, judged against this player's
 * runtime. When the package predates that data, the panel says so rather
 * than guessing.
 */
import * as React from "react";

import { Callout, Checkbox } from "../../components";
import { describeVersionMismatch } from "../../../core/resolver/versionMismatch";
import type { CompatibilityReport } from "../../../types/installPlan";

export function VersionMismatchPanel(props: {
  mismatch: NonNullable<CompatibilityReport["versionMismatch"]>;
  acknowledged: boolean;
  onAcknowledge: (acknowledged: boolean) => void;
}): JSX.Element {
  const { mismatch, acknowledged, onAcknowledge } = props;
  const d = describeVersionMismatch(mismatch);

  return (
    <Callout tone="warning" title="Your game version is different from the curator's">
      <div className="eh-stack eh-stack--sm">
        <p className="eh-body">{d.headline} You can still install. Pick one of two roads:</p>

        <strong className="eh-strong">1. Keep your version and swap what will not load</strong>
        {d.summary.map((line, i) => (
          <p key={i} className="eh-secondary">
            {line}
          </p>
        ))}
        {d.swapLines.length > 0 && (
          <>
            <p className="eh-secondary">
              After the install, reinstall these from their mod pages, picking the file made for
              your game version:
            </p>
            <ul className="eh-list">
              {d.swapLines.map((line, i) => (
                <li key={i} className="eh-secondary">
                  {line}
                </li>
              ))}
            </ul>
          </>
        )}

        {mismatch.changeGame.length > 0 && (
          <>
            <strong className="eh-strong">2. Change your game to {mismatch.required}</strong>
            {mismatch.changeGame.map((line, i) => (
              <p key={i} className="eh-secondary">
                {line}
              </p>
            ))}
          </>
        )}

        {/*
          The label says what was FOUND, not a generic sentence.
          It read identically whether the answer was "six mods" or "nothing
          could be checked" — a tick that carries no information is a tick
          people learn to click, and in one case it asserted the opposite of
          the paragraph above it.
        */}
        <Checkbox
          checked={acknowledged}
          onChange={(e): void => onAcknowledge(e.target.checked)}
          label={<span>{d.acknowledgement}</span>}
        />
      </div>
    </Callout>
  );
}
