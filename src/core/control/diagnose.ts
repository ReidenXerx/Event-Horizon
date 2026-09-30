/**
 * ──────────────────────────────────────────────────────────────────────
 * Verdicts for an agent, not raw text (owner, 2026-09-30: "imagine they will
 * have Sonnet-grade agents").
 *
 * A crash log is 2,000 lines, and the part that matters is scattered across
 * four sections: the exception, the call stack, the objects in the registers
 * and on the stack, and which file each came from. An agent reading it raw
 * spends its context and still guesses. This reads it once, the same way every
 * time, and names suspects: the DLLs and plugins the log points at, ranked by
 * where they appear, and the Vortex mod each one came from. The agent's job is
 * then to explain and to act, which is the part it is good at.
 *
 * Pure: the caller reads the file and supplies who owns what.
 * ──────────────────────────────────────────────────────────────────────
 */

export type ParsedCrashLog = {
  game?: { name: string; version: string };
  logger?: { name: string; version: string };
  /** `module` is absent when the crash executed memory no module owns (a freed object, a broken hook). */
  exception?: { code: string; module?: string; offset?: string; detail?: string };
  /** Modules of the call stack, top first; `probable` frames are the logger's reconstruction, the rest a stack scan. */
  callStack: Array<{ module: string; probable: boolean }>;
  /** DLLs named in the registers and on the stack (void* -> x.dll+...). */
  dllMentions: Record<string, number>;
  /** Plugins named in registers and on the stack (File:, Modified by:), counted. */
  pluginMentions: Record<string, number>;
  /** The last plugin of each "Modified by" chain: the override the game actually used. */
  winningOverrides: Record<string, number>;
  /** Asset files named (meshes, textures, animations, scripts). */
  assetMentions: Record<string, number>;
  /** Object types in the registers ("BSTriShape", "TESObjectREFR"), counted. */
  objectTypes: Record<string, number>;
  /** Object names ("Raider", a mesh node name), counted. */
  objectNames: Record<string, number>;
  /** Papyrus scripts on a crashing script stack (Skyrim's logger prints them), counted. */
  scripts: Record<string, number>;
  /** Plugins the game had loaded, from the PLUGINS section. */
  loadedPlugins: string[];
};

const bump = (m: Record<string, number>, k: string, by = 1): void => {
  m[k] = (m[k] ?? 0) + by;
};

const PLUGIN_RE = /\.(esp|esm|esl)$/i;
const ASSET_RE = /\.(nif|dds|hkx|bgsm|bgem|pex|psc|tri|ba2|bsa|swf|wav|xwm|fuz|lip)$/i;

