import { describe, expect, it } from "vitest";

import {
  EH_INSTALLER_PRIORITY,
  EH_MAIN_PAGE_ID,
  testSupported,
} from "./collectionIntercept";

/**
 * The claim rule, and nothing else. `makeInstall` needs a live Vortex api and
 * is proven on the real thing (two probes plus a real Nexus collection
 * installed from the website); this covers the half that decides WHICH
 * archives we touch, which is the half that can quietly hurt strangers.
 */
const files = (...names: string[]): string[] => names;

describe("which archives Event Horizon claims", () => {
  it("claims an archive carrying both markers", async () => {
    const res = await testSupported(
      files("collection.json", "manifest.json", "readme.txt"),
      "fallout4",
    );
    expect(res.supported).toBe(true);
  });

  it("declines a collection Event Horizon did not build", async () => {
    /**
     * THE one that protects everybody else. Vortex's own test is a single
     * line — files.indexOf("collection.json") !== -1 — so matching that alone
     * would claim every Nexus collection the user ever installs and break all
     * of them silently. Measured against a real collection (SEPHRAJIN's
     * Module 04 - Nature) installed from the website: asked first, declined.
     */
    const res = await testSupported(
      files("collection.json", "readme.txt"),
      "fallout4",
    );
    expect(res.supported).toBe(false);
  });

  it("declines an ordinary mod that happens to ship a manifest.json", async () => {
    const res = await testSupported(
      files("manifest.json", "Data/thing.esp"),
      "fallout4",
    );
    expect(res.supported).toBe(false);
  });

  it("ignores markers that are not at the archive root", async () => {
    // A mod shipping `docs/collection.json` is not a collection, and a nested
    // pair is not ours. Vortex hands archive-relative paths, so depth is the
    // only thing separating the two.
    const res = await testSupported(
      files("sub/collection.json", "sub/manifest.json"),
      "fallout4",
    );
    expect(res.supported).toBe(false);
  });

  it("matches regardless of separator or case", async () => {
    // Windows archives carry backslashes, and casing is not ours to assume.
    const res = await testSupported(
      files("Collection.JSON", "Manifest.json"),
      "fallout4",
    );
    expect(res.supported).toBe(true);
  });

  it("names both markers as required when it claims", async () => {
    // Vortex uses requiredFiles to decide what to extract before calling the
    // installer. Naming only one would hand us an archive missing the other.
    const res = await testSupported(
      files("collection.json", "manifest.json"),
      "fallout4",
    );
    expect(res.requiredFiles).toEqual(["collection.json", "manifest.json"]);
  });

  it("stays quiet about archives that are not collections at all", async () => {
    // The common case, and the reason testSupported must be cheap: it runs for
    // every archive the user installs.
    const res = await testSupported(files("Data/thing.esp", "readme.txt"), "fallout4");
    expect(res.supported).toBe(false);
    expect(res.requiredFiles).toEqual([]);
  });
});

describe("the numbers that decide the claim", () => {
  it("registers below Vortex's collections installer", () => {
    /**
     * A number, not a name, decides this: Vortex sorts installers ascending by
     * priority and takes the first that says supported. Its collections
     * installer sits at 5. At or above that, the claim never happens and
     * nothing reports it — everything loads and Vortex simply gets there
     * first.
     */
    expect(EH_INSTALLER_PRIORITY).toBeLessThan(5);
  });

  it("names the page by id, because show-main-page matches ids", () => {
    // `setOpenMainPage(page.id)` — the title "Event Horizon" silently does
    // nothing.
    expect(EH_MAIN_PAGE_ID).toBe("event-horizon");
  });
});
