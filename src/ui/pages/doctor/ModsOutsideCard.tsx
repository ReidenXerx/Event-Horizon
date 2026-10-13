/**
 * The mods in a collection's profile that the collection did not install,
 * listed and copyable for whoever is helping. Lists only: removing them is
 * the player's call (NS-2).
 */

import * as React from "react";

import type { ModsOutsideCollection, OutsideMod } from "../../../core/doctor/modsOutsideCollection";
import { Button, Card, LinkButton, Pill } from "../../components";

const SHOWN = 40;

function ModList(props: { mods: OutsideMod[]; render: (m: OutsideMod) => string }): JSX.Element {
  const [all, setAll] = React.useState(false);
  const shown = all ? props.mods : props.mods.slice(0, SHOWN);
  return (
    <ul className="eh-list eh-list--plain eh-stack eh-stack--xs eh-small">
      {shown.map((m) => (
        <li key={m.vortexModId}>{props.render(m)}</li>
      ))}
      {props.mods.length > SHOWN && (
        <li>
          <LinkButton variant="xs" onClick={(): void => setAll((v) => !v)}>
            {all ? "show fewer" : `show all ${props.mods.length.toLocaleString()}`}
          </LinkButton>
        </li>
      )}
    </ul>
  );
}

const page = (m: OutsideMod): string => (m.nexusModId !== undefined ? ` (Nexus ${m.nexusModId})` : "");

export function ModsOutsideCard(props: {
  packageName: string;
  found: ModsOutsideCollection;
  onCopy: () => void;
}): JSX.Element {
  const { extra, otherFiles, dropped } = props.found;
  const total = extra.length + otherFiles.length + dropped.length;
  return (
    <Card
      title="Mods not from this collection"
      subtitle={`Enabled in the ${props.packageName} profile, not installed by the collection. The first thing to check when something breaks.`}
      actions={
        <Button intent="ghost" size="sm" onClick={props.onCopy} title="Plain text for a Discord or Nexus post">
          Copy the list
        </Button>
      }
    >
      <div className="eh-stack">
        <div className="eh-row eh-row--sm">
          <Pill intent={extra.length > 0 ? "warning" : "success"}>{extra.length > 0 ? "extra mods" : "none extra"}</Pill>
          <span className="eh-strong">
            {total === 0
              ? "Every enabled mod in this profile came from the collection."
              : `${extra.length.toLocaleString()} mod(s) not in the collection` +
                (otherFiles.length + dropped.length > 0 ? `, ${(otherFiles.length + dropped.length).toLocaleString()} more listed below` : "")}
          </span>
        </div>
        {extra.length > 0 && <ModList mods={extra} render={(m): string => `${m.name}${page(m)}`} />}
        {otherFiles.length > 0 && (
          <div className="eh-stack eh-stack--xs">
            <span className="eh-small eh-strong">Another file of a collection mod&rsquo;s page — usually a version you kept</span>
            <ModList mods={otherFiles} render={(m): string => `${m.name}${page(m)}, collection has ${m.collectionMod}`} />
          </div>
        )}
        {dropped.length > 0 && (
          <div className="eh-stack eh-stack--xs">
            <span className="eh-small eh-strong">Dropped by the curator in an update, still enabled</span>
            <ModList mods={dropped} render={(m): string => `${m.name}, dropped in ${m.droppedIn}`} />
          </div>
        )}
        {total > 0 && (
          <p className="eh-note eh-prose">
            Event Horizon never removes these: they are yours. Disabling one in Vortex and deploying is the quick way to
            test whether it causes a problem.
          </p>
        )}
      </div>
    </Card>
  );
}
