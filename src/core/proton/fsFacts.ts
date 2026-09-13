/**
 * The small filesystem questions the Proton service asks. Each one answers
 * "no" or "missing" instead of throwing: a launcher's record that is not
 * there is an answer, not a failure.
 */

import * as fsp from "fs/promises";

export function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : err instanceof Error ? err.message : String(err);
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

export type JsonRead = { kind: "ok"; value: unknown } | { kind: "missing" } | { kind: "unreadable"; why: string };

/** Launcher settings are kilobytes; a file past this is not one. */
const MAX_JSON_BYTES = 16 * 1024 * 1024;

export async function readJson(file: string): Promise<JsonRead> {
  let text: string;
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) return { kind: "missing" };
    if (stat.size > MAX_JSON_BYTES) return { kind: "unreadable", why: `${stat.size} bytes` };
    text = await fsp.readFile(file, "utf8");
  } catch (err) {
    const code = errorCode(err);
    return code === "ENOENT" || code === "ENOTDIR" ? { kind: "missing" } : { kind: "unreadable", why: code };
  }
  try {
    return { kind: "ok", value: JSON.parse(text) as unknown };
  } catch {
    return { kind: "unreadable", why: "not JSON" };
  }
}
