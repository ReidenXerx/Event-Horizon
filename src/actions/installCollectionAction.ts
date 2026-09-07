/**
 * Toolbar action: "Install Event Horizon Collection" (Phase 3 slice 5 + 6a + 6b).
 *
 * The user-side entry point for installing a `.ehcoll` package the
 * curator built. This action wires up:
 *
 *   1. file pick → `.ehcoll` path,
 *   2. `readEhcoll`     → typed manifest + bundled inventory,
 *   3. `readReceipt`    → cross-release lineage (or `undefined`),
 *   4. snapshot pipeline → hashed `AuditorMod[]` for the active profile,
 *   5. `buildUserSideState` + `pickInstallTarget`,
 *   6. `resolveInstallPlan` → the full plan,
 *   7. preview dialog → user clicks Install or Cancel,
 *   8. **slice 6b**: per-mod conflict picker + per-orphan picker,
 *      collected via sequential `showDialog` prompts (transitional UI),
 *   9. `runInstall(plan, decisions)` → progress notifications +
 *      final result dialog.
 *
 * Spec:
 *   - docs/business/INSTALL_ACTION.md   (this action's call sequence)
 *   - docs/business/INSTALL_DRIVER.md   (what `runInstall` does)
 *
 * ─── TRANSITIONAL UI WARNING ──────────────────────────────────────────
 * Every `showDialog` / `sendNotification` call here is scaffolding.
 * Phase 5 introduces a dedicated React mainPage that owns the install
 * flow (panel, conflict picker, orphan picker, progress, drift
 * report). The CALL SEQUENCE in this file is permanent — readEhcoll,
 * readReceipt, hashing pipeline, buildUserSideState, pickInstallTarget,
 * resolveInstallPlan, picker loop, runInstall. Phase 5 just replaces
 * the rendering layer. See docs/PROPOSAL_INSTALLER.md §10
 * "Transitional UI vs Phase 5 UI".
 * ──────────────────────────────────────────────────────────────────────
 *
 * ─── INSTALLABILITY GATE (slice 6b) ───────────────────────────────────
 * Install is offered when ALL of the following hold:
 *  - `plan.summary.canProceed === true`,
 *  - no `nexus-unreachable` or `external-missing` decisions
 *    (these are hard-blockers; no user choice fixes them).
 *
 * `*-diverged` and `external-prompt-user` decisions are accepted —
 * the action collects a `ConflictChoice` for each via sequential
 * picker dialogs after the user clicks Install. Orphans are
 * accepted and similarly resolved via per-orphan pickers.
 * ──────────────────────────────────────────────────────────────────────
 */

import { util } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";

import { enrichModsWithArchiveHashes } from "../core/archiveHashing";
import {
  getActiveGameId,
  getActiveProfileIdFromState,
  getModsForProfile,
} from "../core/getModsListForProfile";
import {
  InstallLedgerError,
  deleteReceipt,
  readReceipt,
} from "../core/installLedger";
import type { InstallReceipt } from "../types/installLedger";
import { runInstall } from "../core/installer/runInstall";
import { listInstallAttempts } from "../core/installer/attemptRecord";
import {
  type ReadEhcollResult,
  ReadEhcollError,
  readEhcoll,
} from "../core/manifest/readEhcoll";
import { resolveInstallPlan } from "../core/resolver/resolveInstallPlan";
import { scanAvailableDownloads } from "../core/resolver/scanAvailableDownloads";
import { getEventHorizonDir } from "../core/paths";
import {
  buildUserSideState,
  pickInstallTarget,
  resumableProfileFromAttempts,
  resolveDeploymentMethod,
  resolveEnabledExtensions,
  resolveGameVersion,
  resolveProfileName,
  resolveVortexVersion,
} from "../core/resolver/userState";
import type { SupportedGameId } from "../types/ehcoll";
import type {
  CarriedModReportEntry,
  ConflictChoice,
  DriverProgress,
  InstallResult,
  InstalledModReportEntry,
  OrphanChoice,
  RemovedModReportEntry,
  UserConfirmedDecisions,
} from "../types/installDriver";
import type {
  CompatibilityReport,
  InstallPlan,
  InstallTarget,
  ModDecision,
  ModResolution,
  OrphanedModDecision,
  PlanSummary,
} from "../types/installPlan";
import { pickEhcollFile, pickModArchiveFile } from "../utils/utils";
import { getVortexUserDataPath } from "../core/paths";
import { beginOp, ehLog } from "../core/logging/ehLog";
import * as path from "path";

const SUPPORTED_GAME_IDS: ReadonlySet<string> = new Set<SupportedGameId>([
  "skyrimse",
  "fallout3",
  "falloutnv",
  "fallout4",
  "starfield",
]);

