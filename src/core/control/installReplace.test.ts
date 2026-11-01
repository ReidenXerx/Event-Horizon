import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __testPaths } from "@nexusmods/vortex-api";

vi.mock("./gameProcess", () => ({ isProcessRunning: vi.fn(async () => false) }));
vi.mock("./restorePoints", async (orig) => ({ ...((await orig()) as object), saveRestorePoint: () => undefined }));
vi.mock("../preferences", () => ({ loadPreferences: () => ({ controlChannel: { enabled: true, askFirst: false }, shownOnce: {} }) }));
const vortex = vi.hoisted(() => ({
  install: undefined as undefined | ((archiveId: string) => Promise<{ vortexModId: string }>),
  uninstalled: [] as string[],
  uninstall: undefined as undefined | ((ids: readonly string[]) => Promise<void>),
}));
vi.mock("../installer/modInstall", () => ({
  installFromExistingDownload: (_api: unknown, a: { archiveId: string }) => vortex.install!(a.archiveId),
  installNexusViaApi: async () => {
    throw new Error("not in this test");
  },
  uninstallMods: async (_api: unknown, a: { modIds: readonly string[] }) => {
    vortex.uninstalled.push(...a.modIds);
    await vortex.uninstall!(a.modIds);
  },
}));

import { runVerb } from "./verbs";
import { enabledAfterReplace, mergeReplacement, pickReplaceTarget } from "./safeReplace";

const PAGE = 163969;

/** Two copies of S.L.A.C.K. from one Nexus page, as Skyrim-collection had them (GOG and Steam). */
function fakeVortex() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eh-replace-"));
  __testPaths.installPath = root;
  const folder = (name: string, file: string): void => {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, "SKSE.dll"), file);
  };
  folder("slack-gog", "gog 1.5.2");
  folder("slack-steam", "steam 1.5.1");
  const state: any = {
    settings: { profiles: { activeGameId: "skyrimse", activeProfileId: "p1" }, gameMode: { discovered: {} } },
    session: { notifications: { notifications: [], dialogs: [] } },
    persistent: {
      profiles: {
        p1: { id: "p1", gameId: "skyrimse", modState: { "slack-gog": { enabled: true }, "slack-steam": { enabled: true } } },
        p2: { id: "p2", gameId: "skyrimse", modState: { "slack-gog": { enabled: false }, "slack-steam": { enabled: false } } },
      },
      mods: {
        skyrimse: {
          "slack-gog": {
            id: "slack-gog",
            state: "installed",
            archiveId: "X",
            installationPath: "slack-gog",
            attributes: { modId: PAGE, version: "1.5.2", customFileName: "S.L.A.C.K. (GOG)", notes: "gog copy" },
            rules: [{ type: "after", reference: { id: "gog-rule" } }],
          },
          "slack-steam": {
            id: "slack-steam",
            state: "installed",
            archiveId: "Y",
            installationPath: "slack-steam",
            attributes: { modId: PAGE, version: "1.5.1", customFileName: "S.L.A.C.K. (Steam)", notes: "steam copy", newestFileId: 9 },
            rules: [{ type: "after", reference: { id: "steam-rule" } }],
          },
        },
      },
      downloads: {
        files: {
          X: { localPath: "SLACK-163969-1-5-2.7z", state: "finished", game: ["skyrimse"], modInfo: { nexus: { ids: { modId: PAGE } } } },
          Z: { localPath: "Ride Along 2.0.zip", state: "finished", game: ["skyrimse"], modInfo: { nexus: { ids: { modId: 777 } } } },
        },
      },
    },
  };
  const pool = (): Record<string, any> => state.persistent.mods.skyrimse;
  const listeners = new Set<() => void>();
  const api = {
    getState: () => state,
    sendNotification: vi.fn(),
    events: { on: vi.fn(), removeListener: vi.fn(), emit: vi.fn((_ev: string, _id: string, cb?: () => void) => cb?.()) },
    store: {
      subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
      dispatch: (a: { type: string; payload: any }) => {
        if (a.type === "STUB_SET_MOD_ENABLED") state.persistent.profiles[a.payload.profileId].modState[a.payload.modId] = { enabled: a.payload.enabled };
        if (a.type === "STUB_FORGET_MOD") delete state.persistent.profiles[a.payload.profileId].modState[a.payload.modId];
        if (a.type === "STUB_ADD_MOD") pool()[a.payload.mod.id] = a.payload.mod;
        if (a.type === "STUB_REMOVE_MOD") delete pool()[a.payload.modId];
        listeners.forEach((l) => l());
      },
    },
  };
  /** Vortex installing alongside: a variant mod, with ANOTHER mod's rules copied on (its previous-version pass), the old one switched off here. */
  const installsAlongside = (copiedRulesFrom: string) => async (archiveId: string) => {
    const id = Object.keys(pool()).length > 5 ? "x" : "slack+tmp";
    folder(id, "new 1.5.2");
    pool()[id] = {
      id,
      state: "installed",
      archiveId,
      installationPath: id,
      attributes: { modId: PAGE, version: "1.5.2", customFileName: "S.L.A.C.K.", installerChoices: { type: "fomod", options: ["Steam"] }, variant: "eh-replace-x" },
      rules: pool()[copiedRulesFrom].rules,
    };
    for (const p of Object.values<any>(state.persistent.profiles)) p.modState[id] = { enabled: p.id === "p1" };
    state.persistent.profiles.p1.modState["slack-gog"] = { enabled: false };
    return { vortexModId: id };
  };
  vortex.uninstalled = [];
  vortex.uninstall = async (ids) => {
    for (const id of ids) {
      fs.rmSync(path.join(root, pool()[id].installationPath), { recursive: true, force: true });
      delete pool()[id];
      for (const p of Object.values<any>(state.persistent.profiles)) delete p.modState[id];
    }
  };
  return { api, state, pool, root, installsAlongside };
}

