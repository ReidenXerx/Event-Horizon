/**
 * Will a collection's script-extender plugins load on a given game?
 *
 * Accepted first on real data, before any of these were written: every mod
 * shipped in Meridia 1.0.22 and Ivy 1.0.34, DLLs read from disk and judged
 * against each collection's own game with its real rules. Meridia: 236 load,
 * 0 cannot, 0 undetermined conflicts. Ivy: 92 unverified, exactly 1 cannot —
 * crafting_highlight_fix.dll, a next-gen-only build on an old-gen game.
 *
 * Every case below is a way this was got wrong while building it.
 */
import { describe, expect, it } from "vitest";

import type { EhcollNativePlugin, EhcollRule } from "../../types/ehcoll";
import {
  describeCuratorNativeFindings,
  extenderApiFor,
  judgeCollection,
  judgePlugin,
  runtimeIdFor,
} from "./nativePluginCompat";

const declares = (over: Partial<EhcollNativePlugin> = {}): EhcollNativePlugin => ({
  path: "SKSE/Plugins/x.dll",
  extender: "skse",
  kind: "declares",
  versionIndependent: false,
  runtimes: [],
  hasQuery: false,
  ...over,
});

const AE_GOG = { runtime: "1.6.1179.1", api: "version" as const };
const OLDGEN = { runtime: "1.10.163", api: "query" as const };

describe("how the runtime is spelled", () => {
  it("adds SKSE's GOG marker, which the executable itself does not report", () => {
    // Compare "1.6.1179.0" with a plugin's "1.6.1179.1" and every GOG
    // plugin looks incompatible.
    expect(runtimeIdFor("skyrimse", "1.6.1179.0", "gog")).toBe("1.6.1179.1");
    expect(runtimeIdFor("skyrimse", "1.6.1170.0", "steam")).toBe("1.6.1170");
  });

  it("adds no marker for Fallout 4, where no plugin uses one", () => {
    expect(runtimeIdFor("fallout4", "1.10.163.0", "gog")).toBe("1.10.163");
  });

  it("claims nothing for a game it has not been measured on", () => {
    expect(runtimeIdFor("falloutnv", "1.4.0.525", undefined)).toBeUndefined();
    expect(extenderApiFor("starfield", "1.14.70.0")).toBeUndefined();
  });
});

describe("which extender API a game uses", () => {
  it("Skyrim AE reads the version block; SE calls Query", () => {
    expect(extenderApiFor("skyrimse", "1.6.1179.0")).toBe("version");
    expect(extenderApiFor("skyrimse", "1.6.317.0")).toBe("version");
    expect(extenderApiFor("skyrimse", "1.5.97.0")).toBe("query");
  });

  it("Fallout 4 next-gen reads the block; old-gen calls Query", () => {
    expect(extenderApiFor("fallout4", "1.10.984.0")).toBe("version");
    expect(extenderApiFor("fallout4", "1.10.980.0")).toBe("version");
    expect(extenderApiFor("fallout4", "1.10.163.0")).toBe("query");
  });
});

describe("one plugin on a version-block extender", () => {
  it("loads when Address Library makes it independent", () => {
    expect(judgePlugin(declares({ versionIndependent: true }), AE_GOG)).toEqual({ kind: "loads" });
  });

  it("loads when it names this exact runtime", () => {
    expect(judgePlugin(declares({ runtimes: ["1.6.1179.1"] }), AE_GOG)).toEqual({ kind: "loads" });
  });

  it("cannot load when pinned to another runtime, and says which", () => {
    const v = judgePlugin(declares({ runtimes: ["1.6.640"] }), AE_GOG);
    expect(v.kind).toBe("cannot-load");
    expect(v.kind === "cannot-load" && v.why).toMatch(/1\.6\.640.*1\.6\.1179\.1/);
  });

  it("an SE-era Query-only SKSE plugin cannot load on AE", () => {
    expect(judgePlugin({ path: "p", extender: "skse", kind: "query-only" }, AE_GOG).kind).toBe(
      "cannot-load",
    );
  });

  it("does NOT claim a Query-only F4SE plugin fails on next-gen, which is not established", () => {
    const nextGen = { runtime: "1.10.984", api: "version" as const };
    expect(judgePlugin({ path: "p", extender: "f4se", kind: "query-only" }, nextGen).kind).toBe(
      "unknown",
    );
  });
});

describe("one plugin on a Query-calling extender", () => {
  it("cannot load when it has only the version block — the crafting_highlight_fix case", () => {
    // Crafting Highlight Fix 1.9: next-gen build, no Query function, shipped
    // in a collection for old-gen 1.10.163. F4SE calls Query and finds none.
    const v = judgePlugin(
      declares({ extender: "f4se", runtimes: ["1.10.984"], hasQuery: false }),
      OLDGEN,
    );
    expect(v.kind).toBe("cannot-load");
  });

  it("is unverified — not 'loads' — when it has Query, because Query decides at load time", () => {
    const v = judgePlugin(
      declares({ extender: "f4se", runtimes: ["1.11.240"], hasQuery: true }),
      OLDGEN,
    );
    // Its declared runtimes are irrelevant here: the extender never reads them.
    expect(v).toEqual({ kind: "unverified" });
  });

  it("is unverified for a Query-only plugin", () => {
    expect(judgePlugin({ path: "p", extender: "f4se", kind: "query-only" }, OLDGEN)).toEqual({
      kind: "unverified",
    });
  });
});

describe("an unreadable DLL", () => {
  it("is unknown, never a verdict", () => {
    expect(judgePlugin({ path: "p", extender: "skse", kind: "unreadable" }, AE_GOG).kind).toBe(
      "unknown",
    );
  });
});

