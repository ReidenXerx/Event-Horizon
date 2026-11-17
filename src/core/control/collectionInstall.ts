/**
 * ──────────────────────────────────────────────────────────────────────
 * collection.install: an Event Horizon collection install an agent can run
 * with nobody at the screen (owner, 2026-11-17: alasdairn's PC, remotely).
 *
 * ─── THE SAME INSTALL, ANOTHER HAND ON THE BUTTONS ─────────────────────
 * Nothing here installs anything itself. It drives the install page's own
 * InstallSession through the same steps a click does: loading pipeline,
 * preview, decisions, confirm, the start gates, the hands-off warning, and
 * runInstall. So the layers, rules, plugin order, ini tweaks, mirrors,
 * receipt and Doctor all behave exactly as for a clicked install (NS-1). A
 * per-mod replay with the `install` verb would have produced none of those.
 *
 * Only the answering hand differs, and it answers by the gate's KIND, never
 * by its wording (installSession.ts AgentAskKind):
 *   - what the dialog itself offers as the fix is taken: switch auto-deploy
 *     and auto-sort off, move unaccounted game-folder files aside (Doctor →
 *     Moved-aside files puts them back);
 *   - everything that means "this machine cannot take this install" stops
 *     the run with the dialog's own text: a dead extractor, no deployment
 *     method, a blocked environment check, the plugin budget over the limit
 *     (unless allowOverBudget), a failed clean.
 *
 * ─── WHAT IT NEVER GUESSES ─────────────────────────────────────────────
 *   - A FOMOD the curator left with nothing selected still opens its wizard
 *     (NS-8). The run waits for it like a clicked install would; the caller
 *     answers it with fomod.answer, which does not queue behind this verb.
 *   - A mod the plan asks a file for gets the caller's `localFiles` entry, a
 *     remembered source that still exists, or is SKIPPED and listed. It is
 *     never matched by name: the resolver already matched the Downloads
 *     folder by hash, and a prompt-user mod is one it did not find.
 *
 * ─── THE TARGET IS THE RESOLVER'S ──────────────────────────────────────
 * pickInstallTarget's rule stands: no receipt means a fresh profile. What a
 * player loses to that (their own mods) is carried, the way an update
 * carries them: every mod switched on in `carryFromProfileId` (default: the
 * active profile) that the plan does not resolve as a collection mod, with
 * its plugins ticked as they were. The source profile is left untouched.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import type { types } from "@nexusmods/vortex-api";

import { ControlError } from "./controlError";
import { askOwner } from "./ownerConsent";
import { ehLog } from "../logging/ehLog";
import type { AgentAsk, AgentAskKind } from "../../ui/pages/install/installSession";
import type { WizardState } from "../../ui/pages/install/state";
import type { InstallPlan } from "../../types/installPlan";

type Body = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

export type AgentOptions = { allowOverBudget: boolean };
export type AgentVerdict = { label: string | undefined; stops: boolean };

/**
 * What the agent presses, per gate. Pure, so every row is tested.
 *
 * `stops` means the gate ends WITHOUT starting the install, and the verb
 * reports the dialog's text instead of waiting for a start that will not come.
 */