let v: ReturnType<typeof fakeVortex>;
beforeEach(() => {
  v = fakeVortex();
});

const replace = (body: Record<string, unknown>) =>
  runVerb(v.api as any, "install", { archiveId: "X", ifExisting: "replace", interactive: true, ...body });

describe('install "ifExisting": "replace"', () => {
  it("replaces the mod replaceModId names, on its id and folder, and never the twin from the same archive", async () => {
    v.state.persistent.mods.skyrimse["slack-steam"].archiveId = "X"; // both twins from one archive, as at 03:32Z
    vortex.install = v.installsAlongside("slack-gog");
    const r = (await replace({ replaceModId: "slack-steam" })) as any;
    expect(r).toMatchObject({ vortexModId: "slack-steam", version: "1.5.2", replaced: { id: "slack-steam", why: "asked", previousVersion: "1.5.1" } });
    const steam = v.pool()["slack-steam"];
    expect(steam).toMatchObject({ archiveId: "X", installationPath: "slack-steam", attributes: { version: "1.5.2", notes: "steam copy" } });
    expect(steam.rules).toEqual([{ type: "after", reference: { id: "steam-rule" } }]); // not the GOG copy's
    expect(steam.attributes.newestFileId).toBeUndefined();
    expect(steam.attributes.variant).toBeUndefined();
    expect(fs.readFileSync(path.join(v.root, "slack-steam", "SKSE.dll"), "utf8")).toBe("new 1.5.2");
    // The GOG copy is untouched, and back on where Vortex switched it off.
    expect(v.pool()["slack-gog"]).toMatchObject({ attributes: { version: "1.5.2", notes: "gog copy" }, rules: [{ type: "after", reference: { id: "gog-rule" } }] });
    expect(v.state.persistent.profiles.p1.modState["slack-gog"]).toEqual({ enabled: true });
    // Every profile keeps its on/off for the replaced mod; the temporary mod is gone everywhere.
    expect(v.state.persistent.profiles.p1.modState["slack-steam"]).toEqual({ enabled: true });
    expect(v.state.persistent.profiles.p2.modState["slack-steam"]).toEqual({ enabled: false });
    expect(v.pool()["slack+tmp"]).toBeUndefined();
    expect(v.state.persistent.profiles.p1.modState["slack+tmp"]).toBeUndefined();
    expect(fs.existsSync(path.join(v.root, "slack+tmp"))).toBe(false);
    expect(vortex.uninstalled).toEqual(["slack-steam"]);
  });

  it("asks instead of guessing when two installed mods could be meant, and installs nothing", async () => {
    vortex.install = vi.fn();
    await expect(replace({})).rejects.toMatchObject({
      code: "replace-target-unclear",
      details: { candidates: [expect.objectContaining({ id: "slack-gog", why: "same archive" }), expect.objectContaining({ id: "slack-steam", why: "same Nexus page" })] },
    });
    expect(vortex.install).not.toHaveBeenCalled();
  });

  it("a cancelled or failed install leaves the old mod exactly as it was", async () => {
    vortex.install = async () => {
      v.state.persistent.profiles.p1.modState["slack-steam"] = { enabled: false }; // Vortex switched it off first
      throw new Error("Step Optionals has no group Shiny Amulets");
    };
    await expect(replace({ replaceModId: "slack-steam" })).rejects.toMatchObject({ message: expect.stringContaining("slack-steam was not touched") });
    expect(vortex.uninstalled).toEqual([]);
    expect(v.pool()["slack-steam"]).toMatchObject({ archiveId: "Y", attributes: { version: "1.5.1" } });
    expect(v.state.persistent.profiles.p1.modState["slack-steam"]).toEqual({ enabled: true });
  });

  it("an update whose archive was renamed replaces the one mod from its Nexus page instead of landing beside it", async () => {
    delete v.state.persistent.mods.skyrimse["slack-gog"];
    v.state.persistent.downloads.files.Z.modInfo.nexus.ids.modId = PAGE;
    vortex.install = v.installsAlongside("slack-steam");
    const r = (await replace({ archiveId: "Z" })) as any;
    expect(r.replaced).toMatchObject({ id: "slack-steam", why: "same Nexus page" });
    expect(Object.keys(v.pool())).toEqual(["slack-steam"]);
    expect(v.pool()["slack-steam"].archiveId).toBe("Z");
  });

  it("refuses replaceModId without replace, and a replaceModId that is not installed", async () => {
    await expect(runVerb(v.api as any, "install", { archiveId: "X", replaceModId: "slack-steam" })).rejects.toMatchObject({ code: "bad-request" });
    await expect(replace({ replaceModId: "nope" })).rejects.toMatchObject({ code: "no-such-mod" });
  });
});

