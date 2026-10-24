/**
 * Ivy Rev 26 (sudo_bluuuk, 2026-10-25): no collection rule ordered MTs-255 FPA
 * Replacer against "Ivy - JNFA2026 Women Only", the player's game got FPA's
 * 368-line PersistantSubgraphInfoAndOffsetData.txt instead of JNFA's merged
 * 3,804-line one, and no save would load. Re-applying the collection's rules
 * could not change that; the repair must add the rule the creator's game implies.
 */
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  findings: [] as unknown[],
  deployed: 0,
}));

vi.mock("../installer/deploymentCheck", () => ({
  checkDeployment: async () => ({
    kind: "checked",
    judgedPaths: 10,
    judgedWinners: 1,
    findings: h.findings,
    lines: [],
    fixable: false,
    pinnable: true,
  }),
}));
vi.mock("../installer/runInstall", () => ({
  deployAndWait: async () => {
    h.deployed += 1;
  },
}));

import { runHeal } from "./runHeal";

const receipt = {
  packageId: "pkg-ivy",
  packageName: "Ivy",
  gameId: "fallout4",
  vortexProfileId: "prof-ivy",
  vortexProfileName: "IvyPanties - AE",
  installedAt: "2026-10-25T10:00:00.000Z",
  mods: [
    { compareKey: "k:jnfa", vortexModId: "jnfa-id", name: "Ivy - JNFA2026 Women Only" },
    { compareKey: "k:fpa", vortexModId: "fpa-id", name: "MTs-255 FPA Replacer" },
  ],
} as never;

function fakeApi(playerRules: Record<string, unknown[]> = {}) {
  const dispatched: Array<{ type: string; payload: unknown }> = [];
  const api = {
    getState: () => ({
      settings: { profiles: { activeProfileId: "prof-ivy" } },
      persistent: {
        mods: {
          fallout4: {
            "jnfa-id": { id: "jnfa-id", rules: playerRules["jnfa-id"] ?? [] },
            "fpa-id": { id: "fpa-id", rules: playerRules["fpa-id"] ?? [] },
          },
        },
      },
    }),
    store: { dispatch: (a: { type: string; payload: unknown }) => dispatched.push(a) },
  };
  return { api: api as never, dispatched };
}

const finding = {
  kind: "wrong-winner",
  modType: "",
  path: "meshes/animtextdata/persistantsubgraphinfoandoffsetdata.txt",
  expected: "k:jnfa",
  actualKey: "k:fpa",
  actualFolder: "fpa-id",
  ruled: false,
};

describe("redeploy-winners on a pair the collection leaves open", () => {
  it("adds 'JNFA after FPA' to the player's Vortex, then deploys", async () => {
    h.findings = [finding];
    h.deployed = 0;
    const { api, dispatched } = fakeApi();
    const out = await runHeal("redeploy-winners", { api, gameId: "fallout4", receipt, manifest: { rules: [] } as never });
    expect(out.kind).toBe("done");
    const added = dispatched.filter((a) => a.type === "STUB_ADD_MOD_RULE");
    expect(added).toHaveLength(1);
    expect(added[0]!.payload).toMatchObject({ gameId: "fallout4", modId: "jnfa-id", rule: { type: "after", reference: { id: "fpa-id" } } });
    expect(h.deployed).toBe(1);
    expect((out as { summary: string }).summary).toMatch(/added 1 rule/);
  });

  it("leaves a pair alone when the player's own rule puts FPA last", async () => {
    h.findings = [finding];
    const { api, dispatched } = fakeApi({ "fpa-id": [{ type: "after", reference: { id: "jnfa-id" } }] });
    const out = await runHeal("redeploy-winners", { api, gameId: "fallout4", receipt, manifest: { rules: [] } as never });
    expect(dispatched.filter((a) => a.type === "STUB_ADD_MOD_RULE")).toHaveLength(0);
    expect((out as { summary: string }).summary).toMatch(/Left alone/);
  });
});
