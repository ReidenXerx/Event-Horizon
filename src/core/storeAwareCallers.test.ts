/**
 * ──────────────────────────────────────────────────────────────────────
 * Every caller that resolves a game folder must say which STORE.
 *
 * This is a tripwire, not a unit test, and it exists because the bug it
 * guards is invisible by construction. Vortex names these folders after
 * whoever sold the game — `Skyrim Special Edition GOG`, `Fallout4 MS` — and a
 * caller that forgets the store reads the Steam folder instead. On a GOG
 * machine that folder either does not exist, in which case the capture comes
 * back EMPTY and empty is also what a game with no plugins.txt legitimately
 * produces, or it is a leftover from an earlier install, in which case the
 * capture succeeds and ships someone's months-old settings.
 *
 * Neither fails. Neither warns. It cost a real curator every Skyrim SE
 * package they had built — no plugin order, no ESL flags, no LOOT rules, and
 * stale INIs — while their Fallout 4 packages from the same machine were
 * perfect, which is exactly why nobody noticed for months.
 *
 * Then, fixing it, two more call sites were missed on the first pass and only
 * found by accident: Doctor's plugin-order heal, which would have stripped
 * every plugin the user had added, and the compare-plugins action, which
 * compared against the wrong file entirely. Two misses out of seven is a rate
 * that says the next one will be missed too.
 *
 * So the rule is enforced rather than remembered.
 * ──────────────────────────────────────────────────────────────────────
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import * as path from "path";

const SRC = path.join(__dirname, "..");
const read = (rel: string): string => readFileSync(path.join(SRC, rel), "utf8");

/** Strip comments, so prose about a call is not mistaken for the call. */
function code(src: string): string {
  return src
    .split(/\/\*[\s\S]*?\*\//)
    .join(" ")
    .split("\n")
    .map((l) => {
      const at = l.search(/(^|[^:])\/\//);
      return at === -1 ? l : l.slice(0, at === 0 ? 0 : at + 1);
    })
    .join("\n");
}

/**
 * Call sites that must be store-aware, and the argument that proves it.
 *
 * A path here that stops calling the function is not a failure — the file
 * list below is checked for existence separately, so a rename shows up as a
 * missing file rather than as a silent pass.
 */
const CALLERS: { file: string; fn: string }[] = [
  // plugins.txt — %LOCALAPPDATA%\<game>\plugins.txt
  { file: "actions/comparePluginsAction.ts", fn: "getCurrentPluginsTxtPath" },
  { file: "ui/pages/build/engine.ts", fn: "getCurrentPluginsTxtPath" },
  { file: "core/installer/checkPluginOrder.ts", fn: "getCurrentPluginsTxtPath" },
  // …and the readers that wrap it.
  { file: "core/installer/runInstall.ts", fn: "readUserPluginsTxt" },
  { file: "core/doctor/gather.ts", fn: "readUserPluginsTxt" },
  { file: "core/doctor/runHeal.ts", fn: "readUserPluginsTxt" },
  // INIs — Documents\My Games\<game>
  { file: "core/manifest/gameIni.ts", fn: "iniLocationFor" },
  { file: "core/installer/applyGameIni.ts", fn: "iniLocationFor" },
];

describe("no game folder is resolved without knowing the store", () => {
  it("every listed file still exists", () => {
    // So a rename fails loudly instead of quietly removing a guard.
    const missing = CALLERS.filter((c) => {
      try {
        read(c.file);
        return false;
      } catch {
        return true;
      }
    }).map((c) => c.file);
    expect(missing).toEqual([]);
  });

  it("passes a store to every folder-resolving call", () => {
    /**
     * The check is deliberately shallow: it asserts the call has a SECOND
     * argument, not what that argument is. A deep check would need the type
     * system, which already agrees — and a shallow one that fires is worth
     * more than a thorough one nobody writes.
     */
    const offenders: string[] = [];
    for (const { file, fn } of CALLERS) {
      const body = code(read(file));
      const calls = [...body.matchAll(new RegExp(`\\b${fn}\\s*\\(`, "g"))];
      for (const m of calls) {
        // Walk to the matching close paren so a multi-line call is one unit.
        let depth = 0;
        let i = m.index! + m[0].length - 1;
        let args = "";
        for (; i < body.length; i += 1) {
          const ch = body[i]!;
          if (ch === "(") depth += 1;
          else if (ch === ")") {
            depth -= 1;
            if (depth === 0) break;
          }
          if (depth >= 1) args += ch;
        }
        // `(` is included by the loop above; drop it.
        const inner = args.slice(1);
        // A definition, not a call.
        if (/^\s*$/.test(inner)) continue;
        if (/:\s*string/.test(inner)) continue;
        if (!inner.includes(",")) {
          offenders.push(`${file}: ${fn}(${inner.trim().slice(0, 60)})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
