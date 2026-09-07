/**
 * The name a second copy of a mod carries.
 *
 * It is user-visible — it is what they see in Vortex's mod list and what
 * tells them whose copy this is — and it is load-bearing: Vortex collides on
 * `mod.id === installName`, so two collections needing different builds of the
 * same mod must not produce the same string, or the replace-or-variant dialog
 * comes straight back.
 */
import { describe, expect, it } from "vitest";

import { alongsideInstallName } from "./installAlongside";

const base = {
  modName: "Skyrim Landscapes",
  collectionName: "Meridia Panties",
  collectionVersion: "1.0.10",
};

describe("alongsideInstallName", () => {
  it("names the mod, the collection, the revision, and us", () => {
    expect(alongsideInstallName(base)).toBe(
      "Skyrim Landscapes - Meridia Panties v1.0.10 - Event Horizon",
    );
  });

  it("distinguishes two collections that need the same mod", () => {
    // Without the collection in the name these collide on Vortex's install
    // name, and the second install brings back the dialog this avoids.
    expect(alongsideInstallName(base)).not.toBe(
      alongsideInstallName({ ...base, collectionName: "Other Collection" }),
    );
  });

  it("distinguishes two revisions of the SAME collection", () => {
    // A new revision gets its own profile and may need a different build of
    // the same mod; both have to be able to exist at once.
    expect(alongsideInstallName(base)).not.toBe(
      alongsideInstallName({ ...base, collectionVersion: "1.0.11" }),
    );
  });

  it("replaces characters Windows cannot put in a file name", () => {
    // The name becomes a file name and then a staging folder. Both halves are
    // free text — a manifest mod name and whatever the curator typed.
    expect(
      alongsideInstallName({
        modName: 'A/B\\C:D*E?F"G<H>I|J',
        collectionName: "Wet: Cold",
        collectionVersion: "1.0",
      }),
    ).toBe("A_B_C_D_E_F_G_H_I_J - Wet_ Cold v1.0 - Event Horizon");
  });

  it("trims the MOD name, never the marker", () => {
    /**
     * The marker is what makes the name unique and what identifies the owner.
     * Truncating from the right would drop "- Event Horizon" first and then
     * the version, which is exactly backwards: it would reintroduce the
     * collision the name exists to prevent.
     */
    const out = alongsideInstallName({ ...base, modName: "x".repeat(400) });
    expect(out.endsWith(" - Meridia Panties v1.0.10 - Event Horizon")).toBe(
      true,
    );
    expect(out.length).toBeLessThan(140);
  });

  it("keeps a usable mod name even when the collection name is absurd", () => {
    // A floor, so a long collection title cannot squeeze the mod name to
    // nothing and make every second copy look identical.
    const out = alongsideInstallName({
      ...base,
      modName: "Skyrim Landscapes Overhaul Special Edition",
      collectionName: "y".repeat(300),
    });
    expect(out.startsWith("Skyrim Landscapes Overha")).toBe(true);
  });
});
