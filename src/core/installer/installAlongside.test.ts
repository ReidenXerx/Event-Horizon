/**
 * Installing the curator's copy beside a mod the user already has — and what
 * happens when THIS collection has already made that copy once.
 *
 * ─── THE RUN THIS COMES FROM ────────────────────────────────────────────────
 * The install name is deterministic in (mod, collection, version), and a
 * Vortex mod's id IS its install name. So a second run of the same release
 * asks Vortex to create a mod that already exists, and Vortex answers with its
 * replace-or-variant dialog — which cannot be pre-answered, only avoided.
 * Nobody watches an unattended install, so it simply sat there:
 *
 *   install.alongside.failed  F4SE  /  Address Library
 *   "Mod install stalled — Vortex made no observable progress for 600s while
 *    extracting. The install pipeline may be waiting on a stuck dialog"
 *
 * Twenty minutes each, and both mods ended up unmirrored.
 *
 * A mod under this name is OURS by construction — the name carries our
 * collection and version, which nothing else writes — so finding one is not a
 * collision to work around, it is the previous run's answer.
 */
import { describe, expect, it } from "vitest";

import { alongsideInstallName, installAlongside } from "./installAlongside";

const stateWithMod = (modId: string): unknown => ({
  persistent: { mods: { skyrimse: { [modId]: { id: modId } } } },
});

const ARGS = {
  gameId: "skyrimse",
  modName: "Address Library - All In One",
  collectionName: "ivy panties",
  collectionVersion: "1.0.13",
  // Deliberately absent: reaching the copy step at all is how the second test
  // proves it did NOT take the adopt shortcut.
  archivePath: "C:/nowhere/does-not-exist.7z",
};

describe("a copy this collection already made", () => {
  it("adopts it instead of asking Vortex to create it again", async () => {
    const name = alongsideInstallName({
      modName: ARGS.modName,
      collectionName: ARGS.collectionName,
      collectionVersion: ARGS.collectionVersion,
    });
    let installsRequested = 0;
    const api = {
      getState: () => stateWithMod(name),
      events: {
        emit: () => {
          installsRequested += 1;
        },
      },
      store: { dispatch: () => undefined },
    } as never;

    const result = await installAlongside(api, ARGS);

    expect(result.vortexModId).toBe(name);
    expect(result.installName).toBe(name);
    /**
     * The assertion that matters: Vortex was never asked to install anything,
     * so the dialog that stalls for ten minutes cannot fire. Checking only the
     * returned id would pass against an implementation that installed first
     * and returned the same name afterwards.
     */
    expect(installsRequested).toBe(0);
  });

  it("does NOT adopt a mod under some other name", async () => {
    /**
     * The name carries our collection and version, which nothing else writes.
     * Matching loosely would let us claim a mod the user installed themselves
     * and then mirror over it (NS-2).
     *
     * Proven by the failure mode: with no adoption it proceeds to stage the
     * archive, and the archive does not exist — so a throw here is evidence
     * that it took the install path rather than the shortcut.
     */
    const api = {
      getState: () => stateWithMod(ARGS.modName),
      events: { emit: () => undefined },
      store: { dispatch: () => undefined },
    } as never;

    await expect(installAlongside(api, ARGS)).rejects.toThrow();
  });

  it("does not adopt across a different collection VERSION", async () => {
    // A copy made for v1.0.12 is not the copy v1.0.13 needs: the bytes may
    // differ, and adopting it would ship the previous release's files.
    const older = alongsideInstallName({
      modName: ARGS.modName,
      collectionName: ARGS.collectionName,
      collectionVersion: "1.0.12",
    });
    const api = {
      getState: () => stateWithMod(older),
      events: { emit: () => undefined },
      store: { dispatch: () => undefined },
    } as never;

    await expect(installAlongside(api, ARGS)).rejects.toThrow();
  });
});
