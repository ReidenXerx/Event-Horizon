/**
 * The re-pin keeps a user's patch below the collection plugin it patches, and
 * learns what a plugin patches from these masters. Read from real TES4 bytes,
 * through the same list Vortex keeps (`session.plugins.pluginList`).
 */
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildRepinOrder, previewRepin } from "../doctor/loadOrderStatus";
import { readUserPluginMasters } from "./userPluginMasters";

const subrecord = (type: string, data: Buffer): Buffer => {
  const head = Buffer.alloc(6);
  head.write(type, 0, 4, "latin1");
  head.writeUInt16LE(data.length, 4);
  return Buffer.concat([head, data]);
};

const plugin = (masters: string[]): Buffer => {
  const body = Buffer.concat([
    subrecord("HEDR", Buffer.alloc(12)),
    ...masters.flatMap((m) => [subrecord("MAST", Buffer.from(`${m}\0`, "latin1")), subrecord("DATA", Buffer.alloc(8))]),
  ]);
  const header = Buffer.alloc(24);
  header.write("TES4", 0, 4, "latin1");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
};

let dir: string;
let state: unknown;

beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "eh-user-masters-"));
  const files: Record<string, Buffer> = {
    "Heather.esp": plugin(["Fallout4.esm"]),
    "Heather Shared Body.esp": plugin(["Fallout4.esm", "Heather.esp"]),
    "Mine.esp": plugin(["Fallout4.esm"]),
  };
  for (const [name, bytes] of Object.entries(files)) await fsp.writeFile(path.join(dir, name), bytes);
  state = {
    session: {
      plugins: {
        pluginList: {
          "fallout4.esm": { isNative: true, filePath: path.join(dir, "missing-native.esm") },
          "heather.esp": { modId: "heather", filePath: path.join(dir, "Heather.esp") },
          "heather shared body.esp": { modId: "patch", filePath: path.join(dir, "Heather Shared Body.esp") },
          "mine.esp": { modId: "mine", filePath: path.join(dir, "Mine.esp") },
          "gone.esp": { modId: "gone", filePath: path.join(dir, "Gone.esp") },
        },
      },
    },
    loadOrder: {},
  };
});

afterAll(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe("readUserPluginMasters", () => {
  it("reads the masters of the user's own plugins, keyed lowercased", async () => {
    const masters = await readUserPluginMasters(state, ["Heather.esp", "B.esp"]);
    expect(masters["heather shared body.esp"]).toEqual(["Fallout4.esm", "Heather.esp"]);
    expect(masters["mine.esp"]).toEqual(["Fallout4.esm"]);
  });

  it("skips the collection's plugins, natives, and files it cannot read", async () => {
    const masters = await readUserPluginMasters(state, ["Heather.esp"]);
    expect(Object.keys(masters).sort()).toEqual(["heather shared body.esp", "mine.esp"]);
  });
});

describe("the Doctor's re-apply with a user's patch", () => {
  // The tester's shape: curator order puts Heather after B; LOOT put her
  // before B with the user's patch right under her.
  const baseline = ["A.esp", "B.esp", "Heather.esp"].map((name) => ({ name, enabled: true }));
  const current = ["A.esp", "Heather.esp", "Heather Shared Body.esp", "B.esp"].map((name) => ({ name, enabled: true }));

  it("keeps the patch below Heather, and the preview shows the same moves", async () => {
    const masters = await readUserPluginMasters(state, baseline.map((p) => p.name));
    const order = buildRepinOrder(baseline, current, masters).map((p) => p.name);
    expect(order).toEqual(["A.esp", "B.esp", "Heather.esp", "Heather Shared Body.esp"]);
    const preview = previewRepin(baseline, current, masters);
    const previewed = [...current.map((p) => p.name)];
    for (const m of preview.moves) previewed[m.to] = m.name;
    expect(previewed).toEqual(order);
  });

  it("without the masters, re-apply puts the patch above its master (the bug)", () => {
    const order = buildRepinOrder(baseline, current).map((p) => p.name);
    expect(order.indexOf("Heather Shared Body.esp")).toBeLessThan(order.indexOf("Heather.esp"));
  });
});