export function agentAnswer(ask: AgentAsk, opts: AgentOptions): AgentVerdict {
  const has = (l: string): string | undefined => (ask.actions.includes(l) ? l : undefined);
  // The gates put the decline first and the offered fix second.
  const offered = ask.actions[1];
  const rule: Record<AgentAskKind, () => AgentVerdict> = {
    "auto-deploy": () => ({ label: offered, stops: offered === undefined }),
    "auto-sort": () => ({ label: offered, stops: offered === undefined }),
    "clean-plan": () => ({ label: offered, stops: offered === undefined }),
    "plugin-budget": () =>
      opts.allowOverBudget && has("Install anyway") !== undefined
        ? { label: "Install anyway", stops: false }
        : { label: has("Cancel") ?? ask.actions[0], stops: true },
    // Disabling sorting did not take: LOOT would re-sort the curator's order during the run.
    "auto-sort-still-on": () => ({ label: has("Cancel") ?? ask.actions[0], stops: true }),
    // The check could not run: a person decides whether to go on without it, never an agent.
    "environment-check-crashed": () => ({ label: has("Cancel") ?? ask.actions[0], stops: true }),
    "extractor-broken": () => ({ label: has("Close") ?? ask.actions[0], stops: true }),
    "environment-blocked": () => ({ label: ask.actions[0], stops: true }),
    "active-game-changed": () => ({ label: ask.actions[0], stops: true }),
    "clean-failed": () => ({ label: ask.actions[0], stops: true }),
    "no-deployment-method": () => ({ label: ask.actions[0], stops: true }),
  };
  return rule[ask.kind]();
}

/**
 * The player's own mods in a profile: on there, in the pool, not a mod this
 * plan resolves as the collection's, and not another file of a Nexus page the
 * collection installs. That last one is an older or newer copy of a
 * collection mod: carrying it puts two copies of one mod in the new profile
 * and stops the run on Vortex's "An older version of this mod is already
 * installed" (alasdairn, 2026-11-17: Tacticool 0.23.30 against 0.23.31).
 */
export function ownModsToCarry(args: {
  plan: Pick<InstallPlan, "modResolutions">;
  pool: Readonly<Record<string, { attributes?: Record<string, unknown> } | undefined>>;
  modState: Readonly<Record<string, { enabled?: boolean } | undefined>>;
  /** Nexus mod ids (pages) of the collection's Nexus mods. */
  collectionNexusModIds?: ReadonlySet<string>;
}): Array<{ vortexModId: string; name: string }> {
  const collection = new Set<string>();
  for (const r of args.plan.modResolutions) {
    const id = (r.decision as { existingModId?: unknown }).existingModId;
    if (typeof id === "string") collection.add(id);
  }
  const out: Array<{ vortexModId: string; name: string }> = [];
  for (const [id, st] of Object.entries(args.modState)) {
    if (st?.enabled !== true || collection.has(id)) continue;
    const mod = args.pool[id];
    if (mod === undefined) continue;
    const a = mod.attributes ?? {};
    const nexusId = a["modId"];
    const fromNexus = a["source"] === undefined || a["source"] === "nexus";
    if (fromNexus && (typeof nexusId === "number" || typeof nexusId === "string") && args.collectionNexusModIds?.has(String(nexusId))) continue;
    const name = [a["customFileName"], a["logicalFileName"], a["name"]].find((v): v is string => typeof v === "string" && v !== "") ?? id;
    out.push({ vortexModId: id, name });
  }
  return out.sort((x, y) => x.name.localeCompare(y.name));
}

type Session = Awaited<ReturnType<typeof loadSession>>;
async function loadSession(): Promise<ReturnType<typeof import("../../ui/pages/install/installSession")["getInstallSession"]>> {
  const { getInstallSession } = await import("../../ui/pages/install/installSession");
  return getInstallSession();
}

/** Resolves with the first state `pick` accepts; rejects after `ms`. */
function waitFor<T>(session: Session, pick: (s: WizardState) => T | undefined, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    let unsubscribe: (() => void) | undefined;
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe?.();
      fn();
    };
    const check = (): void => {
      let hit: T | undefined;
      try {
        hit = pick(session.getSnapshot().state);
      } catch (err) {
        finish(() => reject(err));
        return;
      }
      if (hit !== undefined) finish(() => resolve(hit as T));
    };
    const timer = setTimeout(
      () => finish(() => reject(new ControlError("timeout", `Waited ${Math.round(ms / 60000)} min for ${what}; the install page is at "${session.getSnapshot().state.kind}".`, 504))),
      ms,
    );
    // Also on a beat: a gate the agent stopped changes no wizard state, so nothing would notify.
    const beat = setInterval(check, 1000);
    const unsub = session.subscribe(check);
    unsubscribe = (): void => {
      clearInterval(beat);
      unsub();
    };
    check();
  });
}

