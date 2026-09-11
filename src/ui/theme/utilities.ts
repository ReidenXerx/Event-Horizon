/**
 * ──────────────────────────────────────────────────────────────────────
 * Layout and tone utilities.
 *
 * The UI has a real design system — tokens, and ~1,500 lines of component CSS
 * — and the pages route around it. Measured: **393 inline `style={{…}}`
 * blocks**, and what they mostly do is re-derive the same handful of layouts
 * by hand:
 *
 *   19x  color: var(--eh-text-muted)
 *   15x  display:flex; flex-direction:column; gap:<a spacing token>
 *    9x  muted + xs + uppercase + letter-spacing   (a field label)
 *    5x  display:flex; gap:sp-2; flex-wrap:wrap    (a row of pills)
 *    5x  flex:1; min-width:0                       (the item that gives)
 *
 * Written out at 393 call sites, those drift. One page pads a card with
 * `sp-3` and the next with `sp-4`; one muted note is `xs` and another is
 * `sm`; a row wraps here and not there. Nothing is broken and everything is
 * slightly different, which is exactly what "makeshift" looks like.
 *
 * These classes are EXACTLY the styles they replace — same tokens, same
 * values. Converting a call site is a no-op visually, on purpose: a sweep
 * that also changes how things look cannot be reviewed, because every
 * difference could be intentional or a mistake. Make it identical first;
 * change the design afterwards, deliberately.
 * ──────────────────────────────────────────────────────────────────────
 */