export default function createInstallCollectionAction(
  context: types.IExtensionContext,
): () => Promise<void> {
  return async () => {
    const hashingNotificationId = "vortex-event-horizon:install-hashing";
const downloadScanNotificationId = "vortex-event-horizon:install-download-scan";
    let hashingNotificationShown = false;
    const op = beginOp("install");

    try {
      // ── 1. file pick ─────────────────────────────────────────────────
      const zipPath = await pickEhcollFile(context.api);
      if (zipPath === undefined) {
        op.ok({ cancelled: "file-picker" });
        return; // user cancelled
      }
      op.step("package-picked", { file: path.basename(zipPath) });

      // ── 2. read .ehcoll ──────────────────────────────────────────────
      const ehcoll = await readEhcoll(zipPath);
      const { manifest } = ehcoll;
      op.step("ehcoll-read", {
        packageId: manifest.package.id,
        packageName: manifest.package.name,
        packageVersion: manifest.package.version,
        mods: manifest.mods.length,
      });

      // ── 3. early game-id gate (cheap; avoids hashing unrelated mods) ─
      const state = context.api.getState();

      const activeGameId = getActiveGameId(state);
      if (!activeGameId) {
        throw new Error(
          "No active game in Vortex. Switch to the game this collection targets, then retry.",
        );
      }

      if (!SUPPORTED_GAME_IDS.has(activeGameId)) {
        throw new Error(
          `Active game "${activeGameId}" is not supported by Event Horizon. ` +
            `Supported: ${Array.from(SUPPORTED_GAME_IDS).join(", ")}.`,
        );
      }

      if (manifest.game.id !== activeGameId) {
        throw new Error(
          `This collection is for "${manifest.game.id}" but the active game is "${activeGameId}". ` +
            `Switch to "${manifest.game.id}" in Vortex's game selector and retry.`,
        );
      }

      const activeProfileId = getActiveProfileIdFromState(state, activeGameId);
      if (!activeProfileId) {
        throw new Error(`No profile found for game "${activeGameId}".`);
      }
      const activeProfileName =
        resolveProfileName(state, activeProfileId) ?? activeProfileId;

      // ── 4. read receipt (single source of truth for lineage) ─────────
      const appDataPath = getVortexUserDataPath();
      let receipt = await readReceipt(appDataPath, manifest.package.id);
      op.step("receipt-read", { found: receipt !== undefined });

      // H2: a receipt may reference a Vortex profile the user has
      // since deleted (e.g. they nuked the EH-created profile to
      // "start over"). Without this check, `pickInstallTarget` would
      // return current-profile mode and we'd happily install the
      // collection into whatever the user's currently active profile
      // is — silently merging the collection into an unrelated setup.
      // Detect the stale receipt and ask the user what to do.
      if (receipt !== undefined) {
        const profileExists = profileExistsInState(
          state,
          receipt.vortexProfileId,
        );
        if (!profileExists) {
          const resolution = await resolveStaleReceipt(
            context.api,
            receipt,
            appDataPath,
          );
          if (resolution === "cancel") {
            return; // user declined; abort the install entirely
          }
          if (resolution === "delete") {
            // Receipt is gone now; fall through to fresh-profile mode
            // by clearing the local handle. No further state change
            // needed.
            receipt = undefined;
          }
          // resolution === "keep" ⇒ proceed with the stale receipt;
          // the install will land in the user's current active
          // profile (the legacy behavior).
        }
      }

      // ── 5. snapshot pipeline (hash installed mods) ───────────────────
      // Hashing is required for the resolver's byte-exact match logic
      // to work — without it every mod degrades to "looks like fresh
      // download" even for collections the user already has installed.
      // This is the slow step (potentially many MB read).
      const rawMods = getModsForProfile(state, activeGameId, activeProfileId);

      context.api.sendNotification?.({
        id: hashingNotificationId,
        type: "activity",
        message: `Hashing ${rawMods.length} mod archives for accurate install planning...`,
      });
      hashingNotificationShown = true;

      const hashingStartedAt = Date.now();
      op.step("hashing-start", { archives: rawMods.length });
      const installedMods = await enrichModsWithArchiveHashes(
        state,
        activeGameId,
        rawMods,
        { concurrency: 4 },
      );
      op.step("hashing-done", {
        ms: Date.now() - hashingStartedAt,
        archives: installedMods.length,
      });

      context.api.dismissNotification?.(hashingNotificationId);
      hashingNotificationShown = false;

      // ── 5b. hash the download folder ─────────────────────────────────
      // Without this the resolver's `*-use-local-download` arms are
      // unreachable, so the install asks Nexus for archives the user is
      // already holding — and when Vortex finds nothing to do, the driver
      // sits forever on "downloading" a download that already finished.
      //
      // The install PAGE has done this for a while; this pipeline did not,
      // and both reach resolveInstallPlan. Same helper for both now.
      context.api.sendNotification?.({
        id: downloadScanNotificationId,
        type: "activity",
        message: "Checking which mod archives are already downloaded...",
      });
      let downloadScanShown = true;
      const downloadScanStartedAt = Date.now();
      op.step("download-scan-start");
      const availableDownloads = await scanAvailableDownloads({
        api: context.api,
        gameId: activeGameId,
        appDataPath: getEventHorizonDir(),
        onProgress: (done, total, name) => {
          // A first scan hashes every archive in the folder and can run for
          // minutes on a large collection. Silence there reads as a hang.
          context.api.sendNotification?.({
            id: downloadScanNotificationId,
            type: "activity",
            message: `Checking downloads (${done}/${total}): ${name}`,
          });
        },
      });
      op.step("download-scan-done", {
        ms: Date.now() - downloadScanStartedAt,
        // `undefined` means the downloads folder itself could not be
        // resolved (no game-specific download dir) — distinct from "zero
        // archives found", so it is worth telling apart in the log.
        skipped: availableDownloads === undefined,
        found: availableDownloads?.length ?? 0,
      });
      if (downloadScanShown) {
        context.api.dismissNotification?.(downloadScanNotificationId);
        downloadScanShown = false;
      }

      // ── 6. build UserSideState ───────────────────────────────────────
      const userState = buildUserSideState({
        gameId: activeGameId,
        gameVersion: resolveGameVersion(state, activeGameId),
        vortexVersion: resolveVortexVersion(state),
        deploymentMethod: resolveDeploymentMethod(state, activeGameId),
        enabledExtensions: resolveEnabledExtensions(state),
        activeProfileId,
        activeProfileName,
        installedMods,
        receipt,
        availableDownloads,
        externalDependencyState: undefined,
      });

      // ── 7. pick install target ──────────────────────────────────────
      const installTarget = pickInstallTarget(
        manifest,
        receipt,
        activeProfileId,
        activeProfileName,
        // Continue the profile an interrupted attempt was filling, rather
        // than forking a new one on every restart.
        resumableProfileFromAttempts(
          state,
          activeGameId,
          manifest.package.id,
          await listInstallAttempts(appDataPath),
        ),
      );

      // ── 8. resolve install plan ──────────────────────────────────────
      const plan = resolveInstallPlan(manifest, userState, installTarget);

      // ── 9. log + render preview dialog ───────────────────────────────
      logPlanSummary(plan, zipPath);

      const installable = isPlanInstallable(plan);
      const dialogResult = await renderPlanDialog(
        context.api,
        plan,
        installable,
      );

      if (dialogResult?.action !== "Install") {
        // User chose Cancel / Close, or dialog returned null. Distinguish a
        // plan that was never installable from a curator declining a valid
        // one — "did nothing" and "blocked" are different findings.
        op.ok({ cancelled: installable.ok ? "preview-dialog" : "not-installable" });
        return;
      }

      // ── 10. collect user decisions (slice 6b) ────────────────────────
      // Sequential picker dialogs: one per conflict, one per orphan.
      // The user can cancel the picker chain at any time, which
      // aborts the install before the driver runs.
      const decisions = await collectUserDecisions(context.api, plan);
      if (decisions === undefined) {
        // Cancelled AFTER the plan was resolved but BEFORE anything was
        // written. Distinct from cancelling at the picker, and worth being
        // able to tell apart when a run "did nothing".
        op.ok({ cancelled: "decisions" });
        return; // user cancelled mid-picker
      }
      op.step("decisions-confirmed", {
        conflictsResolved: Object.keys(decisions.conflictChoices ?? {}).length,
        orphansResolved: Object.keys(decisions.orphanChoices ?? {}).length,
      });

      // ── 11. run install ──────────────────────────────────────────────
      await runInstallFlow({
        api: context.api,
        plan,
        ehcoll,
        ehcollZipPath: zipPath,
        appDataPath,
        decisions,
      });

      op.ok({ file: path.basename(zipPath) });
    } catch (error) {
      const message = formatError(error);
      context.api.sendNotification?.({
        type: "error",
        message: `Install preview failed: ${message}`,
      });
      op.fail(error);
      console.error("[Vortex Event Horizon] Install preview failed:", error);
    } finally {
      if (hashingNotificationShown) {
        context.api.dismissNotification?.(hashingNotificationId);
      }
    }
  };
}

