/**
 * The alongside install must happen BEFORE the mod-id map is built.
 *
 * ─── WHY THIS IS A TEST AND NOT A COMMENT ───────────────────────────────────
 * When a mirrored mod is one the user already owns, Event Horizon installs the
 * curator's copy beside theirs and swaps `installedMods[i]` to point at ours.
 * Four later phases resolve their target through `buildPostInstallModIdMap` —
 * mod rules, INI tweaks, the modType restore and the Vortex LoadOrder dispatch
 * — so if the swap happens after the map is built, all four land on the mod we
 * are about to DISABLE, and our own copy gets none of them.
 *
 * That is what shipped. It was silent in every direction: the rules were
 * counted as applied, the INI tweak was enabled on a disabled mod, the
 * `dinput` modType went to the user's mod permanently (in all their profiles)
 * while ours deployed loose DLLs into `Data` where nothing loads them — and
 * every file check still passed.
 *
 * A behavioural test would need a mirrored mod, a user-owned duplicate, and an
 * obtainable curator archive driven through the whole driver; that fixture
 * does not exist yet. This asserts the one property that makes the difference,
 * and it fails loudly if someone moves either half back.
 */
import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.join(__dirname, "runInstall.ts"),
  "utf8",
);

describe("phase ordering around the alongside install", () => {
  it("has both anchors, so a rename cannot make this test vacuous", () => {
    // A source-text test that silently stops matching is worse than none: it
    // goes green forever. Prove the things we are locating actually exist.
    expect(source).toContain("tryInstallAlongside({");
    expect(source).toContain("buildPostInstallModIdMap(");
  });

  it("installs our copy before the map every later phase resolves through", () => {
    const firstAlongside = source.indexOf("tryInstallAlongside({");
    const mapBuild = source.indexOf("buildPostInstallModIdMap(\n      installedMods,");

    expect(firstAlongside).toBeGreaterThan(-1);
    expect(mapBuild).toBeGreaterThan(-1);
    expect(firstAlongside).toBeLessThan(mapBuild);
  });

  it("no longer installs anything from inside the mirror loop", () => {
    /**
     * The mirror phase reconciles BYTES. Once it also installed mods, the
     * ordering above was impossible to keep — so the loop must not regrow a
     * call. `install.mirror.skipped-not-ours` is what it does instead when a
     * mod is still not ours by then.
     */
    const mirrorPhase = source.indexOf('"install.mirror.phase.start"');
    expect(mirrorPhase).toBeGreaterThan(-1);
    expect(source.indexOf("tryInstallAlongside({", mirrorPhase)).toBe(-1);
    expect(source).toContain('"install.mirror.skipped-not-ours"');
  });
});
