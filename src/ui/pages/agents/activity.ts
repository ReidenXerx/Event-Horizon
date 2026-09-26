/**
 * What the Agents page's live feed shows for one command an agent sent.
 *
 * Pure: an op record in, a line a person can read out. The feed is the
 * showcase of the control channel (owner, 2026-09-26: show users how it works
 * "instead of their hands"), so every line says what happened in words, and
 * what Event Horizon CHECKED, and what it answered on the user's behalf, is
 * shown as chips on it.
 */

import type { OpRecord } from "../../../core/control/ops";

export type Tone = "running" | "queued" | "ok" | "fail" | "read";
export type Chip = { text: string; tone: "ok" | "warn" | "fail" | "info" };
export type Step = { name: string; state: "done" | "failed" | "todo" };

export type OpView = {
  id: string;
  badge: string;
  tone: Tone;
  title: string;
  detail?: string;
  chips: Chip[];
  steps?: Step[];
  when: string;
  duration?: string;
  mutates: boolean;
};

type Meta = { badge: string; doing: (b: Record<string, unknown>) => string; read?: boolean };

const n = (v: unknown): string => (typeof v === "number" ? v.toLocaleString("en-US") : String(v ?? "?"));
const ids = (b: Record<string, unknown>): number => (Array.isArray(b["modIds"]) ? (b["modIds"] as unknown[]).length : 0);

const META: Record<string, Meta> = {
  state: { badge: "READ", doing: () => "Reading the setup", read: true },
  "mods.find": { badge: "READ", doing: () => "Searching mods", read: true },
  "mod.get": { badge: "READ", doing: (b) => `Looking at ${String(b["id"])}`, read: true },
  "mods.rules": { badge: "READ", doing: (b) => `Reading rules of ${String(b["id"])}`, read: true },
  plugins: { badge: "READ", doing: () => "Reading the load order", read: true },
  "plugins.rules": { badge: "READ", doing: () => "Reading LOOT rules", read: true },
  "plugins.lastGood": { badge: "READ", doing: () => "Reading the last good plugin list", read: true },
  downloads: { badge: "READ", doing: () => "Reading downloads", read: true },
  conflicts: { badge: "READ", doing: () => "Checking file conflicts", read: true },
  "vortex.notifications": { badge: "READ", doing: () => "Reading Vortex's notifications", read: true },
  install: {
    badge: "INSTALL",
    doing: (b) => {
      const nx = b["nexus"] as { modId?: unknown; fileId?: unknown } | undefined;
      return nx !== undefined ? `Installing Nexus ${String(nx.modId)}:${String(nx.fileId)}` : `Installing download ${String(b["archiveId"])}`;
    },
  },
  deploy: { badge: "DEPLOY", doing: () => "Deploying" },
  purge: { badge: "PURGE", doing: () => "Purging the game folder" },
  "mods.setEnabled": { badge: "MODS", doing: (b) => `${b["enabled"] ? "Enabling" : "Disabling"} ${ids(b)} mod(s)` },
  "mods.remove": { badge: "REMOVE", doing: (b) => `Removing ${ids(b)} mod(s)` },
  "mods.rule": { badge: "RULE", doing: (b) => `Setting ${String(b["source"])} ${String(b["type"] ?? "rule")} ${String(b["reference"])}` },
  "plugins.rule": { badge: "LOOT", doing: (b) => `LOOT rule: ${String(b["name"])} ${String(b["type"])} ${String(b["reference"])}` },
  "plugins.setGroup": { badge: "LOOT", doing: (b) => `Moving ${String(b["name"])} to group ${String(b["group"])}` },
  "plugins.sort": { badge: "LOOT", doing: () => "Sorting with LOOT" },
  "plugins.setAutoSort": { badge: "LOOT", doing: (b) => `Turning autosort ${b["enabled"] ? "on" : "off"}` },
  "plugins.apply": {
    badge: "PLUGINS",
    doing: (b) => `Applying a ${Array.isArray(b["order"]) ? (b["order"] as unknown[]).length : "?"}-plugin load order`,
  },
  "plugins.setEnabled": {
    badge: "PLUGINS",
    doing: (b) => `${b["enabled"] ? "Enabling" : "Disabling"} ${Array.isArray(b["names"]) ? (b["names"] as unknown[]).length : "?"} plugin(s)`,
  },
  "profile.switch": { badge: "PROFILE", doing: (b) => `Switching to profile ${String(b["profileId"])}` },
  "game.setPath": { badge: "GAME", doing: (b) => `Pointing the game at ${String(b["path"])}` },
  "game.switchInstall": { badge: "SWITCH", doing: (b) => `Switching the game to ${String(b["path"])}` },
};

const SWITCH_STEPS = ["purge", "setPath", "profile", "deploy"];
const STEP_LABEL: Record<string, string> = { purge: "Purge", setPath: "Repoint", profile: "Profile", deploy: "Deploy" };