// ===========================================================================
// Logging
// ===========================================================================

function logPlanSummary(plan: InstallPlan, sourcePath: string): void {
  const m = plan.manifest;
  const s = plan.summary;
  console.log(
    `[Vortex Event Horizon] Install preview | ${m.package.name} v${m.package.version} | ` +
      `target=${plan.installTarget.kind} | ` +
      `mods=${s.totalMods} (already=${s.alreadyInstalled}, ` +
      `silent=${s.willInstallSilently}, confirm=${s.needsUserConfirmation}, ` +
      `missing=${s.missing}, orphans=${s.orphans}) | ` +
      `canProceed=${s.canProceed} | source=${sourcePath}`,
  );
  // Mirrored into the persistent log: console.log never survives past the
  // devtools session, and this is the one line that answers "what did the
  // plan actually resolve to" for a user who cannot be watched live.
  ehLog("info", "install.plan.summary", {
    packageId: m.package.id,
    packageVersion: m.package.version,
    target: plan.installTarget.kind,
    totalMods: s.totalMods,
    alreadyInstalled: s.alreadyInstalled,
    silent: s.willInstallSilently,
    confirm: s.needsUserConfirmation,
    missing: s.missing,
    orphans: s.orphans,
    canProceed: s.canProceed,
  });

  for (const w of plan.compatibility.warnings) {
    console.warn(`[Vortex Event Horizon] compat warn: ${w}`);
  }
  if (plan.compatibility.warnings.length > 0) {
    ehLog("warn", "install.plan.compat-warnings", {
      count: plan.compatibility.warnings.length,
      warnings: plan.compatibility.warnings,
    });
  }
  for (const e of plan.compatibility.errors) {
    console.warn(`[Vortex Event Horizon] compat error: ${e}`);
  }
  if (plan.compatibility.errors.length > 0) {
    ehLog("error", "install.plan.compat-errors", {
      count: plan.compatibility.errors.length,
      errors: plan.compatibility.errors,
    });
  }
}

// ===========================================================================
// Dialog rendering (transitional)
// ===========================================================================

async function renderPlanDialog(
  api: types.IExtensionApi,
  plan: InstallPlan,
  installable: { ok: true } | { ok: false; reason: string },
): Promise<types.IDialogResult | undefined> {
  const text = formatPlanText(plan, installable);

  const buttons: types.DialogActions = installable.ok
    ? [
        { label: "Cancel", default: true },
        { label: "Install" },
      ]
    : [{ label: "Close", default: true }];

  return api.showDialog?.(
    plan.summary.canProceed ? "info" : "error",
    `Install preview: ${plan.manifest.package.name} v${plan.manifest.package.version}`,
    { text },
    buttons,
  );
}

/**
 * Build the multi-line preview text the transitional dialog renders.
 * Order is deliberately: high-level verdict first, then the headline
 * blockers, then the per-section detail. The user should be able to
 * stop reading at any horizontal rule and have a useful summary.
 *
 * Phase 5 replaces this with a real React panel; the structure here
 * mirrors what that panel will surface.
 */
function formatPlanText(
  plan: InstallPlan,
  installable: { ok: true } | { ok: false; reason: string },
): string {
  const lines: string[] = [];

  // ─── Verdict ────────────────────────────────────────────────────────
  lines.push(formatVerdict(plan));
  lines.push("");

  // ─── Install target + lineage ───────────────────────────────────────
  lines.push(formatInstallTarget(plan));
  lines.push("");

  // ─── Summary counts ─────────────────────────────────────────────────
  lines.push(formatSummary(plan.summary));
  lines.push("");

  // ─── Compatibility ──────────────────────────────────────────────────
  lines.push(formatCompatibility(plan.compatibility));
  lines.push("");

  // ─── Per-mod overview ───────────────────────────────────────────────
  lines.push(formatModBuckets(plan.modResolutions));

  if (plan.orphanedMods.length > 0) {
    lines.push("");
    lines.push(formatOrphans(plan.orphanedMods.length));
  }

  if (plan.externalDependencies.length > 0) {
    lines.push("");
    lines.push(formatExternalDeps(plan.externalDependencies.length));
  }

  // ─── Footer ─────────────────────────────────────────────────────────
  lines.push("");
  if (installable.ok) {
    lines.push(
      "── Ready to install ──────────────────────────────────────────",
    );
    // NOT "write plugins.txt". That writer was deleted when the rules-only
    // strategy became the locked design — Vortex and LOOT regenerate
    // plugins.txt, so writing it is undone. This text went on promising it,
    // in the last thing the user reads before committing to a 963-mod
    // install, and the one thing they most want to know is exactly what
    // happens to their load order.
    if (plan.installTarget.kind === "fresh-profile") {
      lines.push(
        "Clicking Install will create a new Vortex profile, install all mods " +
          "into Vortex's global pool, apply the collection's mod conflict and " +
          "LOOT rules, and deploy.",
      );
      lines.push(
        "Plugin order is set by those rules plus your own LOOT sort, not " +
          "written directly. Any remaining difference from the curator's order " +
          "is reported at the end.",
      );
      lines.push(
        "Your existing profile is NOT modified. You can switch back at any time.",
      );
    } else {
      lines.push(
        "Clicking Install will install/update mods into your CURRENT profile " +
          `("${plan.installTarget.profileName}"), apply your conflict and ` +
          "orphan choices, apply the collection's mod conflict and LOOT " +
          "rules, and deploy.",
      );
      lines.push(
        "Plugin order is set by those rules plus your own LOOT sort, not " +
          "written directly. Any remaining difference from the curator's order " +
          "is reported at the end.",
      );
    }
    if (plan.summary.needsUserConfirmation > 0 || plan.orphanedMods.length > 0) {
      lines.push(
        "You will be asked to resolve each conflict and orphan one by one " +
          "before installation begins.",
      );
    }
  } else {
    lines.push(
      "── Cannot install ────────────────────────────────────────────",
    );
    lines.push(installable.reason);
  }

  return lines.join("\n");
}

