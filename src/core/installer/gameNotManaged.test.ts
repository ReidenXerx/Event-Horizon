import { describe, expect, it } from "vitest";

import { describeGameNotManaged, isGameNotManaged } from "./gameNotManaged";

describe("Vortex refusing every install because the game is not managed", () => {
  it("recognises Vortex's two refusals, however they arrive", () => {
    expect(isGameNotManaged(new Error("You need to manage a game before installing this mod"))).toBe(true);
    expect(isGameNotManaged({ message: "You need to select a game before installing this mod" })).toBe(true);
    expect(isGameNotManaged("Install failed: you need to manage a game before installing this mod")).toBe(true);
  });

  it("leaves ordinary mod failures to the streak", () => {
    expect(isGameNotManaged(new Error("Failed to extract archive"))).toBe(false);
    expect(isGameNotManaged(undefined)).toBe(false);
  });

  it("names the cause and the fix, not the extractor", () => {
    const text = describeGameNotManaged({
      modName: "SKSE",
      atIndex: 1,
      total: 900,
      gameName: "Skyrim Special Edition",
      discoveredPath: undefined,
    });
    expect(text).toContain('Stopped at mod 1 of 900 ("SKSE")');
    expect(text).toContain("no folder recorded for Skyrim Special Edition");
    expect(text).toContain('click "Manage"');
    expect(text).toContain("not your extractor");
  });
});
