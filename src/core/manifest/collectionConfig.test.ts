/**
 * Regression tests for "what counts as a published collection".
 *
 * The bug: `loadOrCreateCollectionConfig` writes a config file the moment the
 * curator opens the Build page, and `listPublishedCollections` reported every
 * config file it found. So simply visiting the page produced a phantom
 * "1 published" collection, rendered as PUBLISHED with a footer reading
 * "never built" and an Update button for a package that did not exist.
 *
 * `lastBuiltAt` is written only after a build succeeds, so it is the honest
 * test. These fail against the unfiltered implementation.
 */
import { promises as fsp } from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listPublishedCollections, loadOrCreateCollectionConfig } from "./collectionConfig";

let dir: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "eh-config-"));
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

async function writeConfig(slug: string, extra: Record<string, unknown>): Promise<void> {
  await fsp.writeFile(
    path.join(dir, `${slug}.json`),
    JSON.stringify({
      schemaVersion: 1,
      packageId: "fa6eb141-03b0-4847-bb12-e4c5fe4fa385",
      externalMods: {},
      ...extra,
    }),
    "utf8",
  );
}

describe("lastPackageFormat", () => {
  it("comes back as it was saved, so the format question offers it first", async () => {
    await writeConfig("ivy", { lastPackageFormat: "zip" });
    const { config } = await loadOrCreateCollectionConfig({ configDir: dir, slug: "ivy" });
    expect(config.lastPackageFormat).toBe("zip");
  });

  it("drops an unknown value instead of refusing the whole config", async () => {
    await writeConfig("ivy", { lastPackageFormat: "7z", lastBuiltVersion: "1.0.0" });
    const { config } = await loadOrCreateCollectionConfig({ configDir: dir, slug: "ivy" });
    expect(config.lastPackageFormat).toBeUndefined();
    expect(config.lastBuiltVersion).toBe("1.0.0");
  });
});

describe("listPublishedCollections", () => {
  it("does NOT report a config that has never been built", async () => {
    // Exactly what opening the Build page leaves behind.
    await writeConfig("my-collection", {});
    expect(await listPublishedCollections(dir)).toEqual([]);
  });

  it("reports a collection once it has actually been built", async () => {
    await writeConfig("shipped", {
      lastBuiltAt: "2026-08-24T00:00:00.000Z",
      lastBuiltVersion: "1.0.0",
      lastBuiltName: "Shipped Collection",
    });
    const out = await listPublishedCollections(dir);
    expect(out).toHaveLength(1);
    expect(out[0].slug).toBe("shipped");
    expect(out[0].lastBuiltVersion).toBe("1.0.0");
  });

  it("filters never-built configs out from among built ones", async () => {
    await writeConfig("scratch", {});
    await writeConfig("real", { lastBuiltAt: "2026-08-24T00:00:00.000Z" });
    const out = await listPublishedCollections(dir);
    expect(out.map((c) => c.slug)).toEqual(["real"]);
  });

  it("sorts most recently built first", async () => {
    await writeConfig("older", { lastBuiltAt: "2026-01-01T00:00:00.000Z" });
    await writeConfig("newer", { lastBuiltAt: "2026-08-24T00:00:00.000Z" });
    const out = await listPublishedCollections(dir);
    expect(out.map((c) => c.slug)).toEqual(["newer", "older"]);
  });

  it("returns empty for a directory that does not exist", async () => {
    expect(await listPublishedCollections(path.join(dir, "nope"))).toEqual([]);
  });

  it("skips malformed json and surfaces it via onError rather than throwing", async () => {
    await fsp.writeFile(path.join(dir, "broken.json"), "{ not json", "utf8");
    await writeConfig("good", { lastBuiltAt: "2026-08-24T00:00:00.000Z" });
    const errors: string[] = [];
    const out = await listPublishedCollections(dir, {
      onError: (name) => errors.push(name),
    });
    expect(out.map((c) => c.slug)).toEqual(["good"]);
    expect(errors).toHaveLength(1);
  });
});
