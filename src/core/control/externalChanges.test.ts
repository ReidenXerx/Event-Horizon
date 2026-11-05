import { describe, expect, it } from "vitest";
import { describeExternalChanges, volatileAnswer, type DeclaredLookup } from "./externalChanges";
import { declaredSet } from "../volatileFiles";

// Skyrim-collection, 2026-11-06: OBody rewrites GT Softbody's copy every session.
const OBODY = "SKSE\\plugins\\OBody_presetDistributionConfig.json";
const idOf = (source: string): string | undefined => ({ "GT Softbody-1": "gt-softbody", "Tuned OBody-2": "tuned" })[source];
const declared: DeclaredLookup = (modId) =>
  modId === "gt-softbody" ? declaredSet(["SKSE/Plugins/OBody_presetDistributionConfig.json"]) : undefined;

describe("volatileAnswer", () => {
  it("answers every file when each is declared generated for its own mod", () => {
    const answer = volatileAnswer([{ source: "GT Softbody-1", filePath: OBODY }], "revert", idOf, declared);
    expect(answer).toEqual({ files: { [OBODY]: "revert" } });
  });

  it("answers nothing when one file is not declared, so Confirm never settles a file nobody chose", () => {
    const answer = volatileAnswer(
      [
        { source: "GT Softbody-1", filePath: OBODY },
        { source: "GT Softbody-1", filePath: "SKSE\\plugins\\Other.ini" },
      ],
      "revert",
      idOf,
      declared,
    );
    expect(answer).toBeUndefined();
  });

  it("is per mod: the same path in a mod that did not declare it is not answered", () => {
    const answer = volatileAnswer([{ source: "Tuned OBody-2", filePath: OBODY }], "revert", idOf, declared);
    expect(answer).toBeUndefined();
  });

  it("answers nothing for a staging folder Vortex does not know", () => {
    expect(volatileAnswer([{ source: "gone", filePath: OBODY }], "revert", idOf, declared)).toBeUndefined();
  });
});

describe("describeExternalChanges", () => {
  it("marks declared files so an agent sees which ones a volatile deploy would answer", () => {
    const state = {
      session: {
        mods: {
          changes: [
            { source: "GT Softbody-1", filePath: OBODY, type: "refchange", action: "drop" },
            { source: "Tuned OBody-2", filePath: OBODY, type: "refchange", action: "drop" },
          ],
        },
      },
    };
    const shown = describeExternalChanges(state, idOf, undefined, declared) as {
      mods: Array<{ mod: string; files: Array<{ declaredVolatile?: boolean }> }>;
    };
    expect(shown.mods.find((m) => m.mod === "GT Softbody-1")?.files[0]?.declaredVolatile).toBe(true);
    expect(shown.mods.find((m) => m.mod === "Tuned OBody-2")?.files[0]?.declaredVolatile).toBeUndefined();
  });
});