function errorOf(state: WizardState): never | undefined {
  if (state.kind !== "error") return undefined;
  const e = state.error as { title?: unknown; message?: unknown; details?: unknown };
  throw new ControlError("install-error", `${String(e.title ?? "Install error")}: ${String(e.message ?? "")}`.trim(), 500, {
    ...(e.details !== undefined ? { details: e.details } : {}),
  });
}

const MIN = 60_000;

/** What the run pressed on Vortex's own install questions. */
type DialogsAnswered = { invalidFomod: string[]; alreadyInstalled: Array<{ title?: string; text: string; answer: string }> };
type DialogTools = Pick<typeof import("./verbs"), "answerFor" | "rawDialogs">;

/**
 * Vortex's own install questions during the run:
 *   - "Invalid fomod" gets Ignore: the same installer, same choices, validation off;
 *   - "An older version of this mod is already installed" and "Install options"
 *     (already installed) are answered ALONGSIDE, as a clicked install's
 *     bundled mods are (bundledTargetName.ts): the new profile gets the
 *     collection's file and every other profile keeps what it had (NS-2).
 */
function answerRunDialogs(api: types.IExtensionApi, answered: DialogsAnswered, tools: DialogTools): () => void {
  const handled = new Set<string>();
  const check = (): void => {
    for (const d of tools.rawDialogs(api)) {
      if (handled.has(d.id)) continue;
      const answer = tools.answerFor({ ifExisting: "alongside" }, d);
      if (answer === undefined) continue;
      handled.add(d.id);
      answered.alreadyInstalled.push({ ...(d.title !== undefined ? { title: d.title } : {}), text: d.text.slice(0, 300), answer: answer.label });
      ehLog("info", "control.collection-install.already-installed-answered", { title: d.title, text: d.text.slice(0, 300), answer: answer.label });
      setTimeout(() => api.closeDialog?.(d.id, answer.label, answer.input ?? {}), 0);
    }
    answerInvalidFomodNow();
  };
  const answerInvalidFomodNow = (): void => {
    const dialogs = (api.getState() as { session?: { notifications?: { dialogs?: unknown[] } } }).session?.notifications?.dialogs;
    for (const d of Array.isArray(dialogs) ? dialogs : []) {
      const x = d as { id?: unknown; title?: unknown; actions?: unknown[]; content?: { text?: unknown; message?: unknown } };
      if (typeof x.id !== "string" || handled.has(x.id)) continue;
      if (String(x.title ?? "").toLowerCase() !== "invalid fomod") continue;
      const labels = (Array.isArray(x.actions) ? x.actions : []).map((a) => (typeof a === "string" ? a : String((a as { label?: unknown })?.label ?? "")));
      if (!labels.includes("Ignore")) continue;
      handled.add(x.id);
      const text = String(x.content?.text ?? x.content?.message ?? "").slice(0, 300);
      answered.invalidFomod.push(text);
      ehLog("warn", "control.collection-install.invalid-fomod-ignored", { text });
      const id = x.id;
      setTimeout(() => api.closeDialog?.(id, "Ignore", {}), 0);
    }
  };
  return (api.store as unknown as { subscribe?: (fn: () => void) => () => void } | undefined)?.subscribe?.(check) ?? ((): void => undefined);
}

function decisionCounts(plan: InstallPlan): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of plan.modResolutions) out[r.decision.kind] = (out[r.decision.kind] ?? 0) + 1;
  return out;
}

