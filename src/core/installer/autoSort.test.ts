/**
 * Vortex sorts plugins with LOOT automatically, and it is ON BY DEFAULT —
 * `settings.plugins.autoSort` is initialised `true` in Vortex's own bundle.
 *
 * That silently replaces the curator's load order with LOOT's: during the run,
 * and again every time the user deploys or enables a plugin afterwards. Every
 * file still verifies and the game still starts; it simply loads a different
 * order than the curator tested, which is the one thing this tool exists to
 * get right.
 *
 * So it is gated like auto-deployment — offered, not done, and left off.
 */
import { describe, expect, it } from "vitest";

import {
  ACTION_SET_AUTOSORT_ENABLED,
  blocksInstall,
  describeAutoSortBlock,
  readsAutoSort,
} from "./autoSort";

describe("reading Vortex's autoSort setting", () => {
  it("reads settings.plugins.autoSort, the path Vortex actually uses", () => {
    expect(readsAutoSort({ settings: { plugins: { autoSort: true } } })).toBe(true);
    expect(readsAutoSort({ settings: { plugins: { autoSort: false } } })).toBe(false);
  });

  it("is undefined — not false — when it cannot be read", () => {
    // "We could not tell" and "it is off" are different facts, and only one of
    // them is a reason to say nothing to the user.
    expect(readsAutoSort({})).toBeUndefined();
    expect(readsAutoSort(undefined)).toBeUndefined();
    expect(readsAutoSort({ settings: { plugins: {} } })).toBeUndefined();
    expect(readsAutoSort({ settings: { plugins: { autoSort: "yes" } } })).toBeUndefined();
  });
});

describe("when the install stops to ask", () => {
  it("asks only when sorting is definitely ON", () => {
    expect(blocksInstall({ settings: { plugins: { autoSort: true } } })).toBe(true);
  });

  it("does NOT interrupt when it is off, or unreadable", () => {
    /**
     * Fail open, the same rule the deployment and auto-deploy gates use.
     * Refusing to start a working install because a check could not run does
     * more damage than the thing it guards against.
     */
    expect(blocksInstall({ settings: { plugins: { autoSort: false } } })).toBe(false);
    expect(blocksInstall({})).toBe(false);
    expect(blocksInstall(undefined)).toBe(false);
  });
});

describe("what the user is asked", () => {
  it("names the consequence, not the setting", () => {
    // "Autosort" means nothing to someone who never turned it on. What they
    // care about is whether the collection plays the way the curator built it.
    const d = describeAutoSortBlock(1606);
    expect(d.body).toMatch(/1606 plugin\(s\)/);
    expect(d.body).toMatch(/curator/i);
    expect(d.body).toMatch(/on by default/i);
    // And that it is reversible, so agreeing is not a leap.
    expect(d.body).toMatch(/re-enable it in Vortex/i);
    expect(d.confirm).toMatch(/turn it off/i);
    expect(d.decline).toMatch(/leave it on/i);
  });

  it("reads sensibly when the plugin count is unknown", () => {
    expect(describeAutoSortBlock(0).body).toMatch(/this collection's plugins/);
    expect(describeAutoSortBlock(0).body).not.toMatch(/0 plugin/);
  });

  it("uses the action id Vortex's own bundle registers", () => {
    // Read out of gamebryo-plugin-management, not guessed: the payload is the
    // bare boolean, `createAction('SET_AUTOSORT_ENABLED', e => e)`.
    expect(ACTION_SET_AUTOSORT_ENABLED).toBe("SET_AUTOSORT_ENABLED");
  });
});

describe("the wiring", () => {
  it("is gated in startInstall, next to the auto-deploy gate", async () => {
    // A gate nothing calls is the failure this codebase has shipped six times.
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "..", "ui", "pages", "install", "installSession.ts"),
      "utf8",
    );
    expect(src).toContain("autoSortBlocks(liveState)");
    expect(src).toContain("offerDisableAutoSort");
    // And it dispatches the real action rather than only warning.
    expect(src).toContain("ACTION_SET_AUTOSORT_ENABLED");
  });
});
