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
 * ─── AND WHY THE RETRY PASS IS NOT ENOUGH ───────────────────────────────────
 * Refusing is loud, so the retry rescues it. The SAME `<fileDependency>` in a
 * step's `<visible>` or a `<conditionalFileInstalls>` pattern does not refuse:
 * it takes a different branch and installs a different FILE SET, with nothing
 * failing — so nothing retries. A population discovered by letting mods FAIL
 * can never contain the ones that do not fail.
 *
 * Measured on the real 978-mod collection: 96 archives carry a FOMOD, 27 ask
 * the game about a plugin, 21 name one the collection itself ships. Exactly
 * ONE of those 21 was the loud kind. The other twenty are patch hubs.
 *
 * ─── WHY MOST OF THIS FILE IS NOW A REAL TEST ───────────────────────────────
 * The split used to live inside the driver, so these could only be source-text
 * guards. It is a decision about a plan, computed from the manifest alone, so
 * it moved to `core/resolver/installEpochs.ts` — and a decision in a pure
 * function can simply be RUN. Only the orchestration half is still pinned by
 * reading the source, because entering `runInstallImpl` from a test needs a
 * fixture that does not exist yet.
 */
import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

import {
  describeInstallEpochs,
  planInstallEpochs,
} from "../resolver/installEpochs";
import type { EhcollManifest } from "../../types/ehcoll";

const src = fs.readFileSync(path.join(__dirname, "runInstall.ts"), "utf8");

/** A manifest with just enough shape for the split to be computable. */
const manifest = (
  mods: { name: string; reads?: string[] }[],
  pluginNames: string[],
): EhcollManifest =>
  ({
    game: { id: "fallout4" },
    plugins: { order: pluginNames.map((name) => ({ name, enabled: true })) },
    mods: mods.map((m, i) => ({
      compareKey: `nexus:${i}:${i}`,
      name: m.name,
      install: {
        fomodSelections: [],
        ...(m.reads !== undefined ? { readsPluginState: m.reads } : {}),
      },
    })),
  }) as unknown as EhcollManifest;

describe("which mods have to wait", () => {
  it("defers a mod waiting on a plugin this collection ships", () => {
    // The measured case: FO4HHS names aaf.esm, and AAF is in the collection.
    const epochs = planInstallEpochs(
      manifest([{ name: "FO4HHS", reads: ["aaf.esm"] }], ["aaf.esm"]),
    );

    expect(epochs.second).toHaveLength(1);
    expect(epochs.deferred[0]?.waitsFor).toEqual(["aaf.esm"]);
  });

  it("does NOT defer for a base-game master", () => {
    /**
     * `Fallout4.esm` is active before anything installs, so waiting changes
     * nothing and costs the mod its position. Real mods name it: "Rufgt's Old
     * Animations" reads exactly `fallout4.esm` and must not defer.
     */
    const epochs = planInstallEpochs(
      manifest(
        [{ name: "Rufgt's Old Animations", reads: ["fallout4.esm"] }],
        ["fallout4.esm", "something.esp"],
      ),
    );

    expect(epochs.second).toEqual([]);
    expect(epochs.first).toHaveLength(1);
  });

  it("does NOT defer for a plugin nobody here ships", () => {
    /**
     * The mirror image. "Optimized Vanilla Tree LODs" asks about four
     * seasonal-tree plugins this collection does not contain — waiting will
     * not make them active, so deferring buys nothing.
     */
    const epochs = planInstallEpochs(
      manifest(
        [{ name: "Optimized Vanilla Tree LODs", reads: ["a forest.esp"] }],
        ["unrelated.esp"],
      ),
    );

    expect(epochs.second).toEqual([]);
  });

  it("waits only for the plugins that matter, not everything named", () => {
    /**
     * Scripts name dozens. "Weapon Level List Patches FOMOD" reads over three
     * hundred plugins and only eight are shipped here — reporting all of them
     * would bury the reason.
     */
    const epochs = planInstallEpochs(
      manifest(
        [{ name: "Patch Hub", reads: ["mine.esp", "theirs.esp", "fallout4.esm"] }],
        ["mine.esp", "fallout4.esm"],
      ),
    );

    expect(epochs.deferred[0]?.waitsFor).toEqual(["mine.esp"]);
  });

  it("leaves the ordinary collection entirely alone", () => {
    // 786 of 978 mods have no FOMOD at all. The second epoch has to be empty
    // for them, or every install pays for a deploy and a plugin write.
    const epochs = planInstallEpochs(
      manifest([{ name: "A" }, { name: "B" }, { name: "C" }], ["x.esp"]),
    );

    expect(epochs.second).toEqual([]);
    expect(epochs.first).toHaveLength(3);
    expect(describeInstallEpochs(epochs)).toEqual([]);
  });

  it("keeps manifest order inside each epoch", () => {
    // The order is `installOrder` ascending and deliberate — the split may
    // move a mod between epochs, never past its neighbours within one.
    const epochs = planInstallEpochs(
      manifest(
        [
          { name: "A" },
          { name: "B", reads: ["p.esp"] },
          { name: "C" },
          { name: "D", reads: ["p.esp"] },
        ],
        ["p.esp"],
      ),
    );

    expect(epochs.first).toEqual(["nexus:0:0", "nexus:2:2"]);
    expect(epochs.second).toEqual(["nexus:1:1", "nexus:3:3"]);
  });

  it("says what is waiting and why, before anything installs", () => {
    // The dry run. Selecting a package reports this without touching a thing.
    const lines = describeInstallEpochs(
      planInstallEpochs(
        manifest([{ name: "Patch Hub", reads: ["aaf.esm"] }], ["aaf.esm"]),
      ),
    );

    expect(lines.join(" ")).toMatch(/second pass/i);
    expect(lines.join(" ")).toMatch(/Patch Hub.*waits for aaf\.esm/);
    // And it names the consequence, which is the part nobody would guess.
    expect(lines.join(" ")).toMatch(/missing compatibility patch/i);
  });
});

