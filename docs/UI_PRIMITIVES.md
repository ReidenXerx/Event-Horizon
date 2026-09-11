# UI primitives — the vocabulary

Every screen in Event Horizon is built from the components in `src/ui/components`
and the classes in `src/ui/theme`. A page does not carry `style={{…}}`; if a page
needs a look the vocabulary lacks, the vocabulary grows (in the theme, with a
name) rather than the page working around it.

Two tests enforce this: `theme/classes.test.ts` fails on a class no theme module
declares, and `components/noInlineStyle.test.ts` fails on an inline style inside
a primitive. `theme/tokens.test.ts` fails on an undeclared `--eh-*` token.

To LOOK at the result: `npm run ui:shots` renders every screen in
`src/ui/__render__/renderScreens.test.ts` to `.scratch-render/shots/*.png`.

## Components

| Need | Component | Notes |
| --- | --- | --- |
| A page or wizard step | `Page` | `title`, `subtitle`, `eyebrow` (step dots), `actions` |
| A titled region inside a page | `Section` | `title`, `count`, `description`, `actions`, `size="sm"` |
| A boxed container | `Card` | `title`, `subtitle`, `actions`, `footer`, `compact`, `tone`, `onClick` |
| Label over a value | `StatTile` | `tone`, `size` (`sm`/`md`/`lg`), `sub`, `subMono`, `bare` |
| A row of tiles | `StatGrid` | auto-fit; `min` = narrowest tile |
| A message with a tone | `Callout` | `tone`, `title`, `actions`; role follows tone (`role="silent"` for body prose) |
| A labelled finding on a report | `Notice` | pill + summary + optional detail |
| Nothing here yet | `EmptyState` | `icon`, `title`, body, `actions` |
| A button | `Button` | `intent`, `size`, `busy`, `leadingIcon`, `fullWidth` |
| An action that reads as text | `LinkButton` | `variant="caps"` for SHOW DETAILS, `tone` |
| A status tag | `Pill` | `intent`, `withDot`; `plain` for a sentence-case phrase |
| Label + control + hint | `Field` | `hint`, `error`, `required`, `inline`; the child gets `id` + `aria-describedby`, or use `(id, describedBy) => …` |
| Text / number input | `Input` | `mono`, `small` |
| Multi-line | `Textarea` | |
| Dropdown | `Select` | `small`, `auto` |
| Tick box / radio | `Checkbox`, `Radio` | `label`, `description`, `indeterminate` |
| A whole card that is one option | `ChoiceCard` | `checked`, `label`, `sub`, `kind` |
| A toggling filter pill | `Chip` | `active` |
| Blocking question | `Modal` | focus-trapped; only the topmost handles Esc |
| Non-blocking message | `useToast()` | pauses on hover; `danger` is sticky |
| Sortable, filterable list | `DataTable` | selection survives filters; the table is fixed-layout, so give `actionsWidth` when rows have action buttons or the name column pays for them |
| Working indicator | `Spinner` | sized in `em`, coloured by `currentColor` |
| Slow pass reassurance | `HashingCard` | |
| Wizard position | `StepDots` | |

## Layout classes (theme/utilities.ts and theme/primitives.ts)

| Need | Class |
| --- | --- |
| Vertical rhythm | `eh-stack` (`--xs`, `--sm`, `--lg`, `--xl`) |
| Things side by side, wrapping | `eh-row` (`--sm`, `--lg`, `--nowrap`, `--split`) |
| The item that absorbs leftover width | `eh-fill` |
| Responsive grid | `eh-grid` (`--tight`, `--start`); `--eh-grid-min` sets the column minimum |
| Body copy at a readable width | `eh-prose` |
| The actions row of a step | `eh-actions`; `eh-actions--sticky` on a long step; `eh-actions__clear` for the small link beside a ticked count |
| Key / value line | `eh-kv` + `eh-kv__label` |
| Recessed block inside a card | `eh-inset` |
| Micro-label | `eh-label` |
| Small print | `eh-note` |
| Body paragraph | `eh-body` |
| Bulleted list | `eh-list` |
| Identifier text | `eh-mono` |
| Tone | `eh-muted`, `eh-secondary`, `eh-strong`; `eh-tone--info/success/warning/danger` for a coloured word |
| Small print, not a label | `eh-small` |
| One line, ellipsis | `eh-truncate` |
| Keep line breaks | `eh-pre-line`, `eh-pre-wrap` |
| Row alignment | `eh-row--baseline`, `eh-row--top`, `eh-row--end`, `eh-row--xl`; `eh-stack--end` |
| Scroll-capped block | `eh-scroll` (`--eh-scroll-max`), `eh-list-box` |
| List variants | `eh-list--plain`, `eh-list--spaced`, `eh-list--inset`, `eh-list__more` |
| Rule above a block | `eh-divider-top` |
| Dashed "nothing here" box | `eh-empty-box` |
| Inset tones | `eh-inset--warning`, `eh-inset--danger`, `eh-inset--deep` |
| Details tones | `eh-details--warning`, `eh-details--danger` |
| Thin progress bar | `eh-bar` + `eh-bar__fill` (`--eh-progress`) |
| Ring beside a headline | `eh-progress-panel` + `eh-progress-panel__title`; `eh-centred` for the stacked form |
| Severity dot | `eh-dot` (`--info` … `--danger`, `--glow`, `--lg`) |
| Native disclosure | `<details class="eh-details">` + `eh-details__body` |

## Rules

- Tokens only. A hex colour or a pixel size that is not a token belongs in the theme.
- Colour is for something that needs attention. Neutral is plain text.
- Every section on a page is the same level of hierarchy. Do not mix an h2 with a micro-label as siblings.
- One primary button per view. Everything else is ghost.
- Edit markup by matching a unique literal string, never by index arithmetic (PP-3).