export const UTILITIES_CSS = `
/* ── Stacks: the vertical rhythm of a card or a panel ─────────────── */
.eh-stack {
  display: flex;
  flex-direction: column;
  gap: var(--eh-sp-3);
}
.eh-stack--xs { gap: var(--eh-sp-1); }
.eh-stack--sm { gap: var(--eh-sp-2); }
.eh-stack--lg { gap: var(--eh-sp-4); }
.eh-stack--xl { gap: var(--eh-sp-5); }

/* ── Rows: things side by side, wrapping by default ───────────────── */
.eh-row {
  display: flex;
  align-items: center;
  gap: var(--eh-sp-2);
  flex-wrap: wrap;
}
.eh-row--sm { gap: var(--eh-sp-1); }
.eh-row--lg { gap: var(--eh-sp-3); }
/* A row that must stay on one line — a toolbar, not a pill cloud. */
.eh-row--nowrap { flex-wrap: nowrap; }
/* Push everything after this to the far edge.
   Only reliable on a row that does NOT wrap: margin-left:auto acts within the
   line the element lands on, so once a wrapping row breaks, the "far edge"
   becomes the far edge of whatever line it fell onto. For a row that can wrap,
   group the buttons and use .eh-row--split instead. */
.eh-row__spacer { margin-left: auto; }
/* Two groups held apart, which survives wrapping: the groups stay whole and
   drop as units instead of one stray button being carried down with the
   destructive one. */
.eh-row--split { justify-content: space-between; }
.eh-row--xl { gap: var(--eh-sp-5); }
/* Alignment on the cross axis, for a row that mixes line-heights. */
.eh-row--baseline { align-items: baseline; }
.eh-row--top { align-items: flex-start; }
/* Everything pushed to the far edge (a refresh control above a form). */
.eh-row--end { justify-content: flex-end; }
/* A stack whose items hug the right edge (step dots under a header). */
.eh-stack--end { align-items: flex-end; }
/* A stack whose items centre (a figure over its label inside a ring). */
.eh-stack--center { align-items: center; text-align: center; }
/* Something that navigates on click and is not a button. */
.eh-clickable { cursor: pointer; }

/* The element that absorbs the leftover width. min-width:0 is what stops a
   long unbroken string (a mod name, a path) forcing the row wider than its
   container — the single most common flexbox surprise. */
.eh-fill {
  flex: 1;
  min-width: 0;
}


/* Small print: a hint under a field, a caveat under a heading. */
.eh-note {
  color: var(--eh-text-muted);
  font-size: var(--eh-text-sm);
  line-height: 1.5;
}

/* The micro-label above a value — uppercase, tracked, quiet. */
.eh-label {
  color: var(--eh-text-muted);
  font-size: var(--eh-text-xs);
  text-transform: uppercase;
  letter-spacing: var(--eh-tracking-widest);
}

/* The key/value line is .eh-kv in primitives.ts; .eh-field is a FORM field. */

/* Body copy inside a card: the default paragraph of this UI. */
.eh-body {
  margin: 0;
  color: var(--eh-text-secondary);
  font-size: var(--eh-text-sm);
}

/* A bulleted list of reasons or items, indented off the text column. */
.eh-list {
  margin: 0;
  padding-left: var(--eh-sp-5);
  color: var(--eh-text-secondary);
  font-size: var(--eh-text-sm);
  line-height: var(--eh-leading-relaxed);
}

/* A recessed block inside a card — a path, a payload, a quoted detail. */
.eh-inset {
  padding: var(--eh-sp-3);
  background: var(--eh-bg-base);
  border: 1px solid var(--eh-border-subtle);
  border-radius: var(--eh-radius-sm);
}
/* Modifiers sit AFTER their base in the same module: declared in another
   module that loaded earlier, all three lost to the base's shorthand at
   equal specificity and six call sites rendered untinted. */
.eh-inset--warning { border-color: color-mix(in srgb, var(--eh-warning) 55%, transparent); }
.eh-inset--danger  { border-color: color-mix(in srgb, var(--eh-danger) 55%, transparent); }
.eh-inset--deep    { background: var(--eh-bg-deep); }

/* The row of actions at the bottom of a step or a card. Right-aligned,
   because that is where the eye finishes and where the primary action for a
   flow belongs. */
.eh-actions {
  display: flex;
  gap: var(--eh-sp-2);
  margin-top: var(--eh-sp-5);
  flex-wrap: wrap;
  justify-content: flex-end;
}

/* One line, cut with an ellipsis: a name in a row that must not wrap. */
.eh-truncate {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Small print that is NOT a label: xs, muted, sentence case. */
.eh-small {
  color: var(--eh-text-muted);
  font-size: var(--eh-text-xs);
  line-height: var(--eh-leading-normal);
}

/* A list without bullets, indented off nothing. */
.eh-list--plain { list-style: none; padding-left: 0; }
/* A list inside an inset block keeps the bullets but hugs the padding. */
.eh-list--inset { padding-left: var(--eh-sp-4); }
/* The trailing "and N more" line of a capped list. */
.eh-list__more { list-style: none; opacity: 0.7; }

/* A rule above a block that continues a card. */
.eh-divider-top {
  border-top: 1px solid var(--eh-border-subtle);
  padding-top: var(--eh-sp-3);
}

/* Nothing here: a dashed box saying so, inside a card. */
.eh-empty-box {
  padding: var(--eh-sp-4);
  border: 1px dashed var(--eh-border-default);
  border-radius: var(--eh-radius-md);
  color: var(--eh-text-muted);
  font-size: var(--eh-text-sm);
  text-align: center;
}

/* A bordered, scroll-capped list of rows (mods in a receipt). */
.eh-list-box {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: var(--eh-scroll-max, 320px);
  overflow-y: auto;
  border: 1px solid var(--eh-border-subtle);
  border-radius: var(--eh-radius-sm);
  background: var(--eh-bg-base);
}

.eh-list-box > li {
  padding: var(--eh-sp-2) var(--eh-sp-3);
  border-bottom: 1px solid var(--eh-border-subtle);
}

.eh-list-box > li:last-child { border-bottom: 0; }

/* A grid whose cells top-align (cards of different heights). */
.eh-grid--start { align-items: start; }

/* Monospace for things that are identifiers rather than prose. */
.eh-mono {
  font-family: var(--eh-font-mono);
  font-size: var(--eh-text-xs);
  word-break: break-all;
}

/* ── Text tone — declared LAST on purpose ─────────────────────────── */
/* These only set colour, and they are the caller's last word: a structural
   class that also sets a colour (.eh-label, .eh-list, .eh-note) must lose to
   them. Declared earlier, "eh-label eh-tone--warning" rendered muted and
   "eh-list eh-muted" rendered secondary, because the later rule won. */
.eh-muted { color: var(--eh-text-muted); }
.eh-secondary { color: var(--eh-text-secondary); }
.eh-strong { color: var(--eh-text-primary); }
.eh-tone--info    { color: var(--eh-cyan); }
.eh-tone--success { color: var(--eh-success); }
.eh-tone--warning { color: var(--eh-warning); }
.eh-tone--danger  { color: var(--eh-danger); }

/* A number that is the point of its tile or ring. */
.eh-figure {
  font-size: var(--eh-text-xl);
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
`;