/** Reads Buffout 4 / Buffout 4 NG / Crash Logger SSE / Crash Logger (Starfield) logs. Lenient: unknown lines are skipped. */
export function parseCrashLog(text: string): ParsedCrashLog {
  const out: ParsedCrashLog = {
    callStack: [],
    dllMentions: {},
    pluginMentions: {},
    winningOverrides: {},
    assetMentions: {},
    objectTypes: {},
    objectNames: {},
    scripts: {},
    loadedPlugins: [],
  };
  const lines = text.split(/\r?\n/);
  let section = "";
  for (const raw of lines.slice(0, 12)) {
    const line = raw.trim();
    const game = /^(Fallout 4 VR|Fallout 4|Skyrim VR|Skyrim SSE|Skyrim SE|Skyrim Special Edition|Starfield)\s+v?(\d[\d.]*)/i.exec(line);
    if (game !== null && out.game === undefined) out.game = { name: game[1]!, version: game[2]! };
    const logger = /^(.*?Crash ?Logger\w*|Buffout 4(?: NG)?)\s+v?(\d[\w.-]*)/i.exec(line);
    if (logger !== null && out.logger === undefined) out.logger = { name: logger[1]!.trim(), version: logger[2]! };
  }
  const objectLine = (line: string): void => {
    // (NiNode*) "Pelvis"  ·  (FormID 0x14 -> PlayerCharacter* 0x...) "Prisoner" [...] ("Apprentice.esp")
    const typed = /\((?:FormID 0x[0-9A-F]+ -> )?([A-Za-z_][\w:<>]*)\*(?: 0x[0-9A-F]+)?\)(?:\s+"([^"]+)")?/i.exec(line);
    if (typed !== null && !/^(void|char|size_t)$/.test(typed[1]!)) {
      bump(out.objectTypes, typed[1]!);
      if (typed[2] !== undefined) bump(out.objectNames, typed[2]);
    }
    for (const m of line.matchAll(/\("([^"]+\.(?:esp|esm|esl))"\)/gi)) bump(out.pluginMentions, m[1]!);
    for (const m of line.matchAll(/([\w .()'-]+?\.dll)\+[0-9A-F]+/gi)) bump(out.dllMentions, m[1]!.trim());
    for (const m of line.matchAll(/"([^"]+\.(?:nif|dds|hkx|bgsm|bgem|pex|tri|swf))"/gi)) bump(out.assetMentions, m[1]!);
  };
  for (const raw of lines) {
    const line = raw.trim();
    const exc = /Unhandled exception "([^"]+)" at 0x[0-9A-F]+(?:\s+([^\s+]+)\+([0-9A-F]+))?/i.exec(line);
    if (exc !== null && out.exception === undefined) {
      out.exception = { code: exc[1]!, ...(exc[2] !== undefined ? { module: exc[2], offset: exc[3]! } : {}) };
      continue;
    }
    const detail = /^Access Violation:\s*(.+)$/i.exec(line);
    if (detail !== null && out.exception !== undefined && out.exception.detail === undefined) {
      out.exception.detail = detail[1]!;
      continue;
    }
    // "REGISTERS:", "CALL STACK ([P]robable / [S]tack scan):"
    const header = /^([A-Z][A-Z0-9 ]*?)\s*(?:\([^)]*\))?:\s*$/.exec(raw.trimEnd());
    if (header !== null && !raw.startsWith("\t") && !raw.startsWith(" ")) {
      section = header[1]!.trim();
      continue;
    }
    if (section === "CALL STACK" || section === "PROBABLE CALL STACK") {
      const frame = /^\[\s*\d+\](\[[PS]\])?\s+0x[0-9A-F]+\s+([^\s+]+)\+[0-9A-F]+/i.exec(line);
      if (frame !== null) out.callStack.push({ module: frame[2]!, probable: frame[1] === undefined || frame[1] === "[P]" });
      continue;
    }
    if (section === "POSSIBLE RELEVANT OBJECTS") {
      objectLine(line);
      continue;
    }
    if (section === "REGISTERS" || section === "STACK") {
      objectLine(line);
      const file = /^File:\s*"([^"]+)"/i.exec(line);
      if (file !== null) {
        const f = file[1]!;
        if (PLUGIN_RE.test(f)) bump(out.pluginMentions, f);
        else if (ASSET_RE.test(f)) bump(out.assetMentions, f);
      }
      // A cell or a common record is "modified by" dozens of plugins, all of them normal:
      // only the last one, the override the game used, says anything.
      const modified = /^Modified by:\s*(.+)$/i.exec(line);
      if (modified !== null) {
        const chain = modified[1]!.split(/\s*->\s*/).map((s) => s.trim()).filter((s) => PLUGIN_RE.test(s));
        if (chain.length > 0) bump(out.winningOverrides, chain[chain.length - 1]!);
      }
      // A Papyrus frame: [quest or alias (formid)].ScriptName.Function() - "file" Line n
      const papyrus = /^\[.+\]\.([\w:]+)\.\w+\(\)/.exec(line);
      if (papyrus !== null) bump(out.scripts, papyrus[1]!);
      continue;
    }
    if (section === "PLUGINS" || section === "GAME PLUGINS") {
      const p = /^\[[0-9A-F: ]+\]\s+(.+?\.(?:esp|esm|esl))\s*$/i.exec(line);
      if (p !== null) out.loadedPlugins.push(p[1]!);
    }
  }
  return out;
}

/** The game itself and Windows: they are where a crash lands, rarely why. */
const GAME_EXE = /^(Fallout4|Fallout4VR|SkyrimSE|SkyrimVR|Starfield)\.exe$/i;
const SYSTEM = new Set(
  [
    "ntdll.dll",
    "kernel32.dll",
    "kernelbase.dll",
    "ucrtbase.dll",
    "msvcrt.dll",
    "msvcp140.dll",
    "vcruntime140.dll",
    "vcruntime140_1.dll",
    "user32.dll",
    "gdi32.dll",
    "combase.dll",
    "d3d11.dll",
    "dxgi.dll",
    "d3d12.dll",
    "xinput1_3.dll",
    "x3daudio1_7.dll",
    "xaudio2_7.dll",
    "steam_api64.dll",
    "bink2w64.dll",
    "tbb.dll",
    "tbbmalloc.dll",
  ].map((s) => s.toLowerCase()),
);
/** Graphics drivers: a crash here is the GPU driver, usually fed something broken. */
const GPU_DRIVER = /^(nvwgf2umx?|nvoglv64|nvlddmkm|atidxx64|atiumd64|amdxx64|amdxc64|igd10iumd64|igd12umd64|igdumdim64|igxelpicd64)\.dll$/i;

export type Owner = { modId: string; modName: string };

export type CrashSuspect = {
  kind: "dll" | "plugin" | "asset";
  name: string;
  /** Higher is more likely; only comparable within one log. */
  score: number;
  where: string[];
  mod?: Owner;
};

export type CrashVerdict = {
  summary: string;
  /** What the exception location means, in words, when it says something on its own. */
  meaning?: string;
  suspects: CrashSuspect[];
  objects: { types: string[]; names: string[] };
};

