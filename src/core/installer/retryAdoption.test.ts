/**
 * The retry pass must not re-install a mod that is already installed.
 *
 * ─── THE FIELD FAILURE ─────────────────────────────────────────────────────
 * KazumaDessu's 3,236-mod run, 2026-09-17 (collection "Gate to SovnGoon"):
 *
 *   03:15:44  Race-Based Textures starts installing, opens a dialog
 *   03:25:46  install.stalled — watchdog gives up, driver moves on
 *   05:04:07  Vortex: "finish mod install … outcome: success" (6,502,895 ms)
 *   16:25:40  retry pass re-runs the ORIGINAL nexus-download decision
 *   16:35:40  install.stalled again — Vortex was asking "replace, or install
 *             as a variant?", a modal nothing can pre-answer
 *   16:35:41  install.partial 3235/3236, receipt records a FAILED mod that had
 *             been installed for eleven hours
 *
 * His next run resolved that same mod `nexus-already-installed` in ONE
 * millisecond. The pool knew. The retry pass just never asked it again.
 */
import { describe, expect, it } from "vitest";

import type { types } from "@nexusmods/vortex-api";

import type { ModResolution } from "../../types/installPlan";

import { adoptIfNowInstalled } from "./runInstall";

const GAME = "skyrimse";
const PROFILE = "profile-1";
const SHA = "a".repeat(64);

const downloadResolution: ModResolution = {
  compareKey: "nexus:29725:548408",
  name: "Race-Based Textures (RBT)-29725-1-1-1-1727898410",
  sourceKind: "nexus",
  decision: {
    kind: "nexus-download",
    gameDomain: "skyrimspecialedition",
    modId: 29725,
    fileId: 548408,
    expectedSha256: SHA,
    archiveName: "Race-Based Textures (RBT)-29725-1-1-1-1727898410.zip",
  },
};

/**
 * A Vortex state with a mod pool. `getModsForGame` reads
 * `persistent.mods[gameId]` and takes the Nexus ids off `attributes`, which is
 * where Vortex puts them — mirrored from a real state dump, not invented.
 */
const stateWith = (
  mods: Record<string, { name: string; modId?: number; fileId?: number; sha?: string }>,
): types.IExtensionApi => {
  /**
   * Built ONCE and returned by reference. A `getState` that rebuilds the object
   * on every call silently discards anything a test mutates afterwards, which
   * would make the two tests below pass without testing what they name.
   */
  const state = {
    persistent: {
      mods: {
        [GAME]: Object.fromEntries(
          Object.entries(mods).map(([id, m]) => [
            id,
            {
              id,
              attributes: {
                name: m.name,
                ...(m.modId !== undefined ? { modId: m.modId } : {}),
                ...(m.fileId !== undefined ? { fileId: m.fileId } : {}),
              },
              ...(m.sha !== undefined ? { archiveSha256: m.sha } : {}),
            },
          ]),
        ),
      },
      profiles: { [PROFILE]: { modState: {} as Record<string, unknown> } },
    },
  };
  return { getState: () => state } as unknown as types.IExtensionApi;
};

/** Same pool, with some mods enabled in the profile this run installs into. */
const stateWithEnabled = (
  mods: Record<string, { name: string; modId?: number; fileId?: number; sha?: string }>,
  enabled: readonly string[],
): types.IExtensionApi => {
  const api = stateWith(mods);
  const state = api.getState() as unknown as {
    persistent: { profiles: Record<string, { modState: Record<string, unknown> }> };
  };
  for (const id of enabled) state.persistent.profiles[PROFILE].modState[id] = { enabled: true };
  return api;
};

const adopt = (api: types.IExtensionApi): ModResolution | undefined =>
  adoptIfNowInstalled({
    api,
    gameId: GAME,
    enablementProfileId: PROFILE,
    resolution: downloadResolution,
  });

