/**
 * The Build page's "Optional mods" card (owner, 2026-10-09): mark any mod
 * optional, give it the one line players see, and say whether it is for
 * handheld PCs. Writes the same collection-config fields a curator could type
 * (`optional`, `optionalNote`, `optionalFor`), through the form's overrides.
 */
import * as React from "react";

import { Button, Card, Checkbox, Input } from "../../components";
import type { AuditorMod } from "../../../core/getModsListForProfile";
import type { ExternalModConfigEntry } from "../../../core/manifest/collectionConfig";

const MAX_MATCHES = 8;

export function OptionalModsCard(props: {
  mods: readonly Pick<AuditorMod, "id" | "name" | "enabled">[];
  overrides: Readonly<Record<string, ExternalModConfigEntry>>;
  onChange: (modId: string, patch: Partial<ExternalModConfigEntry>) => void;
}): JSX.Element {
  const [search, setSearch] = React.useState("");
  const optional = props.mods.filter((m) => props.overrides[m.id]?.optional === true);
  const needle = search.trim().toLowerCase();
  const matches =
    needle.length < 2
      ? []
      : props.mods
          .filter((m) => props.overrides[m.id]?.optional !== true && m.name.toLowerCase().includes(needle))
          .slice(0, MAX_MATCHES);

  return (
    <Card title={`Optional mods (${optional.length})`}>
      <div className="eh-stack eh-stack--sm">
        <p className="eh-body">
          Players can untick an optional mod at install, and one that cannot be downloaded is skipped without
          breaking the collection. A mod switched off in your own profile still ships when it is optional, so you
          can keep handheld or alternative settings out of your own game.
        </p>
        <Input
          type="search"
          value={search}
          placeholder="Find a mod to make optional"
          onChange={(e) => setSearch(e.target.value)}
        />
        {matches.map((m) => (
          <div key={m.id} className="eh-row">
            <span className="eh-body">
              {m.name}
              {!m.enabled && <span className="eh-muted"> (switched off in your profile)</span>}
            </span>
            <Button
              size="sm"
              intent="ghost"
              onClick={(): void => {
                props.onChange(m.id, { optional: true });
                setSearch("");
              }}
            >
              Make optional
            </Button>
          </div>
        ))}
        {optional.map((m) => {
          const entry = props.overrides[m.id] ?? {};
          return (
            <div key={m.id} className="eh-stack eh-stack--xs eh-inset">
              {!m.enabled && (
                <p className="eh-note eh-secondary">
                  Switched off in your profile: it ships from the next time you open the Build page.
                </p>
              )}
              <div className="eh-row">
                <strong>{m.name}</strong>
                <Button size="sm" intent="ghost" onClick={(): void => props.onChange(m.id, { optional: false })}>
                  Not optional
                </Button>
              </div>
              <Input
                type="text"
                value={entry.optionalNote ?? ""}
                placeholder="One line players see: what it adds"
                onChange={(e) => props.onChange(m.id, { optionalNote: e.target.value })}
              />
              <Checkbox
                label="For handheld PCs"
                description="Ticked at install on a Steam Deck, ROG Ally, Legion Go and similar; unticked on a desktop PC."
                checked={entry.optionalFor === "handheld"}
                onChange={(e): void =>
                  props.onChange(m.id, e.target.checked ? { optionalFor: "handheld" } : { optionalFor: undefined })
                }
              />
            </div>
          );
        })}
      </div>
    </Card>
  );
}
