/**
 * The name a second copy of a mod carries.
 *
 * It is user-visible — it is what they see in Vortex's mod list and what
 * tells them whose copy this is — and it is load-bearing: Vortex collides on
 * `mod.id === installName`, so two collections needing different builds of the
 * same mod must not produce the same string, or the replace-or-variant dialog
 * comes straight back.
 *
 * ─── WHAT THE OLD VERSION OF THIS FILE COULD NOT SEE ────────────────────────
 * Every case below used to vary ONE field and assert the outputs differ, which
 * proves the marker carries that field and nothing more. It cannot see the
 * failure that actually shipped: two DIFFERENT mods in the SAME collection
 * release colliding, because the marker is assembled first and the mod name is
 * truncated to what is left. On a long collection title the distinguishing
 * half is the half that gets cut.
 *
 * A Vortex mod's id IS its install name, so the second mod then aliased onto
 * the first and the mirror rewrote one staging folder to the other's file
 * list, deleting real files while both receipt rows said verified. So the
 * cases that matter here are the ones where the inputs are ADVERSARIAL rather
 * than merely different.
 */
import { describe, expect, it } from "vitest";

import { alongsideInstallName } from "./installAlongside";

const base = {
  modName: "Skyrim Landscapes",
  collectionName: "Meridia Panties",
  collectionVersion: "1.0.10",
  packageId: "11111111-2222-4333-8444-555555555555",
  compareKey: "nexus:1234:5678",
};

describe("alongsideInstallName", () => {
  it("names the mod, the collection, the revision, and us", () => {
    expect(alongsideInstallName(base)).toMatch(
      /^Skyrim Landscapes - Meridia Panties v1\.0\.10 \[[0-9a-f]{8}\] - Event Horizon$/,
    );
  });

  it("distinguishes two collections that need the same mod", () => {
    // Without the collection in the name these collide on Vortex's install
    // name, and the second install brings back the dialog this avoids.
    expect(alongsideInstallName(base)).not.toBe(
      alongsideInstallName({ ...base, collectionName: "Other Collection" }),
    );
  });

  it("distinguishes two collections that share a TITLE", () => {
    /**
     * The title is free text the curator typed into the build form;
     * `package.id` is the UUID that actually identifies a release. Two
     * curators can both publish "Skyrim Essentials" v1.0.0, and with only the
     * title in the name one collection adopts the other's copy, mirrors over
     * it, and later uninstalls it — leaving the first collection broken
     * behind a receipt that still says verified.
     */
    expect(alongsideInstallName(base)).not.toBe(
      alongsideInstallName({
        ...base,
        packageId: "99999999-2222-4333-8444-555555555555",
      }),
    );
  });

  it("distinguishes two revisions of the SAME collection", () => {
    // A new revision gets its own profile and may need a different build of
    // the same mod; both have to be able to exist at once.
    expect(alongsideInstallName(base)).not.toBe(
      alongsideInstallName({ ...base, collectionVersion: "1.0.11" }),
    );
  });

  it("distinguishes two mods whose names share a long prefix", () => {
    /**
     * THE REGRESSION THIS FILE MISSED. Executed against the real function
     * before the fix, with a 51-character collection title:
     *
     *   marker length 78, budget = max(24, 120-78) = 42
     *   "Unofficial Skyrim Special Edition Patch - German Translation"
     *   "Unofficial Skyrim Special Edition Patch - Chinese Translation"
     *   both -> "Unofficial Skyrim Special Edition Patch -  - Skyrim ..."
     *   COLLIDE: true
     *
     * Patch and translation families share long prefixes by convention, and
     * they are exactly the mods a collection mirrors. The compareKey digest
     * sits INSIDE the marker, so it survives any truncation of the mod name.
     */
    const collectionName = "Skyrim Special Edition - Ultimate Immersion Overhaul";
    const a = alongsideInstallName({
      ...base,
      collectionName,
      modName: "Unofficial Skyrim Special Edition Patch - German Translation",
      compareKey: "nexus:266:1001",
    });
    const b = alongsideInstallName({
      ...base,
      collectionName,
      modName: "Unofficial Skyrim Special Edition Patch - Chinese Translation",
      compareKey: "nexus:266:1002",
    });
    expect(a).not.toBe(b);
  });

  it("collides only when it SHOULD — same mod, same release", () => {
    /**
     * The other direction, and the reason the digest is over the compareKey
     * rather than something per-run: the name has to be reproducible, because
     * the adopt-our-own-copy shortcut finds a previous run's copy by looking
     * it up under exactly this string. A name that varied per run would ask
     * Vortex to create a mod that already exists and hit the 600s dialog
     * stall the shortcut exists to avoid.
     */
    expect(alongsideInstallName(base)).toBe(alongsideInstallName({ ...base }));
  });

  it("replaces characters Windows cannot put in a file name", () => {
    // The name becomes a file name and then a staging folder. Both halves are
    // free text — a manifest mod name and whatever the curator typed.
    expect(
      alongsideInstallName({
        ...base,
        modName: 'A/B\\C:D*E?F"G<H>I|J',
        collectionName: "Wet: Cold",
        collectionVersion: "1.0",
      }),
    ).toMatch(
      /^A_B_C_D_E_F_G_H_I_J - Wet_ Cold v1\.0 \[[0-9a-f]{8}\] - Event Horizon$/,
    );
  });

  it("trims the MOD name, never the marker", () => {
    /**
     * The marker is what makes the name unique and what identifies the owner.
     * Truncating from the right would drop "- Event Horizon" first and then
     * the version, which is exactly backwards: it would reintroduce the
     * collision the name exists to prevent.
     */
    const out = alongsideInstallName({ ...base, modName: "x".repeat(400) });
    expect(out).toMatch(
      / - Meridia Panties v1\.0\.10 \[[0-9a-f]{8}\] - Event Horizon$/,
    );
    expect(out.length).toBeLessThan(140);
  });

  it("keeps the discriminator even when the collection name is absurd", () => {
    /**
     * The floor keeps a readable mod name; the digest keeps the name CORRECT.
     * Under a 300-character title the mod name is squeezed to 24 characters,
     * so two mods sharing a 24-character prefix have nothing else to tell
     * them apart — which is precisely the shipped bug, at its worst.
     */
    const collectionName = "y".repeat(300);
    const a = alongsideInstallName({
      ...base,
      collectionName,
      modName: "Skyrim Landscapes Overhaul Special Edition",
      compareKey: "nexus:1:1",
    });
    const b = alongsideInstallName({
      ...base,
      collectionName,
      modName: "Skyrim Landscapes Overhaul Legendary Edition",
      compareKey: "nexus:1:2",
    });
    expect(a.startsWith("Skyrim Landscapes Overha")).toBe(true);
    expect(a).not.toBe(b);
  });
});