function formatVerdict(plan: InstallPlan): string {
  if (plan.summary.canProceed) {
    if (plan.summary.needsUserConfirmation > 0) {
      return (
        `▶ Plan resolves but needs your input: ${plan.summary.needsUserConfirmation} mod(s) ` +
        `require confirmation before install can run.`
      );
    }
    return "▶ Plan resolves cleanly. Ready to install (in a later release).";
  }
  return "■ Plan cannot proceed — see compatibility errors below.";
}

function formatInstallTarget(plan: InstallPlan): string {
  const t: InstallTarget = plan.installTarget;
  if (t.kind === "current-profile") {
    const prev = plan.previousInstall;
    const lineage = prev
      ? `Upgrading from v${prev.packageVersion} (installed ${formatTimestamp(
          prev.installedAt,
        )}, ${prev.modCount} mods).`
      : "(no previous lineage tag — anomaly, please report)";
    return (
      `Install target: CURRENT PROFILE — "${t.profileName}"\n` +
      `  ${lineage}`
    );
  }
  return (
    `Install target: FRESH PROFILE (forced — no install receipt for this collection)\n` +
    `  Suggested name: "${t.suggestedProfileName}"\n` +
    `  Your current profile WILL NOT be modified. The collection's mods are added to ` +
    `Vortex's global pool but are only enabled in the new profile.`
  );
}

function formatSummary(s: PlanSummary): string {
  return [
    "── Summary ────────────────────────────────────────────────────",
    `  Total mods:                ${s.totalMods}`,
    `  Already installed:         ${s.alreadyInstalled}`,
    `  Will install silently:     ${s.willInstallSilently}`,
    `  Need user confirmation:    ${s.needsUserConfirmation}`,
    `  Missing:                   ${s.missing}`,
    `  Orphaned (from previous):  ${s.orphans}`,
    `  Can proceed?               ${s.canProceed ? "YES" : "NO"}`,
  ].join("\n");
}

function formatCompatibility(c: CompatibilityReport): string {
  const out: string[] = [
    "── Compatibility ──────────────────────────────────────────────",
  ];
  out.push(
    `  Game:               ${c.gameMatches ? "match" : "MISMATCH"}`,
  );
  out.push(`  Game version:       ${formatVersionCheck(c.gameVersion)}`);
  out.push(
    `  Required extensions: ${formatExtensionCheck(c.extensions)}`,
  );
  out.push(`  Vortex version:     ${formatVortexVersion(c.vortexVersion)}`);
  out.push(`  Deployment method:  ${formatDeploymentMethod(c.deploymentMethod)}`);

  if (c.warnings.length > 0) {
    out.push("  Warnings:");
    for (const w of c.warnings) out.push(`    • ${w}`);
  }
  if (c.errors.length > 0) {
    out.push("  Errors (block install):");
    for (const e of c.errors) out.push(`    × ${e}`);
  }
  return out.join("\n");
}

function formatVersionCheck(v: CompatibilityReport["gameVersion"]): string {
  switch (v.status) {
    case "ok":
      return "ok";
    case "unknown":
      return `unknown (required: "${v.required}")`;
    case "mismatch":
      return `mismatch — required "${v.required}", installed "${v.installed}" (policy: ${v.policy})`;
  }
}

function formatExtensionCheck(
  exts: CompatibilityReport["extensions"],
): string {
  if (exts.length === 0) return "(none required)";
  const parts: string[] = [];
  for (const e of exts) {
    if (e.status === "ok") {
      parts.push(`${e.id} ok`);
    } else if (e.status === "missing") {
      parts.push(`${e.id} MISSING`);
    } else {
      parts.push(
        `${e.id} TOO OLD (have ${e.installedVersion}, need ${e.required.minVersion})`,
      );
    }
  }
  return parts.join(", ");
}

function formatVortexVersion(
  v: CompatibilityReport["vortexVersion"],
): string {
  return v.status === "ok"
    ? `${v.installed} (built on ${v.required})`
    : `${v.installed} (built on ${v.required}; differs — informational)`;
}

function formatDeploymentMethod(
  d: CompatibilityReport["deploymentMethod"],
): string {
  switch (d.status) {
    case "ok":
      return `${d.user} (matches curator)`;
    case "warn-mismatch":
      return `${d.user} (curator built with ${d.curator}; informational)`;
    case "unknown":
      return `unknown (curator built with ${d.curator})`;
  }
}

/**
 * Mod-bucket overview: count per decision kind. Avoids dumping the
 * whole mod list — that's a Phase 5 panel.
 */
function formatModBuckets(resolutions: ModResolution[]): string {
  const counts = new Map<string, number>();
  for (const r of resolutions) {
    counts.set(r.decision.kind, (counts.get(r.decision.kind) ?? 0) + 1);
  }
  const out: string[] = [
    "── Mod resolution buckets ─────────────────────────────────────",
  ];
  if (counts.size === 0) {
    out.push("  (no mods in manifest — this is unusual)");
    return out.join("\n");
  }
  for (const [kind, n] of [...counts.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  )) {
    out.push(`  ${kind.padEnd(32, " ")} ${n}`);
  }
  return out.join("\n");
}

function formatOrphans(n: number): string {
  return (
    "── Orphaned mods ──────────────────────────────────────────────\n" +
    `  ${n} mod(s) the previous release of this collection installed are no longer referenced.\n` +
    `  None will be auto-uninstalled — Phase 5 UI surfaces a per-orphan picker.`
  );
}

function formatExternalDeps(n: number): string {
  return (
    "── External dependencies ──────────────────────────────────────\n" +
    `  ${n} entry(ies). Verification is deferred to install time (file picking + hashing).`
  );
}

function formatTimestamp(iso: string): string {
  // ISO-8601 → "YYYY-MM-DD HH:MM UTC". If the parse fails, return raw.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  );
}

// ===========================================================================
// Installability gate
// ===========================================================================