describe("the copy that deploys", () => {
  const PATH = "SKSE/Plugins/fiss.dll";
  const base = {
    name: "FileAccess Interface for Skyrim SE Scripts",
    compareKey: "nexus:13956:1",
    nativePlugins: [declares({ path: PATH, runtimes: ["1.6.640"] })],
  };
  const replacer = {
    name: "FISSES for Skyrim AE 1.6.1130 (or later)",
    compareKey: "nexus:107513:2",
    nativePlugins: [declares({ path: PATH, versionIndependent: true })],
  };

  it("judges only the winner — a base+replacer pair is not a broken plugin", () => {
    /**
     * Judging every copy called three correct setups broken: fiss.dll,
     * skee64.dll and wsfw_identifier.dll all ship a base build that cannot
     * load and a replacer that can, with a rule making the replacer win.
     */
    const rules: EhcollRule[] = [{ source: replacer.compareKey, type: "after", reference: base.compareKey }];
    const j = judgeCollection({ mods: [base, replacer], rules, target: AE_GOG });
    expect(j.cannotLoad).toEqual([]);
    expect(j.loads).toBe(1);
  });

  it("flags it when the BASE wins, which is exactly the broken setup", () => {
    const rules: EhcollRule[] = [{ source: base.compareKey, type: "after", reference: replacer.compareKey }];
    const j = judgeCollection({ mods: [base, replacer], rules, target: AE_GOG });
    expect(j.cannotLoad.map((f) => f.mod)).toEqual([base.name]);
  });

  it("reads a `before` rule from the other side too", () => {
    const rules: EhcollRule[] = [{ source: base.compareKey, type: "before", reference: replacer.compareKey }];
    expect(judgeCollection({ mods: [base, replacer], rules, target: AE_GOG }).cannotLoad).toEqual([]);
  });

  it("matches a partly pinned reference", () => {
    // `nexus:13956` refers to any file of that mod.
    const rules: EhcollRule[] = [{ source: replacer.compareKey, type: "after", reference: "nexus:13956" }];
    expect(judgeCollection({ mods: [base, replacer], rules, target: AE_GOG }).cannotLoad).toEqual([]);
  });

  it("does NOT treat `requires` as an order — it is a dependency", () => {
    // Counting it was the second mistake made while fixing the first.
    const rules: EhcollRule[] = [{ source: replacer.compareKey, type: "requires", reference: base.compareKey }];
    const j = judgeCollection({ mods: [base, replacer], rules, target: AE_GOG });
    expect(j.undeterminedConflicts).toEqual([{ path: PATH, mods: [base.name, replacer.name] }]);
    expect(j.cannotLoad).toEqual([]);
  });

  it("ignores a rule the curator disabled", () => {
    const rules: EhcollRule[] = [
      { source: replacer.compareKey, type: "after", reference: base.compareKey, ignored: true },
    ];
    expect(judgeCollection({ mods: [base, replacer], rules, target: AE_GOG }).undeterminedConflicts).toHaveLength(1);
  });

  it("treats paths case-insensitively, because they are one file on Windows", () => {
    const upper = { ...replacer, nativePlugins: [declares({ path: "skse/plugins/FISS.DLL", versionIndependent: true })] };
    const rules: EhcollRule[] = [{ source: replacer.compareKey, type: "after", reference: base.compareKey }];
    const j = judgeCollection({ mods: [base, upper], rules, target: AE_GOG });
    expect(j.undeterminedConflicts).toEqual([]);
    expect(j.cannotLoad).toEqual([]);
  });
});

describe("what the curator is told about their own build", () => {
  const clean = { cannotLoad: [], unknown: [], undeterminedConflicts: [], loads: 236, unverified: 0 };

  it("says nothing when everything loads — Meridia 1.0.22's real result", () => {
    expect(describeCuratorNativeFindings(clean, "1.6.1179.0 gog")).toEqual([]);
  });

  it("stays quiet about unverified plugins, which are the NORMAL state of an old-gen game", () => {
    // Ivy 1.0.34: 92 unverified. Listing them would bury the one real finding.
    expect(describeCuratorNativeFindings({ ...clean, loads: 0, unverified: 92 }, "1.10.163.0 gog")).toEqual([]);
  });

  it("names a plugin that cannot load, its mod, and why — Ivy 1.0.34's real result", () => {
    const [msg] = describeCuratorNativeFindings(
      {
        ...clean,
        cannotLoad: [
          {
            mod: "Crafting Highlight Fix 1.9-27479-1-9-1718721187",
            path: "F4SE/Plugins/crafting_highlight_fix.dll",
            why: "it is built for the newer script extender only",
          },
        ],
      },
      "1.10.163.0 gog",
    );
    expect(msg).toContain("1 script-extender plugin in this collection cannot load");
    expect(msg).toContain("1.10.163.0 gog");
    expect(msg).toContain("crafting_highlight_fix.dll");
    expect(msg).toContain("Crafting Highlight Fix 1.9");
    expect(msg).toContain("built for the newer script extender only");
  });

  it("reports a conflict no rule decides, because the collection then does not decide the DLL", () => {
    const [msg] = describeCuratorNativeFindings(
      { ...clean, undeterminedConflicts: [{ path: "SKSE/Plugins/skee64.dll", mods: ["RaceMenu", "GOG Fix"] }] },
      "1.6.1179.0 gog",
    );
    expect(msg).toContain("skee64.dll");
    expect(msg).toContain("RaceMenu / GOG Fix");
    expect(msg).toMatch(/before\/after rule/);
  });
});
