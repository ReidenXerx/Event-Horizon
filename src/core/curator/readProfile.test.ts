/**
 * Reading Vortex's store into the view's shape.
 *
 * The trap this file exists for: Vortex keys mods by its OWN id and stores the
 * NEXUS mod id inside `attributes.modId`. They are different numbers with
 * confusable names, and every action here is addressed by one or the other.
 */
import { describe, expect, it } from "vitest";

import {
  FROZEN_ATTRIBUTE,
  freezeAttribute,
  readCuratorMods,
  readEnabledModIds,
} from "./readProfile";
import type { types } from "@nexusmods/vortex-api";

const state = (mods: Record<string, unknown>): types.IState =>
  ({ persistent: { mods: { skyrimse: mods } } }) as unknown as types.IState;

describe("reading the profile", () => {
  it("keeps Vortex's mod id and the NEXUS mod id apart", () => {
    const [m] = readCuratorMods(
      state({
        "vortex-local-id": {
          attributes: { name: "A Mod", modId: 12345, fileId: 999 },
        },
      }),
      "skyrimse",
      new Set(["vortex-local-id"]),
    );
    expect(m!.id).toBe("vortex-local-id");
    expect(m!.nexusModId).toBe(12345);
    expect(m!.nexusFileId).toBe(999);
  });

  it("coerces ids Vortex stored as strings", () => {
    // Vortex's attributes are not normalised; both shapes occur in the wild.
    const [m] = readCuratorMods(
      state({ a: { attributes: { modId: "77", fileId: "88" } } }),
      "skyrimse",
      new Set(),
    );
    expect(m!.nexusModId).toBe(77);
    expect(m!.nexusFileId).toBe(88);
  });

  it("leaves a junk id absent rather than NaN", () => {
    const [m] = readCuratorMods(
      state({ a: { attributes: { modId: "not-a-number" } } }),
      "skyrimse",
      new Set(),
    );
    expect(m!.nexusModId).toBeUndefined();
  });

  it("marks enabled from the profile, not from the mod record", () => {
    const mods = readCuratorMods(
      state({ on: { attributes: {} }, off: { attributes: {} } }),
      "skyrimse",
      new Set(["on"]),
    );
    expect(mods.find((m) => m.id === "on")!.enabled).toBe(true);
    expect(mods.find((m) => m.id === "off")!.enabled).toBe(false);
  });

  it("includes DISABLED mods", () => {
    // The view exists to answer "why is this still on disk?", which it cannot
    // do if it hides everything the curator turned off.
    expect(
      readCuratorMods(state({ off: { attributes: {} } }), "skyrimse", new Set()),
    ).toHaveLength(1);
  });

  it("reads our freeze attribute", () => {
    const [m] = readCuratorMods(
      state({ a: { attributes: { [FROZEN_ATTRIBUTE]: "1.4.2" } } }),
      "skyrimse",
      new Set(),
    );
    expect(m!.frozenAtVersion).toBe("1.4.2");
  });

  it("falls back to the mod id when there is no name", () => {
    const [m] = readCuratorMods(
      state({ nameless: { attributes: {} } }),
      "skyrimse",
      new Set(),
    );
    expect(m!.name).toBe("nameless");
  });

  it("returns nothing for a game Vortex has no mods for", () => {
    expect(readCuratorMods(state({}), "fallout4", new Set())).toEqual([]);
    expect(
      readCuratorMods({} as unknown as types.IState, "skyrimse", new Set()),
    ).toEqual([]);
  });

  it("sorts by name so the list does not reshuffle between reads", () => {
    const mods = readCuratorMods(
      state({
        z: { attributes: { name: "Zebra" } },
        a: { attributes: { name: "Aardvark" } },
      }),
      "skyrimse",
      new Set(),
    );
    expect(mods.map((m) => m.name)).toEqual(["Aardvark", "Zebra"]);
  });

  it("omits absent fields instead of writing undefined into them", () => {
    const [m] = readCuratorMods(
      state({ a: { attributes: {} } }),
      "skyrimse",
      new Set(),
    );
    expect("version" in m!).toBe(false);
    expect("frozenAtVersion" in m!).toBe(false);
  });
});

describe("the freeze attribute", () => {
  it("is namespaced, so Vortex cannot grow one that collides", () => {
    expect(FROZEN_ATTRIBUTE).toContain("eventHorizon");
  });

  it("writes the version, and clears with undefined", () => {
    expect(freezeAttribute("1.0")).toEqual({
      key: FROZEN_ATTRIBUTE,
      value: "1.0",
    });
    expect(freezeAttribute(undefined).value).toBeUndefined();
  });
});

