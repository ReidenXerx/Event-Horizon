/**
 * ─── TWO COPIES OF EVENT HORIZON, BOTH ENABLED ──────────────────────────────
 * Vortex loads every folder under plugins/ as its own extension. A copy
 * installed by hand (a zip dropped in, a GitHub download) and the copy the
 * Extensions page installed from Nexus live in different folders, so both load
 * and both register: two collection installers claiming the same archive, two
 * load-order watchers, two sidebar pages. Seen on a tester's machine
 * 2026-09-25: 0.2.12 by hand next to 0.2.14 from Nexus, both "Enabled".
 *
 * The first copy to load claims the process; any later one registers nothing
 * and says which two copies are installed, so the user can remove one. A copy
 * that has already registered cannot be unloaded, so "the first one wins" is
 * the only rule available; the notice names both versions rather than
 * pretending the newer one is running.
 */

export type InstanceIdentity = { version: string; folder: string };

export type InstanceClaim =
  | { kind: "first" }
  | { kind: "duplicate"; running: InstanceIdentity };

const SLOT = "__eventHorizonInstance";

export function claimSingleInstance(
  host: Record<string, unknown>,
  me: InstanceIdentity,
): InstanceClaim {
  const running = host[SLOT] as InstanceIdentity | undefined;
  if (running !== undefined && typeof running === "object") return { kind: "duplicate", running };
  host[SLOT] = { ...me };
  return { kind: "first" };
}

export function duplicateNotice(running: InstanceIdentity, me: InstanceIdentity): string {
  return (
    `Two copies of Event Horizon are installed. ${running.version} (folder "${running.folder}") is running; ` +
    `${me.version} (folder "${me.folder}") was not loaded. Remove one on Vortex's Extensions page (keep the ` +
    `one installed from Nexus, it updates itself), then restart Vortex.`
  );
}
