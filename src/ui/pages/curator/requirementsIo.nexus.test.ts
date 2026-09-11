import { afterEach, describe, expect, it } from "vitest";

import { util } from "@nexusmods/vortex-api";

import { nexusDomainForVortexGame } from "./requirementsIo";

type Mutable = { nexusGameId?: unknown; getGame?: unknown };
const u = util as unknown as Mutable;

afterEach(() => {
  delete u.nexusGameId;
  delete u.getGame;
});

describe("Vortex id → Nexus domain at the edge", () => {
  it("asks Vortex's own util.nexusGameId, with the game Vortex has for that id", () => {
    const seen: unknown[] = [];
    u.getGame = (id: string) => ({ id, details: { nexusPageId: "from-details" } });
    u.nexusGameId = (game: unknown, fallback: string) => {
      seen.push([game, fallback]);
      return `vortex-says-${fallback}`;
    };
    expect(nexusDomainForVortexGame("skyrimse")).toBe("vortex-says-skyrimse");
    expect(seen).toEqual([[{ id: "skyrimse", details: { nexusPageId: "from-details" } }, "skyrimse"]]);
  });

  it("falls back to the game's own page id, then the table, when this Vortex does not export the converter", () => {
    expect(nexusDomainForVortexGame("skyrimse")).toBe("skyrimspecialedition");
    u.getGame = () => ({ details: { nexusPageId: "enderalspecialedition" } });
    expect(nexusDomainForVortexGame("enderalspecialedition")).toBe("enderalspecialedition");
  });

  it("survives a converter or a game lookup that throws", () => {
    u.getGame = () => {
      throw new Error("no such game");
    };
    u.nexusGameId = () => {
      throw new Error("broken");
    };
    expect(nexusDomainForVortexGame("falloutnv")).toBe("newvegas");
  });
});