export function relativeTime(iso: string | undefined, now: number): string {
  if (iso === undefined) return "";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatDuration(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

/** What Vortex said during the op: answered dialogs, unanswered ones, errors. */
function vortexChips(vortex: unknown): Chip[] {
  const v = (vortex ?? {}) as {
    dialogsSeen?: Array<{ title?: string; answer?: string }>;
    notifications?: Array<{ type?: string; title?: string; message?: string }>;
  };
  const out: Chip[] = [];
  for (const d of v.dialogsSeen ?? []) {
    out.push(
      d.answer !== undefined
        ? { text: `Answered “${d.answer}”`, tone: "info" }
        : { text: `Dialog: ${d.title ?? "question"}`, tone: "warn" },
    );
  }
  for (const x of v.notifications ?? []) {
    if (x.type === "error") out.push({ text: `Vortex error: ${x.title ?? x.message ?? ""}`.trim(), tone: "fail" });
  }
  return out;
}

function resultChips(verb: string, r: Record<string, unknown>): Chip[] {
  const out: Chip[] = [];
  if (r["verified"] !== undefined) out.push({ text: "✓ Verified", tone: "ok" });
  if (typeof r["deployedFiles"] === "number" && verb !== "game.switchInstall") out.push({ text: `${n(r["deployedFiles"])} files deployed`, tone: "info" });
  if (verb === "purge" && r["deployedFilesAfter"] === 0) out.push({ text: "Game folder clean", tone: "info" });
  if (Array.isArray(r["removed"])) {
    const own = (r["removed"] as Array<{ owner?: string }>).filter((m) => m.owner !== "eh-installed").length;
    if (own > 0) out.push({ text: `${own} not installed by Event Horizon`, tone: "warn" });
  }
  if (typeof r["enabledCorrections"] === "number" && r["enabledCorrections"] > 0) out.push({ text: `${n(r["enabledCorrections"])} plugins switched`, tone: "info" });
  if (typeof r["movedCount"] === "number") out.push({ text: `${n(r["movedCount"])} moved`, tone: "info" });
  if (Array.isArray(r["unknown"]) && r["unknown"].length > 0) out.push({ text: `${r["unknown"].length} not in Vortex`, tone: "warn" });
  const conflict = r["conflict"] as { resolved?: boolean } | null | undefined;
  if (conflict?.resolved === true) out.push({ text: "Conflict resolved", tone: "ok" });
  if (typeof r["store"] === "string" && verb.startsWith("game.")) out.push({ text: `Store: ${r["store"]}`, tone: "info" });
  return [...out, ...vortexChips(r["vortex"])];
}

function stepsOf(op: OpRecord): Step[] | undefined {
  if (op.verb !== "game.switchInstall") return undefined;
  const done = (op.result?.["steps"] as string[] | undefined) ?? ((op.details?.["completedSteps"] as string[] | undefined) ?? []);
  const failed = op.details?.["failedStep"] as string | undefined;
  return SWITCH_STEPS.map((s) => ({
    name: STEP_LABEL[s] ?? s,
    state: done.includes(s) ? "done" : s === failed ? "failed" : "todo",
  }));
}

export function presentOp(op: OpRecord, now: number): OpView {
  const meta = META[op.verb] ?? { badge: op.verb.split(".")[0]!.toUpperCase(), doing: () => op.verb };
  const mutates = op.mutates ?? meta.read !== true;
  const doing = meta.doing(op.body ?? {});
  const base = {
    id: op.opId,
    badge: meta.badge,
    when: relativeTime(op.endedAt ?? op.startedAt ?? op.queuedAt, now),
    mutates,
  };
  const steps = stepsOf(op);
  if (op.status === "queued") return { ...base, tone: "queued", title: `${doing} (waiting its turn)`, chips: [], ...(steps ? { steps } : {}) };
  if (op.status === "running") {
    const ms = op.startedAt !== undefined ? now - Date.parse(op.startedAt) : undefined;
    return { ...base, tone: "running", title: `${doing}…`, chips: [], duration: formatDuration(ms), ...(steps ? { steps } : {}) };
  }
  if (op.status === "failed") {
    return {
      ...base,
      tone: "fail",
      title: `${doing}: refused`,
      detail: op.message,
      chips: [{ text: op.code ?? "error", tone: "fail" }, ...vortexChips(op.details?.["vortex"])],
      duration: formatDuration(op.ms),
      ...(steps ? { steps } : {}),
    };
  }
  const summary = op.summary !== undefined ? op.summary.charAt(0).toUpperCase() + op.summary.slice(1) : doing;
  return {
    ...base,
    tone: mutates ? "ok" : "read",
    title: summary,
    chips: resultChips(op.verb, op.result ?? {}),
    duration: formatDuration(op.ms),
    ...(steps ? { steps } : {}),
  };
}

export type ActivityStats = { changes: number; verified: number; refused: number; answered: number };

/** The tiles over the feed: what agents did, what was checked, what was refused, what they spared the user. */
export function activityStats(ops: readonly OpRecord[]): ActivityStats {
  let changes = 0;
  let verified = 0;
  let refused = 0;
  let answered = 0;
  for (const op of ops) {
    const mutates = op.mutates ?? META[op.verb]?.read !== true;
    if (!mutates) continue;
    if (op.status === "succeeded") {
      changes += 1;
      if (op.result?.["verified"] !== undefined) verified += 1;
    }
    if (op.status === "failed") refused += 1;
    const seen = ((op.result?.["vortex"] ?? op.details?.["vortex"]) as { dialogsSeen?: Array<{ answer?: string }> } | undefined)?.dialogsSeen ?? [];
    answered += seen.filter((d) => d.answer !== undefined).length;
  }
  return { changes, verified, refused, answered };
}
