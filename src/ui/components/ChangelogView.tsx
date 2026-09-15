/**
 * One version of a collection's changelog as Event Horizon wrote it: the
 * curator's words, the totals, then every group of changes.
 *
 * Shared by the build Done card and the install preview, so a curator sees
 * exactly what the people updating will read.
 *
 * Long groups show their first lines and a button for the rest: one re-sorted
 * load order can move hundreds of plugins, and a preview that tall buries the
 * decision the screen exists for.
 */

import * as React from "react";

import { Button } from "./Button";
import { DiffSectionBlock } from "./DiffSectionBlock";
import {
  changeSections,
  describeUnknowns,
  summarizeEntry,
  type ChangelogEntry,
  type ChangeSection,
} from "../../core/changelog/changelog";

export interface ChangelogEntryViewProps {
  entry: ChangelogEntry;
  /** Lines shown per group before "Show all". Defaults to 12. */
  previewLines?: number;
  /** Start every group collapsed. */
  collapsed?: boolean;
  /** Leave out the version line, when the surrounding card already names it. */
  hideHeading?: boolean;
}

export function ChangelogEntryView(props: ChangelogEntryViewProps): JSX.Element {
  const { entry } = props;
  const sections = entry.changes !== undefined ? changeSections(entry.changes) : [];
  const unknown = entry.changes !== undefined ? describeUnknowns(entry.changes) : undefined;
  return (
    <div className="eh-stack eh-stack--sm">
      {props.hideHeading !== true && (
        <div className="eh-row">
          <strong className="eh-strong">v{entry.version}</strong>
          <span className="eh-note">{entry.date.slice(0, 10)}</span>
        </div>
      )}
      {entry.notes !== undefined && (
        <div className="eh-stack eh-stack--xs">
          {entry.notes.split(/\n\s*\n/).map((paragraph, i) => (
            <p key={i} className="eh-body">
              {paragraph}
            </p>
          ))}
        </div>
      )}
      <p className="eh-strong">{summarizeEntry(entry)}</p>
      {sections.map((section) => (
        <ChangeGroup
          key={section.title}
          section={section}
          previewLines={props.previewLines ?? 12}
          collapsed={props.collapsed === true}
        />
      ))}
      {unknown !== undefined && <p className="eh-note">Not compared: {unknown}</p>}
    </div>
  );
}

function ChangeGroup(props: {
  section: ChangeSection;
  previewLines: number;
  collapsed: boolean;
}): JSX.Element {
  const [showAll, setShowAll] = React.useState(false);
  const { title, lines } = props.section;
  const shown = showAll ? lines : lines.slice(0, props.previewLines);
  return (
    <DiffSectionBlock
      title={title}
      count={lines.length}
      intent="neutral"
      defaultExpanded={!props.collapsed}
    >
      <div className="eh-stack eh-stack--xs">
        <ul className="eh-list">
          {shown.map((text, i) => (
            <li key={`${i}-${text.slice(0, 24)}`} className="eh-secondary">
              {text}
            </li>
          ))}
        </ul>
        {lines.length > shown.length && (
          <div>
            <Button intent="ghost" size="sm" onClick={(): void => setShowAll(true)}>
              Show all {lines.length}
            </Button>
          </div>
        )}
      </div>
    </DiffSectionBlock>
  );
}
