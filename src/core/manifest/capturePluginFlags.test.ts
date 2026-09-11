/**
 * What the build records about each plugin's light flag, and which bit that
 * record came from.
 *
 * The package is where a wrong bit becomes permanent: every user who installs
 * it gets the curator's values applied. A Starfield build read 0x200 — not
 * Starfield's light bit — and wrote the answers into the package as "light".
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { capturePluginFlags, describePluginFlagCapture } from "./capturePluginFlags";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-capture-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const writePlugin = (name: string, flags: number): void => {
  const buf = Buffer.alloc(24);
  buf.write("TES4", 0, "latin1");
  buf.writeUInt32LE(12, 4);
  buf.writeUInt32LE(flags, 8);
  fs.writeFileSync(path.join(dir, name), buf);
};

describe("capturing per game", () => {
  it("Starfield: records 0x100 as light, 0x200 as not light, and says the bit was 0x100", async () => {
    writePlugin("Only0x200.esm", 0x200);
    writePlugin("Only0x100.esm", 0x100);
    writePlugin("Medium.esm", 0x400);
    const c = await capturePluginFlags({
      pluginNames: ["Only0x200.esm", "Only0x100.esm", "Medium.esm"],
      dataDir: dir,
      gameId: "starfield",
    });
    expect(c.light).toEqual({ "only0x200.esm": false, "only0x100.esm": true, "medium.esm": false });
    expect(c).toMatchObject({ lightFlagBit: 0x100, lightCount: 1, mediumCount: 1 });
  });

  it("Skyrim SE: unchanged — 0x200 is light, and the bit recorded is 0x200", async () => {
    writePlugin("A.esp", 0x200);
    writePlugin("B.esp", 0x100);
    const c = await capturePluginFlags({ pluginNames: ["A.esp", "B.esp"], dataDir: dir, gameId: "skyrimse" });
    expect(c.light).toEqual({ "a.esp": true, "b.esp": false });
    expect(c).toMatchObject({ lightFlagBit: 0x200, lightCount: 1, mediumCount: 0 });
  });

  it("records nothing, and no bit, for a game it does not know or one without light plugins", async () => {
    writePlugin("A.esp", 0x200);
    for (const gameId of ["cyberpunk2077", "falloutnv"]) {
      const c = await capturePluginFlags({ pluginNames: ["A.esp"], dataDir: dir, gameId });
      expect(c.light).toEqual({});
      expect(c.lightFlagBit).toBeUndefined();
      expect(c.notCaptured).toBeDefined();
    }
  });
});

describe("the curator's warning", () => {
  it("counts medium plugins out of the regular budget", () => {
    // 270 plugins, 10 light and 5 medium: 255 regular against Starfield's 253.
    const said = describePluginFlagCapture(
      { light: {}, unreadable: [], lightCount: 10, mediumCount: 5 },
      270,
      253,
    );
    expect(said).toMatch(/255 regular/);
    expect(said).toMatch(/2 OVER/);
  });
});
