/**
 * Remembered local files pre-fill only the mods this plan still asks a file for.
 *
 * ─── THE RUN THIS COMES FROM ────────────────────────────────────────────────
 * A player updating Ivy's Panties to 1.0.28 (2026-09-15) had answered external
 * mods on an earlier version. The memory is kept per collection, keyed by each
 * mod's compareKey, and 1.0.28 had updated or dropped three of those mods, so
 * their keys matched nothing in the new plan. The decisions screen pre-filled
 * them anyway, and preflight refused the whole 978-mod install:
 *
 *   Plan contains 3 invalid conflictChoice(s): stray conflictChoice key
 *   "external:staging:ec638def…" matches no mod in the plan; …
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../core/installer/sourceMemory", () => ({
  readSourceMemory: async () => ({}),
  usableSources: async () => ({
    "external:asks": { path: "C:/still-asked.7z" },
    "external:old-version": { path: "C:/older-version.7z" },
    "external:installed": { path: "C:/already-installed.7z" },
  }),
  rememberSource: async () => undefined,
}));

vi.mock("../../../core/installer/runInstall", () => ({
  runInstall: () => new Promise(() => undefined),
  buildAbortedResult: () => ({ kind: "aborted" }),
}));

import { getInstallSession } from "./installSession";

describe("pre-filling remembered local files", () => {
  it("fills only the mods this plan still asks a file for", async () => {
    const s = getInstallSession();
    const plan = {
      modResolutions: [
        { compareKey: "external:asks", name: "Still asked", decision: { kind: "external-prompt-user" } },
        {
          compareKey: "external:installed",
          name: "Already installed",
          decision: { kind: "external-already-installed" },
        },
      ],
      manifest: { package: { id: "ivy", name: "Ivy" }, game: { id: "fallout4" } },
    };
    (s as unknown as { state: unknown }).state = {
      kind: "preview",
      bundle: { plan, appDataPath: "C:/appdata", zipPath: "C:/ivy.zip", ehcoll: {} },
    };

    s.openDecisionsFromPreview();

    const choices = (): Record<string, unknown> =>
      (s as unknown as { state: { conflictChoices?: Record<string, unknown> } }).state
        .conflictChoices ?? {};
    await vi.waitFor(() => expect(choices()["external:asks"]).toBeDefined());
    // Give any further pre-fill a chance to land before asserting its absence.
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));

    expect(choices()).toEqual({
      "external:asks": { kind: "use-local-file", localPath: "C:/still-asked.7z" },
    });
  });
});
