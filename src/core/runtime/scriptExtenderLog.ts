/**
 * ──────────────────────────────────────────────────────────────────────
 * Which script-extender plugins actually loaded, from the log that knows.
 *
 * ─── THE FAILURE THIS ANSWERS ──────────────────────────────────────────
 * A tester's Fallout 4 body physics stopped working: bodies present, physics
 * absent, nothing printed anywhere a player would look. Every explanation for
 * that symptom is invisible from the outside and they are not the same fix:
 *
 *   • a missing VC++ runtime, so the plugin DLL never loaded
 *   • the body never built in BodySlide
 *   • a missing or incompatible skeleton
 *   • a plugin built for a different game version after an update
 *
 * The collection verifies byte-for-byte in all four cases. The script
 * extender's own log is the artefact that separates them, because it says —
 * per DLL — whether the thing loaded at all.
 *
 * ─── THE FORMAT WAS READ, NOT REMEMBERED ───────────────────────────────
 * Both shapes below come from real logs on a real machine (F4SE 0.6.23 with
 * 92 plugins, SKSE64 with 237), not from documentation:
 *
 *     checking plugin <path>
 *     plugin <path> (00000001 AAF_1_10_163 00000001) loaded correctly
 *     plugin <path> (00000001 Name 01050000) loaded correctly (handle 50)
 *     plugin <path> does not appear to be an F4SE plugin
 *
 * That third line is NOT a failure and must never be reported as one. Crash
 * loggers and helper libraries ship support DLLs into the same folder —
 * `msdia140.dll` is in both of those logs — and the extender dutifully checks
 * and skips them. Calling that "2 plugins failed" would send someone hunting
 * a problem that does not exist.
 *
 * ─── AND EVERY OTHER OUTCOME IS QUOTED, NOT CLASSIFIED ─────────────────
 * The interesting failures — "couldn't load plugin (Error 126)", "reported as
 * incompatible", a version refusal — did not occur in either log available to
 * measure. So they are not pattern-matched. Anything that was CHECKED and did
 * not reach one of the two known conclusions is reported as failed, carrying
 * the log's own lines verbatim as the reason.
 *
 * That is deliberate: a parser that invents a category for a line it has
 * never seen will confidently mislabel the one case that matters. Showing the
 * extender's own words costs nothing and cannot be wrong.
 * ──────────────────────────────────────────────────────────────────────
 */

/** What became of one DLL in the plugins folder. */
export type PluginOutcome =
  | { kind: "loaded"; file: string; name: string; version: string }
  /** A DLL that is not an extender plugin at all. Normal; never a failure. */
  | { kind: "not-a-plugin"; file: string }
  /** Checked, never concluded. `lines` is the log's own account. */
  | { kind: "failed"; file: string; lines: string[] };

export type ScriptExtenderLog = {
  /** The extender's own version banner, when the log has one. */
  runtime?: string;
  /** Where it looked for plugins. */
  pluginDir?: string;
  outcomes: PluginOutcome[];
};

/** The file name only, from either a full path or a bare name. */
function baseName(raw: string): string {
  const cleaned = raw.trim().replace(/\\\\/g, "\\");
  const cut = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return (cut >= 0 ? cleaned.slice(cut + 1) : cleaned).trim();
}

/**
 * Parse an F4SE / SKSE / NVSE style log.
 *
 * Tolerant by construction: an unrecognised line is simply not evidence, and
 * a log truncated mid-write (the game crashed, which is exactly when someone
 * reads one) still yields every plugin that concluded before the cut.
 */
export function parseScriptExtenderLog(text: string): ScriptExtenderLog {
  const out: ScriptExtenderLog = { outcomes: [] };
  const lines = text.split(/\r?\n/);

  /** The plugin currently being checked, and everything said since. */
  let open: { file: string; said: string[] } | undefined;
  const close = (outcome?: PluginOutcome): void => {
    if (open === undefined) return;
    out.outcomes.push(
      outcome ?? { kind: "failed", file: open.file, lines: [...open.said] },
    );
    open = undefined;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;

    if (out.runtime === undefined && /runtime: initialize/i.test(line)) {
      out.runtime = line;
      continue;
    }
    const dir = /^plugin directory\s*=\s*(.+)$/i.exec(line);
    if (dir !== null) {
      out.pluginDir = dir[1]!.trim();
      continue;
    }

    const checking = /^checking plugin (.+)$/i.exec(line);
    if (checking !== null) {
      // A new check ends the previous one. If that one never concluded, the
      // lines it accumulated are its reason.
      close();
      open = { file: baseName(checking[1]!), said: [] };
      continue;
    }

    if (open !== undefined) {
      const loaded =
        /^plugin (.+?) \(([0-9A-Fa-f]+) (.+?) ([0-9A-Fa-f]+)\) loaded correctly/i.exec(
          line,
        );
      if (loaded !== null && baseName(loaded[1]!) === open.file) {
        close({
          kind: "loaded",
          file: open.file,
          name: loaded[3]!.trim(),
          version: loaded[4]!,
        });
        continue;
      }
      const notPlugin = /^plugin (.+?) does not appear to be an? .* plugin/i.exec(
        line,
      );
      if (notPlugin !== null && baseName(notPlugin[1]!) === open.file) {
        close({ kind: "not-a-plugin", file: open.file });
        continue;
      }
      // Anything else said while this plugin is open is kept as evidence.
      open.said.push(line);
    }
  }
  close();
  return out;
}

