/**
 * alasdairn (Ivy, 2026-10-31): he switches "Collection of textures and
 * presets" off, and every update switched it back on.
 */
import { describe, expect, it } from "vitest";

import type { EhcollMod } from "../../types/ehcoll";
import type { DriverContext } from "../../types/installDriver";
import { applyKeptOff, findKeptOffOffers, refuseNeededMasters } from "./keptOff";

const mod = (compareKey: string, name: string, files: string[], extra: Record<string, unknown> = {}): EhcollMod =>
  ({ compareKey, name, state: { stagingFiles: files.map((path) => ({ path, size: 1 })), ...extra } }) as unknown as EhcollMod;

const cotap = mod("nexus:30019:1", "CoTaP", ["Textures/CoTaP/a.dds", "CoTaP.esp"]);
const master = mod("nexus:2:2", "Master Mod", ["Master.esm"]);
const patch = mod("nexus:3:3", "Patch", ["Patch.esp"]);
const optional = mod("nexus:4:4", "Optional", ["Opt.esp"], { optional: true });
const installed = { kind: "nexus-already-installed" };
const res = (m: EhcollMod, existingModId: string, decision = installed) => ({ compareKey: m.compareKey, name: m.name, decision, existingModId });

const receipt = {
  vortexProfileId: "rev26",
  mods: [
    { compareKey: cotap.compareKey, vortexModId: "cotap" },
    { compareKey: master.compareKey, vortexModId: "master" },
    { compareKey: patch.compareKey, vortexModId: "patch" },
  ],
};

describe("collection mods the player switched off", () => {
  it("are offered when they were off in the previous revision's profile", () => {
    const offers = findKeptOffOffers({
      manifestMods: [cotap, master, patch, optional],
      resolutions: [res(cotap, "cotap"), res(master, "master"), res(patch, "patch"), res(optional, "opt")],
      receipt,
      previousModState: { cotap: { enabled: false }, master: { enabled: true }, patch: { enabled: true }, opt: { enabled: false } },
      remembered: new Set(),
    });
    expect(offers).toEqual([{ compareKey: cotap.compareKey, name: "CoTaP", why: "switched-off" }]);
  });

  it("stay offered at the next update from what was remembered, unless switched back on since", () => {
    const base = {
      manifestMods: [cotap],
      resolutions: [res(cotap, "cotap")],
      receipt: { vortexProfileId: "rev27", mods: [] },
      remembered: new Set([cotap.compareKey]),
    };
    expect(findKeptOffOffers({ ...base, previousModState: { cotap: { enabled: false } } })).toHaveLength(1);
    expect(findKeptOffOffers({ ...base, previousModState: { cotap: { enabled: true } } })).toEqual([]);
  });

  it("a mod that is not installed yet is not offered: there is nothing to keep off", () => {
    expect(
      findKeptOffOffers({
        manifestMods: [cotap],
        resolutions: [res(cotap, "cotap", { kind: "nexus-download" })],
        receipt,
        previousModState: { cotap: { enabled: false } },
        remembered: new Set(),
      }),
    ).toEqual([]);
  });

  it("one another collection plugin needs as a master is refused, with who needs it", () => {
    const offers = [
      { compareKey: cotap.compareKey, name: "CoTaP", why: "switched-off" as const },
      { compareKey: master.compareKey, name: "Master Mod", why: "switched-off" as const },
    ];
    const result = refuseNeededMasters(offers, [cotap, master, patch], new Map([["patch.esp", ["Fallout4.esm", "Master.esm"]]]));
    expect(result.offers.map((o) => o.name)).toEqual(["CoTaP"]);
    expect(result.refused).toEqual([{ compareKey: master.compareKey, name: "Master Mod", neededBy: ["patch.esp"] }]);
  });

  it("the run sees a kept-off mod as a left-out optional mod", () => {
    const ctx = {
      plan: { manifest: { mods: [cotap, patch] }, modResolutions: [{ compareKey: cotap.compareKey }, { compareKey: patch.compareKey }] },
      decisions: { optionalSkipped: ["x"], keptOff: [cotap.compareKey] },
    } as unknown as DriverContext;
    const out = applyKeptOff(ctx);
    expect(out.plan.manifest.mods[0]!.state.optional).toBe(true);
    expect(out.plan.manifest.mods[1]!.state.optional).toBeUndefined();
    expect((out.plan.modResolutions[0] as { optional?: true }).optional).toBe(true);
    expect(out.decisions.optionalSkipped).toEqual(["x", cotap.compareKey]);
    expect(applyKeptOff({ ...ctx, decisions: {} } as DriverContext)).toEqual({ ...ctx, decisions: {} });
  });
});