describe("how the driver runs the two epochs", () => {
  it("has every anchor it locates, so a rename cannot make this vacuous", () => {
    for (const anchor of [
      "const epochs = planInstallEpochs(plan.manifest)",
      "const installQueue = [...firstEpoch, ...secondEpoch]",
      "const secondEpochStartsAt = firstEpoch.length",
      '"install.epoch.second.start"',
      '"install.epoch.second.activation-failed"',
    ]) {
      expect(src, anchor).toContain(anchor);
    }
  });

  it("uses the SAME decision the plan reported, not a second copy", () => {
    /**
     * A private re-derivation in the driver is how the dry run and the real
     * install would come to disagree — and a dry run that disagrees with the
     * install is worse than none. This repo has paid for a duplicated rule
     * twice already (`gateOnMasters`, `resolveBundledArchives`).
     */
    expect(src).toContain("planInstallEpochs(plan.manifest)");
    expect(src).not.toContain("!isBaseGameMaster(");
  });

  it("walks ONE queue, so both epochs share one code path", () => {
    // A permutation, not a second loop: one set of journalling, failure-streak
    // and abort rules. A second copy of the install body is how the alongside
    // and retry paths each drifted and had to be caught later.
    expect(src).toContain("const resolution = installQueue[i]!;");
    const loopAt = src.indexOf("for (let i = 0; i < total; i++) {");
    const loopEnd = src.indexOf("// ── 5a-verify", loopAt);
    expect(loopEnd).toBeGreaterThan(loopAt);
    expect(src.slice(loopAt, loopEnd)).not.toContain("plan.modResolutions[i]");
  });

  it("activates the plugins at the boundary, and does not sort", () => {
    const at = src.indexOf('"install.epoch.second.start"');
    expect(at).toBeGreaterThan(-1);
    const scope = src.slice(Math.max(0, at - 2200), at);

    // Deploy makes the plugins exist; the pin makes them ACTIVE, and
    // `activeOnly` reads enablement rather than presence.
    expect(scope).toContain("await deployAndWait(api, activeProfileId)");
    expect(scope).toContain("await applyPluginOrder({");
    // No LOOT run — the real ordering pass re-pins after the sort later.
    expect(scope).toContain("skipSort: true");
  });

  it("degrades to the old behaviour when the boundary fails", () => {
    // An optimisation must not be able to fail an install: the deferred mods
    // install anyway, and the retry pass is still their net.
    const at = src.indexOf('"install.epoch.second.activation-failed"');
    expect(at).toBeGreaterThan(-1);
    // A fragment that does not span a string concatenation — the prose is
    // wrapped across two literals in the source.
    expect(src.slice(at, at + 700)).toContain("pass remains their safety net");
  });

  it("costs nothing when no mod defers", () => {
    expect(src).toContain(
      "if (i === secondEpochStartsAt && secondEpoch.length > 0) {",
    );
    expect(src).toContain("if (secondEpoch.length > 0) {");
  });
});
