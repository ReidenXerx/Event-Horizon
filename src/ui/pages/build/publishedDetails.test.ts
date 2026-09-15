/**
 * Seeing what a collection contains used to require starting a build, which
 * loads and hashes the whole profile — a minute of work to answer "how many
 * mods was this".
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bundledModNames,
  findBuiltPackages,
  modsWithInstructions,
} from "./publishedDetails";
import type { CollectionConfig } from "../../../core/manifest/collectionConfig";
import { buildStoredZip } from "../../../core/manifest/storedZip.testutil";

const config = (externalMods: CollectionConfig["externalMods"]): CollectionConfig =>
  ({ schemaVersion: 1, packageId: "p", externalMods }) as CollectionConfig;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-details-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, bytes = 8): void =>
  fs.writeFileSync(path.join(dir, name), Buffer.alloc(bytes));

describe("findBuiltPackages", () => {
  it("finds this collection's packages, newest first", async () => {
    write("ivy-1.0.0.ehcoll");
    write("ivy-1.0.1.ehcoll");
    const found = await findBuiltPackages(dir, "ivy");
    // Touch one so ordering is unambiguous rather than filesystem-dependent.
    fs.utimesSync(path.join(dir, "ivy-1.0.1.ehcoll"), new Date(), new Date(Date.now() + 5000));
    const ordered = await findBuiltPackages(dir, "ivy");
    expect(found).toHaveLength(2);
    expect(ordered[0]!.fileName).toBe("ivy-1.0.1.ehcoll");
  });

  it("does NOT claim a different collection whose slug shares a prefix", async () => {
    // "ivy" and "ivy-2" are separate collections with separate lineages and
    // separate package ids. Showing one's builds under the other misreports
    // release history — and this is the real pair on the curator's disk.
    write("ivy-1.0.0.ehcoll");
    write("ivy-2-1.0.3.ehcoll");

    // The dangerous direction: the SHORTER slug must not swallow the longer.
    const known = ["ivy", "ivy-2"];
    const ivy = (await findBuiltPackages(dir, "ivy", known)).map((p) => p.fileName);
    expect(ivy).toEqual(["ivy-1.0.0.ehcoll"]);

    const ivy2 = (await findBuiltPackages(dir, "ivy-2", known)).map((p) => p.fileName);
    expect(ivy2).toEqual(["ivy-2-1.0.3.ehcoll"]);
  });

  it("keeps a dashed VERSION when no other collection explains it", async () => {
    // `ivy-2-1.0.3` is only ivy-2's build if ivy-2 exists. On its own it is
    // ivy at version "2-1.0.3", and dropping it would hide a real release.
    write("ivy-2-1.0.3.ehcoll");
    const names = (await findBuiltPackages(dir, "ivy", ["ivy"])).map((p) => p.fileName);
    expect(names).toEqual(["ivy-2-1.0.3.ehcoll"]);
  });

  it("ignores unrelated files in the same folder", async () => {
    write("ivy-1.0.0.ehcoll");
    write("notes.txt");
    write("ivy-backup.zip");
    expect(await findBuiltPackages(dir, "ivy")).toHaveLength(1);
  });

  it("finds a .zip build alongside .ehcoll ones, newest first", async () => {
    write("ivy-1.0.0.ehcoll");
    fs.writeFileSync(
      path.join(dir, "ivy-1.0.1.zip"),
      buildStoredZip([{ name: "manifest.json", body: "{}" }]),
    );
    fs.utimesSync(path.join(dir, "ivy-1.0.1.zip"), new Date(), new Date(Date.now() + 5000));
    const names = (await findBuiltPackages(dir, "ivy")).map((p) => p.fileName);
    expect(names).toEqual(["ivy-1.0.1.zip", "ivy-1.0.0.ehcoll"]);
  });

  it("does not take a .zip without manifest.json at its root for a build", async () => {
    fs.writeFileSync(
      path.join(dir, "ivy-1.0.2.zip"),
      buildStoredZip([{ name: "Data/ivy.esp", body: "TES4" }]),
    );
    fs.writeFileSync(
      path.join(dir, "ivy-1.0.3.zip"),
      buildStoredZip([{ name: "nested/manifest.json", body: "{}" }]),
    );
    expect(await findBuiltPackages(dir, "ivy")).toEqual([]);
  });

  it("returns nothing rather than throwing when the folder is gone", async () => {
    expect(await findBuiltPackages(path.join(dir, "nope"), "ivy")).toEqual([]);
  });
});

describe("config-derived details", () => {
  it("lists the mods set to bundle, by display name", () => {
    const c = config({
      a: { name: "Alpha", bundled: true, instructions: "" },
      b: { name: "Beta", bundled: false, instructions: "" },
      z: { name: "Zeta", bundled: true, instructions: "" },
    });
    expect(bundledModNames(c)).toEqual(["Alpha", "Zeta"]);
  });

  it("lists only mods with real instructions, not blank ones", () => {
    const c = config({
      a: { name: "Alpha", bundled: false, instructions: "   " },
      b: { name: "Beta", bundled: false, instructions: "Install after X" },
    });
    expect(modsWithInstructions(c)).toEqual(["Beta"]);
  });

  it("falls back to the id when a config entry has no name", () => {
    const c = config({ "raw-id": { bundled: true } as never });
    expect(bundledModNames(c)).toEqual(["raw-id"]);
  });

  it("is empty-safe on a config with no external mods", () => {
    expect(bundledModNames(config({}))).toEqual([]);
    expect(modsWithInstructions(config({}))).toEqual([]);
  });
});
