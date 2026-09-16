/**
 * Which Nexus collections the upload offers, and which one starts selected.
 *
 * A wrong default is expensive in both directions: an unwanted new collection
 * on the curator's profile, or a draft on another collection's page. So the
 * only defaults are the collection the last upload went to, and a collection
 * that is unambiguously this one by name.
 */
import { describe, expect, it } from "vitest";

import { collectionOptions, defaultChoice, renameWarning } from "./NexusCollectionUpload";

const IVY = { slug: "tumkz9", name: "Ivy's Panties", gameDomain: "fallout4", latestRevision: 3 };
const OTHER = { slug: "zz9zz9", name: "Something Else", gameDomain: "fallout4" };
const REMEMBERED = { id: 350133, slug: "tumkz9", gameDomain: "fallout4", name: "Ivy's Panties" };

describe("the collections offered", () => {
  it("puts the remembered collection first, once", () => {
    expect(collectionOptions([OTHER, IVY], REMEMBERED).map((c) => c.slug)).toEqual(["tumkz9", "zz9zz9"]);
  });

  it("still offers the remembered collection when Nexus's list came back without it", () => {
    // emitAndAwait turns a failed request into an empty list.
    expect(collectionOptions([], REMEMBERED)).toEqual([
      { slug: "tumkz9", name: "Ivy's Panties", gameDomain: "fallout4" },
    ]);
  });

  it("offers the curator's collections as listed when nothing is remembered", () => {
    expect(collectionOptions([IVY, OTHER], undefined)).toEqual([IVY, OTHER]);
  });
});

describe("the collection selected at first", () => {
  it("is the one the last upload went to", () => {
    expect(defaultChoice([OTHER], REMEMBERED, "Renamed")).toBe("tumkz9");
  });

  it("is the one collection with this package's name, ignoring case and spaces", () => {
    expect(defaultChoice([OTHER, IVY], undefined, "  ivy's panties ")).toBe("tumkz9");
  });

  it("is nothing when two collections share the name, or none has it", () => {
    const twin = { ...IVY, slug: "aaaaaa" };
    expect(defaultChoice([IVY, twin], undefined, "Ivy's Panties")).toBeUndefined();
    expect(defaultChoice([OTHER], undefined, "Ivy's Panties")).toBeUndefined();
  });
});

describe("renaming a live collection", () => {
  it("warns when the chosen collection has another name, because Vortex renames it on upload", () => {
    const lite = { slug: "q8w3rt", name: "Ivy's Panties Lite", gameDomain: "fallout4" };
    expect(renameWarning([IVY, lite], "q8w3rt", "Ivy's Panties")).toMatch(/renames "Ivy's Panties Lite" on Nexus to "Ivy's Panties"/);
  });

  it("stays quiet for the same name, a new collection, or no choice yet", () => {
    expect(renameWarning([IVY], "tumkz9", "Ivy's Panties")).toBeUndefined();
    expect(renameWarning([IVY], "", "Anything")).toBeUndefined();
    expect(renameWarning([IVY], undefined, "Anything")).toBeUndefined();
  });
});