const top = (m: Record<string, number>, n: number): string[] =>
  Object.entries(m)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([k]) => k);

export function judgeCrash(
  log: ParsedCrashLog,
  owners: {
    dll: (file: string) => Owner | undefined;
    plugin: (file: string) => Owner | undefined;
    asset: (relPath: string) => Owner | undefined;
    /** Base-game and official plugins: named, never ranked as suspects. */
    isBaseGame: (plugin: string) => boolean;
  },
): CrashVerdict {
  const suspects = new Map<string, CrashSuspect>();
  const add = (kind: CrashSuspect["kind"], name: string, score: number, where: string): void => {
    const key = `${kind}:${name.toLowerCase()}`;
    const s = suspects.get(key) ?? { kind, name, score: 0, where: [] };
    s.score += score;
    if (!s.where.includes(where)) s.where.push(where);
    suspects.set(key, s);
  };
  const isOurs = (dll: string): boolean => !GAME_EXE.test(dll) && !SYSTEM.has(dll.toLowerCase()) && !GPU_DRIVER.test(dll);

  const exc = log.exception;
  if (exc?.module !== undefined && isOurs(exc.module)) add("dll", exc.module, 10, "the crash happened inside it");
  log.callStack.slice(0, 12).forEach((f, i) => {
    if (isOurs(f.module)) add("dll", f.module, f.probable ? (i < 5 ? 4 : 2) : i < 5 ? 2 : 1, "in the call stack");
  });
  for (const [script, n] of Object.entries(log.scripts)) {
    add("asset", `Scripts/${script.replace(/:/g, "/")}.pex`, 3 + Math.min(n, 3), "its Papyrus script was running when the game crashed");
  }
  for (const [dll, n] of Object.entries(log.dllMentions)) if (isOurs(dll)) add("dll", dll, Math.min(n, 3), "on the stack");
  for (const [p, n] of Object.entries(log.pluginMentions)) {
    if (!owners.isBaseGame(p)) add("plugin", p, Math.min(n, 4), "a record it was handling came from it");
  }
  for (const [p, n] of Object.entries(log.winningOverrides)) {
    if (!owners.isBaseGame(p)) add("plugin", p, Math.min(n, 3) * 2, "its change to that record was the one in use");
  }
  for (const [a, n] of Object.entries(log.assetMentions)) add("asset", a, 2 + Math.min(n, 3), "the game was using this file");

  const ranked = [...suspects.values()]
    .map((s) => {
      const mod = s.kind === "dll" ? owners.dll(s.name) : s.kind === "plugin" ? owners.plugin(s.name) : owners.asset(s.name);
      return mod !== undefined ? { ...s, mod } : s;
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 12);

  let meaning: string | undefined;
  if (exc !== undefined && exc.module === undefined) {
    meaning =
      "The game jumped to memory no module owns: code called through a dangling pointer, usually a freed object or a " +
      "DLL hook that went stale. The objects listed are what it was working on; a mod that adds or changes those " +
      "(named nodes, bones, forms) is the first suspect.";
  } else if (exc?.module !== undefined) {
    if (GPU_DRIVER.test(exc.module)) {
      meaning =
        "The graphics driver crashed. It is usually fed something broken: a bad mesh or texture from a mod, an ENB or " +
        "ReShade preset, or it ran out of video memory. Rarely the driver itself.";
    } else if (GAME_EXE.test(exc.module)) {
      meaning =
        "The crash is in the game's own code. That code was handling something a mod supplied: look at the plugins and " +
        "files the suspects list names, not at the game.";
    } else if (SYSTEM.has(exc.module.toLowerCase())) {
      meaning = "The crash surfaced in a Windows library; the call stack below it says whose code called it.";
    } else {
      meaning =
        `The crash happened inside ${exc.module}, a mod's DLL. Most often it is built for another game version ` +
        "(check with diagnose_setup), outdated, or conflicting with another DLL.";
    }
    if (/STACK_OVERFLOW/i.test(exc.code)) {
      meaning += " A stack overflow usually means code that called itself without end, often through a mod's data looping.";
    }
  }
  const first = ranked[0];
  const summary =
    exc === undefined
      ? "No exception line found: this may not be a crash log, or the logger's format is unknown."
      : first === undefined
        ? `${exc.code} in ${exc.module ?? "memory no module owns"}; nothing in the log points at a mod.`
        : `${exc.code} in ${exc.module ?? "memory no module owns"}; the log points most at ${first.name}${first.mod !== undefined ? ` (mod: ${first.mod.modName})` : ""}.`;
  return {
    summary,
    ...(meaning !== undefined ? { meaning } : {}),
    suspects: ranked,
    objects: { types: top(log.objectTypes, 6), names: top(log.objectNames, 8) },
  };
}
