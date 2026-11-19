/**
 * cloud_16493, Ivy 1.0.64 (2026-11-19): the repair reinstalled Immersive
 * Deathclaws while Deathclaw_nude.esp was inactive, so its installer picked
 * the Plain build instead of the curator's UAP build.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pluginsToActivateBeforeRepair } from "./repairPluginState";
import { describeRepairAttempt } from "./runInstall";

const manifest = {
  plugins: {
    order: [
      { name: "Fallout4.esm", enabled: true },
      { name: "Deathclaw_nude.esp", enabled: true },
      { name: "SomethingOff.esp", enabled: false },
    ],
  },
} as never;

describe("plugins a repair activates first", () => {
  it("activates the curator-enabled plugin the installer reads, in the collection's spelling", () => {
    const mod = { install: { readsPluginState: ["deathclaw_nude.esp"] } } as never;
    expect(pluginsToActivateBeforeRepair(manifest, mod)).toEqual(["Deathclaw_nude.esp"]);
  });

  it("never switches on a plugin the curator had off", () => {
    const mod = { install: { readsPluginState: ["somethingoff.esp"] } } as never;
    expect(pluginsToActivateBeforeRepair(manifest, mod)).toEqual([]);
  });

  it("does nothing for a mod whose installer reads no plugin", () => {
    expect(pluginsToActivateBeforeRepair(manifest, { install: {} } as never)).toEqual([]);
    expect(pluginsToActivateBeforeRepair(manifest, undefined)).toEqual([]);
  });

  it("runs before the repair reinstalls, not after", () => {
    const src = readFileSync(new URL("./runInstall.ts", import.meta.url), "utf8");
    const activate = src.indexOf("pluginsToActivateBeforeRepair(plan.manifest");
    const repair = src.indexOf("await tryRecoverFailedMod(");
    expect(activate).toBeGreaterThan(0);
    expect(activate).toBeLessThan(repair);
  });
});

describe("curator report: a copy beside the user's own", () => {
  it("says the copy was installed when it was", () => {
    const line = describeRepairAttempt({ kind: "not-ours" }, { alongsideInstalled: true });
    expect(line).toContain("installed the collection's copy beside it");
    expect(line).not.toContain("could not be installed");
  });

  it("keeps saying it could not be installed when it could not", () => {
    expect(describeRepairAttempt({ kind: "not-ours" })).toContain("could not be installed");
  });
});