describe("which mods the active profile has on", () => {
  const withProfile = (modState: Record<string, unknown>): types.IState =>
    ({
      persistent: {
        mods: { skyrimse: {} },
        profiles: { p1: { gameId: "skyrimse", modState } },
      },
      settings: { profiles: { activeProfileId: "p1" } },
    }) as unknown as types.IState;

  it("returns only the enabled ones", () => {
    const on = readEnabledModIds(
      withProfile({ a: { enabled: true }, b: { enabled: false } }),
      "skyrimse",
    );
    expect([...on]).toEqual(["a"]);
  });

  it("treats a tracked-but-not-enabled mod as off, not as absent", () => {
    // `modState[id]` existing means the profile KNOWS the mod; `.enabled`
    // says whether it is on. Conflating them switches mods on by accident.
    expect(readEnabledModIds(withProfile({ a: {} }), "skyrimse").size).toBe(0);
  });

  it("is empty when the game has no profile at all", () => {
    expect(readEnabledModIds(withProfile({}), "fallout4").size).toBe(0);
  });
});

describe("the archive reference the cleanup depends on", () => {
  it("reads archiveId off the mod record, not its attributes", () => {
    // Vortex stores it on the mod itself. Reading attributes.archiveId would
    // find nothing and make every archive look deletable.
    const [m] = readCuratorMods(
      state({ a: { archiveId: "dl-77", attributes: { name: "A" } } }),
      "skyrimse",
      new Set(),
    );
    expect(m!.archiveId).toBe("dl-77");
  });

  it("leaves it absent for a mod Vortex tracks no source for", () => {
    const [m] = readCuratorMods(
      state({ a: { attributes: {} } }),
      "skyrimse",
      new Set(),
    );
    expect("archiveId" in m!).toBe(false);
  });
});

/**
 * ──────────────────────────────────────────────────────────────────────
 * `newestFileId: "unknown"` is a VALUE, and it was being destroyed here.
 *
 * Vortex writes the literal string when it knows a mod has an update but
 * cannot name the file, and its own `updateState` tests for it FIRST — those
 * mods render with the go-to-the-site icon in the Mods table.
 *
 * This reader coerces the attribute with `Number(...)`, and `Number("unknown")`
 * is NaN, which became `undefined`. So an assertion that an update EXISTS
 * arrived downstream indistinguishable from "no update information", and a mod
 * Vortex was actively flagging appeared in neither of our update lists.
 *
 * The tests for the two lists could not catch this: they build the mod shape
 * directly and never run the coercion. This is the one that does.
 * ──────────────────────────────────────────────────────────────────────
 */
describe("newestFileId that Vortex could not resolve to a number", () => {
  const readOne = (attributes: Record<string, unknown>) =>
    readCuratorMods(
      state({ "vortex-local-id": { attributes } }),
      "skyrimse",
      new Set(["vortex-local-id"]),
    )[0]!;

  it("preserves the fact when the value is the string \"unknown\"", () => {
    const m = readOne({ name: "A Mod", modId: 1, fileId: 5, newestFileId: "unknown" });
    expect(m.newestFileUnknown).toBe(true);
    // And still no number, because there is no number — the two facts are
    // separate on purpose.
    expect(m.newestFileId).toBeUndefined();
  });

  it("does NOT claim it for a mod with no newestFileId at all", () => {
    // The ordinary case, and by far the most common: nothing known about a
    // newer file. Flagging these would put most of a 1,007-mod profile into
    // the manual-update list.
    const m = readOne({ name: "A Mod", modId: 1, fileId: 5 });
    expect(m.newestFileUnknown).toBeUndefined();
  });

  it("does NOT claim it for an ordinary numeric newestFileId", () => {
    const m = readOne({ name: "A Mod", modId: 1, fileId: 5, newestFileId: 77 });
    expect(m.newestFileUnknown).toBeUndefined();
    expect(m.newestFileId).toBe(77);
  });

  it("reads a numeric-looking STRING as the number Vortex meant", () => {
    // Vortex's own comparison is `newestFileId.toString() !== fileId.toString()`,
    // so it treats "77" and 77 alike. Dropping the string form would lose a
    // real update rather than a confusing one.
    const m = readOne({ name: "A Mod", modId: 1, fileId: 5, newestFileId: "77" });
    expect(m.newestFileId).toBe(77);
    expect(m.newestFileUnknown).toBeUndefined();
  });
});
