/**
 * Skyrim-collection, alasdairn's PC (2026-11-23): `{"answer":"revert"}` named
 * none of all/mods/files, so every refchange file kept Vortex's default
 * ("newer") and the verb reported "answered 5". The older game-folder copies
 * won and overwrote staging.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { planAnswer } from "./externalChanges";

const change = (filePath: string, source = "Archery") => ({ filePath, source, type: "refchange", action: "newest" });
const noIds = (): undefined => undefined;

describe("externalChanges.answer", () => {
  it("revert on a modified game-folder file drops it, so staging wins", () => {
    const plan = planAnswer([change("a.dll"), change("a.pdb")], { all: "revert" }, noIds);
    expect(plan.actions).toEqual([{ action: "drop", filePaths: ["a.dll", "a.pdb"] }]);
    expect(plan.unanswered).toEqual([]);
  });

  it("names every file no answer reached, instead of leaving it on Vortex's default silently", () => {
    const plan = planAnswer([change("a.dll"), change("b.json", "GT")], { mods: { Archery: "revert" } }, noIds);
    expect(plan.unanswered).toEqual(["b.json"]);
  });

  it("reads `answer` as `all` and refuses a body that answers nothing", () => {
    const src = readFileSync(new URL("./verbs.ts", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("async function answerExternalChanges"));
    expect(fn).toMatch(/str\(body\["all"\]\) \?\? str\(body\["answer"\]\)/);
    // The refusal comes before anything is dispatched or confirmed.
    expect(fn.indexOf("No answer given")).toBeGreaterThan(0);
    expect(fn.indexOf("No answer given")).toBeLessThan(fn.indexOf("SET_EXTERNAL_CHANGE_ACTION"));
    expect(fn.indexOf("No answer given")).toBeLessThan(fn.indexOf('clickDialogButton("confirm")'));
  });
});
