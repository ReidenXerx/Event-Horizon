/**
 * Restoring the KIND of mod, before the files go anywhere.
 *
 * `modType` decides the destination: default → Data, `dinput` → the game root,
 * which is where a script extender's loader has to be. Vortex derives the type
 * from the archive and is usually right, so this usually plans nothing.
 *
 * It is wrong for exactly the mods that hurt most. SSE Engine Fixes Part 2 is
 * loose binaries with no detectable shape, so a curator managing it through
 * Vortex sets the type by hand — and a hand-set choice cannot be re-derived.
 * On the user's machine detection answers "default" with full confidence, the
 * DLLs land in Data, every file verifies, and the game launches without the
 * fix.
 *
 * The old behaviour noticed this AFTER deploying and told the user to go and
 * fix it. Now the type is set first, so the single deploy is already correct.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  applyModTypeChanges,
  describeModTypeChanges,
  planModTypeChanges,
  readCurrentModTypes,
} from "./applyModTypes";
import type { EhcollMod } from "../../types/ehcoll";

const mod = (compareKey: string, name: string, modType?: string): EhcollMod =>
  ({ compareKey, name, state: { ...(modType !== undefined ? { modType } : {}) } }) as
    unknown as EhcollMod;

describe("planning the corrections", () => {
  it("restores a hand-set type detection cannot reproduce", () => {
    // The real case: Engine Fixes Part 2 installed as an ordinary mod here,
    // recorded as dinput on the curator's machine.
    const plan = planModTypeChanges({
      installed: new Map([["nexus:17230:2", "vortex-1"]]),
      currentTypes: new Map([["vortex-1", ""]]),
      manifestMods: [mod("nexus:17230:2", "SSE Engine Fixes Part 2", "dinput")],
    });
    expect(plan).toEqual([
      {
        name: "SSE Engine Fixes Part 2",
        vortexModId: "vortex-1",
        from: "",
        to: "dinput",
      },
    ]);
  });

  it("plans nothing when detection already agreed", () => {
    // SKSE is the common case: its archive is recognisable, so Vortex derives
    // dinput on its own and there is nothing to do.
    expect(
      planModTypeChanges({
        installed: new Map([["nexus:30379:1", "vortex-1"]]),
        currentTypes: new Map([["vortex-1", "dinput"]]),
        manifestMods: [mod("nexus:30379:1", "SKSE64", "dinput")],
      }),
    ).toEqual([]);
  });

  it("treats absent and empty as the same default type", () => {
    // A manifest that recorded nothing must not be read as "change this mod
    // to the empty type" — it is already the empty type.
    expect(
      planModTypeChanges({
        installed: new Map([["k", "vortex-1"]]),
        currentTypes: new Map([["vortex-1", ""]]),
        manifestMods: [mod("k", "Ordinary Mod")],
      }),
    ).toEqual([]);
  });

  it("ignores case and padding rather than churning the store", () => {
    expect(
      planModTypeChanges({
        installed: new Map([["k", "vortex-1"]]),
        currentTypes: new Map([["vortex-1", "dinput"]]),
        manifestMods: [mod("k", "X", " DInput ")],
      }),
    ).toEqual([]);
  });

  it("skips a mod this install never produced", () => {
    expect(
      planModTypeChanges({
        installed: new Map(),
        currentTypes: new Map(),
        manifestMods: [mod("k", "Not installed", "dinput")],
      }),
    ).toEqual([]);
  });

  it("would set a mod BACK to default, not only away from it", () => {
    // The correction is symmetric. A mod Vortex guessed as dinput that the
    // curator kept as a normal mod is equally wrong, and equally silent.
    const plan = planModTypeChanges({
      installed: new Map([["k", "vortex-1"]]),
      currentTypes: new Map([["vortex-1", "dinput"]]),
      manifestMods: [mod("k", "Guessed wrong", "")],
    });
    expect(plan[0]!.to).toBe("");
    expect(plan[0]!.from).toBe("dinput");
  });
});

describe("applying them", () => {
  const api = (): { store: { dispatch: ReturnType<typeof vi.fn> } } => ({
    store: { dispatch: vi.fn() },
  });

  it("dispatches setModType with the curator's value", () => {
    const a = api();
    const setModType = vi.fn((g: string, m: string, t: string) => ({ g, m, t }));
    const applied = applyModTypeChanges(
      a as never,
      "skyrimse",
      [{ name: "X", vortexModId: "vortex-1", from: "", to: "dinput" }],
      { setModType },
    );
    expect(setModType).toHaveBeenCalledWith("skyrimse", "vortex-1", "dinput");
    expect(a.store.dispatch).toHaveBeenCalledTimes(1);
    expect(applied).toHaveLength(1);
  });

  it("keeps going when one mod is refused", () => {
    // Unrelated mods. The ones that succeed are still worth having.
    const a = api();
    const setModType = vi.fn((_g: string, m: string) => {
      if (m === "bad") throw new Error("nope");
      return {};
    });
    const applied = applyModTypeChanges(
      a as never,
      "skyrimse",
      [
        { name: "Bad", vortexModId: "bad", from: "", to: "dinput" },
        { name: "Good", vortexModId: "good", from: "", to: "dinput" },
      ],
      { setModType },
    );
    expect(applied.map((c) => c.vortexModId)).toEqual(["good"]);
  });
});

describe("reading current types", () => {
  it("returns nothing rather than throwing on unreadable state", () => {
    // Failing to correct a type is a warning later. Throwing here would take
    // down an install that was otherwise fine.
    const api = {
      getState: () => {
        throw new Error("no state");
      },
    };
    expect(readCurrentModTypes(api as never, "skyrimse").size).toBe(0);
  });

  it("reads an absent type as the default rather than skipping the mod", () => {
    const api = {
      getState: () => ({
        persistent: { mods: { skyrimse: { a: {}, b: { type: "dinput" } } } },
      }),
    };
    const types = readCurrentModTypes(api as never, "skyrimse");
    expect(types.get("a")).toBe("");
    expect(types.get("b")).toBe("dinput");
  });
});

describe("what the user is told", () => {
  it("explains why a mod is outside Data", () => {
    const text = describeModTypeChanges([
      { name: "Engine Fixes Part 2", vortexModId: "1", from: "", to: "dinput" },
    ]).join("\n");
    expect(text).toMatch(/beside the game executable/i);
    expect(text).toContain("Engine Fixes Part 2");
  });

  it("says nothing when nothing was corrected", () => {
    expect(describeModTypeChanges([])).toEqual([]);
  });
});

describe("the driver sets types BEFORE it deploys", () => {
  // Ordering is the whole value and it breaks silently: run the restore after
  // the deploy and every file is already linked into the wrong folder, which
  // is exactly the behaviour this replaced. No unit test can see that, so the
  // source order is asserted directly.
  const src = readFileSync(join(__dirname, "runInstall.ts"), "utf8");

  /**
   * The deploy CALL, matched without its argument list.
   *
   * This was pinned as the literal `await deployAndWait(api);` and broke when
   * the function gained a second parameter — a change that did not touch the
   * ordering these tests exist to protect. The anchor is the call; its
   * arguments are not the property under test.
   */
  const DEPLOY_CALL = "await deployAndWait(";

  it("finds both anchors it claims to compare", () => {
    expect(src).toContain("applyModTypeChanges(");
    expect(src).toContain(DEPLOY_CALL);
  });

  it("restores the curator's types before EVERY deploy, not just the first", () => {
    /**
     * Strengthened after this test caught a real one. It used to compare the
     * FIRST index of each, which says nothing about a deploy added later —
     * and the second-epoch boundary added one ~1,300 lines above the modType
     * phase, so mods would have been linked with Vortex's derived type before
     * the curator's was restored. SSE Engine Fixes Part 2 is loose binaries
     * typed `dinput`: deployed as default, its DLLs land in `Data` where
     * nothing loads them, and every file check still passes.
     *
     * The invariant was never "the first deploy" — it is that no deploy
     * happens with the types unset. There is more than one now.
     */
    const deploys: number[] = [];
    for (let at = src.indexOf(DEPLOY_CALL); at !== -1; ) {
      deploys.push(at);
      at = src.indexOf(DEPLOY_CALL, at + 1);
    }
    // Proves the scan found something, so an empty loop cannot pass silently.
    expect(deploys.length).toBeGreaterThanOrEqual(2);

    for (const deployAt of deploys) {
      const typesBefore = src.lastIndexOf("applyModTypeChanges(", deployAt);
      expect(
        typesBefore,
        `a deployAndWait at offset ${deployAt} has no applyModTypeChanges ` +
          `before it — those mods would deploy with Vortex's derived modType`,
      ).toBeGreaterThan(-1);
    }
  });

  it("still checks for leftovers after the deploy", () => {
    // The post-deploy check keeps its job; its meaning is now "this machine
    // refused the type", not "nobody tried to set it".
    expect(src.indexOf(DEPLOY_CALL)).toBeLessThan(
      src.indexOf("findModTypeMismatches({"),
    );
  });
});
