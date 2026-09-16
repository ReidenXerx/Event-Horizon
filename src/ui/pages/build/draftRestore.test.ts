/**
 * Opening a saved build draft, through the real session: the per-mod decisions
 * on the form are the config's, not the draft's copy.
 *
 * The unit is draftOverrides.ts; this proves `begin` uses it, because a helper
 * that is right and never called is exactly how the RobCo entry came back.
 */
import { describe, expect, it, vi } from "vitest";

const loadBuildContext = vi.fn();
vi.mock("./engine", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, loadBuildContext: (...a: unknown[]) => loadBuildContext(...a) };
});
const loadDraft = vi.fn();
vi.mock("../../../core/draftStorage", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, loadDraft: (...a: unknown[]) => loadDraft(...a) };
});

import { BuildSession } from "./buildSession";

const ROBCO = "Reapers Robco Munitions Patches-69882-5-2-1759089401";
const UFO4P = "Unofficial Fallout 4 Patch-4598-2-1-5-1679096028";
const bundled = (name: string) => ({ name, bundled: true, treatAsExternal: true });

describe("restoring a build draft", () => {
  it("opens with the config's per-mod decisions, not the draft's older copy", async () => {
    loadBuildContext.mockResolvedValue({
      gameId: "fallout4",
      profileId: "p1",
      mods: [],
      scopeWarnings: [],
      rootFolderReview: [],
      detectedDependencies: [],
      externalMods: [],
      externalHints: new Map(),
      collectionConfig: { schemaVersion: 1, packageId: "p", externalMods: { [UFO4P]: bundled(UFO4P) } },
      configPath: "/cfg/.config/ivy-panties.json",
      configCreated: false,
      defaultName: "ivy panties",
      defaultVersion: "1.0.31",
      defaultAuthor: "DuduPhudu",
      gameVersion: "1.10.163.0",
    });
    loadDraft.mockResolvedValue({
      savedAt: "2026-09-16T12:19:06.986Z",
      payload: {
        draftId: "d-ivy",
        curator: { name: "ivy panties", version: "1.0.29", author: "DuduPhudu", description: "", gameVersion: "1.10.163.0" },
        overrides: { [UFO4P]: bundled(UFO4P), [ROBCO]: bundled(ROBCO) },
        readme: "",
        changelog: "",
      },
    });

    const s = new BuildSession({
      draftId: "d-ivy",
      gameId: "fallout4",
      hooks: {
        enqueueBuild: () => undefined,
        releaseBuild: () => undefined,
        cancelQueued: () => undefined,
        notifyStateChanged: () => undefined,
      },
    } as never);
    s.begin({} as never);
    const state = (): Record<string, unknown> => (s as unknown as { state: Record<string, unknown> }).state;
    for (let i = 0; i < 50 && state().kind !== "form"; i++) await new Promise((r) => setTimeout(r, 10));

    expect(state().kind).toBe("form");
    expect(Object.keys(state().overrides as object)).toEqual([UFO4P]);
    // The rest of the draft is still restored: this is not a discard.
    expect((state().curator as { version: string }).version).toBe("1.0.29");
  });
});
