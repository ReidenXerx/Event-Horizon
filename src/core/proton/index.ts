/**
 * ──────────────────────────────────────────────────────────────────────
 * The Proton service: everything Event Horizon knows about running under
 * Wine/Proton on Linux, in one place.
 *
 * Vortex under Proton is a Windows process — `process.platform` says "win32" —
 * so nothing about Linux is visible unless something goes looking. This
 * service is the only code that looks: whether this is Wine at all
 * (detect.ts), where the Linux side is (host.ts), which prefix a launcher runs
 * the game in (launcherRecords.ts, gamePrefix.ts), and whether Vortex's
 * settings folders reach it (sharedFolders.ts).
 *
 * What stays out, on purpose, is what a feature SAYS about it: the
 * environment checks word the prefix verdict, the 7-Zip preflight its advice,
 * the resolver its game-version note — each next to the rest of its feature.
 * They ask this service for facts and never probe the machine themselves;
 * protonBoundary.test.ts holds that line.
 * ──────────────────────────────────────────────────────────────────────
 */

export { looksLikeWine } from "./detect";
export { linuxPathOf, linuxPathThroughRoot, reachLinuxPath, readWineHost, type WineHost } from "./host";
export type { PrefixCandidate, PrefixSource } from "./launcherRecords";
export type { FolderShare } from "./sharedFolders";
export { probeWinePrefix, type WinePrefixProbe } from "./gamePrefix";
