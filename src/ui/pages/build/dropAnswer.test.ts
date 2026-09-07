/**
 * ──────────────────────────────────────────────────────────────────────
 * The fourth answer: leave this mod out.
 *
 * The other three all describe HOW to deliver a mod. Some mods should not be
 * delivered at all, and the build already knew it: on a real 1,755-mod
 * collection one mod staged a single 74-byte placeholder — the curator's own
 * copy was empty — so it contributed nothing to the game, and reproducing it
 * meant asking a stranger to complete a FOMOD that produces no files, which
 * Vortex fails outright.
 *
 * `shipsNothing` detected that shape and the screen rendered a paragraph
 * saying the useful answer was to remove the mod. Then it offered mirror,
 * declare and bundle — all three of which faithfully ship the placeholder.
 * The curator answered "declare", correctly for the question posed, and every
 * user's install stopped on it anyway.
 * ──────────────────────────────────────────────────────────────────────
 */
import { describe, expect, it } from "vitest";

import { describeChoice, overrideForChoice } from "./postProcessingDecision";
import {
  applyPostProcessedDeclarations,
  type CollectionConfig,
} from "./engine";
import { choiceFromEntry } from "../../../core/manifest/collectionConfig";
import type { AuditorMod } from "../../../core/getModsListForProfile";

const config = (
  externalMods: Record<string, Record<string, unknown>>,
): CollectionConfig => ({ externalMods } as never);

const mod = (id: string): AuditorMod => ({ id, name: id } as never);

describe("drop", () => {
  it("clears every other answer, so it cannot ship by a stale flag", () => {
    /**
     * The scar this repeats: answering "declare" on a mod already carrying
     * `mirrored: true` once left mirroring in place, and the package shipped
     * a whole staging folder the curator had just declined. Drop must not
     * repeat it in the other direction — a dropped mod that is still marked
     * bundled would ship despite the answer.
     */
    expect(overrideForChoice("drop", { isNexusMod: true })).toMatchObject({
      dropped: true,
      mirrored: false,
      bundled: false,
      postProcessed: false,
    });
  });

  it("outranks the other answers when read back", () => {
    // A dropped mod is not "a bundled mod that is also dropped". Reading it
    // as bundle would ship it.
    expect(choiceFromEntry({ dropped: true, bundled: true } as never)).toBe(
      "drop",
    );
  });

  it("removes the mod from the build", () => {
    const kept = applyPostProcessedDeclarations(
      [mod("keep-me"), mod("drop-me")],
      config({ "drop-me": { dropped: true } }),
    );
    expect(kept.map((m) => m.id)).toEqual(["keep-me"]);
  });

  it("leaves every other mod alone", () => {
    // The filter runs over the whole profile, so an off-by-one here would
    // silently shrink a 1,755-mod collection.
    const kept = applyPostProcessedDeclarations(
      [mod("a"), mod("b"), mod("c")],
      config({}),
    );
    expect(kept.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("says it does NOT touch the curator's own Vortex", () => {
    /**
     * Next to three buttons that ship files, "drop" reads like deletion. A
     * curator unsure whether they are about to lose a mod picks one of the
     * other three — which is exactly how the placeholder mod got answered
     * "declare" and shipped.
     */
    const copy = describeChoice("drop", 1);
    expect(copy.consequence).toMatch(/your own Vortex is untouched/i);
    expect(copy.consequence).toMatch(/keep the mod/i);
  });
});
