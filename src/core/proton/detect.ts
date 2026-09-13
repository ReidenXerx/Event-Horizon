/**
 * Are we running inside Wine?
 *
 * `process.platform` cannot answer this: Vortex under Proton is a Windows
 * process, so it reports "win32" exactly as it would on Windows. These are
 * artefacts Wine creates and a real Windows install does not — `Z:` mapped to
 * the Linux root is the giveaway, and winemenubuilder is the backstop.
 *
 * Before this service there were two copies of this probe, one in the 7-Zip
 * preflight and one in the Collections page's error report, and they did not
 * probe the same paths.
 *
 * A wrong answer costs a less specific message, a time budget of the wrong
 * size, or a prefix check with nothing to find. It never refuses an install on
 * its own: the one Wine check that can refuse needs proof from the game's own
 * prefix, which a Windows machine does not have.
 */

import * as fs from "fs";

export function looksLikeWine(): boolean {
  const probes = ["Z:\\usr", "Z:\\home", "Z:\\etc", "C:\\windows\\system32\\winemenubuilder.exe"];
  for (const p of probes) {
    try {
      if (fs.existsSync(p)) return true;
    } catch {
      // An unreadable path is not evidence either way.
    }
  }
  return false;
}
