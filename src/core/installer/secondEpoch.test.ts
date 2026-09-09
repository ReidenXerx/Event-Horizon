/**
 * Mods whose installer asks the game a question install AFTER the answer exists.
 *
 * ─── THE RUN THIS COMES FROM ────────────────────────────────────────────────
 * Eleven identical failures across every tester log, one mod, 801 of 979:
 *
 *   AAF_VanillaKinkyCreatureAnimations_Themes
 *   "Installer Prerequisits not fulfilled:
 *    File 'aaf.esm' is Active OR File 'aaf.esp' is Active"
 *
 * AAF is in the same collection. The mod failed because it installed before
 * AAF's plugin was active — decided by manifest position, which nobody chose.
 *
 * ─── WHY THE RETRY PASS IS NOT ENOUGH ───────────────────────────────────────
 * Refusing is loud, so the retry rescues it. The SAME `<fileDependency>` in a
 * step's `<visible>` or a `<conditionalFileInstalls>` pattern does not refuse:
 * it takes a different branch and installs a different FILE SET, with nothing
 * failing — so nothing retries, and verification later reports the mod as
 * unreproducible while blaming its archive.
 *
 * Proven from Vortex's shipped bundle: `getAllPlugins(activeOnly)` is
 * registered unconditionally on every FOMOD install and reads
 * `loadOrder[name].enabled`, and there is no argument that disables condition
 * evaluation. Pre-filling the curator's answers does NOT skip the conditions.
 *
 * A population discovered by letting mods FAIL can never contain the ones that
 * do not fail. So the build declares them and the driver installs them second.
 *
 * FIXTURE-DEBT: a behavioural test needs a driver run with a manifest carrying
 * `readsPluginState`, a fake that can report install ORDER, and a plugin the
 * collection ships — `fakeVortex` records installs but the e2e worlds build
 * their manifests from a real capture, so there is no seam for a synthetic
 * `readsPluginState` yet. Until there is, this pins the properties that make
 * the difference, and every anchor it locates is proven to exist first.
 */
import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

const src = fs.readFileSync(path.join(__dirname, "runInstall.ts"), "utf8");

describe("the second install epoch", () => {
  it("has every anchor it locates, so a rename cannot make this vacuous", () => {
    for (const anchor of [
      "const installQueue = [...firstEpoch, ...secondEpoch]",
      "const secondEpochStartsAt = firstEpoch.length",
      '"install.epoch.planned"',
      '"install.epoch.second.start"',
      '"install.epoch.second.activation-failed"',
      "readsPluginState",
      "isBaseGameMaster",
    ]) {
      expect(src, anchor).toContain(anchor);
    }
  });

  it("defers a mod only when waiting can change the answer", () => {
    /**
     * Three conditions, and each one removed would defer mods for nothing.
     * A base-game master is active from the start; a plugin this collection
     * does not order will never become active during the install; a mod that
     * names no plugin has no question to wait for.
     */
    const at = src.indexOf("const collectionPlugins = new Set(");
    expect(at).toBeGreaterThan(-1);
    const scope = src.slice(at, at + 1600);

    expect(scope).toContain("plan.manifest.plugins.order");
    // Base masters excluded — they are active before anything installs.
    expect(scope).toContain("!isBaseGameMaster(");
    // And the mod has to actually name one of them.
    expect(scope).toContain("collectionPlugins.has(");
  });

  it("walks ONE queue, so both epochs share one code path", () => {
    /**
     * A permutation, not a second loop. Every mod goes through the same
     * journalling, failure-streak, abort and progress rules — a second copy
     * of the install body is how the alongside and retry paths each drifted
     * from the first pass and had to be caught later.
     */
    expect(src).toContain("const resolution = installQueue[i]!;");
    // The old positional read is gone, so nothing can quietly bypass the
    // ordering by indexing the resolutions directly inside the loop.
    const loopAt = src.indexOf("for (let i = 0; i < total; i++) {");
    const loopEnd = src.indexOf("// ── 5a-verify", loopAt);
    expect(loopAt).toBeGreaterThan(-1);
    expect(loopEnd).toBeGreaterThan(loopAt);
    expect(src.slice(loopAt, loopEnd)).not.toContain(
      "plan.modResolutions[i]",
    );
  });

  it("activates the plugins at the boundary, and does not sort", () => {
    const at = src.indexOf('"install.epoch.second.start"');
    expect(at).toBeGreaterThan(-1);
    const scope = src.slice(Math.max(0, at - 2200), at);

    // Deploy makes the plugins exist; the pin makes them ACTIVE, and
    // `activeOnly` reads enablement rather than presence.
    expect(scope).toContain("await deployAndWait(api, activeProfileId)");
    expect(scope).toContain("await applyPluginOrder({");
    /**
     * No LOOT run here. This pin exists to activate plugins; the real
     * ordering pass runs later and re-pins after the sort, so sorting now
     * would spend a full LOOT pass on an order about to change again.
     */
    expect(scope).toContain("skipSort: true");
  });

  it("degrades to the old behaviour when the boundary fails", () => {
    /**
     * An optimisation must not be able to fail an install. If the deploy or
     * the pin throws, the deferred mods install anyway — an installer that
     * refuses lands in `failedMods` and the retry pass picks it up after the
     * real deploy, which is exactly what happened before this existed.
     */
    const at = src.indexOf('"install.epoch.second.activation-failed"');
    expect(at).toBeGreaterThan(-1);
    const scope = src.slice(at, at + 700);
    // A fragment that does not span a string concatenation. The prose is
    // wrapped across two literals in the source, so a longer phrase would
    // fail on the join rather than on the property.
    expect(scope).toContain("pass remains their safety net");
  });

  it("costs nothing when no mod defers", () => {
    // The overwhelming majority of collections. Guarded on both the boundary
    // and the log so an ordinary install pays for none of this.
    expect(src).toContain(
      "if (i === secondEpochStartsAt && secondEpoch.length > 0) {",
    );
    expect(src).toContain("if (secondEpoch.length > 0) {");
  });
});
