/**
 * A mod recovered by the retry pass must receive the per-mod finishing work
 * every other mod got.
 *
 * ─── WHY THIS IS A TEST AND NOT A COMMENT ───────────────────────────────────
 * `buildPostInstallModIdMap` is built ONCE, and every per-mod phase resolves
 * its target through it: mod rules, the LOOT userlist, INI tweaks, the modType
 * restore, the mirror, the ESL flag repair. All of them run before the deploy.
 * The retry pass runs AFTER the deploy — that is the whole point of it, because
 * the installers it recovers are the ones that demanded an active plugin — so
 * it pushes into `installedMods` roughly 1,200 lines past the map, and the mods
 * it recovers used to receive none of that work.
 *
 * It was silent in every direction that matters. The worst case is the one the
 * modType phase exists for: SSE Engine Fixes Part 2 is loose binaries with a
 * curator-set `dinput` type that deploys to the game ROOT. Without the restore
 * its DLLs land in `Data`, nothing loads them, and every file check passes.
 *
 * This is the same defect `alongsideOrdering.test.ts` was written to prevent,
 * arriving from the other end: that test pins the ALONGSIDE install above the
 * map, and by construction cannot see a SECOND install site below every
 * consumer of it.
 *
 * FIXTURE-DEBT: a behavioural test needs a driver run where a mod fails its
 * first install, succeeds on the second, and carries a curator modType — which
 * means `fakeVortex` has to fail one named mod once and then succeed. It can
 * fail all installs today, not one. Until that exists, this asserts the
 * properties that make the difference, and it is written to fail loudly rather
 * than go vacuous if someone moves either half.
 */
import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.join(__dirname, "runInstall.ts"), "utf8");

/** The retry pass's own marker — everything below it is the catch-up. */
const retryStart = source.indexOf('"install.retry.start"');
const after = (needle: string): number => source.indexOf(needle, retryStart);

describe("what the retry pass does with the mods it recovers", () => {
  it("has every anchor it locates, so a rename cannot make this vacuous", () => {
    /**
     * GP-7. A source-text test that silently stops matching is worse than
     * none — it goes green forever and reports coverage it does not have. Every
     * string this file searches for is proven to exist first.
     */
    expect(retryStart).toBeGreaterThan(-1);
    for (const anchor of [
      "recoveredKeys",
      "recoveredIds",
      "recoveredManifestMods",
      '"install.retry.finished-mods"',
      "mirrorOneMod",
      "applyModTypeChanges(",
      "applyIniTweaks({",
      "applyModRules({",
      "repinCuratorOrder(",
    ]) {
      expect(source).toContain(anchor);
    }
  });

  it("replays the modType restore for exactly the recovered mods", () => {
    /**
     * The one whose absence is both silent and game-breaking. Scoped, not
     * global: re-running it over every mod would re-dispatch work the first
     * pass already did.
     */
    const call = after("applyModTypeChanges(");
    expect(call).toBeGreaterThan(-1);
    const scope = source.slice(call, call + 400);
    expect(scope).toContain("installed: recoveredIds");
    expect(scope).toContain("manifestMods: recoveredManifestMods");
  });

  it("replays the INI tweaks for exactly the recovered mods", () => {
    const call = after("applyIniTweaks({");
    expect(call).toBeGreaterThan(-1);
    const scope = source.slice(call, call + 300);
    expect(scope).toContain("installed: recoveredIds");
    expect(scope).toContain("manifestMods: recoveredManifestMods");
  });

  it("mirrors a recovered mod through the SAME function the main loop uses", () => {
    /**
     * Not a second copy of the mirror body. `planMirror`'s delete arm is the
     * only code here that removes a user's files (NS-2), and a divergent
     * second implementation of it is exactly the shape this repo has paid for
     * twice — `resolveBundledArchives` and `gateOnMasters` were both extracted
     * after two copies drifted apart.
     */
    expect(source).toContain("const mirrorOneMod = async (");
    // Called by the main 6c loop...
    const firstCall = source.indexOf("await mirrorOneMod(mod);");
    expect(firstCall).toBeGreaterThan(-1);
    expect(firstCall).toBeLessThan(retryStart);
    // ...and again, below the retry, for the recovered ones.
    expect(source.indexOf("await mirrorOneMod(mod);", retryStart)).toBeGreaterThan(
      retryStart,
    );
  });

  it("gives every recovered mod a verification row", () => {
    /**
     * The verify pass ran before these mods existed, so there is no verdict —
     * but an ABSENT row is indistinguishable from a check that lost one, and
     * "978 installed, 977 verified" is what a support conversation reads first.
     */
    const row = after('reason: "recovered-after-verification"');
    expect(row).toBeGreaterThan(retryStart);
  });

  it("re-pins the order the way 7b1 does, instead of asking LOOT to re-sort", () => {
    /**
     * ─── THE REGRESSION ────────────────────────────────────────────────
     * The retry called `applyPluginOrder` with the raw manifest order and no
     * `skipSort`, which emits `autosort-plugins` — a full LOOT re-sort, i.e.
     * precisely the operation the 7b1 re-pin exists to undo. On a real run
     * that re-pin had just taken 686 misordered plugins to zero, and nothing
     * re-measured afterwards, so the receipt reported the clean number for a
     * file LOOT had since rewritten.
     */
    const repin = after("repinCuratorOrder(");
    expect(repin).toBeGreaterThan(retryStart);
    const scope = source.slice(repin, repin + 2600);
    expect(scope).toContain("skipSort: true");
    // The plugin's REAL flag, never a fabricated `true` — asserting `true`
    // switches a curator-disabled plugin back on and writes it to disk.
    expect(scope).toContain("enabledAfter.get(name.toLowerCase()) ?? true");
    // And re-measured from disk, because a number nobody re-checked after a
    // write is not a measurement.
    expect(scope).toContain('"plugins.order-drift.after-retry"');
  });

  it("honours a Stop that lands mid-retry", () => {
    /**
     * The per-mod loop was abort-aware and its TAIL was not, so a Stop was
     * respected for the remaining mods and then ignored for the deploy and the
     * plugins.txt write — the run reporting that it had honoured the stop
     * while rewriting the load order after it.
     */
    const guard = source.indexOf(
      'retriedOk > 0 && !stopBeforeWriting("finishing the retried mods")',
    );
    expect(guard).toBeGreaterThan(retryStart);
    // And it says so rather than going quiet.
    expect(source).toContain('"install.retry.finishing-skipped"');
  });
});
