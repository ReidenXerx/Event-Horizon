/**
 * Is the game running right now?
 *
 * A deploy or purge while the game runs changes its Data folder under it
 * (hardlinks go live at once), and a game-folder change underneath a running
 * game strands whatever it has open. Vortex's own `toolsRunning` only knows
 * about programs Vortex started, so this asks the OS.
 *
 * Unknown is reported as unknown (`undefined`), never as "not running": a
 * guard that cannot see the process list must not wave a deploy through.
 */

import { execFile } from "child_process";

export function parseTasklist(stdout: string, exeName: string): boolean {
  const want = exeName.toLowerCase();
  // `tasklist /FO CSV /NH`: "Image Name","PID",... one process per line.
  return stdout
    .split(/\r?\n/)
    .some((line) => line.split(",")[0]?.replace(/"/g, "").trim().toLowerCase() === want);
}

export function isProcessRunning(exeName: string): Promise<boolean | undefined> {
  if (process.platform !== "win32") {
    return new Promise((resolve) => {
      execFile("pgrep", ["-if", exeName], (err, stdout) => {
        if (err && (err as { code?: number }).code === 1) return resolve(false);
        if (err) return resolve(undefined);
        resolve(stdout.trim().length > 0);
      });
    });
  }
  return new Promise((resolve) => {
    execFile(
      "tasklist",
      ["/FI", `IMAGENAME eq ${exeName}`, "/FO", "CSV", "/NH"],
      { windowsHide: true, timeout: 15000 },
      (err, stdout) => {
        if (err) return resolve(undefined);
        resolve(parseTasklist(stdout, exeName));
      },
    );
  });
}