describe("re-asking the pool before a retry re-installs", () => {
  it("adopts the mod Vortex finished installing after the watchdog gave up", () => {
    const out = adopt(
      stateWith({
        "Race-Based Textures (RBT)-29725-1-1-1-1727898410": {
          name: "Race-Based Textures (RBT)",
          modId: 29725,
          fileId: 548408,
        },
      }),
    );
    expect(out?.decision.kind).toBe("nexus-already-installed");
    expect(
      out?.decision.kind === "nexus-already-installed"
        ? out.decision.existingModId
        : undefined,
    ).toBe("Race-Based Textures (RBT)-29725-1-1-1-1727898410");
    // Everything else about the resolution is carried through untouched — the
    // retry still reports the same mod under the same compare key.
    expect(out?.compareKey).toBe("nexus:29725:548408");
    expect(out?.name).toBe(downloadResolution.name);
  });

  it("reads Vortex's string ids as numbers, which is how Vortex stores them", () => {
    const api = stateWith({
      "rbt-mod": { name: "RBT", modId: 29725, fileId: 548408 },
    });
    // Vortex writes these attributes as strings just as often as numbers.
    const raw = (api.getState() as unknown as {
      persistent: { mods: Record<string, Record<string, { attributes: Record<string, unknown> }>> };
    }).persistent.mods[GAME]["rbt-mod"];
    raw.attributes.modId = "29725";
    raw.attributes.fileId = "548408";
    expect(adopt(api)?.decision.kind).toBe("nexus-already-installed");
  });

  it("does NOT adopt a different file of the same mod page", () => {
    // 548408 is the file the collection pins. An older file is a different
    // mod as far as identity goes, and re-installing is correct there.
    expect(
      adopt(
        stateWith({
          "rbt-old": { name: "RBT 1.0", modId: 29725, fileId: 111111 },
        }),
      ),
    ).toBeUndefined();
  });

  it("matches on the file id alone, because the pool carries no hash here", () => {
    /**
     * This test is why the function has no hash comparison in it. An earlier
     * draft ranked a "proven sha256" above an unhashed copy; this fixture put
     * a hash on the mod and the branch still did not fire, because
     * `getModsForGame` never reads `archiveSha256` — it is filled by
     * `enrichModsWithArchiveHashes`, which hashes archives and is far too
     * expensive to run mid-retry.
     *
     * So the rule is the resolver's: an immutable Nexus file id IS the
     * identity, and an absent hash is "unknown", not "different" (NS-4).
     * Pinning it here means a future hash-aware pass has to face this
     * deliberately rather than inherit a claim that was never true.
     */
    const out = adopt(
      stateWith({
        "rbt-any-bytes": {
          name: "RBT",
          modId: 29725,
          fileId: 548408,
          sha: "b".repeat(64),
        },
      }),
    );
    expect(out?.decision.kind).toBe("nexus-already-installed");
  });

  it("prefers a copy enabled in this run's profile when the pool has two", () => {
    const out = adopt(
      stateWithEnabled(
        {
          "rbt-strangers-copy": { name: "RBT", modId: 29725, fileId: 548408 },
          "rbt-ours": { name: "RBT", modId: 29725, fileId: 548408 },
        },
        ["rbt-ours"],
      ),
    );
    expect(
      out?.decision.kind === "nexus-already-installed"
        ? out.decision.existingModId
        : undefined,
    ).toBe("rbt-ours");
  });

  it("returns undefined when the pool has nothing like it", () => {
    expect(adopt(stateWith({ other: { name: "Something else" } }))).toBeUndefined();
  });

  it("leaves every non-download decision alone", () => {
    // An external mod has no (modId, fileId) to re-ask with, and the other
    // arms either already adopt or are waiting on the user.
    const external: ModResolution = {
      compareKey: "external:deadbeef",
      name: "SCAR-v2.01.AE",
      sourceKind: "external",
      decision: { kind: "external-prompt-user", expectedFilename: "SCAR-v2.01.AE" },
    } as unknown as ModResolution;
    expect(
      adoptIfNowInstalled({
        api: stateWith({}),
        gameId: GAME,
        enablementProfileId: PROFILE,
        resolution: external,
      }),
    ).toBeUndefined();
  });

  it("treats an unreadable state as no evidence, not as a match", () => {
    const broken = {
      getState: () => {
        throw new Error("state unavailable");
      },
    } as unknown as types.IExtensionApi;
    expect(adopt(broken)).toBeUndefined();
  });
});