export const COLLECTION_INSTALL_VERBS = {
  /**
   * Installs an Event Horizon collection package, as the install page does.
   *
   *   { path: the package zip,
   *     carryFromProfileId?: whose own mods to carry (default: the active profile),
   *     staleReceipt?: "keep" | "delete" (only asked when a receipt points at mods that are gone),
   *     localFiles?: { [compareKey or mod name]: file path } for mods the plan asks a file for,
   *     store?: "steam" | "gog" (only when the collection ships store builds and Vortex cannot say),
   *     fomodReplayMode?: "silent" (default) | "supervised",
   *     allowOverBudget?: true,
   *     dryRun?: true }
   *
   * Send with `async: true` and poll ops.get; collection.installStatus shows
   * the phase while it runs.
   */
  "collection.install": {
    mutates: true,
    run: async (api: types.IExtensionApi, body: Body): Promise<Record<string, unknown>> => {
      const zipPath = str(body["path"]);
      if (zipPath === undefined) throw new ControlError("bad-request", `Send "path": the collection package (.zip / .ehcoll).`);
      if (!fs.existsSync(zipPath)) throw new ControlError("no-package", `No file at ${zipPath}.`, 404);
      const dryRun = body["dryRun"] === true;
      const session = await loadSession();
      const before = session.getSnapshot().state.kind;
      if (before === "installing" || before === "loading" || before === "link-fetching") {
        throw new ControlError("busy", `The install page is busy ("${before}"). Wait for it, or reset it in Event Horizon.`, 409);
      }

      ehLog("info", "control.collection-install.start", { zipPath, dryRun });
      session.reset();
      session.pickFile(api, zipPath);
      let state = await waitFor(
        session,
        (s) => (s.kind === "preview" || s.kind === "stale-receipt" || s.kind === "error" ? s : undefined),
        180 * MIN,
        "the package to load and hash",
      );
      errorOf(state);
      if (state.kind === "stale-receipt") {
        const choice = str(body["staleReceipt"]);
        if (choice !== "keep" && choice !== "delete") {
          session.reset();
          throw new ControlError(
            "stale-receipt",
            `An earlier install of this collection left a record whose mods are no longer installed. Send staleReceipt: "keep" (update over it) or "delete" (install as new), as the page would ask.`,
            409,
          );
        }
        session.resolveStaleReceipt(api, choice);
        state = await waitFor(session, (s) => (s.kind === "preview" || s.kind === "error" ? s : undefined), 180 * MIN, "the package to load");
        errorOf(state);
      }
      if (state.kind !== "preview") throw new ControlError("install-error", `Expected the preview, got "${state.kind}".`, 500);

      const bundle = state.bundle;
      const plan = bundle.plan;
      const manifest = plan.manifest;

      // Store builds with no store: the page holds Continue until it is answered.
      const { hasStoreBuilds } = await import("../installer/variantGroups");
      if (hasStoreBuilds(manifest.mods) && bundle.gameStore === undefined) {
        const store = str(body["store"]);
        if (store !== "steam" && store !== "gog") {
          session.reset();
          throw new ControlError("store-unanswered", `This collection ships store builds and Vortex cannot say where the game is from. Send store: "steam" or "gog".`, 409);
        }
        session.pickStore(store);
      }
      const mismatch = plan.compatibility?.versionMismatch;
      if (mismatch !== undefined) session.acknowledgeVersion(true);

      // The preview's own verdict, with the same inputs the page gives it.
      const [{ computeVerdict }, { summarizeEnvironment }, account] = await Promise.all([
        import("../../ui/pages/install/steps"),
        import("../../ui/pages/install/EnvironmentCard"),
        import("../installer/checkNexusAccount"),
      ]);
      const nexusAccount = account.readNexusAccount(api);
      const accountLines = account.describeNexusAccount(nexusAccount, account.countNexusDownloads(plan));
      const accountBlocks = (nexusAccount.kind === "free" || nexusAccount.kind === "logged-out") && accountLines.length > 0 ? accountLines : [];
      const environment = summarizeEnvironment(bundle.environment);
      const now = session.getSnapshot().state;
      const verdict = computeVerdict(
        plan,
        accountBlocks.length > 0 ? [] : accountLines,
        [...environment.blockers, ...accountBlocks],
        true,
        hasStoreBuilds(manifest.mods) && (now.kind === "preview" ? now.bundle.gameStore : bundle.gameStore) === undefined,
      );

      // Own mods to carry: only into a fresh profile, and only when no receipt already offered them.
      const vortexState = api.getState() as {
        settings?: { profiles?: { activeProfileId?: string } };
        persistent?: {
          profiles?: Record<string, { name?: string; gameId?: string; modState?: Record<string, { enabled?: boolean }> } | undefined>;
          mods?: Record<string, Record<string, { attributes?: Record<string, unknown> }>>;
        };
      };
      const sourceId = str(body["carryFromProfileId"]) ?? vortexState.settings?.profiles?.activeProfileId;
      const sourceProfile = sourceId !== undefined ? vortexState.persistent?.profiles?.[sourceId] : undefined;
      if (str(body["carryFromProfileId"]) !== undefined && (sourceProfile === undefined || sourceProfile.gameId !== manifest.game.id)) {
        session.reset();
        throw new ControlError("bad-profile", `No ${manifest.game.id} profile ${String(body["carryFromProfileId"])}.`, 404);
      }
      let carry: Array<{ vortexModId: string; name: string }> = [];
      const receiptCarry = bundle.previousRevision?.carry ?? [];
      if (plan.installTarget.kind === "fresh-profile" && receiptCarry.length === 0 && sourceId !== undefined && sourceProfile?.gameId === manifest.game.id) {
        carry = ownModsToCarry({
          plan,
          pool: vortexState.persistent?.mods?.[manifest.game.id] ?? {},
          modState: sourceProfile.modState ?? {},
          collectionNexusModIds: new Set(
            manifest.mods.flatMap((m) => {
              const src = m.source as { kind: string; modId?: unknown };
              return src.kind === "nexus" && src.modId !== undefined ? [String(src.modId)] : [];
            }),
          ),
        });
      }

      // Files the plan asks for: the caller's, then a remembered one that still exists, else skipped.
      const localFiles = (body["localFiles"] ?? {}) as Record<string, unknown>;
      const { readSourceMemory, usableSources } = await import("../installer/sourceMemory");
      const remembered = await usableSources(await readSourceMemory(bundle.appDataPath, manifest.package.id)).catch(() => ({}) as Record<string, { path: string }>);
      const asks = plan.modResolutions.filter((r) => r.decision.kind === "external-prompt-user");
      const fileChoices: Array<{ compareKey: string; name: string; choice: "given" | "remembered" | "skipped"; path?: string }> = [];
      for (const r of asks) {
        const given = str(localFiles[r.compareKey]) ?? str(localFiles[r.name]);
        if (given !== undefined && fs.existsSync(given)) {
          fileChoices.push({ compareKey: r.compareKey, name: r.name, choice: "given", path: given });
        } else if (remembered[r.compareKey] !== undefined) {
          fileChoices.push({ compareKey: r.compareKey, name: r.name, choice: "remembered", path: remembered[r.compareKey]!.path });
        } else {
          fileChoices.push({ compareKey: r.compareKey, name: r.name, choice: "skipped" });
        }
      }

      const summary = {
        package: { id: manifest.package.id, name: manifest.package.name, version: manifest.package.version },
        target:
          plan.installTarget.kind === "fresh-profile"
            ? { kind: "fresh-profile", name: plan.installTarget.resumeProfileName ?? plan.installTarget.suggestedProfileName, ...(plan.installTarget.resumeProfileId !== undefined ? { resumes: plan.installTarget.resumeProfileId } : {}) }
            : { kind: "current-profile", id: plan.installTarget.profileId, name: plan.installTarget.profileName },
        mods: plan.modResolutions.length,
        decisions: decisionCounts(plan),
        orphans: plan.orphanedMods.length,
        verdict: { canProceed: verdict.canProceed, headline: verdict.headline, lines: verdict.lines },
        ...(mismatch !== undefined ? { gameVersionAcknowledged: { required: mismatch.required, installed: mismatch.installed } } : {}),
        carry: {
          fromProfile: sourceId !== undefined ? { id: sourceId, name: sourceProfile?.name } : null,
          count: carry.length + receiptCarry.filter((c) => c.carry).length,
          names: (carry.length > 0 ? carry.map((c) => c.name) : receiptCarry.filter((c) => c.carry).map((c) => c.name)).slice(0, 300),
        },
        filesAskedFor: fileChoices,
        fomodReplayMode: str(body["fomodReplayMode"]) === "supervised" ? "supervised" : "silent",
      };
      if (dryRun || !verdict.canProceed) {
        session.reset();
        if (!verdict.canProceed) throw new ControlError("cannot-install", `${verdict.headline}: ${verdict.lines.join(" ")}`, 409, summary);
        return { dryRun: true, ...summary };
      }

      await askOwner(api, {
        action: `install ${manifest.package.name} v${manifest.package.version}`,
        lines: [
          `Into: ${summary.target.kind === "fresh-profile" ? `a new profile "${String(summary.target.name)}"` : `profile "${String(summary.target.name)}"`}`,
          `${plan.modResolutions.length} mods; ${summary.carry.count} of your own carried over`,
          ...fileChoices.filter((f) => f.choice === "skipped").map((f) => `Skipped (no file): ${f.name}`),
        ],
        consequence:
          "Vortex's deployment is purged and redeployed, and game-folder files nothing accounts for are moved aside (Doctor → Moved-aside files puts them back).",
      }).catch((err: unknown) => {
        session.reset();
        throw err;
      });

      if (carry.length > 0) {
        const { enabledPluginsOf } = await import("../../ui/pages/install/previousRevision");
        const plugins = sourceId !== undefined ? await enabledPluginsOf(vortexState as never, manifest.game.id, sourceId) : undefined;
        session.setAgentCarry(carry, plugins);
      }
      session.openDecisionsFromPreview();
      if (session.getSnapshot().state.kind !== "decisions") {
        const s = session.getSnapshot().state;
        session.reset();
        throw new ControlError("install-error", `The preview would not continue (at "${s.kind}").`, 500);
      }
      for (const f of fileChoices) {
        session.setConflictChoice(
          f.compareKey,
          f.choice === "skipped" ? { kind: "skip" } : { kind: "use-local-file", localPath: f.path! },
        );
      }
      session.setFomodReplayMode(summary.fomodReplayMode as "silent" | "supervised");
      const { orphanEnabledIn } = await import("../../ui/pages/install/orphanSharing");
      session.openConfirm((id) => orphanEnabledIn(api, plan, id).length > 0);

      // The gates, answered by the agent; a stop ends the run with the dialog's text.
      const asked: Array<{ kind: string; title: string; answer: string | undefined }> = [];
      let stopped: { kind: string; title: string; text: string } | undefined;
      const opts: AgentOptions = { allowOverBudget: body["allowOverBudget"] === true };
      session.setAgent((ask) => {
        const v = agentAnswer(ask, opts);
        asked.push({ kind: ask.kind, title: ask.title, answer: v.label });
        if (v.stops) stopped = { kind: ask.kind, title: ask.title, text: ask.text.slice(0, 2000) };
        return v.label;
      });
      const dialogsAnswered: DialogsAnswered = { invalidFomod: [], alreadyInstalled: [] };
      // Imported here: verbs.ts imports this module's verbs at load.
      const { answerFor, rawDialogs } = await import("./verbs");
      const stopWatching = answerRunDialogs(api, dialogsAnswered, { answerFor, rawDialogs });
      let lastPhase = "";
      const stopProgress = session.subscribe((snap) => {
        const s = snap.state;
        if (s.kind !== "installing" || s.progress === undefined) return;
        const key = `${s.progress.phase}`;
        if (key === lastPhase) return;
        lastPhase = key;
        ehLog("info", "control.collection-install.phase", { phase: s.progress.phase, step: s.progress.currentStep, of: s.progress.totalSteps });
      });
      try {
        session.startInstall(api);
        await waitFor(
          session,
          (s) => {
            errorOf(s);
            if (stopped !== undefined) return true;
            if (s.kind === "confirm" && s.readyToStart === true) return true;
            if (s.kind === "installing" || s.kind === "done") return true;
            return undefined;
          },
          60 * MIN,
          "the start checks",
        );
        if (stopped !== undefined) {
          const st = stopped as { kind: string; title: string; text: string };
          throw new ControlError("gate-stopped", `${st.title}: ${st.text}`.slice(0, 2500), 409, { gate: st.kind, asked, ...summary });
        }
        const atGate = session.getSnapshot().state;
        if (atGate.kind === "confirm" && atGate.readyToStart === true) {
          // The hands-off warning: the agent is the hand, and it keeps off.
          ehLog("info", "install.agent.answered", { kind: "hands-off-warning", answer: "Understood" });
          session.beginInstall(api);
        }
        const done = await waitFor(
          session,
          (s) => {
            errorOf(s);
            return s.kind === "done" ? s : undefined;
          },
          24 * 60 * MIN,
          "the install to finish",
        );
        const result = done.result;
        const base = {
          ...summary,
          asked,
          ...(dialogsAnswered.invalidFomod.length > 0 ? { invalidFomodIgnored: dialogsAnswered.invalidFomod } : {}),
          ...(dialogsAnswered.alreadyInstalled.length > 0 ? { alreadyInstalledAnswered: dialogsAnswered.alreadyInstalled } : {}),
        };
        if (result.kind === "success") {
          return {
            ...base,
            result: "success",
            profile: { id: result.profileId, name: result.profileName, mode: result.installTargetMode },
            installed: result.installedModIds.length,
            skipped: result.skippedMods.map((m) => ({ name: m.name, reason: (m as { reason?: unknown }).reason })),
            durationMin: Math.round(result.durationMs / MIN),
            receiptPath: result.receiptPath,
            verified: { receipt: fs.existsSync(result.receiptPath) },
          };
        }
        throw new ControlError(
          result.kind === "aborted" ? "install-aborted" : "install-failed",
          result.kind === "aborted" ? result.reason : result.error,
          500,
          { ...base, phase: result.phase, ...(result.partialProfileId !== undefined ? { partialProfileId: result.partialProfileId } : {}) },
        );
      } finally {
        session.setAgent(undefined);
        stopWatching();
        stopProgress();
      }
    },
    describe: (b: Body, r: Record<string, unknown>): string =>
      r["dryRun"] === true
        ? `looked at ${String((r["package"] as { name?: unknown } | undefined)?.name ?? b["path"])} (dry run)`
        : `installed ${String((r["package"] as { name?: unknown } | undefined)?.name ?? "")} ${String((r["package"] as { version?: unknown } | undefined)?.version ?? "")}`,
  },

  /** Where the install page is: the step, and while installing the phase and step counts. */
  "collection.installStatus": {
    mutates: false,
    run: async (): Promise<Record<string, unknown>> => {
      const s = (await loadSession()).getSnapshot().state;
      const out: Record<string, unknown> = { step: s.kind };
      if (s.kind === "loading") Object.assign(out, { phase: s.phase, hashed: s.hashDone, of: s.hashCount });
      if (s.kind === "installing" && s.progress !== undefined) {
        Object.assign(out, { phase: s.progress.phase, current: s.progress.currentStep, of: s.progress.totalSteps, message: s.progress.message });
      }
      if (s.kind === "done") out["result"] = s.result.kind;
      if (s.kind === "error") out["error"] = (s.error as { title?: unknown }).title;
      return out;
    },
  },
};
