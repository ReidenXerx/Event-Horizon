/**
 * What Wine tells a process about the Linux side it runs on.
 *
 * Wine maps the Linux root "/" to Z:, and gives every process the Linux home
 * and its own prefix as NT paths — WINEHOMEDIR and WINECONFIGDIR — while the
 * host's HOME and XDG_* arrive renamed WINE_HOST_HOME, WINE_HOST_XDG_*
 * (dlls/ntdll/unix/env.c). A prefix keeps drive C in `<prefix>/drive_c`.
 * Everything here turns that into plain facts and paths; nothing here decides
 * what they mean.
 */

import * as path from "path";

import { segmentsOf } from "../paths";

export type WineHost = {
  /** Where the Linux root "/" is reachable from this process. Wine maps it to Z:. */
  unixRoot: string;
  /** Linux home directories, as Linux paths, most likely first. Empty when Wine did not say. */
  homes: string[];
  /** The host's XDG_CONFIG_HOME, a Linux path, when it was set. */
  xdgConfigHome?: string;
  /** The prefix Vortex itself runs in, a Linux path, when Wine said. */
  vortexPrefix?: string;
};

/**
 * A Linux path, or a Wine NT path through Z: (`\??\Z:\home\me`), as a Linux
 * path. Any other drive letter maps somewhere only Wine's own prefix knows, so
 * that is `undefined` rather than a guess.
 */
export function linuxPathOf(value: string | undefined): string | undefined {
  const v = value?.trim();
  if (v === undefined || v.length === 0) return undefined;
  if (v.startsWith("/")) return `/${segmentsOf(v).join("/")}`;
  const nt = /^(?:\\\?\?\\|\\\\\?\\)?[zZ]:(?:[\\/](.*))?$/.exec(v);
  return nt === null ? undefined : `/${segmentsOf(nt[1] ?? "").join("/")}`;
}

export function readWineHost(env: Readonly<Record<string, string | undefined>>): WineHost {
  const homes: string[] = [];
  const addHome = (p: string | undefined): void => {
    if (p !== undefined && p !== "/" && !homes.includes(p)) homes.push(p);
  };
  addHome(linuxPathOf(env["WINE_HOST_HOME"]));
  addHome(linuxPathOf(env["WINEHOMEDIR"]));
  // A HOME that is a Linux path can only have come from the host.
  if (env["HOME"]?.startsWith("/") === true) addHome(linuxPathOf(env["HOME"]));
  const xdg =
    linuxPathOf(env["WINE_HOST_XDG_CONFIG_HOME"]) ??
    (env["XDG_CONFIG_HOME"]?.startsWith("/") === true ? linuxPathOf(env["XDG_CONFIG_HOME"]) : undefined);
  const vortexPrefix = linuxPathOf(env["WINECONFIGDIR"]);
  return {
    unixRoot: "Z:\\",
    homes,
    ...(xdg !== undefined ? { xdgConfigHome: xdg } : {}),
    ...(vortexPrefix !== undefined ? { vortexPrefix } : {}),
  };
}

/** A Linux path, as this process reaches it. */
export function reachLinuxPath(host: WineHost, linuxPath: string): string {
  return path.join(host.unixRoot, ...segmentsOf(linuxPath));
}

/** A path this process reaches through the Linux root, as that Linux path. */
export function linuxPathThroughRoot(host: WineHost, reached: string): string | undefined {
  const root = segmentsOf(host.unixRoot);
  const segs = segmentsOf(reached);
  if (segs.length < root.length || root.some((s, i) => s.toLowerCase() !== segs[i]!.toLowerCase())) return undefined;
  return `/${segs.slice(root.length).join("/")}`;
}

/** A path on Vortex's own C: as a Linux path — Wine keeps drive C in `<prefix>/drive_c`. */
export function vortexLinuxPath(host: WineHost, reached: string): string | undefined {
  if (host.vortexPrefix === undefined) return undefined;
  const segs = segmentsOf(reached);
  return segs[0]?.toLowerCase() === "c:" ? `${host.vortexPrefix}/drive_c/${segs.slice(1).join("/")}` : undefined;
}
