/**
 * The curator deleted a mod from Vortex and every subsequent build failed:
 *
 *   Config flags modId "AAF_V1-5-5" as bundled, but no such mod is in the
 *   active profile right now.
 *
 * The config keeps per-mod answers keyed by Vortex mod id and deliberately
 * never prunes, because a mod temporarily switched off should keep its
 * instructions. The build could not tell that case from a deletion, so it
 * treated both as fatal — and a deliberately deleted mod blocked every build
 * until someone hand-edited a JSON file.
 */
import { describe, expect, it } from "vitest";

import {
  classifyMissingConfigEntry,
  describeDroppedEntry,
} from "./staleConfigEntries";

const collection = new Set(["in-collection"]);
const pool = new Set(["in-collection", "installed-but-off"]);

describe("telling a deleted mod from a disabled one", () => {
  it("says nothing about a mod that IS in the collection", () => {
    expect(
      classifyMissingConfigEntry("in-collection", collection, pool),
    ).toBeUndefined();
  });

  it("calls a mod still in Vortex's pool DISABLED, not deleted", () => {
    // The build keeps failing for this one, deliberately: the curator marked
    // it to ship and it is not shipping, which is almost certainly an
    // oversight worth stopping for.
    expect(
      classifyMissingConfigEntry("installed-but-off", collection, pool),
    ).toBe("disabled");
  });

  it("calls a mod absent from the pool DELETED", () => {
    // NS-3: the pool is what "do you have this mod" means. Asking the profile
    // would answer "disabled" for a mod that no longer exists at all.
    expect(classifyMissingConfigEntry("AAF_V1-5-5", collection, pool)).toBe(
      "deleted",
    );
  });

  it("does not confuse an empty pool with a mod that is present", () => {
    // A state read that came back empty must not silently reclassify every
    // disabled mod as deleted and start pruning live answers.
    expect(
      classifyMissingConfigEntry("installed-but-off", collection, new Set()),
    ).toBe("deleted");
    // ...which is why the caller reads the pool from `persistent.mods[gameId]`
    // directly rather than from anything that can be scoped or filtered.
  });
});

describe("what the curator is told", () => {
  it("names the mod and says the answer was dropped, not ignored", () => {
    const msg = describeDroppedEntry("AAF_V1-5-5", "AAF", "bundle");
    expect(msg).toContain("AAF");
    expect(msg).toContain("no longer installed");
    expect(msg).toContain("dropped");
    // And what happens next, because a warning with no next step is a shrug.
    expect(msg).toMatch(/reinstall/i);
  });

  it("falls back to the raw id when the config kept no name", () => {
    expect(describeDroppedEntry("AAF_V1-5-5", undefined, "bundle")).toContain(
      "AAF_V1-5-5",
    );
  });
});
