/**
 * Which Nexus collections the upload offers, which one starts selected, and
 * what the collection is called on Nexus.
 *
 * A wrong default is expensive in both directions: an unwanted new collection
 * on the curator's profile, or a draft on another collection's page. So the
 * only default is the collection the last upload went to.
 */
import { describe, expect, it } from "vitest";

import {
  collectionOptions,
  defaultChoice,
  pageNameProblem,
  renameWarning,
  withPageName,
} from "./NexusCollectionUpload";
import type { NexusCollectionInfo } from "../../../core/nexus/collectionPayload";

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
    expect(defaultChoice(REMEMBERED)).toBe("tumkz9");
  });

  it("is nothing when nothing is remembered, even if a page carries the package's name", () => {
    // The first real use was starting over on NEW pages; the page with the
    // package's name was the one being left behind.
    expect(defaultChoice(undefined)).toBeUndefined();
  });
});

describe("the name on Nexus", () => {
  it("accepts the names the curator wants for the new pages", () => {
    expect(pageNameProblem("Ivy's Panties - Event Horizon")).toBeUndefined();
    expect(pageNameProblem("Meridia's Panties - Event Horizon")).toBeUndefined();
  });

  it("refuses what Nexus refuses, counting without surrounding spaces", () => {
    expect(pageNameProblem("x".repeat(37))).toMatch(/3 to 36 characters; this is 37/);
    expect(pageNameProblem("  Iv  ")).toMatch(/this is 2/);
  });

  it("is what the upload sends, trimmed, leaving the rest of the payload alone", () => {
    const info = {
      info: { author: "DuduPhudu", authorUrl: "", name: "Ivy's Panties", domainName: "fallout4", gameVersions: [] },
      mods: [],
    } as NexusCollectionInfo;
    const named = withPageName(info, " Ivy's Panties - Event Horizon ");
    expect(named.info.name).toBe("Ivy's Panties - Event Horizon");
    expect(named.info.author).toBe("DuduPhudu");
    expect(info.info.name).toBe("Ivy's Panties");
  });
});

describe("renaming a live collection", () => {
  it("warns when the chosen collection has another name, because Vortex renames it on upload", () => {
    expect(renameWarning([IVY], "tumkz9", "Ivy's Panties - Event Horizon")).toMatch(
      /renames "Ivy's Panties" on Nexus to "Ivy's Panties - Event Horizon"/,
    );
  });

  it("stays quiet for the same name, a new collection, or no choice yet", () => {
    expect(renameWarning([IVY], "tumkz9", " Ivy's Panties ")).toBeUndefined();
    expect(renameWarning([IVY], "", "Anything")).toBeUndefined();
    expect(renameWarning([IVY], undefined, "Anything")).toBeUndefined();
  });
});
