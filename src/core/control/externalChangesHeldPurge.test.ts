/**
 * alasdairn's PC, 11-25 (Skyrim-collection): collection.install's clean step
 * purged, Vortex held the purge on its External Changes dialog (GT Softbody's
 * OBody_presetDistributionConfig.json), and the agent-driven run waited the
 * whole 1800 s budget for a dialog nobody could see.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { externalChangesHeldPurge } from "./externalChanges";

const change = {
  filePath: "SKSE/Plugins/OBody_presetDistributionConfig.json",
  source: "GT Softbody",
  type: "refchange",
  action: "newer",
};
const stateWith = (changes: unknown[]) => ({ session: { mods: { changes } } });

describe("a purge Vortex holds on External Changes", () => {
  it("stops at once, naming the file and the answer verb", async () => {
    let state = stateWith([]);
    const purging = new Promise<void>(() => undefined); // never answered, like the held purge
    setTimeout(() => {
      state = stateWith([change]);
    }, 20);
    await expect(externalChangesHeldPurge(purging, () => state, 5)).rejects.toThrow(
      /External Changes dialog: 1 file\(s\).*OBody_presetDistributionConfig\.json \(GT Softbody, refchange\).*externalChanges\.answer/,
    );
  });

  it("returns when the purge finishes with no dialog", async () => {
    await expect(externalChangesHeldPurge(Promise.resolve(), () => stateWith([]), 5)).resolves.toBeUndefined();
  });

  it("passes a purge failure through", async () => {
    await expect(externalChangesHeldPurge(Promise.reject(new Error("no listener")), () => stateWith([]), 5)).rejects.toThrow(
      "no listener",
    );
  });

  it("is used for agent-driven installs only, and the stop carries the files", () => {
    const session = readFileSync(new URL("../../ui/pages/install/installSession.ts", import.meta.url), "utf8");
    expect(session).toMatch(/if \(this\.agent !== undefined\) \{\s*const \{ externalChangesHeldPurge \}/);
    const verb = readFileSync(new URL("./collectionInstall.ts", import.meta.url), "utf8");
    expect(verb).toContain("externalChanges: pending, purgeWaiting: true");
  });
});
