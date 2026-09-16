/**
 * A restored build draft must not bring back a per-mod decision the config no
 * longer holds.
 *
 * The regression, 2026-09-16: RobCo's bundling entry was removed from
 * ivy-panties.json by owner decision, the next build restored it from a draft
 * saved that morning, and Ivy 1.0.30 went to Nexus with RobCo bundled again.
 */
import { describe, expect, it, vi } from "vitest";

import { overridesForRestoredDraft } from "./draftOverrides";

const ROBCO = "Reapers Robco Munitions Patches-69882-5-2-1759089401";
const UFO4P = "Unofficial Fallout 4 Patch-4598-2-1-5-1679096028";
const bundled = (name: string) => ({ name, bundled: true, treatAsExternal: true });

describe("a restored draft's per-mod decisions", () => {
  it("come from the config, so an entry removed after the draft was saved stays removed", async () => {
    const readConfigOverrides = vi.fn();
    const restored = await overridesForRestoredDraft({
      draftName: "ivy panties",
      draftOverrides: { [UFO4P]: bundled(UFO4P), [ROBCO]: bundled(ROBCO) },
      contextConfigPath: "C:/Users/x/AppData/Roaming/Vortex/event-horizon/collections/.config/ivy-panties.json",
      contextOverrides: { [UFO4P]: bundled(UFO4P) },
      readConfigOverrides,
    });
    expect(Object.keys(restored.overrides)).toEqual([UFO4P]);
    expect(restored.ignoredDraftEntries).toEqual([ROBCO]);
    expect(restored.source).toBe("context config");
    expect(readConfigOverrides).not.toHaveBeenCalled();
  });

  it("take a changed entry from the config, not the draft", async () => {
    const restored = await overridesForRestoredDraft({
      draftName: "ivy panties",
      draftOverrides: { [UFO4P]: { name: UFO4P, bundled: false } },
      contextConfigPath: "/cfg/ivy-panties.json",
      contextOverrides: { [UFO4P]: bundled(UFO4P) },
      readConfigOverrides: async () => undefined,
    });
    expect(restored.overrides[UFO4P]).toEqual(bundled(UFO4P));
    expect(restored.ignoredDraftEntries).toEqual([UFO4P]);
  });

  it("come from the draft's OWN collection when the context loaded another one", async () => {
    // The context loads the collection built most recently for the game; a
    // draft for a different collection must not get that one's decisions.
    const read = vi.fn(async (slug: string) => (slug === "ivy-2" ? { [UFO4P]: bundled(UFO4P) } : undefined));
    const restored = await overridesForRestoredDraft({
      draftName: "Ivy - 2",
      draftOverrides: { [ROBCO]: bundled(ROBCO) },
      contextConfigPath: "/cfg/ivy-panties.json",
      contextOverrides: { "something-else": bundled("something-else") },
      readConfigOverrides: read,
    });
    expect(read).toHaveBeenCalledWith("ivy-2");
    expect(Object.keys(restored.overrides)).toEqual([UFO4P]);
    expect(restored.source).toBe("draft's collection config");
  });

  it("keep the draft's copy only for a collection that has no config yet", async () => {
    const restored = await overridesForRestoredDraft({
      draftName: "Brand New",
      draftOverrides: { [ROBCO]: bundled(ROBCO) },
      contextConfigPath: "/cfg/ivy-panties.json",
      contextOverrides: {},
      readConfigOverrides: async () => undefined,
    });
    expect(Object.keys(restored.overrides)).toEqual([ROBCO]);
    expect(restored.source).toBe("draft");
  });
});