/**
 * Decide whether the current plan is something the driver can run
 * under any user choice. The driver itself enforces the same hard
 * blockers in its preflight; we double-check here so the dialog can
 * show a helpful "why not" message instead of letting the user click
 * Install only to immediately fail.
 *
 * In slice 6b the gate is much narrower than 6a's was:
 *  - `canProceed === true` (compat errors block).
 *  - No `nexus-unreachable` or `external-missing` decisions
 *    (structurally unfixable from the user side).
 *
 * Everything else — `*-diverged`, `external-prompt-user`, orphans —
 * is resolved via the picker chain after the user clicks Install.
 */
function isPlanInstallable(
  plan: InstallPlan,
): { ok: true } | { ok: false; reason: string } {
  if (!plan.summary.canProceed) {
    return {
      ok: false,
      reason:
        "The plan reports it cannot proceed. Fix the compatibility errors " +
        "above before retrying.",
    };
  }

  const hardBlockers: string[] = [];
  for (const r of plan.modResolutions) {
    const k: ModDecision["kind"] = r.decision.kind;
    if (k === "nexus-unreachable" || k === "external-missing") {
      hardBlockers.push(`${r.name} [${k}]`);
    }
  }

  if (hardBlockers.length > 0) {
    return {
      ok: false,
      reason:
        `The plan contains ${hardBlockers.length} mod(s) that cannot be ` +
        `installed under any user choice:\n  - ${hardBlockers.join("\n  - ")}\n\n` +
        `These are structural issues — the curator must rebuild the package ` +
        `or fix the manifest before this collection can install.`,
    };
  }

  return { ok: true };
}

// ===========================================================================
// User-decision pickers (slice 6b — transitional UI)
// ===========================================================================

/**
 * Walk every decision that needs user input and ask the user what to
 * do. Returns `undefined` if the user cancels the picker chain.
 *
 * Order:
 *  1. Conflict pickers — one per `*-diverged` and `external-prompt-user`
 *     mod, in `manifest.mods` order.
 *  2. Orphan pickers — one per `OrphanedModDecision`.
 *
 * Each prompt is a `showDialog` with the relevant action buttons.
 * For `external-prompt-user` + `Use local file`, an electron file
 * picker pops up after the dialog returns; user-cancel of the picker
 * is treated as "skip" for that mod.
 */
async function collectUserDecisions(
  api: types.IExtensionApi,
  plan: InstallPlan,
): Promise<UserConfirmedDecisions | undefined> {
  const conflictChoices: Record<string, ConflictChoice> = {};
  const orphanChoices: Record<string, OrphanChoice> = {};

  ehLog("info", "install.decisions.start", {
    mods: plan.modResolutions.length,
    orphans: plan.orphanedMods.length,
  });

  // ── Conflict pickers ────────────────────────────────────────────────
  for (const r of plan.modResolutions) {
    const choice = await pickConflictChoice(api, plan, r);
    if (choice === undefined) continue; // decision needs no input
    if (choice === "cancelled") {
      ehLog("info", "install.decisions.cancelled", {
        at: "conflict-picker",
        mod: r.name,
      });
      return undefined;
    }
    ehLog("debug", "install.decisions.conflict-picked", {
      mod: r.name,
      choice: choice.kind,
    });
    conflictChoices[r.compareKey] = choice;
  }

  // ── Orphan pickers ──────────────────────────────────────────────────
  for (const orphan of plan.orphanedMods) {
    const choice = await pickOrphanChoice(api, plan, orphan);
    if (choice === "cancelled") {
      ehLog("info", "install.decisions.cancelled", {
        at: "orphan-picker",
        mod: orphan.name,
      });
      return undefined;
    }
    ehLog("debug", "install.decisions.orphan-picked", {
      mod: orphan.name,
      choice: choice.kind,
    });
    orphanChoices[orphan.existingModId] = choice;
  }

  ehLog("info", "install.decisions.ok", {
    conflictsResolved: Object.keys(conflictChoices).length,
    orphansResolved: Object.keys(orphanChoices).length,
  });

  return { conflictChoices, orphanChoices };
}

/**
 * Render a single conflict dialog for one ModResolution. Returns:
 *  - `undefined` ⇒ this decision needs no user input (the action layer
 *    skips it).
 *  - `"cancelled"` ⇒ the user closed the dialog without picking;
 *    abort the install.
 *  - `ConflictChoice` ⇒ what the user picked.
 */
async function pickConflictChoice(
  api: types.IExtensionApi,
  plan: InstallPlan,
  resolution: ModResolution,
): Promise<ConflictChoice | "cancelled" | undefined> {
  const decision = resolution.decision;

  if (
    decision.kind !== "nexus-version-diverged" &&
    decision.kind !== "nexus-bytes-diverged" &&
    decision.kind !== "external-bytes-diverged" &&
    decision.kind !== "external-prompt-user"
  ) {
    return undefined;
  }

  if (decision.kind === "external-prompt-user") {
    return pickExternalPromptUserChoice(api, plan, resolution);
  }

  // ── *-diverged pickers ──────────────────────────────────────────────
  const text = formatDivergedConflictText(resolution);
  const result = await api.showDialog?.(
    "question",
    `Resolve conflict: ${resolution.name}`,
    { text },
    [
      { label: "Keep existing", default: true },
      { label: "Replace with new" },
      { label: "Abort install" },
    ],
  );

  if (!result) return "cancelled";

  switch (result.action) {
    case "Keep existing":
      return { kind: "keep-existing" };
    case "Replace with new":
      return { kind: "replace-existing" };
    default:
      return "cancelled";
  }
}

async function pickExternalPromptUserChoice(
  api: types.IExtensionApi,
  plan: InstallPlan,
  resolution: ModResolution,
): Promise<ConflictChoice | "cancelled"> {
  const decision = resolution.decision;
  if (decision.kind !== "external-prompt-user") {
    throw new Error(
      `pickExternalPromptUserChoice called for ${decision.kind} (bug).`,
    );
  }
  void plan; // forwarded for forward-compat; not currently consumed.

  const baseText = formatPromptUserText(resolution, decision);

  // H4: cancelling the OS file picker after clicking "Pick file..."
  // used to silently degrade to "skip", which is user-hostile (an
  // accidental Esc would orphan the mod from the install). Loop the
  // picker dialog instead — show a re-prompt note and let the user
  // explicitly choose Skip or Abort.
  let attempt = 0;
  for (;;) {
    const text =
      attempt === 0
        ? baseText
        : `${baseText}\n\n` +
          `(File picker was cancelled — choose Pick file... again, or pick ` +
          `Skip this mod / Abort install explicitly.)`;
    attempt += 1;

    const result = await api.showDialog?.(
      "question",
      `Provide file: ${resolution.name}`,
      { text },
      [
        { label: "Pick file...", default: true },
        { label: "Skip this mod" },
        { label: "Abort install" },
      ],
    );

    if (!result) return "cancelled";

    if (result.action === "Skip this mod") {
      return { kind: "skip" };
    }
    if (result.action !== "Pick file...") {
      return "cancelled";
    }

    const filePath = await pickModArchiveFile({
      api,
      title: `Select archive for "${resolution.name}"`,
      expectedFilename: decision.expectedFilename,
    });

    if (filePath !== undefined) {
      // The driver does NOT verify SHA in v1 — that's a Phase 5
      // enhancement (see docs/business/INSTALL_DRIVER.md).
      return { kind: "use-local-file", localPath: filePath };
    }

    // Picker cancelled → next iteration of the loop re-shows the
    // dialog with the explanatory note. No fallback to "skip".
    ehLog("warn", "install.decisions.file-picker-cancelled", {
      mod: resolution.name,
      attempt,
    });
  }
}

