/**
 * A package now states its own checksum.
 *
 * Nothing recorded one before, and the gap had a measurable cost: when an
 * alpha tester could not open a collection, establishing that his copy was
 * intact took two people running sha256sum by hand and reading hex to each
 * other over a chat client. Twice.
 *
 * The property under test is narrow and the whole point: the hash describes
 * THE BYTES THAT LANDED ON DISK. A hash accumulated while writing, or taken
 * from the staging directory, would describe what we meant to produce — and a
 * recipient hashes what they received.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { packageEhcoll } from "./packageZip";
import type { EhcollManifest } from "../../types/ehcoll";
import type { SevenZipApi } from "./sevenZip";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-pkg-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A 7z that actually writes something.
 *
 * The shared fakeSevenZip records the call and writes no file, which is fine
 * for callers that only inspect arguments — but packaging then stats a file
 * that does not exist. Here the bytes ARE the subject, so they have to be
 * real.
 */
const writingSevenZip = (bytes: Buffer): SevenZipApi =>
  ({
    add: async (archive: string) => {
      fs.writeFileSync(archive, bytes);
      return { code: 0 };
    },
    list: async () => ({ type: "zip" }),
    extractFull: async () => ({ code: 0 }),
  }) as unknown as SevenZipApi;

const manifest = (): EhcollManifest =>
  ({
    schemaVersion: 2,
    package: {
      id: "11111111-2222-4333-8444-555555555555",
      name: "Test",
      version: "1.0.0",
      author: "someone",
      createdAt: "2026-01-01T00:00:00.000Z",
      strictMissingMods: false,
      verificationLevel: "thorough",
    },
    game: { id: "fallout4", version: "1.10.163.0", versionPolicy: "exact" },
    vortex: {
      version: "1.9.0",
      deploymentMethod: "hardlink",
      requiredExtensions: [],
    },
    mods: [],
    rules: [],
    fileOverrides: [],
    plugins: { order: [], enabled: [] },
    loadOrder: [],
    iniTweaks: [],
    externalDependencies: [],
    userlist: { plugins: [], groups: [] },
  }) as unknown as EhcollManifest;

describe("a package states its own checksum", () => {
  it("returns the sha256 of the file that was actually written", async () => {
    const bytes = Buffer.from("pretend this is a 158 MB collection");
    const outputPath = path.join(dir, "out.ehcoll");

    const result = await packageEhcoll({
      manifest: manifest(),
      bundles: [],
      outputPath,
      sevenZip: writingSevenZip(bytes),
    });

    expect(result.outputSha256).toBe(
      crypto.createHash("sha256").update(bytes).digest("hex"),
    );
  });

  it("matches what a recipient would compute from the file on disk", async () => {
    // The version of the check that would have settled the tester's question
    // in one step instead of an afternoon.
    const bytes = Buffer.from("different contents entirely");
    const outputPath = path.join(dir, "out2.ehcoll");

    const result = await packageEhcoll({
      manifest: manifest(),
      bundles: [],
      outputPath,
      sevenZip: writingSevenZip(bytes),
    });

    const asReceived = crypto
      .createHash("sha256")
      .update(fs.readFileSync(outputPath))
      .digest("hex");
    expect(result.outputSha256).toBe(asReceived);
  });

  it("reports the size of the same file it hashed", async () => {
    // Size and hash must describe one artefact. Two numbers taken at
    // different moments are how "157984816 bytes but the wrong hash" happens.
    const bytes = Buffer.alloc(4096, 7);
    const outputPath = path.join(dir, "out3.ehcoll");

    const result = await packageEhcoll({
      manifest: manifest(),
      bundles: [],
      outputPath,
      sevenZip: writingSevenZip(bytes),
    });

    expect(result.outputBytes).toBe(bytes.length);
    expect(result.outputSha256).toBe(
      crypto.createHash("sha256").update(bytes).digest("hex"),
    );
  });
});
