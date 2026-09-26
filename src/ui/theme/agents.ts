/**
 * The Agents page's live feed: a timeline of what agents do, drawn so the
 * work reads at a glance. The marker says the state (a pulsing ring while a
 * command runs), the badge says the kind, the chips say what was checked.
 */
export const AGENTS_CSS = `
/* ── the "live" dot in the card title ───────────────────────────────── */
.eh-agent-live {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--eh-text-disabled);
  flex: none;
}
.eh-agent-live--on {
  background: var(--eh-success);
  animation: eh-pulse-glow 1.6s ease-in-out infinite;
  box-shadow: 0 0 10px var(--eh-success-glow);
}

.eh-agent-empty { padding: var(--eh-sp-4) 0; }

/* ── the timeline ───────────────────────────────────────────────────── */
.eh-agent-feed {
  list-style: none;
  margin: 0;
  padding: 0;
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.eh-agent-feed::before {
  content: "";
  position: absolute;
  left: 9px;
  top: 12px;
  bottom: 12px;
  width: 2px;
  background: linear-gradient(to bottom, var(--eh-border-strong), var(--eh-border-subtle));
}

.eh-agent-op {
  position: relative;
  display: flex;
  gap: 14px;
  padding: 10px 12px 10px 0;
  border-radius: 10px;
  animation: eh-fade-down .35s ease both;
  transition: background .18s ease;
}
.eh-agent-op:hover { background: var(--eh-bg-elevated); }

.eh-agent-op__marker {
  flex: none;
  position: relative;
  z-index: 1;
  width: 20px;
  height: 20px;
  margin-top: 1px;
  border-radius: 50%;
  border: 2px solid var(--eh-border-strong);
  background: var(--eh-bg-raised);
}
.eh-agent-op__marker::after {
  content: "";
  position: absolute;
  inset: 4px;
  border-radius: 50%;
  background: var(--eh-text-disabled);
}
.eh-agent-op--ok .eh-agent-op__marker { border-color: var(--eh-success); box-shadow: 0 0 10px var(--eh-success-glow); }
.eh-agent-op--ok .eh-agent-op__marker::after { background: var(--eh-success); }
.eh-agent-op--fail .eh-agent-op__marker { border-color: var(--eh-danger); box-shadow: 0 0 10px var(--eh-danger-glow); }
.eh-agent-op--fail .eh-agent-op__marker::after { background: var(--eh-danger); }
.eh-agent-op--read .eh-agent-op__marker { border-color: var(--eh-border-default); }
.eh-agent-op--queued .eh-agent-op__marker { border-style: dashed; }
.eh-agent-op--running .eh-agent-op__marker {
  border-color: var(--eh-cyan);
  border-top-color: transparent;
  animation: eh-rotate-cw 1s linear infinite;
}
.eh-agent-op--running .eh-agent-op__marker::after {
  background: var(--eh-cyan);
  animation: eh-pulse-opacity 1.2s ease-in-out infinite;
}

.eh-agent-op__body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.eh-agent-op__head { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.eh-agent-op__badge {
  flex: none;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .1em;
  padding: 2px 7px;
  border-radius: 6px;
  color: var(--eh-text-inverse);
  background: linear-gradient(135deg, var(--eh-disk-hot), var(--eh-disk-pink));
}
.eh-agent-op--read .eh-agent-op__badge { background: var(--eh-bg-elevated); color: var(--eh-text-muted); }
.eh-agent-op--fail .eh-agent-op__badge { background: var(--eh-danger); }
.eh-agent-op--running .eh-agent-op__badge { background: var(--eh-cyan); }
.eh-agent-op__title {
  flex: 1;
  min-width: 0;
  color: var(--eh-text-primary);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.eh-agent-op--read .eh-agent-op__title { color: var(--eh-text-secondary); font-weight: 500; }
.eh-agent-op__time { flex: none; font-size: 11px; color: var(--eh-text-muted); font-variant-numeric: tabular-nums; }
.eh-agent-op__detail { margin: 0; font-size: 12px; color: var(--eh-danger); }

/* ── switch steps ───────────────────────────────────────────────────── */
.eh-agent-steps { display: flex; gap: 4px; flex-wrap: wrap; }
.eh-agent-step {
  font-size: 11px;
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid var(--eh-border-default);
  color: var(--eh-text-muted);
}
.eh-agent-step--done { border-color: var(--eh-success); color: var(--eh-success); }
.eh-agent-step--failed { border-color: var(--eh-danger); color: var(--eh-danger); }

/* ── chips: what was checked, what was answered ─────────────────────── */
.eh-agent-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.eh-agent-chip {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 6px;
  background: var(--eh-bg-elevated);
  color: var(--eh-text-secondary);
}
.eh-agent-chip--ok { color: var(--eh-success); background: rgba(61, 220, 132, .1); }
.eh-agent-chip--info { color: var(--eh-cyan-bright); background: var(--eh-accent-soft); }
.eh-agent-chip--warn { color: var(--eh-warning); background: rgba(255, 177, 92, .1); }
.eh-agent-chip--fail { color: var(--eh-danger); background: rgba(255, 91, 120, .1); }
`;
