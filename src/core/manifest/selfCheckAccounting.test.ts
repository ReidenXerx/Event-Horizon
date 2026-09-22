/**
 * ──────────────────────────────────────────────────────────────────────
 * THE BUILD'S WHOLE CLAIM IS "WE VERIFIED THIS", AND NOTHING COUNTED.
 *
 * Three separate routes let a mod leave the self-check's accounting without
 * anybody being told, and they shared one cause: `reports.length` was never
 * compared with anything.
 *
 *  1. A mod whose check THREW was logged and not pushed. `summary.skipped`
 *     counts only reports that exist with `depth: "skipped"`, so the mod was
 *     in neither the reports nor the skipped count — and the curator is warned
 *     "N mod(s) could not be checked" for the other failure mode and told
 *     nothing at all for this one.
 *  2. A cancelled run `break`s the loop and returns a normal,
 *     complete-SHAPED result computed from a partial report set. Nothing about
 *     the return distinguishes it from a full one.
 *  3. With 7-Zip unresolvable the whole pass returned zero reports, zero
 *     warnings and an all-zero summary — indistinguishable in the build
 *     summary from a collection where every mod checked out clean. A real
 *     build replays 285 mods and containment-checks 1,446.
 *
 * And a fourth, inside the pass rather than around it: a file that cannot be
 * checksummed falls to the `size-only` arm, which counts as EXPLAINED, so the
 * mod's `unexplained` drops and mirror/bundle/declare is never offered. The
 * count escaped only to a debug log. Measured cost, from `crcBySha256.ts`:
 * 2,994 recorded files, 1,130 different for the player, every one at the same
 * path and the same size — "Sizes alone could not have caught a single one."
 * ──────────────────────────────────────────────────────────────────────
 */
import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { runSelfChecks } from "./runSelfChecks";
import type { AuditorMod } from "../getModsListForProfile";
import type { types } from "@nexusmods/vortex-api";

const source = fs.readFileSync(path.join(__dirname, "runSelfChecks.ts"), "utf8");

const mod = (id: string): AuditorMod =>
  ({
    id,
    name: id,
    enabled: true,
    modType: "",
    rules: [],
    fileOverrides: [],
    enabledINITweaks: [],
    hasInstallerChoices: false,
    hasDetailedInstallerChoices: false,
  }) as AuditorMod;

describe("every mod the pass was given comes back accounted for", () => {
  it("returns one report per comparable mod, even with nothing readable", async () => {
    /**
     * The invariant, run rather than read: three mods with no archives, no
     * staging and no state produce three reports. Before this, a mod whose
     * check threw was logged and dropped, so the count silently shrank and
     * `summary.skipped` — which counts only reports that EXIST at
     * `depth: "skipped"` — could not see it either.
     */
    const result = await runSelfChecks(
      {} as unknown as types.IState,
      "skyrimse",
      [mod("a"), mod("b"), mod("c")],
    );

    expect(result.reports).toHaveLength(3);
    expect(result.reports.map((r) => r.modId).sort()).toEqual(["a", "b", "c"]);
    // And every one of them is a depth the "could not be checked" warning
    // already counts, rather than a silent zero.
    expect(result.reports.every((r) => r.depth === "skipped")).toBe(true);
    expect(result.summary.skipped).toBe(3);
  });

  it("says nothing at all when there were no mods to check", () => {
    // A warning about 0 of 0 mods is noise, and noise is how the real ones
    // get ignored.
    return runSelfChecks({} as unknown as types.IState, "skyrimse", []).then(
      (result) => {
        expect(result.reports).toEqual([]);
        expect(result.warnings).toEqual([]);
      },
    );
  });

  it("names the count when 7-Zip itself could not be resolved", () => {
    /**
     * That branch returns before the loop, so it cannot be reached from a
     * test that has a working 7-Zip; asserted at the source instead. It used
     * to return zero reports, zero warnings and an all-zero summary —
     * indistinguishable from a collection where every mod checked out clean,
     * against a real build that replays 285 mods and containment-checks
     * 1,446.
     */
    const at = source.indexOf('ehLog("warn", "selfcheck.unavailable"');
    expect(at).toBeGreaterThan(-1);
    const body = source.slice(at, at + 1400);
    expect(body).toContain("did not run at all");
    expect(body).toContain("mods.length === 0");
  });
});

describe("no mod leaves the accounting without a report", () => {
  it("has its anchors, so this cannot go vacuous", () => {
    // GP-7.
    expect(source).toContain('ehLog("warn", "selfcheck.mod-threw"');
    expect(source).toContain("function unchecked(");
    expect(source).toContain("if (opts?.signal?.aborted === true) break;");
  });

  it("pushes a skipped report when a mod's check throws", () => {
    const at = source.indexOf('ehLog("warn", "selfcheck.mod-threw"');
    // The catch records the mod rather than only logging it. The window spans
    // the docblock between them, which is why it is generous.
    const body = source.slice(at, at + 1400);
    expect(body).toContain("reports.push(");
    expect(body).toContain("unchecked(mod,");
  });

  it("fills in the mods a cancel never reached", () => {
    expect(source).toContain("if (reports.length < comparable.length) {");
    const at = source.indexOf("if (reports.length < comparable.length) {");
    expect(source.slice(at, at + 400)).toContain(
      "cancelled before this mod was checked",
    );
  });

  it("reconciles the count, which is what makes all three impossible at once", () => {
    expect(source).toContain("if (reports.length !== comparable.length) {");
    const at = source.indexOf("if (reports.length !== comparable.length) {");
    expect(source.slice(at, at + 300)).toContain("selfcheck.accounting-mismatch");
  });

  it("reports an `unchecked` mod at a depth the existing warning already counts", () => {
    // Not a new category nobody reads: `summarizeSelfChecks` counts
    // `depth: "skipped"`, and there is already a warning on that number.
    const at = source.indexOf("function unchecked(");
    expect(source.slice(at, at + 500)).toContain('depth: "skipped"');
  });
});

describe("a comparison that fell back to size alone is not reported as a comparison", () => {
  it("routes both degrade paths to the caller instead of a debug log", () => {
    expect(source).toContain("onSizeOnly?: (info: { files: number; why: string }) => void;");
    // The staging folder could not be resolved…
    expect(source).toContain('why: "its staging folder could not be resolved"');
    // …and the per-file read failures the catch counts.
    expect(source).toContain("if (failed > 0) {");
    expect(source).toContain("they could not be read");
  });

  it("puts it in `warnings`, which is what the curator reads while deciding", () => {
    const at = source.indexOf("if (sizeOnlyMods.length > 0) {");
    expect(at).toBeGreaterThan(-1);
    const body = source.slice(at, at + 900);
    expect(body).toContain("warnings.push(");
    expect(body).toContain("SIZE ALONE");
    // Named mods, not a bare number — the curator has to know which.
    expect(body).toContain("m.mod");
  });
});
