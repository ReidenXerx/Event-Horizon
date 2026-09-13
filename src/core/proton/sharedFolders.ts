/**
 * Does Vortex write into the same folder the game reads?
 *
 * PROVEN, not read off paths: a file written into Vortex's copy either shows
 * up in the game's or it does not. People share settings folders by linking
 * them, or by running Vortex inside the game's prefix; both pass, and a copy —
 * identical until the first write — does not.
 */

import { randomUUID } from "crypto";
import * as fsp from "fs/promises";
import * as path from "path";

import { segmentsOf } from "../paths";
import { errorCode, exists, isDirectory } from "./fsFacts";
import { linuxPathThroughRoot, vortexLinuxPath, type WineHost } from "./host";

export type FolderShare = {
  /** What lives there, in words. */
  label: string;
  /** Below the user folder, "/"-separated — the same on both sides. */
  rel: string;
  /** Vortex's copy and the game's, as this process reaches them. */
  vortexDir: string;
  gameDir: string;
  vortexExists: boolean;
  gameExists: boolean;
  /** Both as Linux paths, when known — for a command the user can paste. */
  vortexLinuxPath?: string;
  gameLinuxPath?: string;
  state: "shared" | "separate" | "unprobed";
  /** The evidence, in words. */
  detail: string;
};

/**
 * Does a file written into `from` appear in `to`? Created exclusively under a
 * name nothing else uses and removed again at once, so nothing that was there
 * is ever touched.
 */
async function writesShowUp(
  from: string,
  to: string,
): Promise<{ kind: "probed"; visible: boolean } | { kind: "unprobed"; why: string }> {
  const name = `.event-horizon-prefix-probe-${randomUUID()}`;
  const written = path.join(from, name);
  try {
    await fsp.writeFile(written, "", { flag: "wx" });
  } catch (err) {
    return { kind: "unprobed", why: errorCode(err) };
  }
  try {
    return { kind: "probed", visible: await exists(path.join(to, name)) };
  } finally {
    await fsp.rm(written, { force: true }).catch(() => undefined);
  }
}

export async function shareOf(
  host: WineHost,
  vortexUserDir: string,
  gameUserDir: string,
  folder: { label: string; rel: string },
): Promise<FolderShare> {
  const segs = segmentsOf(folder.rel);
  const vortexDir = path.join(vortexUserDir, ...segs);
  const gameDir = path.join(gameUserDir, ...segs);
  const vortexExists = await isDirectory(vortexDir);
  const gameExists = await isDirectory(gameDir);
  const vortexLinux = vortexLinuxPath(host, vortexDir);
  const gameLinux = linuxPathThroughRoot(host, gameDir);
  const base = {
    label: folder.label,
    rel: folder.rel,
    vortexDir,
    gameDir,
    vortexExists,
    gameExists,
    ...(vortexLinux !== undefined ? { vortexLinuxPath: vortexLinux } : {}),
    ...(gameLinux !== undefined ? { gameLinuxPath: gameLinux } : {}),
  };
  // One side has it and the other does not: they cannot be the same folder.
  if (vortexExists !== gameExists) {
    return { ...base, state: "separate", detail: vortexExists ? "only Vortex's prefix has it" : "only the game's prefix has it" };
  }
  // Neither has it yet: whoever creates it creates it inside the nearest
  // parent both have, so that parent decides.
  let depth = segs.length;
  if (!vortexExists) {
    for (depth = segs.length - 1; depth > 0; depth -= 1) {
      const v = await isDirectory(path.join(vortexUserDir, ...segs.slice(0, depth)));
      const g = await isDirectory(path.join(gameUserDir, ...segs.slice(0, depth)));
      if (v !== g) {
        return {
          ...base,
          state: "separate",
          detail: `neither prefix has it yet, and only ${v ? "Vortex's" : "the game's"} has ${segs.slice(0, depth).join("/")}`,
        };
      }
      if (v) break;
    }
  }
  const at = segs.slice(0, depth);
  const where = at.length === 0 ? "user folder" : at.join("/");
  const probe = await writesShowUp(path.join(vortexUserDir, ...at), path.join(gameUserDir, ...at));
  if (probe.kind === "unprobed") {
    return { ...base, state: "unprobed", detail: `a test file could not be written into Vortex's ${where} (${probe.why})` };
  }
  if (depth === segs.length) {
    return probe.visible
      ? { ...base, state: "shared", detail: "a test file written into Vortex's copy appeared in the game's" }
      : { ...base, state: "separate", detail: "a test file written into Vortex's copy did not appear in the game's" };
  }
  return probe.visible
    ? { ...base, state: "shared", detail: `neither prefix has it yet, and ${where}, where it will be created, is shared` }
    : { ...base, state: "separate", detail: `neither prefix has it yet, and ${where} is not shared` };
}
