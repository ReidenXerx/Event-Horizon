/**
 * Every path, in the log, in pieces a log line can hold.
 *
 * A tester's log is the only evidence of what happened on their machine. A
 * sample of 400 paths said "roughly what"; the question after a quarantine is
 * always "was MY file moved", and only the whole list answers it. Size is not a
 * constraint (NS-1), a single 30,000-path log line is — so it is chunked.
 */

import { ehLog } from "../logging/ehLog";

const CHUNK = 500;

export function logPaths(
  level: Parameters<typeof ehLog>[0],
  event: string,
  data: Record<string, unknown>,
  paths: readonly string[],
): void {
  if (paths.length === 0) {
    ehLog(level, event, { ...data, total: 0, paths: [] });
    return;
  }
  const parts = Math.ceil(paths.length / CHUNK);
  for (let i = 0; i < parts; i += 1) {
    ehLog(level, event, {
      ...data,
      total: paths.length,
      part: i + 1,
      parts,
      paths: paths.slice(i * CHUNK, (i + 1) * CHUNK),
    });
  }
}
