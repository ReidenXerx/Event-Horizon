/**
 * alasdairn (Ivy, 2026-10-31), updating .53 -> .56 on 0.2.101: his 230 own
 * mods came over switched on with their plugins off, and a kept-off
 * Headcase's Abernathy Farmers silently cost him the bundled Connie patch that
 * needs it as a master.
 */
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeZip } from "../../../../test/makeZip";
import type { EhcollManifest } from "../../../types/ehcoll";
import type { InstallPlan } from "../../../types/installPlan";
import type { InstallReceipt } from "../../../types/installLedger";
import { previousRevisionChoices } from "./previousRevision";

const subrecord = (type: string, data: Buffer): Buffer => {
  const head = Buffer.alloc(6);
  head.write(type, 0, 4, "latin1");
  head.writeUInt16LE(data.length, 4);
  return Buffer.concat([head, data]);
};
const plugin = (...masters: string[]): Buffer => {
  const body = Buffer.concat([
    subrecord("HEDR", Buffer.alloc(12)),
    ...masters.map((m) => subrecord("MAST", Buffer.from(`${m}\0`, "latin1"))),
  ]);
  const header = Buffer.alloc(24);
  header.write("TES4", 0, 4, "latin1");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
};

const SHA = "a".repeat(64);
const farmers = { compareKey: "nexus:107997:1", name: "Headcase's Abernathy Farmers", state: { stagingFiles: [{ path: "Headcase's Abernathy Farmers.esp", size: 1 }] } };
const connie = {
  compareKey: "external:staging:connie",
  name: "Ivy - Headcase Connie Patch",
  source: { kind: "external", bundled: true, sha256: SHA, expectedFilename: "connie.zip" },
  state: { stagingFiles: [{ path: "Ivy - Headcase Connie Patch.esp", size: 1 }] },
};
const manifest = { game: { id: "fallout4" }, package: { id: "pkg" }, mods: [farmers, connie] } as unknown as EhcollManifest;
const plan = {
  installTarget: { kind: "fresh-profile" },
  modResolutions: [
    { compareKey: farmers.compareKey, name: farmers.name, decision: { kind: "nexus-already-installed", existingModId: "farmers" } },
    { compareKey: connie.compareKey, name: connie.name, decision: { kind: "external-use-bundled" } },
  ],
} as unknown as InstallPlan;
const receipt = {
  vortexProfileId: "rev53",
  mods: [{ compareKey: farmers.compareKey, vortexModId: "farmers", name: farmers.name }],
} as unknown as InstallReceipt;

const state = {
  settings: { profiles: { activeProfileId: "rev53" } },
  loadOrder: {
    "ecv_remnants.esp": { enabled: true, name: "ECV_Remnants.esp" },
    "headcase's abernathy farmers.esp": { enabled: false },
  },
  persistent: {
    profiles: { rev53: { modState: { farmers: { enabled: false }, ecv: { enabled: true } } } },
    mods: { fallout4: { farmers: { type: "", attributes: { name: "Farmers" } }, ecv: { type: "", attributes: { name: "Enclave Remnants" } } } },
  },
};

let dir: string;
let pkg: string;
beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "eh-prevrev-"));
  pkg = path.join(dir, "pkg.zip");
  await fsp.writeFile(
    pkg,
    makeZip([{ name: `bundled/${SHA}/Ivy - Headcase Connie Patch.esp`, data: plugin("Fallout4.esm", "Headcase's Abernathy Farmers.esp") }]),
  );
});
afterAll(async () => {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe("an update from the previous revision's profile", () => {
  it("refuses to keep off a master of a bundled plugin that is not installed yet", async () => {
    const out = await previousRevisionChoices(state, manifest, plan, receipt, pkg);
    expect(out?.keepOff).toEqual([]);
    expect(out?.refused).toEqual([{ compareKey: farmers.compareKey, name: farmers.name, neededBy: ["ivy - headcase connie patch.esp"] }]);
  });

  it("without the package it cannot know, and offers it as before", async () => {
    const out = await previousRevisionChoices(state, manifest, plan, receipt);
    expect(out?.keepOff.map((k) => k.name)).toEqual([farmers.name]);
  });

  it("carries the plugin ticks of the previous profile with the player's own mods", async () => {
    const out = await previousRevisionChoices(state, manifest, plan, receipt, pkg);
    expect(out?.carry.map((c) => c.vortexModId)).toEqual(["ecv"]);
    expect(out?.previousEnabledPlugins).toEqual(["ecv_remnants.esp"]);
  });

  it("reads an inactive previous profile's ticks from its own plugins.txt, and gives none when unreadable", async () => {
    const inactive = { ...state, settings: { profiles: { activeProfileId: "other" } } };
    const out = await previousRevisionChoices(inactive, manifest, plan, receipt, pkg);
    // The stub's userData path has no profile folder: unknown, not "nothing was ticked".
    expect(out?.previousEnabledPlugins).toBeUndefined();
  });
});