describe("safeReplace pieces", () => {
  it("pickReplaceTarget: nothing related is a plain install", () => {
    expect(pickReplaceTarget({ pool: { a: { id: "a", state: "installed", archiveId: "Q", attributes: { modId: 1 } } }, archiveId: "X", nexusModId: 2 })).toEqual({ kind: "none" });
  });

  it("pickReplaceTarget: a collection or a mod not installed is never a candidate", () => {
    const pool = {
      c: { id: "c", type: "collection", state: "installed", archiveId: "X" },
      d: { id: "d", state: "downloaded", archiveId: "X" },
    };
    expect(pickReplaceTarget({ pool, archiveId: "X" })).toEqual({ kind: "none" });
  });

  it("mergeReplacement strips the copy label from names", () => {
    const e = mergeReplacement(
      { id: "t", attributes: { customFileName: "Old" } },
      { id: "n", attributes: { customFileName: "Mod (eh-replace-1)", logicalFileName: "Mod (eh-replace-1)" } },
      { installationPath: "t", label: "eh-replace-1" },
    );
    expect(e.attributes).toMatchObject({ customFileName: "Mod", logicalFileName: "Mod" });
  });

  it("enabledAfterReplace: the caller's enable wins in the active profile only", () => {
    const writes = enabledAfterReplace({
      before: { p1: { t: false }, p2: { t: true } },
      after: { p1: { n: true }, p2: {} },
      targetId: "t",
      freshId: "n",
      activeProfileId: "p1",
      enable: true,
    });
    expect(writes).toEqual([
      { profileId: "p1", modId: "t", enabled: true },
      { profileId: "p2", modId: "t", enabled: true },
    ]);
  });
});