/**
 * Render a single orphan dialog. Always returns one of the choices —
 * a missing/cancelled dialog falls back to "keep" (the safe no-op).
 */
async function pickOrphanChoice(
  api: types.IExtensionApi,
  plan: InstallPlan,
  orphan: OrphanedModDecision,
): Promise<OrphanChoice | "cancelled"> {
  const text = formatOrphanText(plan, orphan);
  const result = await api.showDialog?.(
    "question",
    `Orphaned mod: ${orphan.name}`,
    { text },
    [
      { label: "Keep installed", default: true },
      { label: "Uninstall it" },
      { label: "Abort install" },
    ],
  );

  if (!result) return "cancelled";

  switch (result.action) {
    case "Keep installed":
      return { kind: "keep" };
    case "Uninstall it":
      return { kind: "uninstall" };
    default:
      return "cancelled";
  }
}

function formatDivergedConflictText(resolution: ModResolution): string {
  const decision = resolution.decision;
  const lines: string[] = [
    `Mod: ${resolution.name}`,
    `compareKey: ${resolution.compareKey}`,
    "",
  ];

  if (decision.kind === "nexus-version-diverged") {
    lines.push(
      `You have file id ${decision.existingFileId} of this Nexus mod ` +
        `installed; the collection wants file id ${decision.requiredFileId}.`,
    );
    lines.push("");
    lines.push(
      "• Keep existing: leave your installed file alone; do not install " +
        "the collection's version. (Safest. The collection may misbehave.)",
    );
    lines.push(
      "• Replace with new: uninstall your version, install the collection's " +
        "version. Your version's mod entry is removed from Vortex.",
    );
    lines.push("• Abort install: cancel the entire install.");
  } else if (decision.kind === "nexus-bytes-diverged") {
    lines.push(
      `Nexus IDs match but the bytes differ. Your archive's SHA-256 is ` +
        `${truncSha(decision.existingSha256)}; the collection expects ` +
        `${truncSha(decision.expectedSha256)}.`,
    );
    lines.push("");
    lines.push(
      "Either Nexus silently re-uploaded the file under the same id, or " +
        "your local archive is corrupt.",
    );
    lines.push("");
    lines.push(
      "• Keep existing: trust your installed copy.",
    );
    lines.push(
      "• Replace with new: uninstall + redownload to match the curator's bytes.",
    );
    lines.push("• Abort install: cancel the entire install.");
  } else if (decision.kind === "external-bytes-diverged") {
    lines.push(
      `An external mod with the same identity is already installed but ` +
        `with different bytes. Your archive's SHA-256 is ` +
        `${truncSha(decision.existingSha256)}; the collection expects ` +
        `${truncSha(decision.expectedSha256)}.`,
    );
    lines.push("");
    lines.push(
      "• Keep existing: trust your installed copy.",
    );
    lines.push(
      "• Replace with new: uninstall + reinstall from the collection's bundled archive.",
    );
    lines.push("• Abort install: cancel the entire install.");
  }

  return lines.join("\n");
}

function formatPromptUserText(
  resolution: ModResolution,
  decision: Extract<ModDecision, { kind: "external-prompt-user" }>,
): string {
  const lines: string[] = [
    `Mod: ${resolution.name}`,
    `Expected file: ${decision.expectedFilename}`,
  ];
  if (decision.expectedSha256 !== undefined) {
    lines.push(`Expected SHA-256: ${truncSha(decision.expectedSha256)}`);
  } else if (decision.expectedStagingSetHash !== undefined) {
    // Archive-less external mod: the curator never had archive bytes
    // to hash, so we identify by deployed file set instead. Surfaced
    // here purely as a debug aid — users don't act on this value.
    lines.push(
      `Expected staging-set hash: ${truncSha(decision.expectedStagingSetHash)}`,
    );
  }
  lines.push("");
  if (decision.instructions) {
    lines.push("Curator's instructions:");
    lines.push(`  ${decision.instructions}`);
    lines.push("");
  }
  lines.push(
    "This mod isn't bundled in the .ehcoll, isn't in your downloads, " +
      "and isn't installed. Pick a local archive file to install from, " +
      "or skip the mod.",
  );
  lines.push("");
  lines.push(
    "Note: this release does not verify the SHA-256 of your picked file. " +
      "Make sure the file matches what the curator expects.",
  );
  return lines.join("\n");
}

function formatOrphanText(
  plan: InstallPlan,
  orphan: OrphanedModDecision,
): string {
  const lines: string[] = [
    `Mod: ${orphan.name}`,
    `compareKey: ${orphan.originalCompareKey}`,
    `Installed by: ${plan.manifest.package.name} v${orphan.installedFromVersion}`,
    "",
    `This mod was installed by a previous release of this collection ` +
      `(v${orphan.installedFromVersion}) but the new release ` +
      `(v${plan.manifest.package.version}) no longer references it.`,
    "",
    "• Keep installed: leave the mod alone. Use this if you want it " +
      "independently of the collection.",
    "• Uninstall it: remove the mod entirely (file system + Vortex state).",
    "• Abort install: cancel the entire install.",
  ];
  return lines.join("\n");
}

function truncSha(s: string): string {
  return s.length > 16 ? `${s.slice(0, 8)}...${s.slice(-8)}` : s;
}

// ===========================================================================
// Stale-receipt resolution (H2)
// ===========================================================================

