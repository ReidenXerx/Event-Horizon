import { describe, expect, it } from "vitest";

import { computePluginBudget, describePluginBudget, type BudgetPlugin } from "./pluginBudget";

const full = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ name: `${prefix}${i}.esp`, light: false }));
const player = (name: string, extra: Partial<BudgetPlugin> = {}): BudgetPlugin => ({
  name,
  enabled: true,
  isNative: false,
  isLight: false,
  ...extra,
});

describe("computePluginBudget", () => {
  it("counts the collection, the game's own and the player's own full plugins (sunnyd0539, 11-09)", () => {
    const collectionOrder = [...full(240, "ivy"), { name: "light.esp", light: true }, { name: "off.esp", light: false, enabled: false }];
    const players = [
      ...Array.from({ length: 7 }, (_, i) => player(`ccFull${i}.esm`, { isNative: true })),
      player("Fallout4.esm", { isNative: true }),
      player("cclight.esl", { isNative: true, isLight: undefined }),
      player("Mine.esp"),
      player("MineLight.esp", { isLight: true }),
      player("MineOff.esp", { enabled: false }),
      player("IVY3.ESP"), // already installed from the collection: counted once, as the collection's
      player("unreadable.esp", { isLight: undefined }),
    ];
    const b = computePluginBudget({ collectionOrder, players, limit: 254 });
    expect(b.collection).toBe(240);
    expect(b.native).toHaveLength(8);
    expect(b.own).toEqual(["Mine.esp"]);
    expect(b.unknown).toBe(1);
    expect(b.total).toBe(249);
    expect(b.over).toBe(0);
  });

  it("says how far over, and names the player's own plugins", () => {
    const b = computePluginBudget({
      collectionOrder: full(250, "c"),
      players: [player("A.esp"), player("B.esm"), player("Fallout4.esm", { isNative: true }), player("Z.esp"), player("Y.esp")],
      limit: 254,
    });
    expect(b.over).toBe(1);
    const d = describePluginBudget(b, { game: "Fallout 4", collection: "Ivy" });
    expect(d.text).toMatch(/255, 1 over/);
    expect(d.message).toMatch(/A\.esp/);
    expect(d.message).toMatch(/Fallout4\.esm/);
  });
});

describe("orderWithoutLeftOut", () => {
  it("drops plugins only a left-out mod ships, keeps ones a kept version shares", async () => {
    const { orderWithoutLeftOut } = await import("./pluginBudget");
    const order = [{ name: "Shared.esp" }, { name: "OnlyOptional.esp" }, { name: "Other.esp" }];
    const mods = [
      { compareKey: "a", state: { stagingFiles: [{ path: "Shared.esp" }, { path: "OnlyOptional.esp" }] } },
      { compareKey: "b", state: { stagingFiles: [{ path: "sub/shared.esp" }] } },
    ];
    expect(orderWithoutLeftOut(order, mods, new Set(["a"])).map((p) => p.name)).toEqual(["Shared.esp", "Other.esp"]);
  });
});