export type ScriptExtenderSummary = {
  loaded: number;
  /** DLLs that are not plugins — counted, never presented as a problem. */
  skipped: number;
  failed: Array<{ file: string; lines: string[] }>;
  /** One line per statement, ready to show. */
  lines: string[];
};

export function summariseScriptExtenderLog(
  log: ScriptExtenderLog,
): ScriptExtenderSummary {
  const loaded = log.outcomes.filter((o) => o.kind === "loaded").length;
  const skipped = log.outcomes.filter((o) => o.kind === "not-a-plugin").length;
  const failed = log.outcomes
    .filter((o): o is Extract<PluginOutcome, { kind: "failed" }> => o.kind === "failed")
    .map((o) => ({ file: o.file, lines: o.lines }));

  const lines: string[] = [];
  lines.push(
    failed.length === 0
      ? `All ${loaded} script-extender plugin${loaded === 1 ? "" : "s"} loaded.`
      : `${failed.length} of ${loaded + failed.length} script-extender plugins did not load.`,
  );
  for (const f of failed) {
    lines.push(
      f.lines.length > 0 ? `${f.file} — ${f.lines[0]}` : `${f.file} — the log says nothing more about it.`,
    );
  }
  if (skipped > 0) {
    lines.push(
      `${skipped} file${skipped === 1 ? "" : "s"} in the plugins folder ${
        skipped === 1 ? "is" : "are"
      } not extender plugins (crash-logger helpers and the like). That is normal.`,
    );
  }
  return { loaded, skipped, failed, lines };
}

/**
 * Where the extender writes its log, per game.
 *
 * Only the two that could be verified against a real file are listed. A game
 * that is not here returns undefined and the caller says "no log found"
 * rather than reading a path someone guessed — the same rule the rest of this
 * folder follows.
 */
export function scriptExtenderLogFor(
  gameId: string,
): { folder: string; file: string } | undefined {
  switch (gameId) {
    case "fallout4":
      return { folder: "F4SE", file: "f4se.log" };
    case "skyrimse":
      return { folder: "SKSE", file: "skse64.log" };
    default:
      return undefined;
  }
}

/**
 * Find and read this game's script-extender log.
 *
 * The folder comes from `iniLocationFor`, not from a path built here: it
 * already knows that a GOG install writes to "Skyrim Special Edition GOG"
 * rather than "Skyrim Special Edition", which is the difference between
 * reading the live log and reporting that there isn't one.
 */
export async function readScriptExtenderLog(args: {
  gameId: string;
  documentsPath: string;
  store?: string;
}): Promise<
  | { kind: "read"; path: string; log: ScriptExtenderLog }
  | { kind: "unsupported" }
  | { kind: "absent"; path: string }
  | { kind: "unreadable"; path: string; why: string }
> {
  const where = scriptExtenderLogFor(args.gameId);
  if (where === undefined) return { kind: "unsupported" };

  const [{ iniLocationFor }, fsp] = await Promise.all([
    import("../manifest/gameIni"),
    import("fs/promises"),
  ]);
  const location = iniLocationFor(args.gameId, args.documentsPath, args.store);
  if (location === undefined) return { kind: "unsupported" };

  const path = `${location.dir}/${where.folder}/${where.file}`;
  try {
    const text = await fsp.readFile(path, "utf8");
    return { kind: "read", path, log: parseScriptExtenderLog(text) };
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    if (code === "ENOENT") return { kind: "absent", path };
    return {
      kind: "unreadable",
      path,
      why: err instanceof Error ? err.message : String(err),
    };
  }
}