/**
 * Cheap profile-existence check. Vortex stores profiles under
 * `state.persistent.profiles[profileId]`; if the entry is missing the
 * user has deleted (or never had) that profile.
 *
 * We don't validate the profile's gameId here — the receipt's gameId
 * was already checked against the manifest before we get here, and a
 * profile with a different gameId would still be a "the receipt
 * thinks it lives somewhere it doesn't" situation we want to surface.
 */
function profileExistsInState(state: unknown, profileId: string): boolean {
  const profiles = (state as {
    persistent?: { profiles?: Record<string, unknown> };
  }).persistent?.profiles;
  if (!profiles) return false;
  return Object.prototype.hasOwnProperty.call(profiles, profileId);
}

/**
 * Ask the user what to do with a receipt whose Vortex profile no
 * longer exists. Three outcomes:
 *  - `"delete"`: the user wants a clean slate. We delete the receipt
 *    on disk so this install proceeds in fresh-profile mode.
 *  - `"keep"`: the user wants to proceed with the stale receipt
 *    (e.g. they recreated a similar profile and want lineage to
 *    carry over). The install will land in the active profile.
 *  - `"cancel"`: the user wants to think about it. We abort the
 *    install entirely and leave the receipt untouched.
 *
 * If `deleteReceipt` itself fails, we surface the error and treat
 * the choice as "cancel" — never silently swallow a write failure
 * to a file we just told the user we'd delete.
 */
async function resolveStaleReceipt(
  api: types.IExtensionApi,
  receipt: InstallReceipt,
  appDataPath: string,
): Promise<"delete" | "keep" | "cancel"> {
  ehLog("warn", "install.stale-receipt.detected", {
    packageId: receipt.packageId,
    profileId: receipt.vortexProfileId,
  });

  const text =
    `An install receipt for "${receipt.packageName}" v${receipt.packageVersion} ` +
    `points to Vortex profile "${receipt.vortexProfileName}" ` +
    `(id ${receipt.vortexProfileId}), but that profile no longer exists in Vortex.\n\n` +
    `This usually means you deleted the Event Horizon profile that previously ` +
    `held this collection.\n\n` +
    `• Treat as fresh install: delete the receipt and install into a NEW, ` +
    `empty profile (recommended; matches the safety guarantees of a first install).\n` +
    `• Use current profile anyway: keep the receipt and install into your active ` +
    `profile. The collection will be merged with your existing setup — only do this ` +
    `if you intentionally want lineage to carry across the deleted profile.\n` +
    `• Cancel: do nothing.`;

  const dialog = await api.showDialog?.(
    "question",
    "Stale install receipt",
    { text },
    [
      { label: "Treat as fresh install", default: true },
      { label: "Use current profile anyway" },
      { label: "Cancel" },
    ],
  );

  if (!dialog) {
    ehLog("info", "install.stale-receipt.resolved", { outcome: "cancel" });
    return "cancel";
  }

  switch (dialog.action) {
    case "Treat as fresh install": {
      try {
        await deleteReceipt(appDataPath, receipt.packageId);
      } catch (err) {
        ehLog("error", "install.stale-receipt.delete-failed", {
          packageId: receipt.packageId,
          err,
        });
        await api.showDialog?.(
          "error",
          "Could not delete stale receipt",
          {
            text:
              `Tried to delete the stale receipt at ` +
              `<appData>/Vortex/event-horizon/installs/${receipt.packageId}.json ` +
              `but the operation failed:\n\n${formatError(err)}\n\n` +
              `The install has been cancelled. Resolve the file-system issue ` +
              `(antivirus lock, permissions, etc.) and retry.`,
          },
          [{ label: "Close", default: true }],
        );
        ehLog("info", "install.stale-receipt.resolved", { outcome: "cancel" });
        return "cancel";
      }
      ehLog("info", "install.stale-receipt.resolved", { outcome: "delete" });
      return "delete";
    }
    case "Use current profile anyway":
      ehLog("info", "install.stale-receipt.resolved", { outcome: "keep" });
      return "keep";
    default:
      ehLog("info", "install.stale-receipt.resolved", { outcome: "cancel" });
      return "cancel";
  }
}

// ===========================================================================
// Install flow
// ===========================================================================

/**
 * Run the driver, surface progress as Vortex notifications, and
 * present the final result with a follow-up dialog.
 */
async function runInstallFlow(args: {
  api: types.IExtensionApi;
  plan: InstallPlan;
  ehcoll: ReadEhcollResult;
  ehcollZipPath: string;
  appDataPath: string;
  decisions: UserConfirmedDecisions;
}): Promise<void> {
  const { api, plan, ehcoll, ehcollZipPath, appDataPath, decisions } = args;

  const progressNotificationId = "vortex-event-horizon:install-progress";

  const runOp = beginOp("install.run", {
    mods: plan.modResolutions.length,
    orphans: plan.orphanedMods.length,
    target: plan.installTarget.kind,
  });

  const onProgress = (progress: DriverProgress): void => {
    api.sendNotification?.({
      id: progressNotificationId,
      type: "activity",
      message: formatProgressMessage(progress),
    });
  };

  let result: InstallResult;
  try {
    result = await runInstall({
      api,
      plan,
      ehcoll,
      ehcollZipPath,
      appDataPath,
      decisions,
      onProgress,
    });
  } catch (err) {
    // The driver reports its own failures via `InstallResult.kind ===
    // "failed"` without throwing; an actual exception here is the driver
    // itself breaking, which is the worse case and must not go unlogged.
    runOp.fail(err);
    throw err;
  } finally {
    api.dismissNotification?.(progressNotificationId);
  }

  if (result.kind === "success") {
    runOp.ok({
      installed: result.installedModIds.length,
      removed: result.removedMods.length,
      carried: result.carriedMods.length,
      skipped: result.skippedMods.length,
      driverDurationMs: result.durationMs,
    });
  } else if (result.kind === "aborted") {
    ehLog("warn", "install.run.aborted", {
      phase: result.phase,
      reason: result.reason,
      installedSoFar: result.installedSoFar.length,
    });
  } else {
    ehLog("error", "install.run.driver-failed", {
      phase: result.phase,
      error: result.error,
      installedSoFar: result.installedSoFar.length,
    });
  }

  await renderResultDialog(api, plan, result);

  if (result.kind === "success") {
    api.sendNotification?.({
      type: "success",
      message:
        `Installed ${plan.manifest.package.name} v${plan.manifest.package.version} ` +
        `(${result.installedModIds.length} mods).`,
    });
  } else if (result.kind === "failed") {
    api.sendNotification?.({
      type: "error",
      message: `Install failed during ${result.phase}: ${result.error}`,
    });
  }
}

