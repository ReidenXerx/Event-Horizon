/**
 * ──────────────────────────────────────────────────────────────────────
 * Event Horizon tells you when Vortex will never update it.
 *
 * Vortex updates an extension only when it installed it from Nexus's
 * extension list: that install records the Nexus mod id on the extension, and
 * the update check matches on nothing else. A copy installed from the Manual
 * download, or dropped into Vortex by hand, has no mod id and is never
 * updated. Vortex says nothing about it. A player was found 22 releases behind
 * (0.2.8 when 0.2.30 was out, 2026-10-02), reporting "different version
 * numbers everywhere".
 *
 * So at startup, once Vortex has fetched its extension list: if this copy has
 * no mod id and Nexus lists a newer Event Horizon, say so and open Vortex's
 * extension page on it. Installing from there records the mod id, and every
 * later update arrives on its own. Two installed copies of Event Horizon
 * (a manual one beside a Vortex one) are named too.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { types } from "@nexusmods/vortex-api";

import { ehLog } from "../../core/logging/ehLog";

export const EH_NEXUS_MOD_ID = 2235;
const EH_NAME = "Event Horizon";

type InstalledExtension = { name?: string; version?: string; modId?: number; path?: string };
type AvailableExtension = { modId?: number | string; version?: string };

export type SelfUpdateFinding =
  | { kind: "manual-install-behind"; installed: string; latest: string }
  | { kind: "duplicates"; copies: Array<{ version: string; path: string }> };

const parts = (v: string): number[] => v.split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
export function isNewer(candidate: string, than: string): boolean {
  const a = parts(candidate);
  const b = parts(than);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

/** What to tell the player, from Vortex's installed extensions and its Nexus extension list. Pure. */
export function selfUpdateFindings(
  installed: Readonly<Record<string, InstalledExtension>>,
  available: readonly AvailableExtension[],
  runningVersion: string,
): SelfUpdateFinding[] {
  const out: SelfUpdateFinding[] = [];
  const ours = Object.values(installed).filter((e) => e.name === EH_NAME);
  if (ours.length > 1) {
    out.push({
      kind: "duplicates",
      copies: ours.map((e) => ({ version: e.version ?? "?", path: e.path ?? "?" })),
    });
  }
  const listed = available.find((a) => Number(a.modId) === EH_NEXUS_MOD_ID);
  const tracked = ours.some((e) => e.modId !== undefined && Number(e.modId) === EH_NEXUS_MOD_ID);
  if (listed?.version !== undefined && !tracked && isNewer(listed.version, runningVersion)) {
    out.push({ kind: "manual-install-behind", installed: runningVersion, latest: listed.version });
  }
  return out;
}

/** Waits for Vortex's extension list (fetched after startup), then checks once. */
export function watchSelfUpdate(api: types.IExtensionApi, runningVersion: string): void {
  const read = (): { installed: Record<string, InstalledExtension>; available: AvailableExtension[] } => {
    const s = api.getState() as unknown as {
      app?: { extensions?: Record<string, InstalledExtension> };
      session?: { extensions?: { available?: AvailableExtension[] } };
    };
    return { installed: s.app?.extensions ?? {}, available: s.session?.extensions?.available ?? [] };
  };
  let done = false;
  const check = (): void => {
    if (done) return;
    const { installed, available } = read();
    if (available.length === 0) return;
    done = true;
    unsubscribe?.();
    clearTimeout(giveUp);
    const findings = selfUpdateFindings(installed, available, runningVersion);
    ehLog(findings.length > 0 ? "warn" : "info", "self-update.checked", { runningVersion, findings });
    for (const f of findings) {
      if (f.kind === "manual-install-behind") {
        api.sendNotification?.({
          id: "eh-manual-install-behind",
          type: "warning",
          title: `Event Horizon ${f.latest} is out — you have ${f.installed}`,
          message:
            "This copy was installed by hand (the Manual download), so Vortex will never update it on its own. " +
            "Install it once from Vortex's extension list and every later update arrives by itself.",
          actions: [
            {
              title: "Open in Vortex",
              action: (dismiss: () => void) => {
                api.events.emit("show-extension-page", EH_NEXUS_MOD_ID);
                dismiss();
              },
            },
          ],
        });
      } else {
        api.sendNotification?.({
          id: "eh-duplicate-install",
          type: "warning",
          title: "Event Horizon is installed twice",
          message:
            `Vortex has ${f.copies.length} copies: ${f.copies.map((c) => c.version).join(", ")}. ` +
            "In Vortex → Extensions, remove the older one and restart. Your collections and settings live in a " +
            "separate folder and are kept.",
        });
      }
    }
  };
  const unsubscribe = (api.store as unknown as { subscribe?: (fn: () => void) => () => void } | undefined)?.subscribe?.(check);
  // Offline, or Vortex never fetched the list: nothing to compare against, say nothing.
  const giveUp = setTimeout(() => {
    done = true;
    unsubscribe?.();
  }, 10 * 60 * 1000);
  check();
}
