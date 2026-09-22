/**
 * ──────────────────────────────────────────────────────────────────────
 * THE SELF-CHECK'S FINDINGS ARE NOT REPORTING — THEY ARE WHAT SHIPS.
 *
 * Three facts are discoverable only by reading a mod's archive and its FOMOD
 * script, and unless they are written onto the mods the manifest cannot carry
 * them: `emptySelectionVerified` (NS-8 — without it the player is handed a
 * FOMOD dialog they cannot answer), `installerUnexamined` (a mod whose archive
 * could not be opened otherwise reaches the manifest indistinguishable from
 * one that was read and asks nothing), and `readsPluginState` (the epoch
 * planner puts a plugin-state-dependent installer in the wrong epoch and the
 * player gets a different file set, with no error).
 *
 * All three lived several hundred lines inside the self-check's `try`, under a
 * blanket `catch (err) { selfCheckOp.fail(err); }` whose comment reads "A
 * self-check problem is never a build problem." That is true of
 * `runSelfChecks`, which contains every per-mod failure by design. It was not
 * true of the 270 lines after it, which are not checking — they are writing
 * results into what ships. Any throw between skipped all three and the build
 * carried on to PACKAGE, and because `selfCheckWarnings` was assigned early
 * the summary still showed the check's findings: it looked like the whole pass
 * had run.
 *
 * The same catch ate the `AbortError` from `checkAbort()`, making the
 * cancellation guard on the decision gate inert — its own comment says a
 * cancelled build would otherwise "walk a 1,700-mod profile before it
 * rewinds", which is exactly what it then did.
 * ──────────────────────────────────────────────────────────────────────
 */
import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { applySelfCheckFindings } from "./engine";
import type { AuditorMod } from "../../../core/getModsListForProfile";
import type { SelfCheckReport } from "../../../core/manifest/runSelfChecks";

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

const report = (over: Partial<SelfCheckReport> & { modId: string }): SelfCheckReport =>
  over as SelfCheckReport;

describe("what the self-check measured reaches the mods that ship", () => {
  it("carries all three findings onto the right mods and nothing onto the rest", () => {
    const out = applySelfCheckFindings(
      [mod("a"), mod("b"), mod("c"), mod("untouched")],
      [
        report({ modId: "a", emptySelectionVerified: true }),
        report({ modId: "b", installerUnexamined: true }),
        report({ modId: "c", readsPluginState: ["Helios_Obsidian.esp"] }),
        report({ modId: "untouched" }),
      ],
    );
    const by = new Map(out.map((m) => [m.id, m]));

    expect(by.get("a")?.emptySelectionVerified).toBe(true);
    expect(by.get("b")?.installerUnexamined).toBe(true);
    expect(by.get("c")?.readsPluginState).toEqual(["Helios_Obsidian.esp"]);

    // The negative half matters as much: a mod with no finding must not gain
    // a field, because `installerUnexamined: false` and its ABSENCE are
    // different claims in the shipped manifest.
    const untouched = by.get("untouched")!;
    expect("emptySelectionVerified" in untouched).toBe(false);
    expect("installerUnexamined" in untouched).toBe(false);
    expect("readsPluginState" in untouched).toBe(false);
  });

  it("leaves every mod alone when the check produced nothing", () => {
    // The check never ran, or threw before producing reports. Saying nothing
    // is the honest answer; inventing "asks nothing" is the bug this closes.
    const mods = [mod("a"), mod("b")];
    expect(applySelfCheckFindings(mods, [])).toEqual(mods);
  });

  it("carries a report with two findings at once", () => {
    // One mod can be both unexamined and a plugin-state reader; three
    // sequential `mods.map` passes made that easy to get wrong by shadowing.
    const [out] = applySelfCheckFindings(
      [mod("a")],
      [report({ modId: "a", installerUnexamined: true, readsPluginState: ["x.esp"] })],
    );
    expect(out?.installerUnexamined).toBe(true);
    expect(out?.readsPluginState).toEqual(["x.esp"]);
  });
});

describe("the pipeline applies them where a reporting failure cannot skip them", () => {
  const source = fs.readFileSync(path.join(__dirname, "engine.ts"), "utf8");

  it("has its anchors, so this cannot go vacuous", () => {
    // GP-7: a source-text test that stops matching reports coverage it does
    // not have.
    expect(source).toContain("const selfCheckOp = beginOp(");
    expect(source).toContain("mods = applySelfCheckFindings(mods, selfCheckReports);");
  });

  it("calls it AFTER the self-check's catch, not inside the try", () => {
    const tryEnd = source.indexOf("    // A self-check problem is never a build problem.");
    const call = source.indexOf("mods = applySelfCheckFindings(mods, selfCheckReports);");
    expect(tryEnd).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(tryEnd);
  });

  it("rethrows an abort out of that catch instead of swallowing it", () => {
    /**
     * Anchored on the comment that IDENTIFIES this catch, not on the first
     * `} catch (err) {` after the self-check — there is a nested one around
     * the second bundling pass, and matching that instead is how a source
     * test quietly checks the wrong thing.
     */
    const marker = source.indexOf(
      "    // A self-check problem is never a build problem.",
    );
    expect(marker).toBeGreaterThan(-1);
    const catchAt = source.lastIndexOf("  } catch (err) {", marker);
    expect(catchAt).toBeGreaterThan(-1);
    const body = source.slice(catchAt, marker);
    expect(body).toContain("if (isAbort(err) || signal?.aborted === true)");
    expect(body).toContain("throw err;");
  });
});