function formatProgressMessage(progress: DriverProgress): string {
  if (progress.totalSteps > 1) {
    return `[${progress.phase}] (${progress.currentStep}/${progress.totalSteps}) ${progress.message}`;
  }
  return `[${progress.phase}] ${progress.message}`;
}

async function renderResultDialog(
  api: types.IExtensionApi,
  plan: InstallPlan,
  result: InstallResult,
): Promise<void> {
  const title = `Install result: ${plan.manifest.package.name} v${plan.manifest.package.version}`;
  const text = formatResultText(plan, result);
  const dialogType: types.DialogType =
    result.kind === "success"
      ? "info"
      : result.kind === "aborted"
        ? "info"
        : "error";

  await api.showDialog?.(dialogType, title, { text }, [
    { label: "Close", default: true },
  ]);
}

function formatResultText(plan: InstallPlan, result: InstallResult): string {
  const lines: string[] = [];

  if (result.kind === "success") {
    lines.push("✓ Install complete.");
    lines.push("");
    const modeLabel =
      result.installTargetMode === "fresh-profile"
        ? "fresh profile (newly created)"
        : "current profile (in-place upgrade)";
    lines.push(`Mode:           ${modeLabel}`);
    lines.push(
      `Profile:        ${result.profileName} (id: ${result.profileId})`,
    );
    lines.push(`Mods installed: ${result.installedModIds.length}`);
    if (result.removedMods.length > 0) {
      lines.push(`Mods removed:   ${result.removedMods.length}`);
    }
    if (result.carriedMods.length > 0) {
      lines.push(`Mods carried:   ${result.carriedMods.length}`);
    }
    lines.push(`Receipt:        ${result.receiptPath}`);

    if (result.installedMods.length > 0) {
      lines.push("");
      lines.push(formatInstalledModsBreakdown(result.installedMods));
    }

    if (result.removedMods.length > 0) {
      lines.push("");
      lines.push(formatRemovedModsBreakdown(result.removedMods));
    }

    if (result.carriedMods.length > 0) {
      lines.push("");
      lines.push(formatCarriedModsBreakdown(result.carriedMods));
    }

    if (result.skippedMods.length > 0) {
      lines.push("");
      lines.push("── Skipped ────────────────────────────────────────────────");
      for (const s of result.skippedMods) {
        lines.push(`  - ${s.name}: ${s.reason}`);
      }
    }

    lines.push("");
    if (result.installTargetMode === "fresh-profile") {
      lines.push(
        "Next: Vortex has switched into the new profile. Launch the game " +
          "to verify everything loads correctly. Switch profiles in Vortex " +
          "any time to return to your previous setup.",
      );
    } else {
      lines.push(
        "Next: your current profile has been updated. Launch the game " +
          "to verify everything loads correctly.",
      );
    }
  } else if (result.kind === "aborted") {
    lines.push("• Install was aborted.");
    lines.push("");
    lines.push(`Phase:  ${result.phase}`);
    lines.push(`Reason: ${result.reason}`);
    if (result.partialProfileId) {
      lines.push(`Partial profile: ${result.partialProfileId}`);
      lines.push("(You can switch to it manually in Vortex if desired.)");
    }
  } else {
    lines.push("× Install failed.");
    lines.push("");
    lines.push(`Phase: ${result.phase}`);
    lines.push(`Error: ${result.error}`);
    if (result.partialProfileId) {
      lines.push("");
      lines.push(`Partial profile: ${result.partialProfileId}`);
      lines.push(
        "The driver does NOT roll back. The partially-built profile is " +
          "left in place so you can inspect what was installed before the " +
          "failure. Switch to your previous profile in Vortex's UI to " +
          "return to your prior setup.",
      );
    }
    if (result.installedSoFar.length > 0) {
      lines.push("");
      lines.push(
        `Mods installed before the failure: ${result.installedSoFar.length}.`,
      );
    }
  }

  return lines.join("\n");
}

function formatInstalledModsBreakdown(
  mods: InstalledModReportEntry[],
): string {
  const counts = new Map<string, number>();
  for (const m of mods) {
    counts.set(m.fromDecision, (counts.get(m.fromDecision) ?? 0) + 1);
  }

  const out: string[] = [
    "── Install breakdown ──────────────────────────────────────────",
  ];
  for (const [kind, n] of [...counts.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  )) {
    out.push(`  ${kind.padEnd(32, " ")} ${n}`);
  }
  return out.join("\n");
}

function formatRemovedModsBreakdown(
  mods: RemovedModReportEntry[],
): string {
  const counts = new Map<string, number>();
  for (const m of mods) {
    counts.set(m.reason, (counts.get(m.reason) ?? 0) + 1);
  }

  const out: string[] = [
    "── Removed breakdown ──────────────────────────────────────────",
  ];
  for (const [reason, n] of [...counts.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  )) {
    out.push(`  ${reason.padEnd(32, " ")} ${n}`);
  }
  return out.join("\n");
}

/**
 * Carry-forward summary (H1 fix). Two reasons:
 *  - `diverged-keep-existing`: user chose to keep their version of a
 *    diverged mod; the driver enabled it in the active profile and
 *    recorded it in the new receipt with previous-release lineage.
 *  - `orphan-keep`: user kept an orphaned mod from the previous
 *    release; the driver did not modify it but recorded it so it
 *    stays detectable in future orphan checks.
 */
function formatCarriedModsBreakdown(
  mods: CarriedModReportEntry[],
): string {
  const counts = new Map<string, number>();
  for (const m of mods) {
    counts.set(m.reason, (counts.get(m.reason) ?? 0) + 1);
  }

  const out: string[] = [
    "── Carried forward (preserved in receipt) ─────────────────────",
  ];
  for (const [reason, n] of [...counts.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  )) {
    out.push(`  ${reason.padEnd(32, " ")} ${n}`);
  }
  return out.join("\n");
}

// ===========================================================================
// Error formatting
// ===========================================================================

function formatError(err: unknown): string {
  if (err instanceof ReadEhcollError) {
    return `Could not read .ehcoll (${err.errors.length} problem${
      err.errors.length === 1 ? "" : "s"
    }):\n${err.errors.map((e) => `  - ${e}`).join("\n")}`;
  }
  if (err instanceof InstallLedgerError) {
    return `Could not read install receipt (${err.errors.length} problem${
      err.errors.length === 1 ? "" : "s"
    }):\n${err.errors.map((e) => `  - ${e}`).join("\n")}`;
  }
  return err instanceof Error ? err.message : String(err);
}
