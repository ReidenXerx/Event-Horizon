/**
 * How a collection was installed, in words that cannot be read as "this is the
 * profile Vortex is on".
 *
 * A receipt records `installTargetMode` at install time. It was shown as
 * "current profile", and on a tester's machine (2026-09-17) the card of an OLD
 * Ivy install said "current profile" while Vortex was on the new install's
 * profile, whose card said "active": two cards, each apparently the current one.
 * Which profile is active is its own badge; this one only says where the
 * install went.
 */
import type { InstallTargetMode } from "../../types/installLedger";

export type InstallModeLabel = {
  /** For a badge. */
  short: string;
  /** For a details field. */
  long: string;
  /** The explanation, for a tooltip. */
  title: string;
};

export function installModeLabel(mode: InstallTargetMode): InstallModeLabel {
  return mode === "fresh-profile"
    ? {
        short: "own profile",
        long: "Its own profile",
        title: "Installed into a profile created for it.",
      }
    : {
        short: "existing profile",
        long: "An existing profile",
        title: "Installed into the profile that was active at the time, alongside what that profile already had.",
      };
}
